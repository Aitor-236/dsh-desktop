'use strict'

/**
 * “检查更新…”：上游检查桌面应用自身的发布（electron-updater + 强制更新策略）。
 * 本移植版把这一入口用于 dsh 本体：对比 npm 上的最新版本，并可选一键升级 + 重启服务。
 */

const { execFile } = require('node:child_process')
const { promisify } = require('node:util')

const { format, labelsFor } = require('./labels')

const PACKAGE = '@deepseek-ai/dsh'

function parseVersion(value) {
  const [core, pre] = String(value).trim().replace(/^v/, '').split('-')
  return {
    numbers: core.split('.').map((part) => Number.parseInt(part, 10) || 0),
    pre: pre === undefined ? null : pre.split('.'),
  }
}

/** 预发布标识逐段比较：数字段比大小，数字段小于字母段，字母段按字典序。 */
function comparePrerelease(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const a = left[i]
    const b = right[i]
    if (a === undefined) return -1
    if (b === undefined) return 1
    const aNumeric = /^\d+$/.test(a)
    const bNumeric = /^\d+$/.test(b)
    if (aNumeric && bNumeric) {
      const x = Number.parseInt(a, 10)
      const y = Number.parseInt(b, 10)
      if (x !== y) return x < y ? -1 : 1
      continue
    }
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1
    if (a !== b) return a < b ? -1 : 1
  }
  return 0
}

/** semver 比较子集：返回 -1 / 0 / 1，预发布版本小于同号正式版。 */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  for (let i = 0; i < Math.max(a.numbers.length, b.numbers.length); i += 1) {
    const x = a.numbers[i] || 0
    const y = b.numbers[i] || 0
    if (x !== y) return x < y ? -1 : 1
  }
  if (a.pre === b.pre) return 0
  if (a.pre === null) return 1
  if (b.pre === null) return -1
  return comparePrerelease(a.pre, b.pre)
}

async function fetchLatestVersion({ timeoutMs = 20000, run = promisify(execFile) } = {}) {
  const { stdout } = await run('npm', ['view', PACKAGE, 'version'], {
    timeout: timeoutMs,
    maxBuffer: 1 << 20,
  })
  return String(stdout).trim()
}

async function upgradeDsh({ timeoutMs = 300000, run = promisify(execFile) } = {}) {
  await run('npm', ['i', '-g', `${PACKAGE}@latest`, '--no-fund', '--no-audit'], {
    timeout: timeoutMs,
    maxBuffer: 8 << 20,
  })
}

/**
 * 菜单入口实现：检查 → 询问 → 升级 → 重启服务。
 * @returns {Promise<{status: 'current'|'later'|'updated'|'error'|'failed', version?: string}>}
 */
async function checkForUpdates({
  dialog,
  window,
  messages,
  localeId,
  installedVersion,
  restart,
  latest = fetchLatestVersion,
  upgrade = upgradeDsh,
}) {
  const labels = labelsFor(localeId)
  let version
  try {
    version = await latest()
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: 'error',
      title: messages.updateCheckFailedTitle,
      message: messages.updateCheckFailed,
      detail: `${labels.noUpdateSource}\n\n${String((error && error.message) || error)}`,
      buttons: [labels.ok],
    })
    return { status: 'error' }
  }

  if (compareVersions(version, installedVersion) <= 0) {
    await dialog.showMessageBox(window, {
      type: 'info',
      title: messages.updateCheckTitle,
      message: messages.updateCurrent,
      detail: format(messages.updateCurrentDetail, { version: installedVersion }),
      buttons: [labels.ok],
    })
    return { status: 'current', version }
  }

  const answer = await dialog.showMessageBox(window, {
    type: 'info',
    title: messages.updateCheckTitle,
    message: format(messages.updateAvailable, { version }),
    detail: labels.updateDshDetail,
    buttons: [messages.installAndRestart, messages.later],
    defaultId: 0,
    cancelId: 1,
  })
  if (answer.response !== 0) return { status: 'later', version }

  try {
    await upgrade()
    if (restart) await restart()
  } catch (error) {
    await dialog.showMessageBox(window, {
      type: 'error',
      title: messages.updateCheckTitle,
      message: labels.updateFailed,
      detail: String((error && error.message) || error),
      buttons: [labels.ok],
    })
    return { status: 'failed', version }
  }

  await dialog.showMessageBox(window, {
    type: 'info',
    title: messages.updateCheckTitle,
    message: format(labels.updateDone, { version }),
    buttons: [labels.ok],
  })
  return { status: 'updated', version }
}

module.exports = { PACKAGE, checkForUpdates, compareVersions, fetchLatestVersion, parseVersion, upgradeDsh }
