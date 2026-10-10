'use strict'

/**
 * 应用自身更新（electron-updater，先于上游 Windows/macOS 版同一套依赖）。
 * 流程与上游 apps/desktop 的 update-coordinator 对齐：
 *   - autoDownload=false / autoInstallOnAppQuit=false：下载与安装都要用户确认
 *   - allowPrerelease=true、allowDowngrade=false（上游显式关掉"选通道导致降级"）
 *   - 检查 → 确认下载 → 下载完成确认 → 安装前先确认没有任务在跑 → quitAndInstall
 * Linux 上 electron-updater 支持 AppImage 原地替换，也支持 deb（走 dpkg/apt 并请求提权）。
 */

const NETWORK_HINT =
  /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ERR_?NETWORK|net::|getaddrinfo|socket hang up/i

const MAX_RETRIES = 3

function isNetworkError(error) {
  const text = `${error && error.code ? error.code : ''} ${error && error.message ? error.message : String(error)}`
  return NETWORK_HINT.test(text)
}

function format(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
}

/**
 * 一次应用更新的状态机。所有副作用都从构造参数注入，便于在无图形环境下单测。
 */
class AppUpdateFlow {
  constructor({
    updater,
    showMessage,
    messages,
    labels,
    isPackaged,
    currentVersion,
    inspectActivity,
    prepareInstall,
    onStateChange,
    logger = console,
  }) {
    this.updater = updater
    this.showMessage = showMessage
    this.messages = messages
    this.labels = labels
    this.isPackaged = isPackaged
    this.currentVersion = currentVersion
    this.inspectActivity = inspectActivity
    this.prepareInstall = prepareInstall
    this.onStateChange = onStateChange
    this.logger = logger
    this.state = { phase: 'idle' }
    this.candidate = undefined
    this.retries = 0

    if (this.updater) {
      this.updater.autoDownload = false
      this.updater.autoInstallOnAppQuit = false
      this.updater.allowPrerelease = true
      // 设置 channel 会让 electron-updater 打开降级，这里按上游显式关掉
      this.updater.allowDowngrade = false
      this._onProgress = (progress) => {
        if (this.state.phase !== 'downloading') return
        const percent = Math.max(0, Math.min(100, Math.round(Number(progress && progress.percent) || 0)))
        if (percent === this.state.percent) return
        this._set(Object.assign({}, this.state, { percent }))
      }
      this._onError = (error) => {
        this.logger.error('app updater error', error)
      }
      this.updater.on('download-progress', this._onProgress)
      this.updater.on('error', this._onError)
    }
  }

  dispose() {
    if (!this.updater) return
    if (this._onProgress) this.updater.off('download-progress', this._onProgress)
    if (this._onError) this.updater.off('error', this._onError)
  }

  _set(state) {
    this.state = state
    if (typeof this.onStateChange === 'function') this.onStateChange(state)
  }

  /** 菜单入口：检查 → 询问 → 下载 → 询问 → 安装。 */
  async check() {
    const messages = this.messages()
    const labels = this.labels()

    if (!this.isPackaged || !this.updater) {
      await this.showMessage({
        type: 'info',
        title: messages.updateCheckTitle,
        message: labels.updateUnavailableInDev,
        buttons: [labels.ok],
      })
      return this.state
    }

    this._set({ phase: 'checking' })
    let result
    try {
      result = await this.updater.checkForUpdates()
    } catch (error) {
      return this._fail('check', error)
    }

    if (!result || result.isUpdateAvailable !== true) {
      await this.showMessage({
        type: 'info',
        title: messages.updateCheckTitle,
        message: messages.updateCurrent,
        detail: format(messages.updateCurrentDetail, { version: this.currentVersion }),
        buttons: [labels.ok],
      })
      this.retries = 0
      this._set({ phase: 'current' })
      return this.state
    }

    const version = result.updateInfo ? result.updateInfo.version : undefined
    this.candidate = version
    this.retries = 0
    this._set({ phase: 'available', version })

    const answer = await this.showMessage({
      type: 'info',
      title: messages.updateCheckTitle,
      message: format(messages.updateAvailable, { version }),
      detail: messages.updateDetail,
      buttons: [messages.updateDownload, messages.updateLater],
      defaultId: 0,
      cancelId: 1,
    })
    if (answer.response !== 0) return this.state
    return this.download(version)
  }

