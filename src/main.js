'use strict'

/**
 * 主进程：把 dsh web 服务装进原生窗口，行为对齐上游 Windows/macOS 桌面版——
 * 关闭窗口即隐藏、退出前询问是否有任务在跑、托盘常驻、单实例、菜单里的
 * 关于 / 检查更新 / 管理 dsh 命令 / 刷新 / 开发者工具（F12）。
 */

const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, powerMonitor, shell } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DshServer, findDsh } = require('./supervisor')
const autostart = require('./autostart')
const { messagesFor } = require('./locale')
const { labelsFor, format } = require('./labels')
const { BackgroundNotice } = require('./background-notice')
const { QuitConfirmation } = require('./quit-confirmation')
const { createActivityProbe, withDeadline } = require('./activity')
const commandManagement = require('./command-management')
const { checkForUpdates, fetchLatestVersion, upgradeDsh } = require('./updates')
const { RendererConsoleTail, pruneCrashReports, writeCrashReport } = require('./diagnostics')
const { navigationDecision, windowOpenDecision } = require('./navigation')
const { contextMenuTemplate } = require('./context-menu')
const { FatalRecovery } = require('./fatal-recovery')
const { disableProfilePatches } = require('./profile-recovery')

const APP_NAME = 'DeepSeek Harness'
const ICON_FILE = path.join(__dirname, '..', 'build', 'icon.png')
const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
  'dsh-desktop',
)
const LOG_FILE = path.join(STATE_DIR, 'server.log')

/** 上游 Windows 版的主窗口尺寸。 */
const WINDOW_BOUNDS = { width: 1280, height: 820, minWidth: 520, minHeight: 600 }
/** 上游给 Host 询问留的截止时间；超时按"有任务在跑"处理。 */
const PROBE_DEADLINE_MS = 2000

const SPLASH_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${APP_NAME}</title>
<style>
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center;
         background:#101418; color:#e6edf3; font:14px/1.7 system-ui,"Noto Sans CJK SC",sans-serif }
  .box { text-align:center }
  .dot { width:10px; height:10px; margin:0 auto 18px; border-radius:50%; background:#4d6bfe;
         animation:pulse 1.2s ease-in-out infinite }
  @keyframes pulse { 0%,100% { opacity:.35; transform:scale(.85) } 50% { opacity:1; transform:scale(1.1) } }
  .hint { color:#8b949e; font-size:12px; margin-top:10px }
</style></head>
<body><div class="box"><div class="dot"></div><div>正在启动 dsh 服务…</div>
<div class="hint">首次启动需要几秒钟</div></div></body></html>`)

let server = null
let win = null
let tray = null
let quitting = false
let sessionEnding = false
let backgroundNotice = null
let quitConfirmation = null
let localeId = 'en'
let cachedDshVersion = null
let fatalRecovery = null
let logsDir = null
let serviceReady = false
const rendererConsole = new RendererConsoleTail()

const messages = () => messagesFor(localeId)
const labels = () => labelsFor(localeId)
// 退出确认前会问一次 Host（走它自己的 session/list），拿不到再退回投影缓存
const activityProbe = createActivityProbe({ url: () => (server && server.url) || null })

function showMessageBox(options) {
  return dialog.showMessageBox(options)
}

function showMessageBoxForWindow(options) {
  if (win && !win.isDestroyed()) return dialog.showMessageBox(win, options)
  return dialog.showMessageBox(options)
}

function notify(title, body) {
  if (!Notification.isSupported()) return
  try {
    new Notification({ title, body, icon: ICON_FILE }).show()
  } catch {
    /* 通知不可用不影响使用 */
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function relaunchCommand() {
  if (process.env.APPIMAGE) return process.env.APPIMAGE
  if (app.isPackaged) return process.execPath
  return null
}

function appFacts() {
  return {
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    node: process.versions.node,
    locale: localeId,
  }
}

function reportFatal(error, source) {
  if (!fatalRecovery) {
    console.error('fatal failure before recovery was ready', error)
    return
  }
  void fatalRecovery.report(error, source)
}

function dshVersion() {
  if (cachedDshVersion) return cachedDshVersion
  const dshPath = findDsh()
  if (!dshPath) return ''
  try {
    cachedDshVersion = execFileSync(dshPath, ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    cachedDshVersion = ''
  }
  return cachedDshVersion
}

function dshVersionText() {
  const dshPath = findDsh()
  if (!dshPath) return labels().stateStopped
  return `${dshVersion() || '?'}（${dshPath}）`
}

function updateTrayMenu() {
  if (!tray) return
  const m = messages()
  const l = labels()
  const running = Boolean(server && server.running)
  tray.setToolTip(m.aboutProduct)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: m.openApplication, click: () => showWindow() },
      { type: 'separator' },
      { label: `${l.serviceState}: ${running ? l.stateRunning : l.stateStopped}`, enabled: false },
      { label: l.restartService, click: () => void restartServer() },
      { label: l.openServiceLog, click: () => void shell.openPath(LOG_FILE) },
      { type: 'separator' },
      {
        label: l.autostart,
        type: 'checkbox',
        checked: autostart.isEnabled(),
        click: (item) => toggleAutostart(Boolean(item.checked)),
      },
      { type: 'separator' },
      { label: m.quitApplication, click: () => app.quit() },
    ]),
  )
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON_FILE).resize({ width: 22, height: 22 }))
  } catch (error) {
    console.warn('desktop tray: unavailable', error)
    tray = null
    return
  }
  updateTrayMenu()
  tray.on('click', () => showWindow())
}

function toggleAutostart(enable) {
  const l = labels()
  try {
    if (enable) {
      autostart.enable(relaunchCommand())
      notify(APP_NAME, l.autostartOn)
    } else {
      autostart.disable()
      notify(APP_NAME, l.autostartOff)
    }
  } catch (error) {
    void showMessageBoxForWindow({
      type: 'warning',
      title: APP_NAME,
      message: l.autostartUnavailable,
      detail: String((error && error.message) || error),
      buttons: [l.ok],
    })
  }
  updateTrayMenu()
}

function installMenu() {
  const m = messages()
  const l = labels()
  const devToolsItems = [
    { role: 'toggleDevTools', visible: false },
    { role: 'toggleDevTools', visible: false, accelerator: 'F12' },
  ]
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: m.application,
        submenu: [
          { label: m.aboutMenu, click: () => void showAbout() },
          { type: 'separator' },
          { label: m.checkUpdatesMenu, click: () => void runUpdateCheck() },
          { label: m.cliCommandMenu, click: () => void openCommandManager() },
          { type: 'separator' },
          { label: l.restartService, click: () => void restartServer() },
          {
            label: m.reloadPageMenu,
            click: () => {
              if (win && !win.isDestroyed()) win.webContents.reload()
            },
          },
          { label: l.openServiceLog, click: () => void shell.openPath(LOG_FILE) },
          { type: 'separator' },
          { label: m.exitApplication, click: () => app.quit() },
          ...devToolsItems,
        ],
      },
      { role: 'editMenu' },
    ]),
  )
  updateTrayMenu()
}

function showAbout() {
  const l = labels()
  return showMessageBoxForWindow({
    type: 'info',
    title: l.aboutTitle,
    message: `${APP_NAME} ${app.getVersion()}`,
    detail: [
      format(l.appVersion, { version: app.getVersion() }),
      format(l.dshVersion, { version: dshVersionText() }),
      `Electron ${process.versions.electron} / Node ${process.versions.node} / Chromium ${process.versions.chrome}`,
      '',
      `${l.openProjectPage}: https://github.com/deepseek-ai/deepseek-harness`,
    ].join('\n'),
    buttons: [l.ok],
  })
}

