# DeepSeek Harness 桌面端（Linux）

`DeepSeek Harness`（`dsh`）官方只有 macOS / Windows 的 Electron 桌面端，Linux 没有打包目标。这个项目是给 Linux 用的轻量桌面壳：**把 dsh 官方 Web GUI 装进原生应用窗口**，由应用自己管理 `dsh web` 服务的生命周期。

## 运行

```sh
npm install          # 需要网络（会下载 Electron）
npm run fix-sandbox  # 首次需要：给 Electron 的 chrome-sandbox 加 setuid（要 sudo）
npm run smoke        # 无界面自检：拉起 dsh web 并校验鉴权链路
npm start            # 开发模式启动
```

前置条件：已安装 `dsh`（`npm i -g @deepseek-ai/dsh`）。应用按 `DSH_BIN` → `PATH` → `~/.local/opt/node-*/bin` → `~/.local/bin` 的顺序查找它。

为什么需要 `fix-sandbox`：Linux 上 Electron 的沙箱助手 `chrome-sandbox` 必须是 root 所有并带 setuid 位，否则启动会直接报 `SUID sandbox helper binary was found, but is not configured correctly`。打包成 deb 后由安装脚本处理；开发模式下执行这条命令即可（临时替代方案是 `npm run start:no-sandbox`，但那会关闭 Chromium 沙箱，不建议日常使用）。

## 打包

```sh
npm run dist         # 产出 dist/*.AppImage 与 dist/*.deb
npm run pack         # 只解包到 dist/linux-unpacked，便于快速验证
```

产物在 `dist/`：`DeepSeek Harness-<版本>-x86_64.AppImage`（`chmod +x` 后直接运行）和 `DeepSeek Harness-<版本>-amd64.deb`（`sudo dpkg -i` 安装，装完在应用列表里显示为 `DeepSeek Harness`）。

两者对 Chromium 沙箱的处理不同，按需要选：

- **deb**：安装脚本会把 `chrome-sandbox` 设为 root 所有 + setuid，沙箱完整生效（推荐长期使用）
- **AppImage**：FUSE 挂载不支持 setuid，electron-builder 默认用 `AppRun --no-sandbox` 启动，即关闭 Chromium 沙箱。它只加载本机 `127.0.0.1` 上的 dsh 页面，风险可控，但更在意隔离就用 deb

## 结构

- `src/supervisor.js`：纯 Node 的服务管理（查找 dsh、`dsh web --no-open --port 0`、解析带 token 的就绪地址、SIGTERM/SIGKILL 关停），可在无图形环境下测试
- `src/main.js`：Electron 主进程（单实例、窗口、托盘、菜单、启动页、导航拦截、右键菜单、退出时回收服务）
- `src/locale.js` / `src/labels.js`：界面文案（前者逐字取自上游，后者是本移植版的补充条目）
- `src/background-notice.js` / `src/quit-confirmation.js` / `src/activity.js`：关闭即隐藏、退出确认与任务探测
- `src/command-management.js` / `src/updates.js`：管理 dsh 命令、检查并升级 dsh
- `src/diagnostics.js` / `src/fatal-recovery.js` / `src/profile-recovery.js`：崩溃报告、原生恢复流程、备份 profile patch
- `src/navigation.js` / `src/context-menu.js`：导航策略与右键编辑菜单
- `src/autostart.js`：XDG autostart 开关（托盘菜单里的「开机自启」）
- `scripts/smoke.js`：端到端自检；`test/`：`node --test` 单元测试

## 设计要点

- **就绪地址而不是固定端口**：用 `--port 0` 让 dsh 自己挑端口，应用解析它打印的 `dsh web: <url>` 再加载，因此不会和别的服务抢 3080，也不需要 cookie 预热。
- **窗口先出现**：先显示一个内联启动页，服务就绪后再 `loadURL`，避免点开图标后长时间没有任何反应。
- **退出即回收**：`before-quit` 里先 SIGTERM 停掉 dsh，宽限 8 秒再 SIGKILL，避免留下孤儿服务进程。
- **托盘可用性**：Ubuntu 自带 `ubuntu-appindicators` 扩展，Electron 托盘（StatusNotifier）可直接显示；如果托盘创建失败，关闭窗口会直接退出应用（而不是把窗口藏到没有入口的地方）。
- **登录自启**：写 `~/.config/autostart/dsh-desktop.desktop`，`Exec` 指向 AppImage 或安装后的可执行文件。

