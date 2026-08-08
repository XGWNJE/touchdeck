# TouchDeck 知识沉淀

> 本文件只记录已验证的实现事实、踩坑和当前缺口。产品路线以 `docs/roadmap.md` 为准，操作规则以 `AGENTS.md` 为准。

## v0.2.2 当前实现与剩余验证

以下是实现现状，不是已完成能力：

- Android 使用 `v: 1`、`type: "action"`、UUID `requestId` 和 `buttonId` 发起远程动作；Host 返回定向 `action-result`。
- Host 对同一 `(clientId, requestId)` 保存有限幂等记录；重复包不会第二次进入宏队列，只返回已知状态。
- Android 在 ACK 超时后以同一 `requestId` 重试一次，随后显示 `timeout`；迟到 ACK 不得覆盖已显示的终态。
- Windows 在入队和实际注入前都实时探测前台；带 `target` 的按钮探测失败或不匹配均返回 `blocked`。
- `npm test` 已覆盖协议格式、非法消息、按客户端隔离的幂等记录、目标匹配/失配/探测失败、无效目标正则，以及宏 FIFO 的串行、排队后二次拦截、队列溢出和执行异常。
- `confirm` 字段已经在部分配置和传输代码中流转，但菜单端尚未形成完整的确认交互；可靠性闭环前不得继续扩展该能力。

### 本轮验证记录（2026-08-09）

已验证：

- `npm test`、`npm run typecheck`、`npm run build` 和 Android Debug 构建均通过。
- Windows Host 与 Android 模拟器真实 P2P 直连；DataChannel 已打开，Host 向 Android 下发 14 个按钮。
- Android 悬浮球触发 `esc` 后生成 UUID `requestId`，收到定向 ACK 后显示“已执行”；这证明 `executed` 不再等同于 DataChannel `send()` 成功。
- 强制结束 Host 后，Android 从“已直连”切换为“主机断线，等待恢复…”，日志出现 `host gone` 及 DataChannel `CLOSING` / `CLOSED`；不得继续显示连接健康。
- Debug APK 的受控测试入口让同一 `requestId` 连发两次；Android 收到两次 `queued`，而 Windows 临时靶记事本只输入一次 `/`，真实链路的去重已验证。
- 动作处于 `queued` 时强制结束 Host：Android 没有收到 `executed`，并立刻记录 `disconnected / host-gone`。此前它会在约 8 秒后误报 `timeout`，已修正。
- 第二台模拟器 `TouchDeck_QA_2` 已加入同一房间：仅发起设备收到自己的 `executed`，另一台没有该 `requestId`，定向 ACK 已验证。
- 在临时记事本前台、400ms 间隔下连续发出 100 个不同 `requestId`：靶窗口得到 100 个 `/`，Android 收到 100 个 `executed`，失败终态为 0（成功率 100%）。
- 无节流突发 100 个不同请求时，30 个执行、70 个明确 `failed`（队列上限保护）；没有静默丢失或重复执行。这不是连续成功率样本。
- Owner 已在真机完成触感、等待至终态反馈和“不抢 Windows 焦点”的目检，结果均通过。

未验证，后续若出现异常优先从这些路径排查：

- Android 自动“超时后重发同一 `requestId`”在真实 DataChannel 上是否只触发一次 Windows 宏；当前已验证受控重复包，不等同于 Android 超时重试路径。
- 带 `target` 的按钮在目标不匹配和前台探测失败时的真实双重拦截；默认配置没有带 `target` 的测试按钮，未临时改写用户配置。自动测试已覆盖安全判断。
- 真机对 `blocked`、`failed` 与 `timeout` 三种终态的逐项触感与文案复核；本轮真机已确认日常成功、等待、断线和焦点行为。

## Windows 悬浮球

