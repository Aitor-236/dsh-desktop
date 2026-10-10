'use strict'

/**
 * 退出前确认：只有明确知道"没有要中断的工作"时才静默退出。
 * 语义与上游 apps/desktop/src/quit-confirmation.ts 一致（unknown → 视为有任务在跑）。
 */

/**
 * @param {object|'unknown'|undefined} inspection
 * @returns {'quitActiveTasks'|'quitScheduledTasks'|'quitActiveAndScheduledTasks'|undefined}
 */
function resolveQuitPrompt(inspection) {
  if (inspection === 'unknown') return 'quitActiveTasks'
  if (!inspection) return undefined
  if (inspection.activeTasks && inspection.scheduledTasks) return 'quitActiveAndScheduledTasks'
  if (inspection.activeTasks) return 'quitActiveTasks'
  if (inspection.scheduledTasks) return 'quitScheduledTasks'
  return undefined
}

class QuitConfirmation {
  constructor({ messages, inspect, show, focus }) {
    this.messages = messages
    this.inspect = inspect
    this.show = show
    this.focus = focus
    this.pending = undefined
    this.disposed = false
  }

  /** @returns {Promise<boolean>} true 表示可以退出 */
  confirm() {
    if (this.disposed) return Promise.resolve(false)
    if (this.pending !== undefined) {
      this.focus()
      return this.pending
    }
    const pending = this._decide().finally(() => {
      if (this.pending === pending) this.pending = undefined
    })
    this.pending = pending
    return pending
  }

  dispose() {
    this.disposed = true
  }

  async _decide() {
    // 没有 Host 在跑就没有东西可中断：直接放行
    const inspection = this.inspect()
    if (inspection === undefined) return true

    let result
    try {
      result = await inspection
    } catch (error) {
      console.warn('quit confirmation: task inspection unavailable', error)
      result = 'unknown'
    }
    const prompt = resolveQuitPrompt(result)
    if (this.disposed) return false
    if (prompt === undefined) return true

    const messages = this.messages()
    const answer = await this.show({
      type: 'warning',
      title: messages.aboutProduct,
      message: messages.quitTitle,
      detail: messages[prompt],
      buttons: [messages.quit, messages.cancel],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    })
    if (this.disposed) return false
    return answer.response === 0
  }
}

module.exports = { QuitConfirmation, resolveQuitPrompt }