  /** 下载更新并在完成后询问是否安装。 */
  async download(version) {
    const messages = this.messages()
    const labels = this.labels()
    const target = version || this.candidate
    if (!this.updater || target === undefined) {
      this.logger.warn('app updater: download requested without a candidate version')
      return this.state
    }

    this._set({ phase: 'downloading', version: target, percent: 0 })
    try {
      await this.updater.downloadUpdate()
    } catch (error) {
      return this._fail('download', error)
    }

    this.retries = 0
    this._set({ phase: 'ready', version: target })
    const answer = await this.showMessage({
      type: 'info',
      title: messages.updateCheckTitle,
      message: format(messages.updateDownloadedTitle, { version: target }),
      detail: messages.updateDownloadedDetail,
      buttons: [messages.installAndRestart, messages.later],
      defaultId: 0,
      cancelId: 1,
    })
    if (answer.response !== 0) return this.state
    return this.install(target)
  }

  /** 安装前确认没有任务在跑；确认后先停服务再交给 electron-updater 重启。 */
  async install(version) {
    const messages = this.messages()
    const target = version || this.candidate
    if (!this.updater || target === undefined) {
      this.logger.warn('app updater: install requested without a candidate version')
      return this.state
    }

    if (typeof this.inspectActivity === 'function') {
      let inspection
      try {
        inspection = await this.inspectActivity()
      } catch (error) {
        this.logger.warn('app updater: activity inspection failed, assuming tasks are running', error)
        inspection = 'unknown'
      }
      // unknown（探测失败/超时）与确认为 active 一样，都要先问用户
      const active = inspection === 'unknown' || !inspection || inspection.activeTasks === true
      if (active) {
        const answer = await this.showMessage({
          type: 'warning',
          title: messages.updateActiveTasks,
          message: messages.updateActiveTasks,
          detail: messages.updateActiveTasksDetail,
          buttons: [messages.updateStopTasks, messages.later],
          defaultId: 0,
          cancelId: 1,
        })
        if (answer.response !== 0) return this.state
      }
    }

    this._set({ phase: 'installing', version: target })
    if (typeof this.prepareInstall === 'function') {
      try {
        await this.prepareInstall()
      } catch (error) {
        this.logger.error('app updater: could not stop the service before installing', error)
        await this.showMessage({
          type: 'error',
          title: messages.updateFailedTitle,
          message: messages.updateStopFailed,
          detail: String((error && error.message) || error),
          buttons: [messages.updateClose],
        })
        this._set(Object.assign({}, this.state, { phase: 'ready' }))
        return this.state
      }
    }

    try {
      this.updater.quitAndInstall(false, true)
    } catch (error) {
      return this._fail('install', error)
    }
    return this.state
  }

  /** 失败处理：网络类错误换成专用文案，并提供重试（最多连续 3 次）。 */
  async _fail(operation, error) {
    const messages = this.messages()
    const labels = this.labels()
    const network = isNetworkError(error)
    const message =
      operation === 'check'
        ? network
          ? messages.updateCheckNetworkFailed
          : messages.updateCheckFailed
        : operation === 'download'
          ? network
            ? messages.updateDownloadNetworkFailed
            : messages.updateDownloadFailed
          : network
            ? messages.updateInstallNetworkFailed
            : messages.updateInstallFailed
    const title = operation === 'check' ? messages.updateCheckFailedTitle : messages.updateFailedTitle
    const detail = String((error && error.message) || error || messages.unknownError)

    this._set({ phase: 'error', operation, message, detail })
    this.retries += 1
    const canRetry = this.retries <= MAX_RETRIES
    const answer = await this.showMessage({
      type: 'error',
      title,
      message,
      detail,
      buttons: canRetry ? [messages.updateRetry, messages.updateClose] : [messages.updateClose],
      defaultId: 0,
      cancelId: canRetry ? 1 : 0,
    })
    if (canRetry && answer.response === 0) {
      if (operation === 'download') return this.download(this.candidate)
      if (operation === 'install') return this.install(this.candidate)
      return this.check()
    }
    return this.state
  }
}

module.exports = { AppUpdateFlow, MAX_RETRIES, isNetworkError }
