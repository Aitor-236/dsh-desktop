'use strict'

/**
 * 右键菜单，对齐上游 apps/desktop/src/main.ts：
 * 可编辑区域给撤销/重做/剪切/复制/粘贴/全选，选中文本给复制，其它情况不弹。
 * role 项统一清空 accelerator，避免显示 Electron 默认快捷键标签。
 */

function contextMenuTemplate({ isEditable, selectionText, editFlags = {}, messages }) {
  const items = []
  if (isEditable) {
    items.push(
      { role: 'undo', label: messages.undo, enabled: editFlags.canUndo !== false },
      { role: 'redo', label: messages.redo, enabled: editFlags.canRedo !== false },
      { type: 'separator' },
      { role: 'cut', label: messages.cut, enabled: editFlags.canCut !== false },
      { role: 'copy', label: messages.copy, enabled: editFlags.canCopy !== false },
      { role: 'paste', label: messages.paste, enabled: editFlags.canPaste !== false },
      { type: 'separator' },
      { role: 'selectAll', label: messages.selectAll, enabled: editFlags.canSelectAll !== false },
    )
  } else if (typeof selectionText === 'string' && selectionText.length > 0) {
    items.push({ role: 'copy', label: messages.copy, enabled: editFlags.canCopy !== false })
  }
  return items.map((item) => (item.role === undefined ? item : Object.assign({}, item, { accelerator: '' })))
}

module.exports = { contextMenuTemplate }
