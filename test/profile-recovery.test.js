'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { disableProfilePatches, PATCH_RELATIVE_PATHS } = require('../src/profile-recovery')

test('备份两层 profile patch，保留原内容', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-'))
  fs.mkdirSync(path.join(home, 'profiles', 'web'), { recursive: true })
  for (const relative of PATCH_RELATIVE_PATHS) {
    fs.writeFileSync(path.join(home, relative), '# user patch\n')
  }
  const moved = disableProfilePatches({ home, now: new Date('2026-10-11T03:30:00.000Z') })
  assert.equal(moved.length, 2)
  for (const relative of PATCH_RELATIVE_PATHS) {
    assert.equal(fs.existsSync(path.join(home, relative)), false, '原文件应被移走')
  }
  for (const backup of moved) {
    assert.match(backup, /\.disabled-2026-10-11T03-30-00-000Z$/)
    assert.equal(fs.readFileSync(backup, 'utf8'), '# user patch\n')
  }
})

test('没有 patch 时返回空数组', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-empty-'))
  assert.deepEqual(disableProfilePatches({ home }), [])
})
