# TouchDeck

面向 Codex 等桌面 GUI 编程 Agent 的平板触控操作层。远程桌面负责呈现完整界面，TouchDeck 负责让你可靠地触发高频命令。

## 项目干什么

- Windows 本机运行不抢焦点的悬浮球和径向菜单，快捷键发往之前活动的目标窗口。
- Android 手机或平板通过 P2P 直连触发 Windows 端的高频命令。
- 当前只围绕一个 GUI 编程 Agent 工作流开发，首个验证目标是 Codex 这类有完整桌面界面的 Agent。
- TouchDeck 不替代终端映射；它补足平板远控 GUI Agent 时快捷键难触达、触控成本高、执行结果不明确的问题。

## 当前开发方向

v0.2.2 可靠指令闭环与 v0.2.3 安全配对已完成受控验证。当前进入 **v0.3.0 单一黄金工作流**：让用户无需修改 JSON，就能在平板上完成一次可靠的 GUI 编程 Agent 操作。

当前不新增第二个场景，不做配置编辑器、自由布局、插件或配置市场；先用真实手机和平板补齐真机验收，并连续使用 7 天验证默认动作。

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
