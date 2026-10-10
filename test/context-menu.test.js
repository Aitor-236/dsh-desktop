'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')

const { contextMenuTemplate } = require('../src/context-menu')
const { messagesFor } = require('../src/locale')

const zh = messagesFor('zh-CN')
const en = messagesFor('en')

test('可编辑区域给出完整编辑菜单（本地化 + 清空 accelerator）', () => {
  const template = contextMenuTemplate({
    isEditable: true,
    selectionText: '',
    editFlags: { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
    messages: zh,
  })
  const labels = template.filter((item) => item.label).map((item) => item.label)
  assert.deepEqual(labels, ['撤销', '重做', '剪切', '复制', '粘贴', '全选'])
  assert.equal(template.find((item) => item.role === 'redo').enabled, false)
  for (const item of template.filter((entry) => entry.role)) {
    assert.equal(item.accelerator, '', 'role 项应清空快捷键标签')
  }
})

test('只有选中文本时给复制', () => {
  const template = contextMenuTemplate({
    isEditable: false,
    selectionText: 'hello',
    editFlags: { canCopy: true },
    messages: en,
  })
  assert.equal(template.length, 1)
  assert.equal(template[0].role, 'copy')
  assert.equal(template[0].label, 'Copy')
})

test('既不可编辑也没有选中内容时不弹菜单', () => {
  assert.deepEqual(contextMenuTemplate({ isEditable: false, selectionText: '', messages: zh }), [])
  assert.deepEqual(contextMenuTemplate({ isEditable: false, messages: zh }), [])
})
