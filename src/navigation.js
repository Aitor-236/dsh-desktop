'use strict'

/**
 * 导航策略，对齐上游 apps/desktop/src/main.ts：
 * 只有应用自己这个来源可以留在窗口里；外链交给系统浏览器；其它协议一律拦掉。
 * （上游允许自定义 dsh-app: 协议，我们托管的是 http://127.0.0.1:<port> 的 Web GUI。）
 */

/** @returns {'allow'|'external'|'block'} */
function navigationDecision(currentUrl, targetUrl) {
  let current
  let target
  try {
    current = new URL(currentUrl)
    target = new URL(targetUrl)
  } catch {
    return 'block'
  }
  const sameOrigin =
    target.origin === current.origin && ['http:', 'https:'].includes(target.protocol)
  if (sameOrigin) return 'allow'
  return ['http:', 'https:'].includes(target.protocol) ? 'external' : 'block'
}

/** 窗口新开请求（target=_blank 等）：一律不新建窗口，http(s) 交给系统浏览器。 */
function windowOpenDecision(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol) ? 'external' : 'block'
  } catch {
    return 'block'
  }
}

module.exports = { navigationDecision, windowOpenDecision }
