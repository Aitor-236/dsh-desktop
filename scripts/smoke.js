#!/usr/bin/env node
'use strict'

/**
 * 无图形环境自检：拉起 dsh web、校验鉴权链路、再关掉。
 * 用法：npm run smoke
 */

const { DshServer, findDsh } = require('../src/supervisor')
const { inspectHost, callRemote, mintSessionCookie } = require('../src/host-probe')

function check(label, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? '✓' : '✗'} ${label}：${actual}（期望 ${expected}）`)
  if (!ok) process.exitCode = 1
}

async function main() {
  const dshPath = findDsh()
  if (!dshPath) throw new Error('找不到 dsh 命令，请先 npm i -g @deepseek-ai/dsh')
  console.log(`dsh：${dshPath}`)

  const server = new DshServer({ dshPath })
  try {
    const started = await server.start()
    console.log(`启动地址：${started.url.replace(/token=[A-Za-z0-9_-]+/, 'token=<redacted>')}（端口 ${started.port}）`)
    const origin = new URL(started.url).origin

    const manifest = await fetch(`${origin}/manifest.webmanifest`)
    check('静态资源 /manifest.webmanifest', manifest.status, 200)

    const anonymous = await fetch(`${origin}/`, { redirect: 'manual' })
    check('未带凭据访问根路径', anonymous.status, 401)

    const exchange = await fetch(started.url, { redirect: 'manual' })
    const setCookie = exchange.headers.getSetCookie
      ? exchange.headers.getSetCookie()[0]
      : exchange.headers.get('set-cookie')
    console.log(`${[303, 302].includes(exchange.status) ? '✓' : '✗'} token 交换：${exchange.status}（期望 303）`)
    if (![303, 302].includes(exchange.status)) process.exitCode = 1
    if (!setCookie) {
      console.log('✗ 未下发会话 cookie')
      process.exitCode = 1
    } else {
      const authed = await fetch(`${origin}/`, { headers: { cookie: setCookie.split(';')[0] } })
      check('带 cookie 访问根路径', authed.status, 200)
    }

    // 真实 Host 探测：用启动 token 换 cookie 再走 Remote 的 session/list
    const host = await inspectHost({ launchUrl: started.url })
    console.log(`✓ Host Remote session/list 可用（source=${host.source}）`)
    check('空闲时没有"运行中"会话', host.activeTasks, false)
    check('定时任务（默认 web profile 未挂载 Schedule）', host.scheduledTasks, false)

    // 契约检查：真实响应里每一行都必须带布尔型 running（这是探测的唯一依据）
    const cookie = await mintSessionCookie(started.url)
    const listed = await callRemote({
      origin,
      cookie,
      endpoint: 'session/list',
      args: { _request: {} },
    })
    const rows = Array.isArray(listed.items) ? listed.items : []
    const everyRowHasRunning = rows.every((row) => typeof row.running === 'boolean')
    console.log(`✓ session/list 返回 ${rows.length} 条会话；字段：${rows.length > 0 ? Object.keys(rows[0]).sort().join(',') : '(无会话)'}`)
    check('每行都带布尔型 running', everyRowHasRunning, true)
  } finally {
    await server.stop()
    console.log('服务已停止')
  }
}

main().catch((error) => {
  console.error(`自检失败：${error.message}`)
  process.exit(1)
})
