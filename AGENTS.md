# TouchDeck 项目规则

## 当前开发主线

TouchDeck 当前只服务一个远程工作流：**Android 手机/平板远程操作 Windows 上的桌面 GUI 编程 Agent**，代表目标是 Codex 这类带完整界面的 Agent。TouchDeck 不替代成熟的终端映射方案。

v0.2.2「远程触控指令可靠性闭环」和 v0.2.3「安全配对」已完成受控验证。当前唯一主线是 v0.3.0「单一黄金工作流」：

- 先在真实手机和平板上补齐首次配对、设备凭据续连、双设备定向 ACK 和反馈验收。
- 陌生用户无需修改 JSON，即可在 10 分钟内完成安装、配对、发送和中断。
- 当前只打磨一个 GUI 编程 Agent 默认预设，动作最终收敛到 8–12 个。
- Owner 连续真实使用至少 7 天，记录频率、失败、重连和误触，不记录输入内容。

## 范围锁定

在单一黄金工作流达到出口标准前，禁止：

- 新增第二个或第三个场景预设。
- 开发 GUI 配置编辑器、自由拖拽画布或任意组件系统。
- 开发插件 API、在线模板市场或配置分享平台。
- 扩展变量、分支、条件等待、循环判断或脚本语言。
- 扩展 iOS、macOS、Linux 或通用远控场景。
- 为视觉丰富进行大型主题系统重构。

现有 `scenarios`、多布局、多主题和宏解析代码是历史基础，不代表当前路线要继续扩张。新增需求必须直接提升“正确执行、明确反馈、快速触达”之一，否则延后并记录到 `docs/roadmap.md` 的决策门槛。

## 静默观察（harness-observer，常驻职责）

- 若系统提示已注入全局协作规则，其中已含本职责，跳过本节。
- 否则干活全程留意 owner 重复纠正、明确偏好、可复用踩坑和自身语义失败。
- 命中即静默追加到 `D:\ObjectCode\HarnessOS\notes\inbox\YYYY-MM-DD.md`，先查重、脱敏；格式以 harness-observer skill 为准。
- 静默观察不得修改本项目文件，不在对话中打断当前任务。

## 铁律

1. 点面板按钮不得抢夺焦点。窗口保持 `focusable: false`，快捷键必须发到操作前的活动窗口。
2. 按钮和界面参数配置驱动。用户配置入口为 `touchdeck.config.json`，资源来自 `themes/`、`layouts/`、`icons/`；不得把用户按钮写死在业务代码中。
3. 触控参数适配 8.8 寸平板隔 UU 视频流点按：按钮默认 120px 起步，按下反馈明显且停留至少 400ms，同一按钮 300ms 内不得重复触发。
4. 远程按键只走 P2P DataChannel。信令服务只做建连和 SDP/ICE 交换，不做按钮转发，不提供 HTTP 回退。
5. 远程协议必须使用版本化消息和唯一 `requestId`。ACK 必须回到原设备，不能向所有设备广播执行结果。
6. `executed` 只表示 Windows 宏执行函数真实完成，不得把 DataChannel `send()` 成功当成执行成功。
7. 带 `target` 的按钮在入队和实际注入前都必须检查；前台探测失败时宁可拦截，不得向未知窗口注入。
8. 剪贴板宏必须执行前快照、结束后恢复；日志不得记录提示词、剪贴板正文、输入文本或凭据。

## 关键命令

- `npm run dev`：开发运行，打开控制台并按状态启动本机面板。
- `npm run typecheck`：TypeScript 类型检查。
- `npm run build`：构建 Electron 产物。
- `npm start`：运行构建产物。
- `npm run build:assets`：从配置包生成 Android 离线 `panel.json` 和图标。
- `npm run dist:win`：构建 Windows setup 与 portable，不发布。
- `gradlew.bat :app:assembleDebug`：在 `android/` 目录构建 Android Debug APK。

当前 `package.json` 有 `test`，没有 `lint` 脚本。不得用 `typecheck` 或 `build` 冒充测试通过。

## 代码边界

- `src/shared/config-resolve.ts`：配置、布局、主题、按钮、宏和目标规则的共享解析。
- `src/main/macro.ts`：Windows 宏执行、FIFO 队列、目标保护和 ACK 状态机的主实现位置。
- `src/main/foreground.ts`：前台窗口探测和场景解析。注入前不得只依赖过期缓存。
- `src/main/peer-host.ts`：P2P 消息进入主进程和 ACK 回传路由；必须保留 `clientId`。
- `src/renderer/peer/main.ts`：Windows Host 的 WebRTC DataChannel 管理，不承担宏执行。
- `android/.../P2PClient.kt`：Android Client 的信令、DataChannel、请求等待、超时和重连。
- `android/.../BubbleService.kt`：Android 悬浮球、径向菜单和非颜色反馈。
- `src/preload/index.ts`：IPC 契约；变更协议时同步更新 `src/renderer/env.d.ts`。
- `touchdeck.config.json`：当前单一 GUI 编程 Agent 场景的默认动作事实来源。
- `layouts/`、`themes/`、`icons/`：当前场景所需资源，不因路线扩张继续增加包数量。
- `server/signal.mjs`：只负责信令、房间和 TURN 配置；不实现 ACK 和动作执行。

