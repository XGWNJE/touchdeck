## 静默观察（harness-observer，常驻职责）

- 若你的系统提示已注入全局协作规则（Claude Code / Codex / OpenCode 会自动注入），其中已含本职责，跳过本节。
- 否则（如 Kimi Code）：干活全程留意四类信号——owner 重复纠正、owner 明确表达的偏好、可复用踩坑、你自身的语义失败（假设/目标/路径/范围错误）。
- 命中即静默追加到 HarnessOS 仓库路径下的 `notes/inbox/YYYY-MM-DD.md`（HarnessOS 路径按 harness-observer skill 的环境前提寻址；先查重，同主题重复计数 +1，脱敏）；记录格式与验收标准以 harness-observer skill 为准，需要时加载它。
- 静默 = 不打断当前任务、不在对话中提及、不改动当前项目任何文件；只追加 inbox，归并提炼留给 owner 评审。

## 中转站真机验证（常驻职责）

- 若你的系统提示已注入全局协作规则（Claude Code / Codex / OpenCode 会自动注入），其中已含本职责，跳过本节。
- 否则（如 Kimi Code）：开发内容未外部发版、仍在测试阶段，且发现用户在用模拟器/虚拟机调试验证、未连接真机时，主动询问用户是否把构建产物传到中转站（get.xgwnje.cn），让用户自行安装到真机测试；问过才传，不擅自上传。

# TouchDeck 项目规则

Windows 触控快捷工具栏：跑在被 UU 远程控制的 Windows 本机上，为 8.8 寸平板触屏远程操作提供一键快捷键面板（AI coding 快捷键 + 语音输入触发）。规划跨平台（Mac），技术栈 Electron + 原生 JS（原型期），正式版迁 TypeScript + React + Tailwind。

## 铁律（不可违反）

1. 点面板按钮不得抢夺焦点——快捷键必须发到之前活动的窗口（窗口 `focusable: false`，不得为省事改回）。
2. 按钮与界面参数全部配置驱动（用户配置 `touchdeck.config.json` + 主题包 `themes/` + 布局包 `layouts/`），按键组合按平台映射，不写死在代码里。
3. 触控参数必须适配 8.8 寸平板隔 UU 视频流点按：按钮默认 120px 起步；按下反馈须明显且停留 ≥400ms；300ms 内忽略同一按钮重复触发。

## 已定设计基线（2026-08-02 视觉实验室实测 + owner 拍板）

- 默认布局：2 列竖排（2×6），停靠屏幕**左侧**居中；尺寸/透明度/反馈：120px、92% 不透明、变色下沉；闲时 5 秒降至 15% 透明度，点亮即恢复。
- 全局等比缩放（`ui.scale`）与布局/位置（`ui.columns`、`ui.position`）必须可配，适配不同远程环境。
- 语音输入按钮默认发 `Ctrl+Win+Shift`（微信输入法「启动语音输入」，点按式）；用户换输入法只改配置。

## 关键路径与命令

