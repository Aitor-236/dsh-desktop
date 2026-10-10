'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  HostProbeError,
  callRemote,
  inspectHost,
  mintSessionCookie,
  originOf,
  runningSessions,
} = require('../src/host-probe')
const { createActivityProbe, inspectActivity } = require('../src/activity')

const launchUrl = 'http://127.0.0.1:3080/?token=test-token'

/** 记录请求的假 fetch：第一步返回 cookie，第二步返回给定的 Remote 结果。 */
function fakeFetch({ items = [], result, status = 200, setCookie = 'dsh-auth-abc=signed-value; Max-Age=2592000; Path=/; HttpOnly' } = {}) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (options.method === undefined) {
      return {
        status: 303,
        headers: { getSetCookie: () => [setCookie], get: () => setCookie },
      }
    }
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () =>
        result === undefined
          ? { type: 'server-response', rpcId: 'x', result: { ok: true, value: { items } } }
          : result,
    }
  }
  return { calls, fetchImpl }
}

test('用启动 token 换到会话 cookie', async () => {
  const { fetchImpl } = fakeFetch()
  assert.equal(await mintSessionCookie(launchUrl, { fetchImpl }), 'dsh-auth-abc=signed-value')
  await assert.rejects(
    () => mintSessionCookie(launchUrl, { fetchImpl: async () => ({ status: 401, headers: { getSetCookie: () => [], get: () => null } }) }),
    /没有下发 cookie/,
  )
})

test('Remote 调用使用 dsh 的 client-request 信封', async () => {
  const { calls, fetchImpl } = fakeFetch();
  const value = await callRemote({
    origin: 'http://127.0.0.1:3080',
    cookie: 'dsh-auth-abc=signed-value',
    endpoint: 'session/list',
    args: { _request: {} },
    fetchImpl,
  })
  assert.deepEqual(value, { items: [] })
  const call = calls[0]
  assert.equal(call.url, 'http://127.0.0.1:3080/api/session/list')
  assert.equal(call.options.method, 'POST')
  assert.equal(call.options.headers['content-type'], 'application/json')
  assert.equal(call.options.headers.cookie, 'dsh-auth-abc=signed-value')
  const body = JSON.parse(call.options.body)
  assert.equal(body.type, 'client-request')
  assert.equal(body.method, 'session/list')
  assert.deepEqual(body.payload, { args: { _request: {} } })
  assert.equal(typeof body.rpcId, 'string')
  assert.ok(body.rpcId.length > 0)
})

test('result.ok=false 与 401 都会抛出可识别错误', async () => {
  const failing = fakeFetch({
    result: {
      type: 'server-response',
      rpcId: 'x',
      result: { ok: false, error: { code: 'gateway/bad-request', message: 'nope', details: {} } },
    },
  })
  await assert.rejects(
    () => callRemote({ origin: 'http://127.0.0.1:3080', endpoint: 'session/list', fetchImpl: failing.fetchImpl }),
    (error) => error instanceof HostProbeError && error.code === 'gateway/bad-request',
  )
  const unauthorized = fakeFetch({ status: 401 })
  await assert.rejects(
    () => callRemote({ origin: 'http://127.0.0.1:3080', endpoint: 'session/list', fetchImpl: unauthorized.fetchImpl }),
    (error) => error instanceof HostProbeError && error.status === 401,
  )
})

test('inspectHost：有会话在跑就是 activeTasks', async () => {
  const { calls, fetchImpl } = fakeFetch({
    items: [
      { sessionId: 'session-a', running: true },
      { sessionId: 'session-b', running: false },
    ],
  })
  const state = await inspectHost({ launchUrl, fetchImpl })
  assert.equal(state.activeTasks, true)
  assert.equal(state.source, 'host')
  assert.deepEqual(state.sessions, [{ id: 'session-a', source: 'host', running: true }])
  assert.equal(calls.length, 2, '先换 cookie 再调 Remote')
})

test('inspectHost：没有会话在跑就是空闲', async () => {
  const { fetchImpl } = fakeFetch({ items: [{ sessionId: 'session-a', running: false }] })
  const state = await inspectHost({ launchUrl, fetchImpl })
  assert.equal(state.activeTasks, false)
  assert.deepEqual(state.sessions, [])
})

test('runningSessions 容忍缺失或畸形数据', () => {
  assert.deepEqual(runningSessions(undefined), [])
  assert.deepEqual(runningSessions({ items: null }), [])
  assert.equal(runningSessions({ items: [null, { running: true }] }).length, 1)
  assert.equal(originOf('http://127.0.0.1:3080/x'), 'http://127.0.0.1:3080')
  assert.equal(originOf('nonsense'), null)
})

test('组合探测：Host 说空闲但缓存里有排队消息，仍然算有任务', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hybrid-'))
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'session-queued.json'),
    JSON.stringify({ record: { rows: { inbox: { val: { 'next-turn': [{}], 'next-step': [] } } } } }),
  )
  const { fetchImpl } = fakeFetch({ items: [{ sessionId: 'session-idle', running: false }] })
  const probe = createActivityProbe({ url: launchUrl, fetchImpl, home })
  const state = await probe()
  assert.equal(state.source, 'host')
  assert.equal(state.activeTasks, true)
  assert.deepEqual(state.sessions.map((session) => session.id), ['session-queued'])
})

test('组合探测：Host 不可用时退回投影缓存', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hybrid-fallback-'))
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'session-live.json'),
    JSON.stringify({ record: { rows: { turnBoundary: { val: { openTurnStartSeq: 4 } } } } }),
  )
  const errors = []
  const probe = createActivityProbe({
    url: launchUrl,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED')
    },
    home,
    onHostError: (error) => errors.push(error),
  })
  const state = await probe()
  assert.equal(state.source, 'cache')
  assert.equal(state.activeTasks, true)
  assert.equal(errors.length, 1)
  assert.match(state.hostError.message, /ECONNREFUSED/)
  assert.equal(inspectActivity({ home }).activeTasks, true)
})

test('组合探测：没有启动地址时直接用缓存', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hybrid-nourl-'))
  const probe = createActivityProbe({ url: () => null, home })
  const state = await probe()
  assert.equal(state.source, 'cache')
  assert.equal(state.activeTasks, false)
})
