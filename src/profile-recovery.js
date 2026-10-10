'use strict'

/**
 * “禁用第三方插件…”按钮的实现：把用户自己的 profile patch 层备份改名，
 * 让 dsh 下次按 shipped 模板启动（上游把这一动作描述为
 * "Disable third-party plugins, back up profile patch, and restart"）。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** 用户可改的两层 patch：per-profile 与 home-level（后者优先级更高）。 */
const PATCH_RELATIVE_PATHS = [
  path.join('profiles', 'web', 'cordis.patch.yml'),
  'cordis.patch.yml',
]

function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

/**
 * @returns {string[]} 被改名备份的文件路径（按原顺序）
 */
function disableProfilePatches({ home = dshHome(), now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const moved = []
  for (const relative of PATCH_RELATIVE_PATHS) {
    const file = path.join(home, relative)
    if (!fs.existsSync(file)) continue
    const backup = `${file}.disabled-${stamp}`
    fs.renameSync(file, backup)
    moved.push(backup)
  }
  return moved
}

module.exports = { PATCH_RELATIVE_PATHS, disableProfilePatches, dshHome }
