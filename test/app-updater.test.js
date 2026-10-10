'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')

const { AppUpdateFlow, isNetworkError } = require('../src/app-updater')
const { messagesFor } = require('../src/locale')
const { labelsFor } = require('../src/labels')

function fakeUpdater({ checkResult, checkError, downloadError, progress = [] } = {}) {
  const updater = new EventEmitter()
  updater.calls = { check: 0, download: 0, install: 0 }
  updater.autoDownload = true
  updater.autoInstallOnAppQuit = true
  updater.allowPrerelease = false
  updater.allowDowngrade = true
  updater.checkForUpdates = async () => {
    updater.calls.check += 1
    if (checkError) throw checkError
    return checkResult
  }
  updater.downloadUpdate = async () => {
    updater.calls.download += 1
    if (downloadError) throw downloadError
    for (const percent of progress) updater.emit('download-progress', { percent })
    return []
  }
  updater.quitAndInstall = (isSilent, isForceRunAfter) => {
    updater.calls.install += 1
    updater.installArgs = [isSilent, isForceRunAfter]
  }
  return updater
}

function recorder(responses = []) {
  const shown = []
  return {
    shown,
    showMessage: async (options) => {
      shown.push(options)
      const next = responses.shift()
      return { response: next === undefined ? 0 : next }
    },
  }
}

function createFlow(overrides = {}) {
  const { shown, showMessage } = recorder(overrides.responses)
  const states = []
  const flow = new AppUpdateFlow(
    Object.assign(
      {
        updater: fakeUpdater(overrides),
        showMessage,
        messages: () => messagesFor('zh-CN'),
        labels: () => labelsFor('zh-CN'),
        isPackaged: true,
        currentVersion: '0.2.0',
        onStateChange: (state) => states.push(state),
        logger: { error: () => {}, warn: () => {}, info: () => {} },
      },
      overrides.flowOverrides,
    ),
  )
  return { flow, shown, states }
}

test('构造时按上游设置开关（不自动下载、不自动安装、允许预发布但不允许降级）', () => {
  const updater = fakeUpdater()
  const { showMessage } = recorder()
  new AppUpdateFlow({
    updater,
    showMessage,
    messages: () => messagesFor('zh-CN'),
    labels: () => labelsFor('zh-CN'),
    isPackaged: true,
    currentVersion: '0.2.0',
  })
  assert.equal(updater.autoDownload, false)
  assert.equal(updater.autoInstallOnAppQuit, false)
  assert.equal(updater.allowPrerelease, true)
  assert.equal(updater.allowDowngrade, false)
})

test('开发模式提示需要打包版本，且不访问更新源', async () => {
  const { flow, shown } = createFlow({
    flowOverrides: { isPackaged: false },
  })
  await flow.check()
  assert.equal(shown.length, 1)
  assert.match(shown[0].message, /开发模式/)
  assert.equal(flow.updater.calls.check, 0)
})

test('已是最新版本时只提示当前版本', async () => {
  const { flow, shown } = createFlow({ checkResult: { isUpdateAvailable: false } })
  await flow.check()
  assert.equal(shown.length, 1)
  assert.equal(shown[0].message, messagesFor('zh-CN').updateCurrent)
  assert.match(shown[0].detail, /0\.2\.0/)
  assert.equal(flow.state.phase, 'current')
})

test('发现新版本但选择稍后，则不会下载', async () => {
  const { flow, shown } = createFlow({
    checkResult: { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } },
    responses: [1],
  })
  await flow.check()
  assert.equal(flow.updater.calls.download, 0)
  assert.equal(shown[0].buttons[0], messagesFor('zh-CN').updateDownload)
  assert.equal(flow.state.phase, 'available')
})