## 与官方 Windows / macOS 桌面版的行为对齐

这一版按上游 `apps/desktop` 的实现逐条对齐（文案取自上游 `locale.ts`，中英双语跟随系统语言）：

| 行为 | 上游桌面版 | 本项目 |
| --- | --- | --- |
| 主窗口尺寸 | 1280×820，最小 520×600 | 相同 |
| 关闭窗口 | 隐藏到托盘（首次弹一次性说明并写标记） | 相同，标记文件同为 `<userData>/background-close-confirmed` |
| 退出 | 先问 Host 是否有任务/定时任务在跑，只有明确没有才静默退出；探询失败或超时按"有任务"处理 | 相同策略；任务来源见下 |
| 托盘 | 图标常驻、tooltip 为产品名、单击显示窗口、菜单含「打开 / 退出」 | 相同，并额外提供服务状态、重启服务、打开日志、开机自启 |
| 单实例 | 第二份启动聚焦已有窗口 | 相同 |
| 应用菜单 | 关于 / 检查更新 / 管理 dsh 命令… / 刷新 / 隐藏 DevTools（F12、Ctrl+Shift+I） | 相同条目（外加「重启服务」「打开日志」，因为 Linux 没有系统托盘菜单栏） |
| 本地化 | `zh-CN` / `en`，跟随系统 | 相同，165 条文案与上游逐字一致 |
| 关机 / 注销 | 用系统事件标记，确认框不挡关机 | 相同（`powerMonitor` 的 `shutdown` 事件） |
| 导航策略 | 只有应用自身来源留在窗口内；外链交给系统浏览器；其它协议拦截 | 相同 |
| 右键菜单 | 可编辑区域给撤销/重做/剪切/复制/粘贴/全选，选中文本给复制 | 相同（Electron 默认没有右键菜单，由应用补上） |
| 致命故障 | 先落盘诊断报告，再弹原生恢复框：退出 / 重启 / 禁用第三方插件并重启；端口占用给专用文案 | 相同，报告写在 Electron 的 `logs` 目录，最多留 10 份 |
| 渲染进程错误 | 收集错误级 console 输出，随崩溃报告一起落盘 | 相同（保留 64 KiB 尾部） |

移植中的三处差异，都是环境限制而非取舍：

1. **任务探测的来源**：上游通过私有 IPC 询问它自己拉起的 Host（desktop profile）。我们托管的是标准 `dsh web` profile，没有那条通道，于是改读 dsh 自己写的会话投影缓存（`~/.dsh/storages/session_projcache/sessions/*.json`）里的 `turnBoundary.openTurnStartSeq`、`openStep`/`pendingCalls`、排队 `inbox`、待回答 `userQuestions`，并用文件 mtime 做新鲜度门槛。定时任务（Schedule overlay）默认不在 web profile 里挂载，因此 `scheduledTasks` 恒为 false。
2. **应用菜单的呈现**：Windows 版把菜单做进自定义标题栏。我们保留系统标题栏（Web 界面自带顶栏，叠加标题栏会遮挡），菜单默认隐藏，按 <kbd>Alt</kbd> 或右键标题栏即可展开。
3. **检查更新的对象**：上游检查桌面应用自身的发布源。本项目的发布源还不存在，所以这个入口用来检查并一键升级 `dsh` 本体（对比 npm latest，升级后自动重启服务）。

## 状态与配置

| 路径 | 内容 |
| --- | --- |
| `~/.local/state/dsh-desktop/server.log` | dsh web 的服务日志（含本地 token，0600，启动时轮转为 `.1`） |
| `~/.config/DeepSeek Harness/background-close-confirmed` | 「关闭窗口后仍在后台运行」的一次性确认标记（与上游同名） |
| `~/.config/autostart/dsh-desktop.desktop` | 开启自启后生成 |
