'use strict'

/**
 * 关闭窗口时的一次性提示：确认后窗口隐藏到托盘，并在 Electron userData 下写
 * background-close-confirmed 标记（与上游 Windows 版同名同语义），之后不再打扰。
 */

const { existsSync, mkdirSync, writeFileSync } = require('node:fs')
const { dirname } = require('node:path')

class BackgroundNotice {
  constructor({ markerPath, messages, show, focus }) {
    this.markerPath = markerPath
    this.messages = messages
    this.show = show
    this.focus = focus
    this.acknowledged = false
    this.pending = false
    this.disposed = false
  }

  /** 请求隐藏窗口；已经确认过就直接隐藏。 */
  close(hide) {
    if (this.disposed) return
    if (this.pending) {
      this.focus()
      return
    }
    if (this.acknowledged || existsSync(this.markerPath)) {
      hide()
      return
    }
    this.pending = true
    void this._confirm(hide)
  }

  dispose() {
    this.disposed = true
  }

  async _confirm(hide) {
    try {
      const messages = this.messages()
      const result = await this.show({
        type: 'info',
        title: messages.aboutProduct,
        message: messages.backgroundNoticeBody,
        buttons: [messages.backgroundNoticeConfirm],
        defaultId: 0,
        cancelId: -1,
      })
      if (this.disposed || result.response !== 0) return
      this.acknowledged = true
      try {
        mkdirSync(dirname(this.markerPath), { recursive: true })
        writeFileSync(this.markerPath, '')
      } catch (error) {
        console.warn('background notice: could not record confirmation', error)
      }
      hide()
    } catch (error) {
      console.warn('background notice: dialog unavailable', error)
    } finally {
      this.pending = false
    }
  }
}

module.exports = { BackgroundNotice }
