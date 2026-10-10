'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const {
  RendererConsoleTail,
  crashReportFileName,
  pruneCrashReports,
  renderCrashReport,
  writeCrashReport,
} = require('../src/diagnostics')

const appFacts = {
  name: 'DeepSeek Harness',
  version: '0.2.0',
  platform: 'linux',
  arch: 'x64',
  electron: '44.7.0',
  node: '24.0.0',
  locale: 'zh-CN',
}

function input(overrides = {}) {
  return Object.assign(
    {
      source: 'host',
      phase: 'startup',
      error: new Error('listen EADDRINUSE: address already in use 127.0.0.1:3080'),
      rendererConsole: [],
      app: appFacts,
      time: new Date('2026-10-11T03:20:00.000Z'),
    },
    overrides,
  )
}

test('报告文件名可排序且带来源', () => {
  assert.equal(crashReportFileName(new Date('2026-10-11T03:20:00.000Z'), 'main'), 'crash-2026-10-11T03-20-00-000Z-main.log')
})

test('报告包含事实表头、错误与渲染进程日志', () => {
  const text = renderCrashReport(input({ rendererConsole: ['a.js:1 boom'], source: 'renderer' }))
  assert.match(text, /source: renderer/)
  assert.match(text, /phase: startup/)
  assert.match(text, /app: DeepSeek Harness 0\.2\.0/)
  assert.match(text, /platform: linux x64/)
  assert.match(text, /--- error ---/)
  assert.match(text, /EADDRINUSE/)
  assert.match(text, /a\.js:1 boom/)
})

test('没有渲染进程日志时明确写出占位说明', () => {
  assert.match(renderCrashReport(input()), /no error-level renderer console output was captured/)
})

test('Host 自述诊断会带进报告', () => {
  const text = renderCrashReport(input({ hostDiagnostic: 'host said: profile failed' }))
  assert.match(text, /host diagnostic/)
  assert.match(text, /host said: profile failed/)
})

test('写报告会创建目录并返回路径', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-crash-')), 'logs')
  const file = await writeCrashReport(dir, input())
  assert.ok(file && fs.existsSync(file))
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.match(fs.readFileSync(file, 'utf8'), /EADDRINUSE/)
})

test('裁剪只删自己的报告且保留最新 10 份', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-crash-prune-'))
  for (let i = 0; i < 13; i += 1) {
    const time = new Date(Date.UTC(2026, 9, 11, 3, i, 0))
    fs.writeFileSync(path.join(dir, crashReportFileName(time, 'main')), 'x')
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'keep me')
  await pruneCrashReports(dir)
  const remaining = fs.readdirSync(dir).filter((name) => name.startsWith('crash-')).sort()
  assert.equal(remaining.length, 10)
  assert.equal(fs.existsSync(path.join(dir, 'notes.txt')), true, '非报告文件不能被删')
  assert.ok(remaining[0].endsWith('03-03-00-000Z-main.log'), '应保留最新的 10 份')
})

test('目录不存在时裁剪是静默的', async () => {
  await pruneCrashReports(path.join(os.tmpdir(), 'dsh-crash-missing-xyz'))
})

test('渲染进程日志尾部有字节上限，超限从头部丢弃', () => {
  const tail = new RendererConsoleTail(20)
  tail.push('1234567890')
  tail.push('abcdefghij')
  tail.push('ZZZZZZZZZZ')
  assert.deepEqual(tail.snapshot(), ['abcdefghij', 'ZZZZZZZZZZ'])
  assert.equal(tail.snapshot().length, 2)
})
