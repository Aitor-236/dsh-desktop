'use strict'

/** 通过 XDG autostart 管理"开机自启"（GNOME 登录时拉起本应用）。 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const APP_ID = 'dsh-desktop'

function autostartDir() {
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart')
}

function autostartFile() {
  return path.join(autostartDir(), `${APP_ID}.desktop`)
}

function isEnabled() {
  try {
    return fs.statSync(autostartFile()).isFile()
  } catch {
    return false
  }
}

/**
 * @param {string} execLine 重新启动本应用所需命令（打包后为 AppImage 或可执行文件路径）
 * @param {string} name 显示名
 */
function enable(execLine, name = 'DeepSeek Harness') {
  if (!execLine) throw new Error('当前运行方式无法生成自启命令（开发模式下请用打包版本再开启）')
  fs.mkdirSync(autostartDir(), { recursive: true })
  const content = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    'Comment=登录时启动 DeepSeek Harness 桌面端',
    `Exec=${execLine}`,
    'Terminal=false',
    'Hidden=false',
    'NoDisplay=true',
    'X-GNOME-Autostart-enabled=true',
    'X-GNOME-Autostart-Delay=5',
    '',
  ].join('\n')
  fs.writeFileSync(autostartFile(), content, { mode: 0o644 })
}

function disable() {
  try {
    fs.unlinkSync(autostartFile())
  } catch {
    /* 已经不存在 */
  }
}

module.exports = { APP_ID, autostartFile, isEnabled, enable, disable }
