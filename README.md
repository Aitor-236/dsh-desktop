# DeepSeek Harness 桌面端（Linux）

`DeepSeek Harness`（`dsh`）官方只有 macOS / Windows 的 Electron 桌面端，Linux 没有打包目标。这个项目是给 Linux 用的轻量桌面壳：**把 dsh 官方 Web GUI 装进原生应用窗口**，由应用自己管理 `dsh web` 服务的生命周期。

## 它和"浏览器套壳"的区别

| | 浏览器 `--app` 窗口 | 本项目 |
| --- | --- | --- |
| 依赖 | 必须装 Chrome | 自带 Chromium（Electron），不依赖浏览器 |
| 服务生命周期 | 靠外部脚本 / 开机自启 | 应用自己拉起、守护、退出时回收 |
| 托盘 | 无 | 有（状态、重启、日志、开机自启、退出） |
| 单实例 | 会开出多个窗口 | 第二次启动聚焦已有窗口 |
| 关闭窗口 | 直接关掉页面 | 可选"隐藏到托盘"，会话继续跑 |
| 分发 | 需要手写 .desktop | `npm run dist` 出 AppImage / deb |

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

产物在 `dist/`：`DeepSeek Harness-0.1.0-x86_64.AppImage`（`chmod +x` 后直接运行）和 `DeepSeek Harness-0.1.0-amd64.deb`（`sudo dpkg -i` 安装，装完在应用列表里显示为 `DeepSeek Harness`）。

两者对 Chromium 沙箱的处理不同，按需要选：

- **deb**：安装脚本会把 `chrome-sandbox` 设为 root 所有 + setuid，沙箱完整生效（推荐长期使用）
- **AppImage**：FUSE 挂载不支持 setuid，electron-builder 默认用 `AppRun --no-sandbox` 启动，即关闭 Chromium 沙箱。它只加载本机 `127.0.0.1` 上的 dsh 页面，风险可控，但更在意隔离就用 deb

## 结构

- `src/supervisor.js`：纯 Node 的服务管理（查找 dsh、`dsh web --no-open --port 0`、解析带 token 的就绪地址、SIGTERM/SIGKILL 关停），可在无图形环境下测试
- `src/main.js`：Electron 主进程（单实例、窗口、托盘、菜单、启动页、退出时回收服务）
- `src/autostart.js`：XDG autostart 开关（托盘菜单里的「开机自启」）
- `scripts/smoke.js`：端到端自检
- `test/`：`node --test` 单元测试

## 设计要点

- **就绪地址而不是固定端口**：用 `--port 0` 让 dsh 自己挑端口，应用解析它打印的 `dsh web: <url>` 再加载，因此不会和别的服务抢 3080，也不需要 cookie 预热。
- **窗口先出现**：先显示一个内联启动页，服务就绪后再 `loadURL`，避免点开图标后长时间没有任何反应。
- **退出即回收**：`before-quit` 里先 SIGTERM 停掉 dsh，宽限 8 秒再 SIGKILL，避免留下孤儿服务进程。
- **托盘可用性**：Ubuntu 自带 `ubuntu-appindicators` 扩展，Electron 托盘（StatusNotifier）可直接显示；若在没有该扩展的桌面上，关闭窗口时的确认框仍可让你选择直接退出。
- **登录自启**：写 `~/.config/autostart/dsh-desktop.desktop`，`Exec` 指向 AppImage 或安装后的可执行文件。

## 状态与配置

| 路径 | 内容 |
| --- | --- |
| `~/.local/state/dsh-desktop/server.log` | dsh web 的服务日志（含本地 token，0600，启动时轮转为 `.1`） |
| `~/.config/dsh-desktop/config.json` | 关闭窗口的行为偏好 |
| `~/.config/autostart/dsh-desktop.desktop` | 开启自启后生成 |