- 菜单窗口创建时使用透明全屏层，菜单窗口保持 `focusable: false`，快捷键发往操作前的活动窗口。
- 仅键鼠交互：快速点球展开/收起；按住 Tab 展开菜单，悬停扇区高亮，左击或松 Tab 确认。
- 拖球按住约 350–500ms 后进入拖动状态，松手按边缘阈值吸附；移动使用 Win32 `SetWindowPos`。
- 进度环等覆盖层必须保持 `pointer-events: none`，否则会截断球的 pointerdown。
- `SetWindowPos` 使用物理像素，Electron 和 nut-js 多使用逻辑像素；缩放屏幕上不可混用坐标。
- 透明分层窗口必须用 `desktopCapturer` 截图目检，普通 GDI 或 PrintScreen 不能作为 UI 验证依据。

## Android 悬浮球

- Android 使用 Kotlin 薄壳和原生 `RadialMenuView`，启动时优先读取离线 assets。
- P2P 连接建立后，Host 推送当前有效按钮集；断开后回落到离线 `panel.json`。
- MIUI 展开层可能从状态栏下方开始，必须使用挂载后的屏幕坐标换算菜单中心。
- MIUI 未授权通知时 Toast 可能被拦截，选中反馈使用自绘浮层，不依赖 Toast。
- 重装应用可能重置悬浮窗权限；真机验证前需确认授权状态，不擅自修改用户设备的息屏设置。
- `input swipe` 容易触发 CANCEL 或被误判为拖动；模拟手势时应先确认球的实际坐标，并使用已验证的分段触摸注入方法。

## 配置与宏

- `touchdeck.config.json` 是用户配置入口；布局、主题和图标分别来自 `layouts/`、`themes/`、`icons/`。
- 配置、布局和主题支持热重载；JSON 损坏时沿用上一份有效配置。
- 打包版配置和状态必须写入 Electron `userData`，asar 内文件只作为默认资源。
- `keys`、`text`、`paste`、`delay` 是当前宏步骤类型；宏只在 Windows 端解析执行。
- 多个触发源共用单消费者 FIFO 队列，队列上限为 16；队列溢出不能在远程端静默等待，必须纳入 ACK 状态机。
- 含 `paste` 的宏执行前快照剪贴板，成功或失败后都恢复；日志不得记录剪贴板正文。
- 中文或长文本优先使用 `paste`；`text` 经过输入法时可能进入候选框而不是目标窗口。
- 带 `target` 的按钮使用前台进程名或窗口标题正则匹配。目标不匹配时宁可拦截，不向未知窗口注入。

## P2P 直连

- Android 是 Client，Windows 是 Host；按键只走 WebRTC DataChannel，信令服务不转发按键。
- Client 必须先创建 DataChannel 再创建 offer，否则 SDP 不包含 application 段。
- WebRTC `PeerConnectionFactory` 必须长持有；Android 必须声明网络状态权限，否则可能触发 native 崩溃。
- 双端使用应用层 ping/pong 判断半开连接；ICE 短暂抖动不应因为单次状态变化就拆除健康通道。
- Host 侧按 `clientId` 维护独立 PeerConnection；设备数量必须按实际 open 通道计算。
- 信令断线时 Host 通过房号 reclaim，服务端在宽限期内保留房间；房间 TTL 到期后必须明确提示重新连接。
- 当前 6 位房间码不是安全认证方案，只适合受控测试；安全配对完成前不得把它描述成安全登录。

## 端到端验证

- Electron 渲染窗口可用 `prototype/cdp-drive.mjs` 做状态读取和基础交互验证。
- 透明窗口用 `window.touchdeck.debugShot()` 或 `desktopCapturer` 截图，不用普通系统截图判断可见性。
- 焦点验证：目标靶窗置前，点面板按钮后前台窗口不变，且按键落入目标。
- P2P 验证：控制台显示真实 open 设备数；指定设备的动作结果只能回到指定设备。
- 可靠性闭环验收必须补充自动化测试和 100 次连续人工记录；没有记录不得写成通过。

## 已知 Windows 边界

- UAC、锁屏和安全桌面下按键注入受 Windows 限制，不绕过该限制。
- UU 触控注入下 `pointermove` 和 `GetAsyncKeyState` 不可靠，不用它们作为拖动松手的唯一依据。
- 页面缩放锁定为 1，避免 UU 多点触控触发捏合缩放。
