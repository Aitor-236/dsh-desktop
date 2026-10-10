'use strict'

/**
 * 崩溃诊断报告，移植自上游 apps/desktop/src/crash-report.ts：
 * 致命失败先落一份完整报告（含进程事实、错误、渲染进程错误日志尾部），
 * 对话框只显示错误尾部并给出报告路径；目录里最多保留 10 份，按文件名排序裁剪。
 */

const { mkdir, readdir, unlink, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const { inspect } = require('node:util')

const CRASH_REPORT_PREFIX = 'crash-'
const CRASH_REPORTS_RETAINED = 10
const RENDERER_CONSOLE_MAX_BYTES = 64 * 1024
const ERROR_SECTION_MAX_CHARS = 256 * 1024

const CRASH_REPORT_NAME =
  /^crash-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(?:host|web-boot|renderer|main)\.log$/

/**
 * 有上限的渲染进程错误日志尾部：超限时从头部丢弃，单行过长时保留整行，避免栈被截断。
 */
class RendererConsoleTail {
  constructor(maxBytes = RENDERER_CONSOLE_MAX_BYTES) {
    this.maxBytes = maxBytes
    this.lines = []
    this.bytes = 0
  }

  push(line) {
    this.lines.push(line)
    this.bytes += Buffer.byteLength(line)
    while (this.lines.length > 1 && this.bytes > this.maxBytes) {
      this.bytes -= Buffer.byteLength(this.lines.shift())
    }
  }

  snapshot() {
    return [...this.lines]
  }
}

/** 报告文件名：时间可排序，末尾是失败来源。 */
function crashReportFileName(time, source) {
  return `${CRASH_REPORT_PREFIX}${time.toISOString().replace(/[:.]/g, '-')}-${source}.log`
}

function boundedErrorSection(error) {
  const rendered = inspect(error, {
    depth: 6,
    maxStringLength: 64 * 1024,
    maxArrayLength: 100,
    breakLength: 120,
  })
  return rendered.length <= ERROR_SECTION_MAX_CHARS
    ? rendered
    : `${rendered.slice(0, ERROR_SECTION_MAX_CHARS)}\n… (error section cut at ${ERROR_SECTION_MAX_CHARS} characters)`
}

/** 渲染一份报告：事实表头 + 错误 + Host 自述诊断（可选）+ 渲染进程错误日志尾部。 */
function renderCrashReport(input) {
  const header = [
    `time: ${input.time.toISOString()}`,
    `source: ${input.source}`,
    `phase: ${input.phase}`,
    `app: ${input.app.name} ${input.app.version}`,
    `platform: ${input.app.platform} ${input.app.arch}`,
    `electron: ${input.app.electron}`,
    `node: ${input.app.node}`,
    `locale: ${input.app.locale}`,
    `shell pid: ${String(process.pid)}`,
  ]
  const consoleSection =
    input.rendererConsole.length === 0
      ? '(no error-level renderer console output was captured)'
      : input.rendererConsole.join('\n')
  return [
    header.join('\n'),
    '',
    '--- error ---',
    boundedErrorSection(input.error),
    '',
    ...(input.hostDiagnostic === undefined
      ? []
      : ['--- host diagnostic (as reported by the host process) ---', input.hostDiagnostic, '']),
    '--- renderer console (error level, oldest first) ---',
    consoleSection,
    '',
  ].join('\n')
}

/** 写入一份报告；失败只记日志并返回 undefined，不让诊断本身变成新的故障。 */
async function writeCrashReport(directory, input) {
  const file = join(directory, crashReportFileName(input.time, input.source))
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(file, renderCrashReport(input), { mode: 0o600, flag: 'wx' })
    return file
  } catch (error) {
    console.error('crash report could not be written', file, error)
    return undefined
  }
}

/** 只裁剪本应用生成的报告文件，目录里其它文件不动。 */
async function pruneCrashReports(directory, retained = CRASH_REPORTS_RETAINED) {
  let names
  try {
    names = await readdir(directory)
  } catch (error) {
    if (error && error.code === 'ENOENT') return
    console.error('crash report directory could not be listed', directory, error)
    return
  }
  const reports = names.filter((name) => CRASH_REPORT_NAME.test(name)).sort()
  const excess = reports.slice(0, Math.max(0, reports.length - retained))
  for (const name of excess) {
    try {
      await unlink(join(directory, name))
    } catch (error) {
      console.error('stale crash report could not be removed', join(directory, name), error)
    }
  }
}

module.exports = {
  CRASH_REPORT_PREFIX,
  CRASH_REPORTS_RETAINED,
  ERROR_SECTION_MAX_CHARS,
  RENDERER_CONSOLE_MAX_BYTES,
  RendererConsoleTail,
  crashReportFileName,
  pruneCrashReports,
  renderCrashReport,
  writeCrashReport,
}
