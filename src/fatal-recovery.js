'use strict'

/**
 * 致命故障的原生恢复流程，移植自上游 apps/desktop/src/fatal-recovery.ts：
 * 先写崩溃报告（最多等 1s），对话框只显示错误尾部 + 报告路径 + 重装建议；
 * 端口占用（EADDRINUSE）时换一组文案与按钮；同一进程只处理第一次故障。
 */

const CRASH_REPORT_WAIT_MS = 1000
const DETAIL_BUDGET = 1200
const DETAIL_TAIL_LINES = 8

/** 把嵌套的 AggregateError 摊平成一条可读消息（上游 desktopErrorState）。 */
function errorState(error) {
  if (error instanceof AggregateError) {
    return [error.message, ...error.errors.map((item) => errorState(item))].join('\n')
  }
  return error instanceof Error ? error.message : String(error)
}

function format(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
}

function reportLine(messages, reportPath) {
  return reportPath === undefined ? '' : `\n${format(messages.reportWrittenTo, { path: reportPath })}`
}

/** 对话框 detail：错误尾部（截短时加提示）+ 报告路径 + 重装建议。 */
function dialogDetail(error, messages, reportPath) {
  const advice = `\n\n${messages.startupReinstallAdvice}`
  const report = reportLine(messages, reportPath)
  const tail = String(error)
    .split(/\r\n|[\n\r\u2028\u2029]/u)
    .slice(-DETAIL_TAIL_LINES)
    .join('\n')
  const budget = DETAIL_BUDGET - advice.length - report.length - messages.diagnosticTruncated.length - 1
  const shortened = tail.slice(-Math.max(budget, 0)).replace(/^[\uDC00-\uDFFF]/u, '')
  return `${shortened === error ? error : `${messages.diagnosticTruncated}\n${shortened}`}${report}${advice}`
}

class FatalRecovery {
  /**
   * @param {object} operations
   * @param {() => object} operations.messages 当前语言的消息表
   * @param {(options: object) => Promise<{response: number}>} operations.show 原生对话框
   * @param {() => Promise<void>} operations.stop 停掉后台服务
   * @param {() => Promise<string[]|void>} operations.disablePlugins 备份 profile patch（第三按钮）
   * @param {() => void} operations.exit 退出进程
   * @param {() => void} operations.restart 重启应用
   * @param {(error: unknown, source: string) => Promise<string|undefined>} operations.writeReport 落盘诊断
   */
  constructor(operations) {
    this.operations = operations
    this.reported = false
  }

  get active() {
    return this.reported
  }

  async report(error, source) {
    if (this.reported) return
    this.reported = true
    const messages = this.operations.messages()
    const reportPath = await this._persist(error, source)
    let detail = errorState(error)
    let message = messages.fatalSummary

    for (;;) {
      const addressInUse = /\blisten EADDRINUSE\b/u.test(detail)
      const answer = await this.operations.show({
        type: 'error',
        title: messages.startupFailed,
        message,
        detail: addressInUse
          ? `${messages.startupAddressInUse}${reportLine(messages, reportPath)}`
          : dialogDetail(detail, messages, reportPath),
        buttons: addressInUse
          ? [messages.exitApplication, messages.restartApplication]
          : [messages.exitApplication, messages.restartApplication, messages.disableThirdPartyPlugins],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      })

      if (answer.response === 0) {
        try {
          await this.operations.stop()
        } catch (failure) {
          console.error(failure)
        }
        this.operations.exit()
        return
      }

      try {
        await this.operations.stop()
        if (answer.response === 2) await this.operations.disablePlugins()
        this.operations.restart()
        return
      } catch (failure) {
        console.error(failure)
        message = messages.recoveryOperationFailed
        detail = errorState(failure)
      }
    }
  }

  async _persist(error, source) {
    let timer
    try {
      return await Promise.race([
        this.operations.writeReport(error, source),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(undefined), CRASH_REPORT_WAIT_MS)
        }),
      ])
    } catch (failure) {
      console.error('crash report failed', failure)
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }
}

module.exports = {
  CRASH_REPORT_WAIT_MS,
  DETAIL_BUDGET,
  DETAIL_TAIL_LINES,
  FatalRecovery,
  dialogDetail,
  errorState,
}
