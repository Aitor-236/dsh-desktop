'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { activityFromProjection, inspectActivity, withDeadline } = require('../src/activity')

function writeProjection(home, session, rows) {
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${session}.json`),
    JSON.stringify({ record: { rows } }),
  )
}

test('openTurnStartSeq 非空 = 回合在跑', () => {
  const activity = activityFromProjection({
    record: { rows: { turnBoundary: { val: { openTurnStartSeq: 12 } } } },
  })
  assert.equal(activity.active, true)
  assert.equal(activity.turn, true)
})

test('排队消息、待回答问题、未结束步骤都算活动', () => {
  const queued = activityFromProjection({
    record: { rows: { inbox: { val: { 'next-turn': [{}, {}], 'next-step': [] } } } },
  })
  assert.equal(queued.queued, true)

  const waiting = activityFromProjection({
    record: { rows: { userQuestions: { val: { questions: { active: [{}], settled: [] } } } } },
  })
  assert.equal(waiting.waiting, true)

  const step = activityFromProjection({
    record: { rows: { sessionStats: { val: { openStep: 3, pendingCalls: 0 } } } },
  })
  assert.equal(step.step, true)
})

test('空闲会话不算活动', () => {
  const activity = activityFromProjection({
    record: {
      rows: {
        turnBoundary: { val: { openTurnStartSeq: null } },
        sessionStats: { val: { openStep: null, pendingCalls: 0 } },
        inbox: { val: { 'next-turn': [], 'next-step': [] } },
        userQuestions: { val: { questions: { active: [], settled: [] } } },
      },
    },
  })
  assert.equal(activity.active, false)
})

test('inspectActivity 汇总目录并跳过过期缓存', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-activity-'))
  writeProjection(home, 'session-running', {
    turnBoundary: { val: { openTurnStartSeq: 5 } },
  })
  writeProjection(home, 'session-idle', { turnBoundary: { val: { openTurnStartSeq: null } } })

  const fresh = inspectActivity({ home })
  assert.equal(fresh.activeTasks, true)
  assert.deepEqual(
    fresh.sessions.map((s) => s.id),
    ['session-running'],
  )

  const stale = inspectActivity({ home, freshnessMs: 0, now: Date.now() + 60_000 })
  assert.equal(stale.activeTasks, false)
})

test('没有缓存目录时视为无任务', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-activity-empty-'))
  assert.deepEqual(inspectActivity({ home }), { activeTasks: false, scheduledTasks: false, sessions: [] })
})

test('withDeadline 超时返回 fallback', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve({ activeTasks: false }), 200))
  assert.equal(await withDeadline(slow, 10, 'unknown'), 'unknown')
  assert.deepEqual(await withDeadline(Promise.resolve({ activeTasks: true }), 1000, 'unknown'), {
    activeTasks: true,
  })
})
