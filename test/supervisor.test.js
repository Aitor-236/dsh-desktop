'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { DshServer, findDsh, parseReadyLine, isExecutable } = require('../src/supervisor')

function tempDsh(script) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-desktop-test-'))
  const file = path.join(dir, 'dsh')
  fs.writeFileSync(file, script, { mode: 0o755 })
  return file
}

test('parseReadyLine 只取出带 token 的启动地址', () => {
  const line =
    'dsh web: http://127.0.0.1:3080/?token=abc123 (LAN: http://10.0.0.5:3080/?token=abc123)'
  assert.equal(parseReadyLine(line), 'http://127.0.0.1:3080/?token=abc123')
  assert.equal(parseReadyLine('dsh web: opening the default browser; pass --no-open to disable'), null)
  assert.equal(parseReadyLine('完全无关的一行'), null)
})

test('findDsh 优先使用 DSH_BIN', () => {
  const fake = tempDsh('#!/bin/sh\nexit 0\n')
  assert.equal(findDsh({ DSH_BIN: fake, PATH: '', HOME: '/nonexistent' }), fake)
  assert.equal(isExecutable(fake), true)
})

test('findDsh 找不到时返回 null', () => {
  assert.equal(
    findDsh({ PATH: '/nonexistent', DSH_BIN: '/nonexistent/dsh', HOME: '/nonexistent' }),
    null,
  )
})

test('DshServer 在 dsh 缺失时拒绝启动', async () => {
  const server = new DshServer({ dshPath: '/nonexistent/dsh' })
  await assert.rejects(() => server.start(), /找不到 dsh 命令/)
  assert.equal(server.running, false)
})

test('DshServer 能带回启动失败的原因', async () => {
  const fake = tempDsh('#!/bin/sh\necho "boom" >&2\nexit 3\n')
  const server = new DshServer({ dshPath: fake })
  await assert.rejects(() => server.start(5000), /exit 3/)
  assert.equal(server.running, false)
})

test('DshServer 能解析假 dsh 打印的就绪地址并优雅停止', async () => {
  const fake = tempDsh(
    '#!/bin/sh\n' +
      'echo "dsh web: http://127.0.0.1:39999/?token=fake-token"\n' +
      'trap "exit 0" TERM\n' +
      'while true; do sleep 0.2; done\n',
  )
  const server = new DshServer({ dshPath: fake })
  const started = await server.start(5000)
  assert.equal(started.url, 'http://127.0.0.1:39999/?token=fake-token')
  assert.equal(started.port, 39999)
  assert.equal(server.running, true)
  await server.stop(2000)
  assert.equal(server.running, false)
})
