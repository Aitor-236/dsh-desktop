'use strict'

/**
 * 用假的 electron 模块加载 src/main.js，验证主进程接线（不开窗口、不占端口）：
 * 单实例 → 建窗口（上游尺寸）→ 托盘 → 拉起 dsh 服务 → 加载就绪地址 →
 * 退出确认（有任务才问）→ 回收服务后退出。
 */

const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

function fakeDshScript() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-main-'))
  const file = path.join(dir, 'dsh')
  fs.writeFileSync(
    file,
    '#!/bin/sh\n' +
      'echo "dsh web: http://127.0.0.1:39998/?token=main-test-token"\n' +
      'trap "exit 0" TERM\n' +
      'while true; do sleep 0.2; done\n',
    { mode: 0o755 },
  )
  return file
}

function writeLiveSession(dshHome) {
  const dir = path.join(dshHome, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'session-live.json'),
    JSON.stringify({ record: { rows: { turnBoundary: { val: { openTurnStartSeq: 3 } } } } }),
  )
}

function createElectronStub(record) {
  class BrowserWindow {
    constructor(options) {
      record.windowOptions = options
      record.loadedUrls = []
      this.webContents = {
        setWindowOpenHandler: (handler) => {
          record.windowOpenHandler = handler
        },
        on: (event, handler) => {
          record.webContentsHandlers[event] = handler
        },
        getURL: () => record.currentUrl,
        reload: () => {
          record.reloads += 1
        },
      }
    }
    loadURL(url) {
      record.loadedUrls.push(url)
      return Promise.resolve()
    }
    once(event, handler) {
      record.windowOnce[event] = handler
    }
    on(event, handler) {
      record.windowHandlers[event] = handler
    }
    show() {}
    hide() {
      record.hides += 1
    }
    focus() {}
    restore() {}
    isMinimized() {
      return false
    }
    isDestroyed() {
      return false
    }
  }

  class Tray {
    constructor(image) {
      record.trayImage = image
    }
    setContextMenu(menu) {
      record.trayMenu = menu
    }
    setToolTip(text) {
      record.tooltip = text
    }
    on(event, handler) {
      record.trayHandlers[event] = handler
    }
    destroy() {
      record.trayDestroyed += 1
    }
  }

  const appHandlers = {}
  return {
    app: {
      setName: () => {},
      getVersion: () => '0.1.0',
      getLocale: () => 'zh-CN',
      getPath: (name) => {
        record.pathRequests.push(name)
        return path.join(record.userDataDir, name === 'userData' ? '' : name)
      },
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      quit: () => {
        record.quitCalls += 1
      },
      exit: () => {
        record.exitCalls += 1
      },
      relaunch: () => {
        record.relaunches += 1
      },
      on: (event, handler) => {
        appHandlers[event] = handler
      },
      handlers: appHandlers,
    },
    BrowserWindow,
    Tray,
    Menu: {
      setApplicationMenu: (template) => {
        record.menuTemplate = template
      },
      buildFromTemplate: (template) =>
        Object.assign(template, {
          popup: (options) => {
            record.popups.push(options)
          },
        }),
    },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    powerMonitor: {
      on: (event, handler) => {
        record.powerHandlers[event] = handler
      },
    },
    dialog: {
      showMessageBoxSync: () => 0,
      showMessageBox: async (first, second) => {
        const options = second === undefined ? first : second
        record.dialogs.push(options)
        const next = record.dialogResponses.shift()
        return { response: next === undefined ? 0 : next }
      },
    },
    Notification: class {
      static isSupported() {
        return false
      }
      show() {}
    },
    shell: { openExternal: () => {}, openPath: async () => '' },
  }
}

/** 加载一份全新的 main.js，用假 electron 驱动。 */
async function loadMain({ liveSessions = false, dialogResponses = [] } = {}) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-state-'))
  const dshHome = path.join(workDir, 'dsh-home')
  fs.mkdirSync(dshHome, { recursive: true })
  if (liveSessions) writeLiveSession(dshHome)

  const record = {
    loadedUrls: [],
    windowHandlers: {},
    windowOnce: {},
    webContentsHandlers: {},
    trayHandlers: {},
    powerHandlers: {},
    dialogs: [],
    dialogResponses,
    popups: [],
    pathRequests: [],
    userDataDir: path.join(workDir, 'user-data'),
    quitCalls: 0,
    exitCalls: 0,
    relaunches: 0,
    trayDestroyed: 0,
    hides: 0,
    reloads: 0,
    currentUrl: 'http://127.0.0.1:39998/',
  }
  const electronStub = createElectronStub(record)

  const previous = {
    DSH_BIN: process.env.DSH_BIN,
    DSH_HOME: process.env.DSH_HOME,
    XDG_STATE_HOME: process.env.XDG_STATE_HOME,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  }
  process.env.DSH_BIN = fakeDshScript()
  process.env.DSH_HOME = dshHome
  process.env.XDG_STATE_HOME = workDir
  process.env.XDG_CONFIG_HOME = workDir

  const originalLoad = Module._load
  const mainPath = require.resolve('../src/main.js')
  delete require.cache[mainPath]
  Module._load = function load(request) {
    if (request === 'electron') return electronStub
    return originalLoad.apply(this, arguments)
  }
  try {
    require(mainPath)
    await new Promise((resolve) => setTimeout(resolve, 700))
  } finally {
    Module._load = originalLoad
  }

  return {
    record,
    electronStub,
    restore() {
      delete require.cache[mainPath]
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    },
  }
}

