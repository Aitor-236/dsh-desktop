'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { BackgroundNotice } = require('../src/background-notice')
const { messagesFor } = require('../src/locale')

const messages = () => messagesFor('zh-CN')

function tempMarker() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-notice-')), 'background-close-confirmed')
}

test('首次关闭：提示确认后才隐藏并写标记', async () => {
  const markerPath = tempMarker()
  const shown = []
  const notice = new BackgroundNotice({
    markerPath,
    messages,
    show: async (options) => {
      shown.push(options)
      return { response: 0 }
    },
    focus: () => {},
  })
  let hidden = 0
  notice.close(() => {
    hidden += 1
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(hidden, 1)
  assert.equal(fs.existsSync(markerPath), true, '应写入 background-close-confirmed 标记')
  assert.equal(shown[0].message, '正在运行的任务不会中断，可在系统托盘中重新打开窗口')
  assert.deepEqual(shown[0].buttons, ['确认'])
  assert.equal(shown[0].cancelId, -1)
})

test('已有标记时直接隐藏，不再提示', async () => {
  const markerPath = tempMarker()
  fs.writeFileSync(markerPath, '')
  let shown = 0
  const notice = new BackgroundNotice({
    markerPath,
    messages,
    show: async () => {
      shown += 1
      return { response: 0 }
    },
    focus: () => {},
  })
  let hidden = 0
  notice.close(() => {
    hidden += 1
  })
  assert.equal(hidden, 1)
  assert.equal(shown, 0)
})

test('确认框返回非 0 时不隐藏、不写标记', async () => {
  const markerPath = tempMarker()
  const notice = new BackgroundNotice({
    markerPath,
    messages,
    show: async () => ({ response: 1 }),
    focus: () => {},
  })
  let hidden = 0
  notice.close(() => {
    hidden += 1
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(hidden, 0)
  assert.equal(fs.existsSync(markerPath), false)
})

test('重复请求会聚焦而不是叠加更多提示', async () => {
  const markerPath = tempMarker()
  let shown = 0
  let focused = 0
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const notice = new BackgroundNotice({
    markerPath,
    messages,
    show: async () => {
      shown += 1
      await gate
      return { response: 0 }
    },
    focus: () => {
      focused += 1
    },
  })
  notice.close(() => {})
  notice.close(() => {})
  release()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(shown, 1)
  assert.equal(focused, 1)
})

test('dispose 之后不再提示也不再隐藏', async () => {
  const markerPath = tempMarker()
  const notice = new BackgroundNotice({
    markerPath,
    messages,
    show: async () => ({ response: 0 }),
    focus: () => {},
  })
  notice.dispose()
  let hidden = 0
  notice.close(() => {
    hidden += 1
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(hidden, 0)
})
