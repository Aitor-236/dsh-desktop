'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { MESSAGES, resolveLocale, messagesFor } = require('../src/locale')
const { LABELS, labelsFor } = require('../src/labels')

test('locale 解析与上游一致：zh 前缀用中文，其余用英文', () => {
  assert.equal(resolveLocale('zh_CN'), 'zh-CN')
  assert.equal(resolveLocale('zh-CN'), 'zh-CN')
  assert.equal(resolveLocale('zh-Hans-CN'), 'zh-CN')
  assert.equal(resolveLocale('en_US'), 'en')
  assert.equal(resolveLocale('de'), 'en')
  assert.equal(resolveLocale(undefined), 'en')
})

test('中英文案表 key 完全对齐（与上游 165 条同构）', () => {
  const zh = Object.keys(MESSAGES['zh-CN']).sort()
  const en = Object.keys(MESSAGES.en).sort()
  assert.deepEqual(zh, en)
  assert.ok(zh.length >= 150, `文案条数偏少：${zh.length}`)
})

test('本移植版自有文案也是双语齐全', () => {
  assert.deepEqual(Object.keys(LABELS['zh-CN']).sort(), Object.keys(LABELS.en).sort())
  assert.equal(labelsFor('zh-CN').restartService, '重启 dsh 服务')
  assert.equal(labelsFor('en').restartService, 'Restart dsh Service')
})

test('关键文案逐字来自上游 Windows 版', () => {
  assert.equal(messagesFor('zh-CN').quitTitle, '退出 DeepSeek Harness？')
  assert.equal(messagesFor('zh-CN').backgroundNoticeBody, '正在运行的任务不会中断，可在系统托盘中重新打开窗口')
  assert.equal(messagesFor('en').cliCommandMenu, 'Manage dsh Command…')
  assert.equal(messagesFor('zh-CN').cliCommandMenu, '管理 dsh 命令…')
})
