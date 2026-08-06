# TouchDeck 项目规则

Windows 触控快捷工具栏：跑在被 UU 远程控制的 Windows 本机上，为 8.8 寸平板触屏远程操作提供一键快捷键面板（AI coding 快捷键 + 语音输入触发）。规划跨平台（Mac），技术栈 Electron + TypeScript + React + Tailwind（2026-08-06 起正式版，electron-vite 构建；此前为原生 JS 原型期）。

## 静默观察（harness-observer，常驻职责）

- 若你的系统提示已注入全局协作规则（Claude Code / Codex / OpenCode 会自动注入），其中已含本职责，跳过本节。
- 否则（如 Kimi Code）：干活全程留意四类信号——owner 重复纠正、owner 明确表达的偏好、可复用踩坑、你自身的语义失败（假设/目标/路径/范围错误）。
- 命中即静默追加到 `D:\ObjectCode\HarnessOS\notes\inbox\YYYY-MM-DD.md`（先查重，同主题重复计数 +1，脱敏）；记录格式与验收标准以 harness-observer skill 为准，需要时加载它。
- 静默 = 不打断当前任务、不在对话中提及、不改动当前项目任何文件；只追加 inbox，归并提炼留给 owner 评审。

## 中转站真机验证（常驻职责）

- 若你的系统提示已注入全局协作规则（Claude Code / Codex / OpenCode 会自动注入），其中已含本职责，跳过本节。
- 否则（如 Kimi Code）：开发内容未外部发版、仍在测试阶段，且发现用户在用模拟器/虚拟机调试验证、未连接真机时，主动询问用户是否把构建产物传到中转站（get.xgwnje.cn），让用户自行安装到真机测试；问过才传，不擅自上传。

## 铁律（不可违反）

1. 点面板按钮不得抢夺焦点——快捷键必须发到之前活动的窗口（窗口 `focusable: false`，不得为省事改回）。
2. 按钮与界面参数全部配置驱动（用户配置 `touchdeck.config.json` + 主题包 `themes/` + 布局包 `layouts/`），按键组合按平台映射，不写死在代码里。
3. 触控参数必须适配 8.8 寸平板隔 UU 视频流点按：按钮默认 120px 起步；按下反馈须明显且停留 ≥400ms；300ms 内忽略同一按钮重复触发。

## 关键路径与命令

