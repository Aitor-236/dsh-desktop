'use strict'

const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, shell } = require('electron')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DshServer, findDsh } = require('./supervisor')
const autostart = require('./autostart')

const APP_NAME = 'DeepSeek Harness'
const ICON_FILE = path.join(__dirname, '..', 'build', 'icon.png')
const STATE_DIR = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
  'dsh-desktop',
)
const CONFIG_FILE = path.join(
  process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
  'dsh-desktop',
  'config.json',
)
const LOG_FILE = path.join(STATE_DIR, 'server.log')

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
let stopInFlight = false
let cachedDshVersion = null

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'))
  } catch {
    return {}
  }
}

function writeConfig(patch) {
  const next = Object.assign({}, readConfig(), patch)
  try {
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true })
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  } catch {
    /* 配置写不进去不影响使用 */
  }
  return next
}

/** 打包运行时的自启命令：优先 AppImage 自身，其次是可执行文件。 */
function relaunchCommand() {
  if (process.env.APPIMAGE) return process.env.APPIMAGE
  if (app.isPackaged) return process.execPath
  return null
}

function notify(title, body) {
  if (!Notification.isSupported()) return
  try {
    new Notification({ title, body, icon: ICON_FILE }).show()
  } catch {
    /* 忽略 */
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function askCloseBehaviour() {
  const choice = dialog.showMessageBoxSync(win, {
    type: 'question',
    title: APP_NAME,
    message: '关闭窗口后要怎么做？',
    detail:
      '「后台运行」：窗口隐藏到托盘，正在跑的会话继续执行，点托盘图标可以重新打开。\n' +
      '「退出应用」：同时结束 dsh 服务，未完成的会话会中断。',
    buttons: ['后台运行（推荐）', '退出应用'],
    defaultId: 0,
    cancelId: 0,
    checkboxLabel: '记住我的选择，不再询问',
  })
  writeConfig({ closeToTray: choice === 0 })
  return choice === 0
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    title: APP_NAME,
    icon: ICON_FILE,
    show: false,
    backgroundColor: '#101418',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })

  win.loadURL(SPLASH_HTML)
  win.once('ready-to-show', () => win.show())
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('close', (event) => {
    if (quitting) return
    const config = readConfig()
    const toTray = config.closeToTray === undefined ? askCloseBehaviour() : Boolean(config.closeToTray)
    if (toTray) {
      event.preventDefault()
      win.hide()
      return
    }
    quitting = true
    app.quit()
  })
}

function updateTrayMenu() {
  if (!tray) return
  const running = Boolean(server && server.running)
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `打开 ${APP_NAME}`, click: showWindow },
      { type: 'separator' },
      { label: `服务状态：${running ? '运行中' : '未运行'}`, enabled: false },
      { label: '重启 dsh 服务', click: () => restartServer() },
      { label: '打开服务日志', click: () => shell.openPath(LOG_FILE) },
      { type: 'separator' },
      {
        label: '开机自启',
        type: 'checkbox',
        checked: autostart.isEnabled(),
        click: (item) => toggleAutostart(item.checked),
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true
          app.quit()
        },
      },
    ]),
  )
  tray.setToolTip(`${APP_NAME}（服务${running ? '运行中' : '未运行'}）`)
}

function createTray() {
  try {
    tray = new Tray(nativeImage.createFromPath(ICON_FILE).resize({ width: 22, height: 22 }))
  } catch {
    tray = null
    return
  }
  updateTrayMenu()
  tray.on('click', showWindow)
}

function toggleAutostart(enable) {
  try {
    if (enable) {
      autostart.enable(relaunchCommand())
      notify(APP_NAME, '已开启开机自启')
    } else {
      autostart.disable()
      notify(APP_NAME, '已关闭开机自启')
    }
  } catch (error) {
    dialog.showMessageBox({
      type: 'warning',
      title: APP_NAME,
      message: '设置开机自启失败',
      detail: String((error && error.message) || error),
    })
  }
  updateTrayMenu()
}

function dshVersionText() {
  if (cachedDshVersion) return cachedDshVersion
  const dshPath = findDsh()
  if (!dshPath) {
    cachedDshVersion = '未安装'
    return cachedDshVersion
  }
  try {
    cachedDshVersion = `${execFileSync(dshPath, ['--version'], { encoding: 'utf8' }).trim()}（${dshPath}）`
  } catch {
    cachedDshVersion = `未知（${dshPath}）`
  }
  return cachedDshVersion
}

function installMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: '视图',
        submenu: [
          { role: 'reload' },
          { role: 'forceReload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      {
        label: '帮助',
        submenu: [
          {
            label: `关于 ${APP_NAME}`,
            click: () =>
              dialog.showMessageBox({
                type: 'info',
                title: `关于 ${APP_NAME}`,
                message: `${APP_NAME} 桌面端 ${app.getVersion()}`,
                detail:
                  `Electron ${process.versions.electron} / Node ${process.versions.node}\n` +
                  `dsh：${dshVersionText()}\n` +
                  '基于 DeepSeek Harness（dsh）官方 Web GUI 的 Linux 桌面壳。',
                buttons: ['好'],
              }),
          },
          {
            label: 'DeepSeek Harness 项目主页',
            click: () => shell.openExternal('https://github.com/deepseek-ai/deepseek-harness'),
          },
        ],
      },
    ]),
  )
}

async function startServer() {
  const dshPath = findDsh()
  if (!dshPath) {
    dialog.showMessageBoxSync({
      type: 'error',
      title: APP_NAME,
      message: '找不到 dsh 命令',
      detail:
        '请先安装 dsh：\n\n    npm i -g @deepseek-ai/dsh\n\n' +
        '安装完成后，用托盘菜单里的「重启 dsh 服务」重试。',
      buttons: ['好'],
    })
    updateTrayMenu()
    return false
  }

  server = new DshServer({ dshPath, logFile: LOG_FILE })
  server.on('exit', ({ code, signal }) => {
    updateTrayMenu()
    if (quitting) return
    notify(`${APP_NAME} 服务已退出`, `dsh web（${code === null ? signal : code}）已停止，可从托盘菜单重启`)
  })

  try {
    const started = await server.start()
    updateTrayMenu()
    if (win && !win.isDestroyed()) await win.loadURL(started.url)
    return true
  } catch (error) {
    updateTrayMenu()
    dialog.showMessageBox({
      type: 'error',
      title: APP_NAME,
      message: 'dsh 服务启动失败',
      detail: `${String((error && error.message) || error).slice(0, 1500)}\n\n完整日志：${LOG_FILE}`,
      buttons: ['好'],
    })
    return false
  }
}

async function restartServer() {
  if (server) await server.stop()
  await startServer()
  showWindow()
}

const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.setName(APP_NAME)

  app.on('second-instance', () => showWindow())

  app.on('window-all-closed', () => {
    // 关闭窗口不等于退出：只有显式退出（托盘菜单或关闭对话框）才结束进程
  })

  app.on('before-quit', (event) => {
    quitting = true
    if (stopInFlight || !server || !server.running) return
    event.preventDefault()
    stopInFlight = true
    server.stop().finally(() => {
      stopInFlight = false
      app.quit()
    })
  })

  app.whenReady().then(async () => {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    } catch {
      /* 忽略 */
    }
    installMenu()
    createWindow()
    createTray()
    await startServer()
    app.on('activate', () => showWindow())
  })
}