- `npm start` / `npx electron .`：运行原型（Windows 面板轨道）。
- `npm run start:server` / `node server.mjs`：新架构链路服务器——面板跑在平板浏览器（`client/index.html`，渲染引擎与 Electron 渲染端同源，fetch 桥替代 preload），按键经局域网 POST 到本机 nut-js 注入；端口 7758，零新依赖。UU 触控注入不可靠是开辟此轨道的原因。
- `android/`：悬浮球 App（Kotlin 薄壳 + 原生径向菜单）。广域网测试期面板离线渲染：资源由 `node scripts/build-panel-assets.mjs` 从配置包生成（panel.json + 主题 PNG 图标 → assets/），改配置后重新生成 + `gradlew assembleDebug`（JAVA_HOME 用 `C:\Android\Android Studio\jbr`）。WebView 面板路线已废弃（窗口尺寸与内容像素机制冲突，2026-08-02 实证），通讯转发接通后 panel.json 同格式改由服务器下发。MIUI 两个坑（2026-08-03 真机实证）：① 展开层窗口即使带 FLAG_LAYOUT_IN_SCREEN 实际也从状态栏之下开始（高 2530 < 物理 2670），与球窗口全屏坐标系差一个顶部偏移，必须挂载后 `getLocationOnScreen` 把球心换算进展开层坐标系，否则菜单不居中、扇区点不中；② 未授权通知时 Toast 被系统静默拦截（logcat: Suppressing toast），选中反馈用自绘小浮层 flashLabel。另：重装（install -r）后 SYSTEM_ALERT_WINDOW 会被重置为 ignore 且可能被 MIUI 回改，启动流程：force-stop → 开 MainActivity → `appops set cn.touchdeck.app SYSTEM_ALERT_WINDOW allow` → 立即点「启动悬浮球」。交互（2026-08-03 v5，小米 15 手机实测）：一滑到底滑选——手指起点在球上直接滑动即展开菜单（锚定起点），球跟随手指、扇区高亮跟随，松手在扇区=选中生效、落空=取消；按住不动超 350ms 再动=拖球挪位；快速点按=展开/收起常驻菜单。滑选中展开菜单必须 `skipBubbleRetop`——展开时 remove/add 球视图会重建 ViewRoot 掐断当前触摸流（实证）。默认 12 键（语音/Steer/中断/发送/退格/命令/Plan/全选/换行/文件/复制/粘贴，layouts/left-dock.json）。布局规则（2026-08-03 用户验收）：全场景按钮等面积——弧长 L=dp108、环厚 T=dp70 恒定，每环槽位数=round(展开角×环中半径÷L)；槽位逐个查可见性（扇区中点在屏内才可用），被屏边挡住的槽位跳过、按键顺延到下一可见槽位（裁的是环上角度不是按键，12 键一个不少）；某环 0 可见槽位即停；不整体缩放。皮肤为 C 方案极简发光 HUD（design/menu-scheme2-C-minimal.png）：扇区不填色、发丝白环+径向分割线、白图标小标签、选中扇区青色（0xFF22D3EE）发光外弧（递宽递淡三描边近似，硬件加速下 BlurMaskFilter 不可靠）+ 淡青填充；不要全局压暗遮罩（用户明确：只有菜单影响画面），可识别度靠扇区黑透底 0xA6000000（局部磨砂近似，悬浮窗无截屏权限做不到真毛玻璃）。手势判定阈值注意：350ms 内位移未超阈值才进拖球，adb 慢速 swipe（位移太小）会被误判为拖动，模拟滑选要用快速 swipe。**调试中手机锁屏/打盹唤不醒（screencap 全黑）时：停止调试并报告用户，等用户主动解锁手机后再继续，不要擅自修改设备设置（如息屏超时）硬扛——owner 明确要求（2026-08-03）**，因为用户不主动拿起手机时 ADB 侧没有可靠办法。诊断知识点备查：mWakefulness=Awake 不代表屏亮（dumpsys display 的 mState 才是），KEYCODE_POWER 比 KEYCODE_WAKEUP 更接近真实亮屏。
- `touchdeck.config.json`：用户配置——选择主题/布局 + 行为微调（唯一面向用户的配置入口）。
- `themes/<名>/theme.json`：主题皮肤资源包（视觉令牌 + 分组色板）。
- `layouts/<名>.json`：布局资源包（网格/位置/缩放 + 按钮清单 + 文字显隐）。
- `icons/<名>.svg`：按钮图标（Lucide 描边风格，currentColor 继承主题色）。
- `src/main.js`：主进程——无框置顶窗口、配置解析（`resolveConfig`）、按键注入（@nut-tree/nut-js）、窗口移动（koffi → SetWindowPos）。
- `src/renderer/index.html`：渲染引擎——主题令牌注入 CSS 变量，布局驱动网格，分组样式按主题动态生成。
- `prototype/visual-lab.html`：UI 参数实测页（尺寸/透明度/反馈/布局），双击浏览器打开 F11 全屏用。

## 最小验证矩阵

| 变更类型 | 最小验证 |
|---|---|
| 窗口/焦点行为 | 记事本置前 → 点按钮 → 前台窗口仍是记事本且字符落入 |
| 按键注入 | 点按钮后目标窗口收到对应字符/组合键（目视或状态栏） |
| 面板 UI | desktopCapturer 截图目检（普通 GDI 截图抓不到透明分层窗口，勿用） |

## 已知边界

- UAC 弹窗/锁屏等安全桌面下按键注入无效（Windows 限制），不试图绕过。
- 窗口移动必须用 Win32 `SetWindowPos`（koffi 直调）；不得用 Electron `setPosition` 高频拖动——透明窗上会累积缩放伪影（2026-08-02 实证）。Modal 移动循环（WM_NCLBUTTONDOWN/SC_MOVE）在 `focusable:false` 窗口上无效，也不可用。
- UU 触控注入下 pointermove 与 GetAsyncKeyState 均不可靠（2026-08-02 实测）：不得用移动阈值判拖拽、不得用 GetAsyncKeyState 判松手。拖拽双通道：小揪揪手柄（布局包 `handle`，原生拖拽区，面板贴顶/底边时自动翻面）与按钮长按抓起（`behavior.dragHoldMs` 默认 500ms，松手信号只信渲染端 pointerup）。
- 页面缩放已锁死（`setVisualZoomLevelLimits(1,1)`），UU 多点触控注入不得引发捏合缩放。
- 调试代码（截屏 IPC、`prototype/run.log`）属原型期临时物，正式版移除。

## 文档地图

- `README.md`：面向人——项目定位、使用方式。
- `AGENTS.md`：面向 Agent——项目铁律、命令、验证要求。
- `touchdeck.config.json`：按钮与 UI 参数事实来源。

事实变化时只更新负责该事实的文档。