test('主进程接线：上游窗口尺寸、托盘、加载就绪地址、退出时回收服务', async () => {
  const { record, electronStub, restore } = await loadMain()
  try {
    assert.ok(record.windowOptions, '应创建窗口')
    assert.equal(record.windowOptions.show, false)
    assert.equal(record.windowOptions.width, 1280)
    assert.equal(record.windowOptions.height, 820)
    assert.equal(record.windowOptions.minWidth, 520)
    assert.equal(record.windowOptions.minHeight, 600)
    assert.equal(record.windowOptions.autoHideMenuBar, true)

    const ready = record.loadedUrls.find((url) => url.includes('token=main-test-token'))
    assert.ok(ready, `窗口应加载 dsh 就绪地址，实际：${JSON.stringify(record.loadedUrls)}`)

    assert.ok(record.trayMenu, '应创建托盘菜单')
    assert.equal(record.tooltip, 'DeepSeek Harness', '托盘 tooltip 应是产品名')
    const trayLabels = record.trayMenu.map((item) => item.label).filter(Boolean)
    assert.ok(trayLabels.includes('打开 DeepSeek Harness'), `托盘应有打开项：${trayLabels.join(' / ')}`)
    assert.ok(trayLabels.includes('退出 DeepSeek Harness'), `托盘应有退出项：${trayLabels.join(' / ')}`)

    const applicationMenu = JSON.stringify(record.menuTemplate)
    assert.match(applicationMenu, /管理 dsh 命令…/, '应用菜单应含“管理 dsh 命令…”')
    assert.match(applicationMenu, /检查更新…/, '应用菜单应含“检查更新…”')
    assert.match(applicationMenu, /检查 dsh 更新…/, '应用菜单应含“检查 dsh 更新…”')
    assert.equal(record.pathRequests.includes('logs'), true)

    assert.ok(record.pathRequests.includes('userData'), '关闭提示标记应放在 userData 下')
    assert.ok(record.pathRequests.includes('logs'), '崩溃报告应写在 logs 目录')
    assert.ok(record.powerHandlers.shutdown, '应监听系统关机，避免用确认框挡住注销')
    assert.ok(record.webContentsHandlers['will-navigate'], '应拦截导航')
    assert.ok(record.webContentsHandlers['context-menu'], '应提供右键菜单')
    assert.ok(record.webContentsHandlers['console-message'], '应收集渲染进程错误日志')

    // 导航策略：外链被拦下并交给系统浏览器，危险协议直接被拦
    let navigated = false
    let preventedNav = false
    record.webContentsHandlers['will-navigate'](
      { preventDefault: () => (preventedNav = true) },
      'https://github.com/deepseek-ai/deepseek-harness',
    )
    assert.equal(preventedNav, true, '外链不应在窗口内打开')
    preventedNav = false
    record.webContentsHandlers['will-navigate'](
      { preventDefault: () => (preventedNav = true) },
      'http://127.0.0.1:39998/settings',
    )
    assert.equal(preventedNav, false, '同源导航应放行')
    assert.equal(navigated, false)

    // 右键菜单：可编辑参数才弹
    record.webContentsHandlers['context-menu']({}, { isEditable: false, selectionText: '' })
    assert.equal(record.popups.length, 0)
    record.webContentsHandlers['context-menu'](
      {},
      { isEditable: true, selectionText: '', editFlags: { canCopy: true } },
    )
    assert.equal(record.popups.length, 1, '可编辑区域应弹出编辑菜单')

    // 无任务在跑：退出不弹框，直接回收服务后退出
    const beforeQuit = electronStub.app.handlers['before-quit']
    let prevented = false
    beforeQuit({ preventDefault: () => (prevented = true) })
    assert.equal(prevented, true, '有服务在跑时应阻止同步退出')
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(record.dialogs.length, 0, '没有任务时不应弹确认框')
    assert.equal(record.quitCalls, 1, '回收服务后再退出')
    assert.equal(record.trayDestroyed, 1, '退出时应销毁托盘图标')
  } finally {
    restore()
  }
})

test('有关闭提示标记语义：首次关闭窗口只隐藏', async () => {
  const { record, electronStub, restore } = await loadMain()
  try {
    const close = record.windowHandlers.close
    assert.ok(close, '应注册 close 处理器')
    let prevented = false
    close({ preventDefault: () => (prevented = true) })
    assert.equal(prevented, true, 'close 应被拦截（改为隐藏）')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(record.hides, 1, '确认后窗口隐藏')
    assert.equal(record.dialogs.length, 1)
    assert.equal(record.dialogs[0].message, '正在运行的任务不会中断，可在系统托盘中重新打开窗口')

    // 收尾：正常退出，确保假 dsh 子进程被回收，测试进程不会挂住
    electronStub.app.handlers['before-quit']({ preventDefault: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(record.quitCalls, 1)
  } finally {
    restore()
  }
})

test('有任务在跑时退出要先确认，取消则不退出', async () => {
  const { record, electronStub, restore } = await loadMain({
    liveSessions: true,
    dialogResponses: [1, 0],
  })
  try {
    const beforeQuit = electronStub.app.handlers['before-quit']

    beforeQuit({ preventDefault: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(record.dialogs.length, 1, '有任务在跑时应弹退出确认')
    assert.equal(record.dialogs[0].message, '退出 DeepSeek Harness？')
    assert.deepEqual(record.dialogs[0].buttons, ['退出', '取消'])
    assert.equal(record.dialogs[0].detail, '当前正在运行的任务将会中断')
    assert.equal(record.quitCalls, 0, '取消后不退出')

    beforeQuit({ preventDefault: () => {} })
    await new Promise((resolve) => setTimeout(resolve, 500))
    assert.equal(record.quitCalls, 1, '确认后退出')
  } finally {
    restore()
  }
})