- `npm run dev`（开发，HMR）/ `npm run build` + `npm start`（跑构建产物）：默认打开**控制台窗口**（`src/renderer/console/`：状态总览 + 本机面板启停 + P2P 远程连接启停与房间码复制；「本机」= 运行面板的设备、「远程端」= 手机/平板/浏览器）并自动按配置启动面板；控制台最小化/关闭都进系统托盘（`src/assets/tray.png`，托盘「退出」结束一切）。**远程按键只走 P2P 直连**（2026-08-05 定案）：信令 `wss://api.xgwnje.cn/signal`（VPS touchdeck-signal:8790，nginx 反代）+ TURN 中继 `212.135.41.88:3478`（coturn）；无任何服务器按键转发（旧 server.mjs/frp 链路已彻底删除，frpc 计划任务与 VPS frps 已停）；信令/中继故障时**无 HTTP 回退**，P2P 失败即提示未连接。控制台/面板按需启动（桌面快捷方式 `TouchDeck`），不设开机自启。**本机面板固定悬浮球 + 键鼠交互**（2026-08-05 定案：网格模式与触控滑选手势已移除，`ui.mode`/`ui.input` 配置项废弃；触控滑选归安卓端）。**面板可单独启停**（`console-toggle-panel`，状态持久化 `touchdeck.state.json` 的 `panel` 字段）：只用安卓/平板端时关闭本机面板避免双悬浮球；面板关闭状态下 `startPanel`（含 display-metrics-changed 重建）一律不启动。P2P 健壮性（2026-08-05）：双端断线自动重连（指数退避+上限）+ DataChannel 心跳判半开 + host 闪断房间宽限期/reclaim（房号不变免重配）+ 房间 TTL 到期主动通知控制台。交互/手势/拖球细节见 docs/touchdeck-notes.md。
- `npm run build:assets`（tsx 直跑 `scripts/build-panel-assets.ts`）：从配置包生成安卓离线资源 `android/app/src/main/assets/panel.json` + `icons/`（配置/图标完全离线，无服务器分发）；改配置后重新生成 + `gradlew assembleDebug` 重装。
- `android/`：悬浮球 App（Kotlin 薄壳 + 原生径向菜单）。启动时从**离线 assets** 加载 `panel.json` 与图标（无网络依赖）；P2P 连接（MainActivity 高级设置输入房间码 → `P2PState`，`P2PClient.kt` 用 webrtc-sdk 125 + Java-WebSocket 打洞）建立 DataChannel 后，选中按钮经 DataChannel 发送 `{id}`（keys 解析在 Windows 端，App 只发 id）。无服务器配置/图标拉取、无 HTTP 按键回传。一个房间支持 8 台设备同时连（clientId 路由；控制台显示「已直连（N 台设备）」）。安卓坑（MIUI 坐标偏移/Toast 拦截/重装权限重置）与交互手势见 docs/touchdeck-notes.md。
- `touchdeck.config.json`：用户配置——选择主题/布局 + 行为微调（唯一面向用户的配置入口）+ `auxButtons`（常驻辅助键区，见下）+ `scenarios`（场景绑定，见下）。**配置/布局/主题改动免重启**（2026-08-06 热重载：fs.watch 三源 → 清图标缓存/重建面板/重推安卓按钮集/控制台报配置错误；JSON 改坏沿用上一份有效配置，注入不断）。
- **按钮动作 = 宏**（2026-08-06）：按钮配 `keys`（单组组合键/文本，视同单步宏）或 `macro` 步骤数组——步骤四型 `keys`/`text`/`paste`/`delay`，可带 `times` 重复；**宏只在 Windows 端解析执行**（App 仍只发 id，铁律不变）。三触发源（本机/菜单/P2P）进全局 FIFO 串行队列，多设备并发不交错；`behavior.macroStepGapMs`（默认 40）控步骤节奏，`behavior.modifierHoldMs`（默认 120）控纯修饰键组合（如语音热键）按住时长；含 `paste` 的宏执行前快照剪贴板、结束后恢复。按钮可带 `target: { process?, title? }`（正则）：前台不匹配时**拦截不注入**并控制台可见反馈；前台探测失败时带 target 的按钮一律拦（宁可拦截不错注）。配置顶层 `scenarios: [{ name, target, layout? }]`：前台命中即整组切换按钮集（本机菜单重排 + DataChannel 推送安卓动态重渲染，离线 panel.json 仅未连接兜底）。`auxButtons`：常驻辅助键（默认语音/中断/发送），跨布局/场景固定，排布占内环起始槽位（菜单/安卓同规则），与布局按钮同 id 去重 aux 优先，标签淡青（#67E8F9）区分。
- `src/shared/config-resolve.ts`：共享配置解析——主进程 bundle 内联、`scripts/build-panel-assets.ts` tsx 直跑，宏校验/场景解析/aux 合并只此一份。
- `src/main/`：主进程（TS 模块化）——index（启动装配）/ state（共享状态）/ win32（koffi 函数层）/ macro（宏引擎+队列）/ foreground（前台探测+场景）/ windows（窗口+托盘+Tab）/ drag（拖球）/ peer-host（P2P 中继 IPC）/ hotreload（配置监听）/ ipc（通用 IPC）。构建产物 `out/`（electron-vite）。
- `src/preload/index.ts`：IPC 契约暴露面（构建为 CJS `.cjs`，沙箱兼容；迁 React 时此面冻结不动）。
- `src/renderer/bubble/` / `menu/`：悬浮球与全屏径向菜单（React 壳 + canvas 命令式绘制；键鼠：点球或按住 Tab 展开、hover 高亮、左击或松 Tab 确认）。
- `src/renderer/console/` / `peer/`：控制台 UI（React + Tailwind）；P2P host（隐藏窗口跑 WebRTC，纯 TS 模块）。
- `themes/<名>/theme.json`：主题皮肤资源包（视觉令牌 + 分组色板）。
- `layouts/<名>.json`：布局资源包（网格/位置/缩放 + 按钮清单 + 文字显隐）。
- `icons/<名>.svg`：按钮图标（Lucide 描边风格，currentColor 继承主题色）。
- `prototype/visual-lab.html`：UI 参数实测页（尺寸/透明度/反馈/布局），双击浏览器打开 F11 全屏用。

