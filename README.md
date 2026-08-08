# TouchDeck

远程 AI 编程工作站的触控命令层。远程桌面负责让你看见，TouchDeck 负责让你可靠地按下高频命令。

## 项目干什么

- Windows 本机运行不抢焦点的悬浮球和径向菜单，快捷键发往之前活动的目标窗口。
- Android 手机或平板通过 P2P 直连触发 Windows 端的高频命令。
- 当前只围绕一个 `agent-terminal` 场景开发，先把“按下、执行、反馈、拦截、失败”做成可信闭环。

## 当前开发方向

当前最优先的工作是 **v0.2.2 远程触控指令可靠性闭环**：每次远程按键都要有唯一请求标识、明确执行状态、目标保护、失败原因和超时恢复。

在可靠性闭环和安全配对达标前，不新增第二个场景、不做 GUI 配置编辑器、不扩展自由布局、插件或配置市场。

## 界面展示

<div align="center">

| Windows 径向菜单 | Android 径向菜单 | Android P2P 配对 |
|:----------------:|:----------------:|:----------------:|
| <img src="screenshots/windows-menu.jpg" width="200" /> | <img src="screenshots/android-menu.png" width="175" /> | <img src="screenshots/android-p2p.png" width="390" /> |

</div>

## 怎么开始

开发运行：`npm run dev`

构建运行：`npm run build` 后执行 `npm start`。

完整操作规则、验证标准和当前禁止范围见 [AGENTS.md](AGENTS.md)。路线与验收门槛见 [docs/roadmap.md](docs/roadmap.md)。

## 文档地图

- [AGENTS.md](AGENTS.md)：面向 Agent 的项目规则、命令、验证和范围锁定。
- [docs/roadmap.md](docs/roadmap.md)：唯一产品路线、阶段出口和停止条件。
- [docs/touchdeck-notes.md](docs/touchdeck-notes.md)：已验证的实现事实、踩坑和当前缺口。
- [CHANGELOG.md](CHANGELOG.md)：已发生的版本历史和发布说明事实来源。
- [产品定位与改进方案](docs/TouchDeck_产品定位与改进方案_v1.0.docx)：本轮路线调整的完整决策依据。
