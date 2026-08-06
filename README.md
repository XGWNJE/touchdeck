# TouchDeck

远程 vibe coding 的触控操作台——UU 远程解决「看得见」，TouchDeck 解决「按得着」。给用平板/手机远程操作 PC 跑 AI CLI 的人用。

## 项目干什么

- **不抢焦点的触控按键面板**：Windows 悬浮球 + 径向菜单，按钮够大、按下反馈明显，为 8.8 寸平板隔视频流点按调参；点按钮把快捷键发到之前活动的窗口，焦点不动。
- **宏 + 场景感知**：按钮可配多步宏（按键/文本/粘贴/延时），前台应用命中即整组切换按钮集；全部声明式 JSON 配置（主题包/布局包/图标包），改配置免重启。
- **P2P 直连远程按键**：安卓悬浮球 App 输房间码 WebRTC 直连本机（一房最多 8 台设备），按键经加密 DataChannel 直达注入，不经过任何服务器转发。

技术栈：Electron + TypeScript + React + Tailwind（electron-vite 构建）；按键注入 @nut-tree/nut-js；窗口控制 koffi 直调 Win32。

## 界面展示

![Windows 悬浮球·径向菜单](screenshots/windows-menu.jpg)

![安卓悬浮球·径向菜单](screenshots/android-menu.png)

![安卓端 P2P 直连·房间码配对](screenshots/android-p2p.png)

## 产品路线

当前 **v0.2.x**（配置外置 userData + 按键频率统计）→ **v0.3.0** 三个场景预设包（cli-agent / kimi-web / deepseek-agent）+ 手动场景切换 → **v0.3.x** 配置编辑器 GUI → **v0.4.0** 远程执行反馈回传 → **v0.4.x** 手感打磨冲刺 → 择机接入自更新。

自定义能力边界、场景预设细节与各版本出口标准见 [docs/roadmap.md](docs/roadmap.md)。

## 怎么开始

双击桌面 `TouchDeck` 快捷方式（或 `npm run build && npm start`）——自动打开控制台并启动面板；控制台可启停本机面板、开启 P2P 直连拿房间码。操作细节与命令见 AGENTS.md。

## 文档地图

- README.md：本文件，面向人——项目干什么、怎么开始
- AGENTS.md：面向 Agent 的完整操作规则（铁律/关键路径命令/验证矩阵/发包流程）
- docs/roadmap.md：产品路线——定位、自定义能力边界、场景预设包、版本排期
- docs/touchdeck-notes.md：知识沉淀——踩坑实证、布局/皮肤规范、配置写法、交互手势细节
