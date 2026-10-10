'use strict'

/**
 * “管理 dsh 命令…”：把 dsh 注册成终端命令，并报告是否有别的 dsh 抢占。
 * 上游只在 macOS/Windows 提供（写入 /usr/local/bin 或用户 PATH），这里是 Linux 版：
 * 固定安装到 ~/.local/bin/dsh 符号链接（该目录已在用户 PATH 中，无需 sudo）。
 */

const { execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { promisify } = require('node:util')

const { findDsh } = require('./supervisor')

class CommandInstallationError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function defaultDestination(env = process.env) {
  return env.DSH_COMMAND_DESTINATION || path.join(os.homedir(), '.local', 'bin', 'dsh')
}

function isExecutable(file) {
  if (!file) return false
  try {
    fs.accessSync(file, fs.constants.X_OK)
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** 读取符号链接目标；不是符号链接返回 undefined。 */
function linkTarget(destination) {
  try {
    return fs.lstatSync(destination).isSymbolicLink() ? fs.readlinkSync(destination) : undefined
  } catch {
    return undefined
  }
}

/** 在登录 shell 里问一次 command -v dsh，与上游一致（用户 rc 里的别名与顺序都会被考虑）。 */
async function loginShellCommand({ shell = os.userInfo().shell, run = promisify(execFile) } = {}) {
  if (!shell) return { selectionUnknown: true }
  const script = "printf '\\0DSH_COMMAND\\0'; command -v dsh; printf '\\0'"
  try {
    const { stdout } = await run(shell, ['-ilc', script], { timeout: 5000, maxBuffer: 65536 })
    const value = String(stdout).split('\0DSH_COMMAND\0')[1]?.split('\0')[0]?.trim()
    if (value === undefined) return { selectionUnknown: true }
    if (value === '') return {}
    return path.isAbsolute(value) && !/[\r\n]/.test(value)
      ? { activeCommand: value }
      : { selectionUnknown: true }
  } catch {
    return { selectionUnknown: true }
  }
}

/**
 * 观察当前安装状态。
 * @returns {{managed: boolean, available: boolean, destination: string, target?: string,
 *   activeCommand?: string, selectionUnknown?: boolean}}
 */
function inspectCommand({ destination = defaultDestination(), activeCommand, selectionUnknown, target } = {}) {
  const link = linkTarget(destination)
  const managed = link !== undefined
  const available = isExecutable(destination)
  const resolved = target || findDsh(process.env, { exclude: [destination] }) || undefined
  const state = { managed, available, destination }
  if (resolved) state.target = resolved
  if (activeCommand !== undefined) state.activeCommand = activeCommand
  if (selectionUnknown) state.selectionUnknown = true
  // 坏链：目标已不存在，把原本指向哪里也报出来
  if (managed && !available && link !== undefined) state.target = link
  return state
}

function installCommand({ destination = defaultDestination(), target } = {}) {
  if (!target) throw new CommandInstallationError('ENOTARGET', '找不到可用的 dsh 目标。')
  if (!isExecutable(target)) {
    throw new CommandInstallationError('ENOTARGET', `目标不是可执行文件：${target}`)
  }
  const link = linkTarget(destination)
  let existing
  try {
    existing = fs.lstatSync(destination)
  } catch {
    existing = undefined
  }
  if (existing && !existing.isSymbolicLink()) {
    throw new CommandInstallationError('EEXIST', `目标位置已有同名文件：${destination}`)
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  if (link !== target) {
    if (existing) fs.unlinkSync(destination)
    fs.symlinkSync(target, destination)
  }
  return { changed: link !== target, destination, target }
}

function removeCommand({ destination = defaultDestination() } = {}) {
  let stat
  try {
    stat = fs.lstatSync(destination)
  } catch {
    return { changed: false, reason: 'absent' }
  }
  if (!stat.isSymbolicLink()) return { changed: false, reason: 'foreign' }
  fs.unlinkSync(destination)
  return { changed: true, destination }
}

function format(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
}

/** 组装对话框；按钮顺序与上游一致（已安装：[关闭, 修复, 移除]，未安装：[安装, 取消]）。 */
function presentCommand(state, messages) {
  const other =
    state.activeCommand !== undefined &&
    path.normalize(state.activeCommand) !== path.normalize(state.destination)
  const detail = [
    format(messages.cliCommandLocation, { path: state.destination }),
    ...(state.activeCommand === undefined
      ? []
      : [format(messages.cliCommandSelected, { path: state.activeCommand })]),
    ...(state.target === undefined ? [] : [format(messages.cliCommandTarget, { path: state.target })]),
    ...(other ? [messages.cliCommandShadowed] : []),
    ...(state.selectionUnknown ? [messages.cliCommandSelectionUnknown] : []),
  ].join('\n\n')
  return {
    type: other ? 'warning' : 'info',
    title: messages.cliCommandTitle,
    message: state.managed
      ? state.available
        ? messages.cliCommandInstalled
        : messages.cliCommandBroken
      : messages.cliCommandNotInstalled,
    detail,
    buttons: state.managed
      ? [messages.cliCommandClose, messages.cliCommandRepair, messages.cliCommandRemove]
      : [messages.cliCommandInstall, messages.cancel],
    defaultId: 0,
    cancelId: state.managed ? 0 : 1,
  }
}

/** 菜单入口：显示状态并允许安装/修复/移除，直到用户关闭。 */
async function showCommandManager({ dialog, window, messages, destination = defaultDestination() }) {
  for (let round = 0; round < 5; round += 1) {
    const shell = await loginShellCommand()
    const state = inspectCommand(Object.assign({ destination }, shell))
    const answer = await dialog.showMessageBox(window, presentCommand(state, messages))

    if (state.managed) {
      if (answer.response === 0) return { action: 'close', state }
      if (answer.response === 2) {
        const removed = removeCommand({ destination })
        if (removed.changed) {
          await dialog.showMessageBox(window, {
            type: 'info',
            title: messages.cliCommandTitle,
            message: messages.cliCommandRemoved,
            detail: messages.cliCommandNewTerminal,
            buttons: [messages.cliCommandClose],
          })
          return { action: 'remove', state }
        }
        await dialog.showMessageBox(window, {
          type: 'warning',
          title: messages.cliCommandTitle,
          message: messages.cliCommandOwnershipError,
          buttons: [messages.cliCommandClose],
        })
        continue
      }
      try {
        installCommand({ destination, target: findDsh(process.env, { exclude: [destination] }) })
      } catch (error) {
        await dialog.showMessageBox(window, {
          type: 'error',
          title: messages.cliCommandTitle,
          message: messages.cliCommandFailed,
          detail: String((error && error.message) || error),
          buttons: [messages.cliCommandClose],
        })
        return { action: 'failed', state }
      }
      continue
    }

    if (answer.response === 1) return { action: 'cancel', state }
    try {
      installCommand({ destination, target: state.target })
      await dialog.showMessageBox(window, {
        type: 'info',
        title: messages.cliCommandTitle,
        message: messages.cliCommandInstalled,
        detail: messages.cliCommandNewTerminal,
        buttons: [messages.cliCommandClose],
      })
      return { action: 'install', state }
    } catch (error) {
      await dialog.showMessageBox(window, {
        type: 'error',
        title: messages.cliCommandTitle,
        message: messages.cliCommandFailed,
        detail: String((error && error.message) || error),
        buttons: [messages.cliCommandClose],
      })
      return { action: 'failed', state }
    }
  }
  return { action: 'exhausted' }
}

module.exports = {
  CommandInstallationError,
  defaultDestination,
  inspectCommand,
  installCommand,
  linkTarget,
  loginShellCommand,
  presentCommand,
  removeCommand,
  showCommandManager,
}
