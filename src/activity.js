'use strict'

/**
 * 活动探测：退出前判断是否还有任务在跑。
 *
 * 上游桌面版通过私有 IPC 询问它自己拉起的 Host；我们托管的是标准 dsh web profile，
 * 没有那条链路，于是改读 dsh 自己写的会话投影缓存
 * （$DSH_HOME/storages/session_projcache/sessions/<session>.json）：
 *   - turnBoundary.val.openTurnStartSeq 非空 → 回合正在运行
 *   - sessionStats.val.openStep / pendingCalls → 步骤或工具调用在跑
 *   - inbox.val[next-turn|next-step] 非空 → 还有排队消息
 *   - userQuestions.val.questions.active 非空 → 正在等待用户回答或审批
 * 缓存文件在回合进行中会被持续刷新，所以用 mtime 做新鲜度门槛，过期的缓存不算数。
 *
 * 定时任务（Schedule）默认不在 web profile 里挂载，因此 scheduledTasks 恒为 false；
 * 将来启用该 overlay 后应在这里补上。
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const DEFAULT_FRESHNESS_MS = 15 * 60 * 1000

function dshHome(env = process.env) {
  return env.DSH_HOME || path.join(os.homedir(), '.dsh')
}

function projectionDir(home) {
  return path.join(home, 'storages', 'session_projcache', 'sessions')
}

function readProjection(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 从一份投影文档里读出该会话的活动状态；结构不认识时返回 null。 */
function activityFromProjection(document) {
  const rows = document && document.record && document.record.rows
  if (!rows || typeof rows !== 'object') return null

  const boundary = rows.turnBoundary && rows.turnBoundary.val
  const stats = rows.sessionStats && rows.sessionStats.val
  const inbox = rows.inbox && rows.inbox.val
  const questions = rows.userQuestions && rows.userQuestions.val

  const turn = Boolean(
    boundary && boundary.openTurnStartSeq !== null && boundary.openTurnStartSeq !== undefined,
  )
  const step = Boolean(
    stats &&
      ((stats.openStep !== null && stats.openStep !== undefined) || Number(stats.pendingCalls || 0) > 0),
  )
  const queued =
    Boolean(inbox) && ((inbox['next-turn'] || []).length > 0 || (inbox['next-step'] || []).length > 0)
  const waiting = Boolean(questions && questions.questions && (questions.questions.active || []).length > 0)

  return { turn, step, queued, waiting, active: turn || step || queued || waiting }
}

/**
 * 扫描投影缓存，判断是否有任务在跑。
 * @returns {{activeTasks: boolean, scheduledTasks: boolean, sessions: Array<object>}}
 */
function inspectActivity({ home = dshHome(), freshnessMs = DEFAULT_FRESHNESS_MS, now = Date.now() } = {}) {
  const dir = projectionDir(home)
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return { activeTasks: false, scheduledTasks: false, sessions: [] }
  }

  const sessions = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const file = path.join(dir, entry)
    let stat
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (now - stat.mtimeMs > freshnessMs) continue
    const activity = activityFromProjection(readProjection(file))
    if (activity && activity.active) {
      sessions.push(Object.assign({ id: entry.replace(/\.json$/, '') }, activity))
    }
  }

  return { activeTasks: sessions.length > 0, scheduledTasks: false, sessions }
}

/** 探测函数，签名与上游 DesktopQuitConfirmation 的 inspect 一致。 */
function createActivityProbe(options = {}) {
  return async () => inspectActivity(options)
}

/** 给探测加截止时间；超时返回 fallback（上游对超时的处理是当作有任务在跑）。 */
function withDeadline(promise, ms, fallback) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

module.exports = {
  DEFAULT_FRESHNESS_MS,
  activityFromProjection,
  createActivityProbe,
  dshHome,
  inspectActivity,
  withDeadline,
}
