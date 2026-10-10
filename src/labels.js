'use strict'

/**
 * 上游 locale.ts 没有覆盖的、本移植版自己的文案（托盘服务项与关于框）。
 * 其余界面文案全部来自 locale.js，与 Windows 版逐字一致。
 */

const LABELS = {
  'zh-CN': {
    aboutTitle: '关于 DeepSeek Harness',
    appVersion: '应用版本：{version}',
    dshVersion: 'dsh 版本：{version}',
    serviceState: '服务状态',
    stateRunning: '运行中',
    stateStopped: '未运行',
    restartService: '重启 dsh 服务',
    openServiceLog: '打开服务日志',
    autostart: '开机自启',
    autostartOn: '已开启开机自启',
    autostartOff: '已关闭开机自启',
    autostartUnavailable: '当前运行方式无法生成自启命令，请先打包安装后再开启。',
    dshMissingTitle: '找不到 dsh 命令',
    dshMissingBody: '请先安装 dsh：\n\n    npm i -g @deepseek-ai/dsh\n\n安装后可从菜单选择「管理 dsh 命令…」或重启服务。',
    serviceStartFailedTitle: 'dsh 服务启动失败',
    serviceStartFailedBody: '可从菜单「重启 dsh 服务」重试。完整日志：{path}',
    ok: '好',
    openProjectPage: 'DeepSeek Harness 项目主页',
    updateStarted: '正在升级 dsh…',
    updateDone: 'dsh 已升级到 {version}',
    noUpdateSource: '无法访问 npm registry，请检查网络或代理设置。',
    updateDshDetail: '升级会替换全局安装的 dsh（npm i -g @deepseek-ai/dsh@latest），随后自动重启服务。',
    updateFailed: '升级失败，请查看 npm 输出后重试。',
    updateUnavailableInDev: '开发模式（未打包）无法检查应用更新，请使用打包后的 AppImage 或 deb。',
    checkDshUpdates: '检查 dsh 更新…',
  },
  en: {
    aboutTitle: 'About DeepSeek Harness',
    appVersion: 'Application version: {version}',
    dshVersion: 'dsh version: {version}',
    serviceState: 'Service',
    stateRunning: 'running',
    stateStopped: 'stopped',
    restartService: 'Restart dsh Service',
    openServiceLog: 'Open Service Log',
    autostart: 'Start at Login',
    autostartOn: 'Start at login enabled',
    autostartOff: 'Start at login disabled',
    autostartUnavailable: 'This run cannot derive a login command. Use a packaged build to enable it.',
    dshMissingTitle: 'dsh command not found',
    dshMissingBody: 'Install dsh first:\n\n    npm i -g @deepseek-ai/dsh\n\nThen use “Manage dsh Command…” or restart the service from the menu.',
    serviceStartFailedTitle: 'dsh service failed to start',
    serviceStartFailedBody: 'Use “Restart dsh Service” from the menu to retry. Full log: {path}',
    ok: 'OK',
    openProjectPage: 'DeepSeek Harness project page',
    updateStarted: 'Upgrading dsh…',
    updateDone: 'dsh upgraded to {version}',
    noUpdateSource: 'Cannot reach the npm registry. Check the network or proxy settings.',
    updateDshDetail: 'Upgrading replaces the globally installed dsh (npm i -g @deepseek-ai/dsh@latest), then restarts the service.',
    updateFailed: 'Upgrade failed. Check the npm output and retry.',
    updateUnavailableInDev:
      'Application updates need a packaged build. Run the AppImage or the installed deb to check for updates.',
    checkDshUpdates: 'Check dsh Updates…',
  },
}

function labelsFor(localeId) {
  return String(localeId || '').toLowerCase().startsWith('zh') ? LABELS['zh-CN'] : LABELS.en
}

function format(text, values) {
  return String(text).replace(/\{(\w+)\}/g, (match, key) => (key in values ? String(values[key]) : match))
}

module.exports = { LABELS, labelsFor, format }
