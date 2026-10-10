'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { checkForUpdates, compareVersions, parseVersion } = require('../src/updates')
const { messagesFor } = require('../src/locale')

const messages = messagesFor('zh-CN')

function recorder(response) {
  const calls = []
  return {
    calls,
    dialog: {
      showMessageBox: async (first, second) => {
        const options = second === undefined ? first : second
        calls.push(options)
        return { response }
      },
    },
  }
}

test('版本比较覆盖预发布与补丁位', () => {
  assert.equal(compareVersions('0.2.0', '0.1.9'), 1)
  assert.equal(compareVersions('0.2.0-rc.2', '0.2.0'), -1)
  assert.equal(compareVersions('0.2.0-rc.10', '0.2.0-rc.2'), 1)
  assert.equal(compareVersions('v0.2.1', '0.2.1'), 0)
  assert.deepEqual(parseVersion('1.2.3-alpha.1').pre, ['alpha', '1'])
  assert.equal(compareVersions('0.2.1-alpha.2', '0.2.0-rc.2'), 1)
})

test('已是最新版本时只提示当前版本', async () => {
  const { calls, dialog } = recorder(0)
  const result = await checkForUpdates({
    dialog,
    window: undefined,
    messages,
    localeId: 'zh-CN',
    installedVersion: '0.2.0-rc.2',
    latest: async () => '0.2.0-rc.2',
  })
  assert.equal(result.status, 'current')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].message, messages.updateCurrent)
})

test('确认升级会升级 dsh 并重启服务', async () => {
  const { calls, dialog } = recorder(0)
  let upgraded = 0
  let restarted = 0
  const result = await checkForUpdates({
    dialog,
    window: undefined,
    messages,
    localeId: 'zh-CN',
    installedVersion: '0.2.0-rc.2',
    latest: async () => '0.2.1-alpha.2',
    upgrade: async () => {
      upgraded += 1
    },
    restart: async () => {
      restarted += 1
    },
  })
  assert.equal(result.status, 'updated')
  assert.equal(upgraded, 1)
  assert.equal(restarted, 1)
  // 第一次是询问，第二次是升级完成提示
  assert.equal(calls.length, 2)
  assert.equal(calls[0].buttons[0], messages.installAndRestart)
})

test('选择稍后则不升级', async () => {
  const { dialog } = recorder(1)
  let upgraded = 0
  const result = await checkForUpdates({
    dialog,
    window: undefined,
    messages,
    localeId: 'zh-CN',
    installedVersion: '0.2.0-rc.2',
    latest: async () => '0.3.0',
    upgrade: async () => {
      upgraded += 1
    },
  })
  assert.equal(result.status, 'later')
  assert.equal(upgraded, 0)
})

test('网络失败时给出可读提示', async () => {
  const { calls, dialog } = recorder(0)
  const result = await checkForUpdates({
    dialog,
    window: undefined,
    messages,
    localeId: 'zh-CN',
    installedVersion: '0.2.0-rc.2',
    latest: async () => {
      throw new Error('ENOTFOUND registry.npmjs.org')
    },
  })
  assert.equal(result.status, 'error')
  assert.equal(calls[0].message, messages.updateCheckFailed)
  assert.match(calls[0].detail, /npm registry/)
})

test('升级失败时报告失败且不再提示成功', async () => {
  const { calls, dialog } = recorder(0)
  const result = await checkForUpdates({
    dialog,
    window: undefined,
    messages,
    localeId: 'zh-CN',
    installedVersion: '0.2.0-rc.2',
    latest: async () => '0.3.0',
    upgrade: async () => {
      throw new Error('EACCES')
    },
  })
  assert.equal(result.status, 'failed')
  assert.equal(calls.length, 2)
  assert.match(calls[1].detail, /EACCES/)
})
