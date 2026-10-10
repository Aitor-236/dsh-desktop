'use strict'

/**
 * 用假的 electron 模块加载 src/main.js，验证主进程的接线（不开窗口、不占端口）：
 * 单实例 → 建窗口 → 托盘 → 拉起 dsh 服务 → 加载就绪地址 → 退出时回收服务。
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

function createElectronStub(record) {
  class BrowserWindow {
    constructor(options) {
      record.windowOptions = options
      this.webContents = { setWindowOpenHandler: () => {} }
      record.loadedUrls = []
    }
    loadURL(url) {
      record.loadedUrls.push(url)
      return Promise.resolve()
    }
    once() {}
    on(event, handler) {
      record.windowHandlers[event] = handler
    }
    show() {}
    hide() {}
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
  }

  const appHandlers = {}
  return {
    app: {
      setName: () => {},
      getVersion: () => '0.1.0',
      isPackaged: false,
      requestSingleInstanceLock: () => true,
      whenReady: () => Promise.resolve(),
      quit: () => {
        record.quitCalls += 1
      },
      on: (event, handler) => {
        appHandlers[event] = handler
      },
      handlers: appHandlers,
    },
    BrowserWindow,
    Tray,
    Menu: { setApplicationMenu: () => {}, buildFromTemplate: (template) => template },
    nativeImage: { createFromPath: () => ({ resize: () => ({}) }) },
    dialog: {
      showMessageBoxSync: () => 0,
      showMessageBox: () => Promise.resolve({ response: 0 }),
    },
    Notification: class {
      static isSupported() {
        return false
      }
      show() {}
    },
    shell: { openExternal: () => {}, openPath: () => {} },
  }
}

test('主进程接线：拉起 dsh、加载就绪地址、退出时回收服务', async () => {
  const record = {
    loadedUrls: [],
    windowHandlers: {},
    trayHandlers: {},
    quitCalls: 0,
  }
  const electronStub = createElectronStub(record)

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-state-'))
  process.env.DSH_BIN = fakeDshScript()
  process.env.XDG_STATE_HOME = stateDir
  process.env.XDG_CONFIG_HOME = stateDir

  const originalLoad = Module._load
  const mainPath = require.resolve('../src/main.js')
  delete require.cache[mainPath]
  Module._load = function load(request) {
    if (request === 'electron') return electronStub
    return originalLoad.apply(this, arguments)
  }

  try {
    require(mainPath)
    await new Promise((resolve) => setTimeout(resolve, 800))
  } finally {
    Module._load = originalLoad
  }

  assert.ok(record.windowOptions, '应创建窗口')
  assert.equal(record.windowOptions.show, false)
  const ready = record.loadedUrls.find((url) => url.includes('token=main-test-token'))
  assert.ok(ready, `窗口应加载 dsh 就绪地址，实际：${JSON.stringify(record.loadedUrls)}`)
  assert.ok(record.trayMenu, '应创建托盘菜单')
  assert.match(record.tooltip, /DeepSeek Harness/)

  // 退出：应阻止立刻退出、停掉 dsh，再调用 app.quit()
  const beforeQuit = electronStub.app.handlers['before-quit']
  assert.ok(beforeQuit, '应注册 before-quit')
  let prevented = false
  beforeQuit({ preventDefault: () => (prevented = true) })
  assert.equal(prevented, true, '有服务在跑时应阻止直接退出')
  await new Promise((resolve) => setTimeout(resolve, 500))
  assert.equal(record.quitCalls, 1, '回收服务后再退出')

  delete require.cache[mainPath]
  delete process.env.DSH_BIN
})
