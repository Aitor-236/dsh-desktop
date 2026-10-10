'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  inspectCommand,
  installCommand,
  linkTarget,
  loginShellCommand,
  presentCommand,
  removeCommand,
} = require('../src/command-management')
const { messagesFor } = require('../src/locale')

const messages = messagesFor('zh-CN')

function tempExecutable() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmd-target-'))
  const file = path.join(dir, 'dsh')
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return file
}

function tempDestination() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-cmd-dest-')), 'bin', 'dsh')
}

test('未安装时的状态与按钮（安装 / 取消）', () => {
  const destination = tempDestination()
  const state = inspectCommand({ destination, target: tempExecutable() })
  assert.equal(state.managed, false)
  const dialog = presentCommand(state, messages)
  assert.equal(dialog.message, messages.cliCommandNotInstalled)
  assert.deepEqual(dialog.buttons, [messages.cliCommandInstall, messages.cancel])
  assert.equal(dialog.cancelId, 1)
  assert.match(dialog.detail, /Desktop 命令：/)
})

test('安装后是托管状态，并可用移除撤销', () => {
  const destination = tempDestination()
  const target = tempExecutable()
  const installed = installCommand({ destination, target })
  assert.equal(installed.changed, true)
  assert.equal(linkTarget(destination), target)

  const state = inspectCommand({ destination, target })
  assert.equal(state.managed, true)
  assert.equal(state.available, true)
  const dialog = presentCommand(state, messages)
  assert.equal(dialog.message, messages.cliCommandInstalled)
  assert.deepEqual(dialog.buttons, [
    messages.cliCommandClose,
    messages.cliCommandRepair,
    messages.cliCommandRemove,
  ])
  assert.equal(dialog.cancelId, 0)

  assert.equal(removeCommand({ destination }).changed, true)
  assert.equal(fs.existsSync(destination), false)
  assert.equal(removeCommand({ destination }).reason, 'absent')
})

test('目标不存在时视为坏链，提示修复', () => {
  const destination = tempDestination()
  const target = path.join(path.dirname(tempExecutable()), 'gone')
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.symlinkSync(target, destination)
  const state = inspectCommand({ destination })
  assert.equal(state.managed, true)
  assert.equal(state.available, false)
  assert.equal(presentCommand(state, messages).message, messages.cliCommandBroken)
})

test('别的 dsh 抢占时给出警告与说明', () => {
  const destination = tempDestination()
  const target = tempExecutable()
  installCommand({ destination, target })
  const other = path.join(path.dirname(target), 'other-dsh')
  fs.writeFileSync(other, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  const state = inspectCommand({ destination, target, activeCommand: other })
  const dialog = presentCommand(state, messages)
  assert.equal(dialog.type, 'warning')
  assert.match(dialog.detail, /另一个 dsh 的优先级更高/)
})

test('目标位置已有普通文件时拒绝安装，不覆盖用户文件', () => {
  const destination = tempDestination()
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, 'mine')
  assert.throws(() => installCommand({ destination, target: tempExecutable() }), /已有同名文件/)
  assert.equal(fs.readFileSync(destination, 'utf8'), 'mine')
  assert.equal(removeCommand({ destination }).reason, 'foreign')
})

test('登录 shell 查询结果解析', async () => {
  const run = async () => ({ stdout: 'banner\0DSH_COMMAND\0/usr/local/bin/dsh\0trailer' })
  assert.deepEqual(await loginShellCommand({ shell: '/bin/bash', run }), {
    activeCommand: '/usr/local/bin/dsh',
  })

  const empty = async () => ({ stdout: '\0DSH_COMMAND\0\0' })
  assert.deepEqual(await loginShellCommand({ shell: '/bin/bash', run: empty }), {})

  const broken = async () => {
    throw new Error('no shell')
  }
  assert.deepEqual(await loginShellCommand({ shell: '/bin/bash', run: broken }), {
    selectionUnknown: true,
  })

  // 没有可用 shell（os.userInfo().shell 为空）时同样按"无法确认"处理
  assert.deepEqual(await loginShellCommand({ shell: null, run: broken }), { selectionUnknown: true })
})