test('确认后下载并（无任务时）直接安装，进度会进入状态', async () => {
  const { flow, shown, states } = createFlow({
    checkResult: { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } },
    progress: [12, 47, 100],
    responses: [0, 0],
    flowOverrides: { inspectActivity: async () => ({ activeTasks: false }) },
  })
  await flow.check()
  assert.equal(flow.updater.calls.download, 1)
  assert.deepEqual(
    states.filter((state) => state.phase === 'downloading').map((state) => state.percent),
    [0, 12, 47, 100],
  )
  assert.equal(shown[1].buttons[0], messagesFor('zh-CN').installAndRestart)
  assert.equal(flow.updater.calls.install, 1)
  assert.deepEqual(flow.updater.installArgs, [false, true])
  assert.equal(flow.state.phase, 'installing')
})

test('有任务在跑时先确认，取消则不安装', async () => {
  const { flow, shown } = createFlow({
    checkResult: { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } },
    responses: [0, 0, 1],
    flowOverrides: { inspectActivity: async () => ({ activeTasks: true }) },
  })
  await flow.check()
  const taskDialog = shown[shown.length - 1]
  assert.equal(taskDialog.message, messagesFor('zh-CN').updateActiveTasks)
  assert.equal(taskDialog.buttons[0], messagesFor('zh-CN').updateStopTasks)
  assert.equal(flow.updater.calls.install, 0)
})

test('任务状态探测失败按“有任务”处理', async () => {
  const { flow, shown } = createFlow({
    checkResult: { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } },
    responses: [0, 0, 1],
    flowOverrides: {
      inspectActivity: async () => {
        throw new Error('probe exploded')
      },
    },
  })
  await flow.check()
  assert.equal(shown[shown.length - 1].message, messagesFor('zh-CN').updateActiveTasks)
})

test('确认停止任务后会先停服务再交给 electron-updater 重启', async () => {
  let prepared = 0
  const { flow } = createFlow({
    checkResult: { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } },
    responses: [0, 0],
    flowOverrides: {
      inspectActivity: async () => ({ activeTasks: true }),
      prepareInstall: async () => {
        prepared += 1
      },
    },
  })
  await flow.check()
  assert.equal(prepared, 1)
  assert.equal(flow.updater.calls.install, 1)
})

test('停服务失败时不安装，并给出提示', async () => {
  const { flow, shown } = createFlow({
    checkResult: { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } },
    responses: [0, 0],
    flowOverrides: {
      inspectActivity: async () => ({ activeTasks: false }),
      prepareInstall: async () => {
        throw new Error('stop failed')
      },
    },
  })
  await flow.check()
  assert.equal(flow.updater.calls.install, 0)
  assert.equal(shown[shown.length - 1].message, messagesFor('zh-CN').updateStopFailed)
  assert.equal(flow.state.phase, 'ready')
})

test('检查失败时按网络与否换文案，并可重试', async () => {
  const network = Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })
  const { flow, shown } = createFlow({ checkError: network, responses: [0, 1] })
  await flow.check()
  assert.equal(shown[0].message, messagesFor('zh-CN').updateCheckNetworkFailed)
  assert.equal(shown[0].buttons[0], messagesFor('zh-CN').updateRetry)
  assert.equal(flow.updater.calls.check, 2, '点重试会再查一次')
})

test('下载失败给出下载文案并能重试', async () => {
  const { flow, shown } = createFlow({
    checkResult: { isUpdateAvailable: true, updateInfo: { version: '0.3.0' } },
    downloadError: new Error('socket hang up'),
    responses: [0, 0],
  })
  await flow.check()
  assert.equal(shown[shown.length - 1].message, messagesFor('zh-CN').updateDownloadNetworkFailed)
  assert.ok(flow.updater.calls.download >= 2, `应重试下载，实际 ${flow.updater.calls.download} 次`)
})

test('连续失败超过上限后不再提供重试', async () => {
  const { flow, shown } = createFlow({ checkError: new Error('boom'), responses: [0, 0, 0, 0] })
  await flow.check()
  const last = shown[shown.length - 1]
  assert.deepEqual(last.buttons, [messagesFor('zh-CN').updateClose])
})

test('网络错误识别', () => {
  assert.equal(isNetworkError(new Error('getaddrinfo ENOTFOUND x')), true)
  assert.equal(isNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED')), true)
  assert.equal(isNetworkError(new Error('signature mismatch')), false)
})