## 当前 P2P 事实

- 信令地址：`wss://api.xgwnje.cn/signal`。
- TURN 服务：`212.135.41.88:3478`，由信令服务下发配置。
- 一个房间目前支持 1 个 Host 和最多 8 个 Client。
- 信令断线、WebRTC 半开、Host 闪断和房间 TTL 已有重连机制，仍需在真实设备日常使用中持续验证。
- Android 已发送版本化 `action` 消息、UUID `requestId` 和 `buttonId`；Host 返回定向 `action-result`。
- 6 位房间码只定位房间；每台新设备使用独立的 5 分钟一次性配对密钥，Host 可为下一台设备生成新密钥；已登记设备使用各自续连凭据。
- Host 指纹用于人工核对主机身份。当前设备登记仍随信令房间生命周期存在，房间过期、Host 主动关房或服务重启后需重新配对。

## 配置和打包事实

- 配置、布局、主题改动支持热重载；坏 JSON 沿用上一份有效配置。
- 打包版配置和状态写入 Electron `userData`，asar 内只读文件不作为运行期写入位置。
- Android 启动时优先使用离线 assets；P2P 连接后由 Host 推送当前有效按钮集。
- `keys` 或 `macro` 只在 Windows 端解析执行，Android 只传按钮标识和协议元数据。
- 本机面板关闭状态必须阻止所有面板窗口启动和重建。

## 验证矩阵

| 变更类型 | 必须验证 |
|---|---|
| 协议/ACK | 自动测试覆盖正常、拦截、失败、超时、断线、重复请求、非法消息和队列溢出 |
| 目标保护 | 目标匹配、目标不匹配、前台探测失败；错误窗口注入为 0 |
| 可靠性 | 目标程序中连续 100 次关键动作，成功率至少 99%，每次均可按 `requestId` 定位 |
| 焦点/注入 | 记事本或专用靶窗置前，点按钮后前台不变且按键落入目标 |
| Android 反馈 | 等待、成功、拦截、失败、断线、超时均有可读反馈，成功和失败有不同触感 |
| 面板 UI | 使用 `desktopCapturer` 截图目检；普通 GDI 截不到透明分层窗口，不使用普通截图判断 |
| P2P | 控制台显示真实连接设备数，指定设备收到自己的 ACK，不向其他设备串反馈 |
| 回归 | `npm run typecheck`、`npm run build`、Android Debug 构建，以及现有本机面板和旧配置 |

无法在当前环境完成的真机或人工项目必须明确标记“未验证”，不得推测通过。

## 已知边界

- UAC、锁屏和安全桌面下按键注入受 Windows 限制，不绕过该限制。
- Win32 `SetWindowPos` 使用物理像素，Electron 和 nut-js 多使用逻辑像素；拖球移动不得混用。
- UU 触控注入下 `pointermove` 和 `GetAsyncKeyState` 不可靠；拖拽收尾必须遵守已验证的双通道方案。
- 页面缩放锁定为 1，避免 UU 多点触控触发捏合缩放。
- Android MIUI 坐标、Toast、通知权限和重装悬浮窗权限问题见 `docs/touchdeck-notes.md`。

## 发包规则

收到“发包”指令时才允许发包；未收到不得创建标签、推送或发布。

1. 在 `CHANGELOG.md` 顶部新增当前版本节，固定包含 `新增`、`修复`、`变更`。
2. 运行 `python D:/ObjectCode/HarnessOS/scripts/check_docs.py --readme README.md`（该脚本只接受 `--readme`；CHANGELOG 版本节由 CI 发包任务机械校验，缺节即失败）。
3. 运行 `node scripts/release.mjs` 检查 `package.json`、Android 和 server 三处版本一致。
4. 按需运行 `npm run build:assets`，再提交代码并打 `v<版本>` 标签触发 CI。
5. 等待 CI 全绿，核验 APK、Windows setup、portable 和信令 tar.gz 均存在。
6. CI 失败时修复根因后删除坏标签并重推；不得绕过 CHANGELOG 检查。
7. 测试期构建产物上传中转站前必须先征得 owner 同意；正式发包只走 GitHub Releases。

## 文档职责

- `README.md`：面向用户的定位、入口、截图和文档导航，不放操作细节。
- `AGENTS.md`：Agent 执行规则、范围锁定、命令、验证和边界。
- `docs/roadmap.md`：唯一产品路线、阶段出口和停止条件。
- `docs/touchdeck-notes.md`：已验证的实现事实、踩坑和当前缺口。
- `server/README.md`：信令服务自身的边界和部署事实。
- `CHANGELOG.md`：已发生的版本历史，不写未实现规划，不改写旧版本。
- `docs/TouchDeck_产品定位与改进方案_v1.0.docx`：本轮产品方向的原始决策材料，不作为实现状态证明。

事实变化时只更新负责该事实的文档；路线变化先更新 `docs/roadmap.md`，再同步入口文档和 Agent 规则。
