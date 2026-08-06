# TouchDeck

Windows 触控快捷工具栏：跑在被远程控制的 Windows 本机上，为触屏远程操作（UU 远程 + 平板）提供一键快捷键面板。

## 解决什么问题

- 触屏语音输入法遮挡画面、快捷键入口层级深（UU 远程预设和软键盘都要点好几层）。
- 把 AI coding 常用快捷键、语音输入触发键（Win+H）等做成大屏触控按钮，点一下就发到目标窗口。

## 核心要求（构思阶段）

- 按钮足够大、有按下反馈，适合 8.8 寸平板触屏点按。
- 点工具栏按钮时不抢夺焦点，快捷键发到之前活动的窗口。
- 快捷键预设可配置（AI coding 常用 + 语音输入），不用频繁切入口。

## 自定义（DIY）

视觉与编排分离，两套资源包可独立扩展：

- **主题皮肤** `themes/<主题名>/theme.json`：颜色、圆角、字号、透明度、分组色板、按下/二次确认态。复制 `themes/default/` 改色即得新皮肤；`groups` 里加新色板即新增按钮分组。
- **布局编排** `layouts/<布局名>.json`：按钮尺寸/间距/列数/停靠位置/缩放，以及按钮清单（图标、文字、分组、按键组合、`confirm: true` 二次确认）；`showLabel`/`showSub` 可隐藏文字、纯图标显示（图标自动放大 1.5 倍）。
- **图标** `icons/<名称>.svg`：按钮 `icon` 字段填图标名（如 `"mic"`）优先用 SVG（Lucide 风格，`currentColor` 随主题文字色），找不到同名文件时回退 emoji/字符。新增图标 = 放一个 24×24 描边风格 SVG 进 `icons/`。
- **用户配置** `touchdeck.config.json`：`theme`/`layout` 选择资源包，`behavior` 调行为（变暗秒数、确认窗口、拖动阈值），`themeOverrides`/`layoutOverrides` 做局部微调（深度合并）。

出厂预设：主题 `default`（深色 + Lucide SVG 图标）、`light`（浅色）、`mono`（深色 + AI 生成描边图标，PNG）；布局 `left-dock`（2×6 左缘）、`bottom-bar`（6×2 底部）、`right-block`（4×3 右缘）。

图标解析优先级：`themes/<当前主题>/icons/`（.svg 或 .png）→ 全局 `icons/`（.svg）→ emoji 回退。主题级图标目录让不同皮肤可以带自己的图标集。

按键写法：`{ "ctrl": true, "key": "s" }` 发组合键；`{ "text": "/" }` 直接输入字符；只写修饰键（如 `{ "ctrl": true, "win": true, "shift": true }`）发纯修饰键组合（微信输入法语音输入即此例）。

## 运行

**一键启动（推荐）**：双击桌面 `TouchDeck` 快捷方式（或 `npm run build && npm start`）——自动打开控制台窗口并启动面板。控制台可启停本机面板、开启 P2P 直连（显示房间码）。快捷方式生成脚本：`powershell -File scripts/make-shortcuts.ps1`。

本机面板为悬浮球模式（2026-08-05 定案，仅键鼠交互）：点按球展开/收起径向菜单、按住 Tab 展开菜单松开确认悬停项、长按球拖动挪位；触控滑选交互由安卓悬浮球 App 承担。

## 多端远程（P2P 直连）

远程按键只走 P2P 直连（2026-08-05 定案）：Windows 端控制台开启连接 → 得到 6 位房间码 → 手机/平板 App 输入房间码 → WebRTC 打洞直连（VPN/对称 NAT 下 TURN 中继兜底），一个房间最多 8 台设备同时连接，按键经加密 DataChannel 直达本机注入，**不经过任何服务器转发**。信令服务 `wss://api.xgwnje.cn/signal` 仅做配对，TURN `212.135.41.88:3478` 仅做中继兜底。

- **安卓悬浮球 App**（`android/`）：按钮配置与图标打包在 APK 内（离线 assets，`npm run build:assets` 重新生成），高级设置里输入房间码连接，选中按钮经 DataChannel 发 `{id}`，按键解析与注入在 Windows 端完成。
- **平板浏览器**：打开 `src/renderer/peer.html` 可直接作为客户端加入房间（开发/测试用）。
- **多设备**：同一房间码支持多台设备同时连接、同时按键（服务端 1 host + 8 clients，clientId 路由）。

技术栈：Electron + TypeScript + React + Tailwind（2026-08-06 起正式版，electron-vite 构建；此前为原生 JS 原型期）；按键注入 @nut-tree/nut-js；窗口移动 koffi 直调 Win32。Agent 侧约束见 AGENTS.md。
