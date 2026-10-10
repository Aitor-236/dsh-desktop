'use strict'

/**
 * 真实的 Host 探测：用 `dsh web` 打印的启动 token 换一次会话 cookie，
 * 再走它自己的 Remote HTTP 接口问"有会话在跑吗"。
 *
 * 协议（来自 dsh 的 connection / api-gateway 实现）：
 *   - 认证：GET 带 token 的根地址 → 302/303 + Set-Cookie（绑定 host:port 的签名 cookie）
 *   - 调用：POST /api/<namespace>/<method>，body 为
 *     { type: 'client-request', rpcId, method: '<namespace>/<method>', payload }
 *   - 响应：{ type: 'server-response', rpcId, result: { ok: true, value } | { ok: false, error } }
 *
 * 用到的端点：`session/list`（返回每行 running/agentAvailable/updatedAt）。
 * `job/list` 是流式且需要 sessionId，这里不用。
 */

const { randomUUID } = require('node:crypto')

const DEFAULT_TIMEOUT_MS = 1500

class HostProbeError extends Error {
  constructor(message, options = {}) {
    super(message)
    this.name = 'HostProbeError'
    if (options.code) this.code = options.code
    if (options.status) this.status = options.status
  }
}

function originOf(url) {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms)
  }
  const controller = new AbortController()
  setTimeout(() => controller.abort(), ms).unref?.()
  return controller.signal
}

/** 用启动 token 换一次浏览器会话 cookie（与浏览器首次打开时完全同一条路径）。 */
async function mintSessionCookie(launchUrl, { fetchImpl = fetch, signal } = {}) {
  const response = await fetchImpl(launchUrl, { redirect: 'manual', signal })
  const setCookie =
    typeof response.headers.getSetCookie === 'function'
      ? response.headers.getSetCookie()[0]
      : response.headers.get('set-cookie')
  if (!setCookie) {
    throw new HostProbeError(`token 交换没有下发 cookie（HTTP ${response.status}）`, {
      status: response.status,
    })
  }
  return setCookie.split(';')[0]
}

/**
 * 调一个 Remote 一元方法，返回 result.value；失败抛 HostProbeError。
 * 网关要求 payload 恰好是 `{ args: {...} }`（args 是命名参数的纯对象）。
 */
async function callRemote({
  origin,
  cookie,
  endpoint,
  args = {},
  fetchImpl = fetch,
  signal,
  rpcId = randomUUID(),
}) {
  const url = new URL(`/api/${endpoint}`, origin)
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: Object.assign(
      { 'content-type': 'application/json' },
      cookie === undefined || cookie === null ? {} : { cookie },
    ),
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    signal,
  })
  if (response.status === 401) throw new HostProbeError('Host 拒绝了凭据（401）', { status: 401 })
  if (!response.ok) {
    throw new HostProbeError(`Remote ${endpoint} 返回 HTTP ${response.status}`, {
      status: response.status,
    })
  }
  const message = await response.json()
  if (!message || message.type !== 'server-response') {
    throw new HostProbeError(`Remote ${endpoint} 响应不是 server-response`, { code: 'malformed' })
  }
  const result = message.result
  if (!result || result.ok !== true) {
    const error = result && result.error
    throw new HostProbeError(
      `Remote ${endpoint} 失败：${error ? `${error.code}: ${error.message}` : '未知错误'}`,
      { code: error ? error.code : 'unknown' },
    )
  }
  return result.value
}

/** 会话是否算"有任务在跑"（Host 的 running 是权威答案）。 */
function runningSessions(value) {
  const items = value && Array.isArray(value.items) ? value.items : []
  return items.filter((row) => row && row.running === true)
}

/**
 * 向 Host 问一次活动状态。
 * @returns {Promise<{activeTasks: boolean, scheduledTasks: boolean, sessions: Array<object>, source: 'host'}>}
 */
async function inspectHost({ launchUrl, fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const origin = originOf(launchUrl)
  if (!origin) throw new HostProbeError(`无效的启动地址：${String(launchUrl)}`)

  const signal = timeoutSignal(timeoutMs)
  const cookie = await mintSessionCookie(launchUrl, { fetchImpl, signal })
  const value = await callRemote({
    origin,
    cookie,
    endpoint: 'session/list',
    // session/list 的唯一命名参数是 _request（SessionListRequest = { cursor? }）
    args: { _request: {} },
    fetchImpl,
    signal,
  })
  const running = runningSessions(value)
  return {
    activeTasks: running.length > 0,
    scheduledTasks: false,
    sessions: running.map((row) => ({ id: row.sessionId, source: 'host', running: true })),
    source: 'host',
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  HostProbeError,
  callRemote,
  inspectHost,
  mintSessionCookie,
  originOf,
  runningSessions,
}
