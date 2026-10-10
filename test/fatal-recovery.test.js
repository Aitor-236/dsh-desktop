'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { FatalRecovery, dialogDetail, errorState } = require('../src/fatal-recovery')
const { messagesFor } = require('../src/locale')

const messages = messagesFor('zh-CN')

function operations(overrides = {}) {
  const calls = { shown: [], stopped: 0, disabled: 0, exited: 0, restarted: 0, reports: [] }
  const base = {
    messages: () => messages,
    show: async (options) => {
      calls.shown.push(options)
      return { response: 0 }
    },
    stop: async () => {
      calls.stopped += 1
    },
    disablePlugins: async () => {
      calls.disabled += 1
      return []
    },
    exit: () => {
      calls.exited += 1
    },
    restart: () => {
      calls.restarted += 1
    },
    writeReport: async () => '/tmp/crash.log',
    ...overrides,
  }
  return { calls, operations: base }
}

test('AggregateError 会被摊平成多行消息', () => {
  const error = new AggregateError([new Error('first'), new Error('second')], 'both failed')
  assert.equal(errorState(error), 'both failed\nfirst\nsecond')
  assert.equal(errorState('plain'), 'plain')
})

test('detail 只保留错误尾部并附上报告路径与重装建议', () => {
  const long = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\n')
  const detail = dialogDetail(long, messages, '/tmp/crash.log')
  assert.match(detail, /line 19$|line 19\n/)
  assert.ok(!detail.includes('line 0'))
  assert.match(detail, /诊断报告：\/tmp\/crash\.log/)
  assert.match(detail, /重新安装/)
  assert.match(detail, /错误详情已截短/)
})

test('普通致命错误给三个按钮，选择退出会先停服务', async () => {
  const { calls, operations: ops } = operations()
  const recovery = new FatalRecovery(ops)
  await recovery.report(new Error('boom'), 'host')
  assert.equal(calls.shown.length, 1)
  assert.deepEqual(calls.shown[0].buttons, [
    messages.exitApplication,
    messages.restartApplication,
    messages.disableThirdPartyPlugins,
  ])
  assert.equal(calls.shown[0].title, messages.startupFailed)
  assert.equal(calls.stopped, 1)
  assert.equal(calls.exited, 1)
  assert.equal(calls.restarted, 0)
})

test('选择重启会先停服务再重启', async () => {
  const { calls, operations: ops } = operations({ show: async () => ({ response: 1 }) })
  await new FatalRecovery(ops).report(new Error('boom'), 'host')
  assert.equal(calls.stopped, 1)
  assert.equal(calls.restarted, 1)
  assert.equal(calls.exited, 0)
})

test('第三个按钮会备份 profile patch 后重启', async () => {
  const { calls, operations: ops } = operations({ show: async () => ({ response: 2 }) })
  await new FatalRecovery(ops).report(new Error('plugin exploded'), 'host')
  assert.equal(calls.disabled, 1)
  assert.equal(calls.restarted, 1)
})

test('端口占用时换成专用文案且只有两个按钮', async () => {
  const { calls, operations: ops } = operations()
  await new FatalRecovery(ops).report(new Error('listen EADDRINUSE: address already in use 127.0.0.1:3080'), 'host')
  assert.deepEqual(calls.shown[0].buttons, [messages.exitApplication, messages.restartApplication])
  assert.match(calls.shown[0].detail, /有其他正在运行的 DSH/)
})

test('同一进程只处理第一次故障', async () => {
  const { calls, operations: ops } = operations()
  const recovery = new FatalRecovery(ops)
  await recovery.report(new Error('first'), 'host')
  await recovery.report(new Error('second'), 'main')
  assert.equal(calls.shown.length, 1)
  assert.equal(recovery.active, true)
})

test('报告写入超时不阻塞对话框', async () => {
  const { calls, operations: ops } = operations({
    writeReport: () => new Promise(() => {}),
  })
  await new FatalRecovery(ops).report(new Error('slow report'), 'host')
  assert.equal(calls.shown.length, 1)
  assert.ok(!calls.shown[0].detail.includes('诊断报告：'))
})