## 发包（Release，Agent 收到「发包」指令时的唯一流程）

「发包」= 发布三端产物到 GitHub Releases：安卓 APK + Windows 安装包（setup + portable）+ 信令服务包。构建与发布由 GitHub Actions 全自动完成（`.github/workflows/ci.yml`），**push `v*` 标签即触发**，无需也不允许手动改 ci.yml 之外的其他发布通道。

发包流程（严格按顺序）：

1. **版本号三处同步**（不一致一律不许发包）：`package.json`（主程序）+ `android/app/build.gradle.kts`（`versionName` 同步、`versionCode` 递增 1）+ `server/package.json`（信令服务）。先跑 `node scripts/release.mjs` 做一致性检查与引导。
2. **本地预检**：改过配置/图标先 `npm run build:assets` 重新生成安卓离线资源；语法错误先本地跑一遍（`npm run dist:win` 或等 CI 报错兜底）。
3. **打标签触发**：`git tag v<版本>`（如 `v0.1.7`）→ `git push origin v<版本>`。push 成功即视为发包开始，CI 自动跑三个打包 job + publish job。
4. **跟踪核验**：等 CI 全绿后，打开 GitHub Releases 页确认三端产物齐全（APK、两个 exe、tar.gz）；缺哪个产物视为发包失败，如实报告。
5. **失败处理**：CI 红叉 → 定位失败 job → 修复后 `git tag -d v<版本>` + `git push origin :refs/tags/v<版本>` 删掉坏标签 → 重新 `git push origin v<版本>`（publish job 用 `--clobber` 覆盖同名 Release）。已知坑：publish job 未 checkout 仓库时 `gh release` 需要 `GH_REPO: ${{ github.repository }}` 环境变量，否则报 not a git repository（v0.1.7 实证）。
6. **测试期产物**（未正式发布、真机验证用）按 mini-vault skill 走中转站 get.xgwnje.cn，问过 owner 才传；正式发包只走 GitHub Releases。

## 最小验证矩阵

| 变更类型 | 最小验证 |
|---|---|
| 窗口/焦点行为 | 记事本置前 → 点按钮 → 前台窗口仍是记事本且字符落入 |
| 按键注入 | 点按钮后目标窗口收到对应字符/组合键（目视或状态栏） |
| 面板 UI | desktopCapturer 截图目检（普通 GDI 截图抓不到透明分层窗口，勿用） |
| P2P 链路 | 控制台状态「已直连（N 台设备）」+ 设备按键注入到目标窗口 |

## 已知边界（要点；细节见 docs/touchdeck-notes.md）

- UAC 弹窗/锁屏等安全桌面下按键注入无效（Windows 限制），不试图绕过。
- 窗口移动必须用 Win32 `SetWindowPos`（koffi 直调）；不得用 Electron `setPosition` 高频拖动（透明窗累积缩放伪影）。**SetWindowPos 入参是物理像素，Electron getPosition/getCursorScreenPoint 是逻辑像素**：拖球轮询须按光标所在显示器 scaleFactor 换算，否则缩放 >100% 时拖动偏移。缩放/分辨率变化由 `screen.on("display-metrics-changed")` 防抖 500ms 重建面板校正。
- UU 触控注入下 pointermove 与 GetAsyncKeyState 均不可靠：不得用移动阈值判拖拽、不得用 GetAsyncKeyState 判松手（拖拽双通道见 docs/）。
- 页面缩放已锁死（`setVisualZoomLevelLimits(1,1)`），UU 多点触控注入不得引发捏合缩放。
- 调试代码（截屏 IPC、`prototype/run.log`）属原型期临时物，正式版移除。

## 文档地图

- `README.md`：面向人——项目定位、使用方式（含 P2P 远程说明）。
- `AGENTS.md`：面向 Agent——项目铁律、命令、验证要求。
- `docs/touchdeck-notes.md`：知识沉淀——踩坑实证、布局/皮肤规范、交互手势细节（AGENTS.md 的细节索引指向此处）。
- `touchdeck.config.json`：按钮与 UI 参数事实来源。

事实变化时只更新负责该事实的文档。
