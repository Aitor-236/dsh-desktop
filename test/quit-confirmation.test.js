'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { QuitConfirmation, resolveQuitPrompt } = require('../src/quit-confirmation')
const { messagesFor } = require('../src/locale')

const messages = () => messagesFor('zh-CN')

function confirmation({ inspect, show, focus = () => {} }) {
  return new QuitConfirmation({ messages, inspect, show, focus })
}

test('退出提示的选择规则与上游一致', () => {
  assert.equal(resolveQuitPrompt(undefined), undefined)
  assert.equal(resolveQuitPrompt({ activeTasks: false, scheduledTasks: false }), undefined)
  assert.equal(resolveQuitPrompt({ activeTasks: true, scheduledTasks: false }), 'quitActiveTasks')
  assert.equal(resolveQuitPrompt({ activeTasks: false, scheduledTasks: true }), 'quitScheduledTasks')
  assert.equal(
    resolveQuitPrompt({ activeTasks: true, scheduledTasks: true }),
    'quitActiveAndScheduledTasks',
  )
  // 探测失败或超时 → 当作有任务在跑
  assert.equal(resolveQuitPrompt('unknown'), 'quitActiveTasks')
})

test('没有 Host 在跑时静默退出（不弹框）', async () => {
  let shown = 0
  const quit = confirmation({
    inspect: () => undefined,
    show: async () => {
      shown += 1
      return { response: 0 }
    },
  })
  assert.equal(await quit.confirm(), true)
  assert.equal(shown, 0)
})

test('没有任务在跑时静默退出', async () => {
  let shown = 0
  const quit = confirmation({
    inspect: async () => ({ activeTasks: false, scheduledTasks: false }),
    show: async () => {
      shown += 1
      return { response: 0 }
    },
  })
  assert.equal(await quit.confirm(), true)
  assert.equal(shown, 0)
})

test('有任务在跑时弹确认框，取消则不退出', async () => {
  const seen = []
  const quit = confirmation({
    inspect: async () => ({ activeTasks: true, scheduledTasks: false }),
    show: async (options) => {
      seen.push(options)
      return { response: 1 }
    },
  })
  assert.equal(await quit.confirm(), false)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].message, '退出 DeepSeek Harness？')
  assert.deepEqual(seen[0].buttons, ['退出', '取消'])
  assert.equal(seen[0].cancelId, 1)
  assert.equal(seen[0].detail, '当前正在运行的任务将会中断')
})

test('确认框打开期间重复请求会并入同一个决定', async () => {
  let shown = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const quit = confirmation({
    inspect: async () => ({ activeTasks: true, scheduledTasks: false }),
    show: async () => {
      shown += 1
      await gate
      return { response: 0 }
    },
  })
  const first = quit.confirm()
  const second = quit.confirm()
  release()
  assert.equal(await first, true)
  assert.equal(await second, true)
  assert.equal(shown, 1)
})

test('探测抛错时按 unknown 处理（弹框）', async () => {
  let shown = 0
  const quit = confirmation({
    inspect: async () => {
      throw new Error('boom')
    },
    show: async () => {
      shown += 1
      return { response: 0 }
    },
  })
  assert.equal(await quit.confirm(), true)
  assert.equal(shown, 1)
})

test('dispose 后不再弹框，也不再放行', async () => {
  const quit = confirmation({
    inspect: async () => ({ activeTasks: true, scheduledTasks: false }),
    show: async () => ({ response: 0 }),
  })
  quit.dispose()
  assert.equal(await quit.confirm(), false)
})

test('真实活动探测与退出确认串起来：本地缓存显示在跑就会拦一次', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quit-'))
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'session-live.json'),
    JSON.stringify({ record: { rows: { turnBoundary: { val: { openTurnStartSeq: 1 } } } } }),
  )
  const { inspectActivity } = require('../src/activity')
  let shown = 0
  const quit = confirmation({
    inspect: async () => inspectActivity({ home }),
    show: async () => {
      shown += 1
      return { response: 0 }
    },
  })
  assert.equal(await quit.confirm(), true)
  assert.equal(shown, 1)
})