async function runUpdateCheck() {
  const l = labels()
  const installed = dshVersion()
  if (!installed) {
    await showMessageBoxForWindow({
      type: 'error',
      title: l.dshMissingTitle,
      message: l.dshMissingTitle,
      detail: l.dshMissingBody,
      buttons: [l.ok],
    })
    return { status: 'missing' }
  }
  const result = await checkForUpdates({
    dialog: { showMessageBox: (target, options) => (options ? dialog.showMessageBox(target, options) : dialog.showMessageBox(target)) },
    window: win && !win.isDestroyed() ? win : undefined,
    messages: messages(),
    localeId,
    installedVersion: installed,
    latest: fetchLatestVersion,
    upgrade: upgradeDsh,
    restart: async () => {
      cachedDshVersion = null
      await restartServer()
    },
  })
  return result
}

async function openCommandManager() {
  await commandManagement.showCommandManager({
    dialog: {
      showMessageBox: (target, options) =>
        target && !target.isDestroyed() ? dialog.showMessageBox(target, options) : dialog.showMessageBox(options),
    },
    window: win && !win.isDestroyed() ? win : undefined,
    messages: messages(),
  })
}

function createWindow() {
  win = new BrowserWindow(
    Object.assign({}, WINDOW_BOUNDS, {
      title: APP_NAME,
      icon: ICON_FILE,
      show: false,
      backgroundColor: '#101418',
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    }),
  )

  win.loadURL(SPLASH_HTML)
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (windowOpenDecision(url) === 'external') void shell.openExternal(url)
    return { action: 'deny' }
  })
  // 只有应用自己的来源留在窗口里；外链交给系统浏览器，其它协议拦掉
  win.webContents.on('will-navigate', (event, url) => {
    const decision = navigationDecision(win.webContents.getURL(), url)
    if (decision === 'allow') return
    event.preventDefault()
    if (decision === 'external') void shell.openExternal(url)
  })
  // 右键菜单：Electron 默认不提供，这里按上游补上编辑/复制
  win.webContents.on('context-menu', (_event, params) => {
    const template = contextMenuTemplate({
      isEditable: Boolean(params && params.isEditable),
      selectionText: params && params.selectionText,
      editFlags: (params && params.editFlags) || {},
      messages: messages(),
    })
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: win })
  })
  // 渲染进程的错误级日志留给崩溃报告
  win.webContents.on('console-message', (details) => {
    if (!details || details.level !== 'error') return
    rendererConsole.push(`${details.sourceId}:${String(details.lineNumber)} ${details.message}`)
  })
  // 关闭即隐藏：页面与 Host 继续运行，下次显示时还是同一个文档。
  win.on('close', (event) => {
    if (quitting || sessionEnding) return
    event.preventDefault()
    const hide = () => {
      if (!quitting && !sessionEnding && win && !win.isDestroyed()) win.hide()
    }
    if (!tray) {
      // 没有托盘就没有回到窗口的入口，只能直接退出
      quitting = true
      app.quit()
      return
    }
    backgroundNotice.close(hide)
  })
}

