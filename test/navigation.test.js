'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { navigationDecision, windowOpenDecision } = require('../src/navigation')

const appUrl = 'http://127.0.0.1:3080/'

test('同源导航放行（含 token 交换后的重定向）', () => {
  assert.equal(navigationDecision(appUrl, 'http://127.0.0.1:3080/settings'), 'allow')
  assert.equal(navigationDecision('http://127.0.0.1:3080/?token=abc', 'http://127.0.0.1:3080/'), 'allow')
})

test('外链交给系统浏览器', () => {
  assert.equal(navigationDecision(appUrl, 'https://github.com/deepseek-ai/deepseek-harness'), 'external')
  assert.equal(navigationDecision(appUrl, 'http://example.com/'), 'external')
})

test('不同端口的本机地址不算同源', () => {
  assert.equal(navigationDecision(appUrl, 'http://127.0.0.1:9999/'), 'external')
})

test('危险或未知协议一律拦截', () => {
  assert.equal(navigationDecision(appUrl, 'javascript:alert(1)'), 'block')
  assert.equal(navigationDecision(appUrl, 'file:///etc/passwd'), 'block')
  assert.equal(navigationDecision(appUrl, 'data:text/html,<h1>x</h1>'), 'block')
  assert.equal(navigationDecision(appUrl, '不是 URL'), 'block')
  assert.equal(navigationDecision('', 'http://127.0.0.1:3080/'), 'block')
})

test('新开窗口：一律不开，http(s) 走系统浏览器', () => {
  assert.equal(windowOpenDecision('https://example.com'), 'external')
  assert.equal(windowOpenDecision('http://127.0.0.1:3080/x'), 'external')
  assert.equal(windowOpenDecision('file:///tmp/x'), 'block')
  assert.equal(windowOpenDecision('nonsense'), 'block')
})