function inspectForQuit() {
  if (!server || !server.running) return undefined
  return withDeadline(activityProbe(), PROBE_DEADLINE_MS, 'unknown')
}

async function startServer() {
  const l = labels()
  const dshPath = findDsh()
  if (!dshPath) {
    await showMessageBoxForWindow({
      type: 'error',
      title: l.dshMissingTitle,
      message: l.dshMissingTitle,
      detail: l.dshMissingBody,
      buttons: [l.ok],
    })
    updateTrayMenu()
    return false
  }

  server = new DshServer({ dshPath, logFile: LOG_FILE })
  server.on('exit', ({ code, signal }) => {
    serviceReady = false
    updateTrayMenu()
    if (quitting) return
    const reason = code === null ? signal : code
    reportFatal(new Error(`dsh web exited (${reason})\n${server ? server.tailText : ''}`), 'host')
  })

  try {
    const started = await server.start()
    serviceReady = true
    updateTrayMenu()
    if (win && !win.isDestroyed()) await win.loadURL(started.url)
    return true
  } catch (error) {
    updateTrayMenu()
    reportFatal(error, 'host')
    return false
  }
}

async function restartServer() {
  if (server) await server.stop()
  await startServer()
  showWindow()
}

function finishQuit() {
  if (quitting) return
  quitting = true
  if (quitConfirmation) quitConfirmation.dispose()
  if (backgroundNotice) backgroundNotice.dispose()
  if (tray) {
    tray.destroy()
    tray = null
  }
  const done = () => app.quit()
  if (server && server.running) server.stop().finally(done)
  else done()
}

async function boot() {
  localeId = app.getLocale()
  logsDir = app.getPath('logs')
  void pruneCrashReports(logsDir)
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
  } catch {
    /* 状态目录写不进去时日志会退化为不可写，但不影响启动 */
  }

  fatalRecovery = new FatalRecovery({
    messages,
    show: (options) => showMessageBox(options),
    stop: async () => {
      if (server) await server.stop()
    },
    disablePlugins: async () => disableProfilePatches(),
    exit: () => app.exit(1),
    restart: () => {
      app.relaunch()
      app.exit(0)
    },
    writeReport: (error, source) =>
      writeCrashReport(logsDir, {
        source,
        phase: serviceReady ? 'running' : 'startup',
        error,
        rendererConsole: rendererConsole.snapshot(),
        app: appFacts(),
        time: new Date(),
      }),
  })
  process.on('uncaughtException', (error) => reportFatal(error, 'main'))
  process.on('unhandledRejection', (reason) =>
    reportFatal(reason instanceof Error ? reason : new Error(String(reason)), 'main'),
  )

  backgroundNotice = new BackgroundNotice({
    markerPath: path.join(app.getPath('userData'), 'background-close-confirmed'),
    messages,
    show: (options) => showMessageBox(options),
    focus: () => showWindow(),
  })
  quitConfirmation = new QuitConfirmation({
    messages,
    inspect: inspectForQuit,
    show: (options) => showMessageBox(options),
    focus: () => showWindow(),
  })

  if (powerMonitor && typeof powerMonitor.on === 'function') {
    // 关机 / 注销不能等确认框
    powerMonitor.on('shutdown', () => {
      sessionEnding = true
    })
  }

  installMenu()
  createWindow()
  createTray()
  await startServer()
  app.on('activate', () => showWindow())
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.setName(APP_NAME)

  app.on('second-instance', () => showWindow())

  app.on('window-all-closed', () => {
    // 关闭窗口不等于退出：只有显式退出才结束进程
  })

  app.on('before-quit', (event) => {
    if (quitting) return
    event.preventDefault()
    if (sessionEnding) {
      finishQuit()
      return
    }
    void quitConfirmation
      .confirm()
      .then((approved) => {
        if (approved) finishQuit()
      })
      .catch((error) => {
        console.error('desktop quit: confirmation failed', error)
        finishQuit()
      })
  })

  void app.whenReady().then(boot)
}
