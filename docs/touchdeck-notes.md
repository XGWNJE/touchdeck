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

- 带 `target` 的按钮在前台探测失败时的真实拦截；探测失败无法在真机稳定模拟，自动测试已覆盖该安全判断（目标不匹配与排队后二次拦截已走真实链路，见下）。
- 真机对 `blocked`、`failed` 与 `timeout` 三种终态的逐项触感与文案复核；本轮真机已确认日常成功、等待、断线和焦点行为。

已闭环（2026-08-10）：长按进拖球模式的 40ms 震动由 owner 真机确认手感正常（模拟器无 vibrator 服务，此前只验证了调用路径不崩、拖动不回归）；控制台配对密钥点击复制已端到端验证（CDP 点击 → 已复制徽标 → 系统剪贴板逐字符一致）。

### 第二轮验证记录（2026-08-09，打包版隔离 Host + 模拟器真实 DataChannel）

已验证：

- Android 超时重试真实路径：5.5 秒慢宏下，Android 在 4.0 秒超时点自动以同一 `requestId` 重发；Host 幂等记录直接返回已知 `queued`，宏队列只进一次，最终一次 `executed`，靶记事本恰好一个 `/`。
- 带 `target` 按钮真实双重拦截：目标匹配时 `executed` 且注入目标窗；前台为其他窗口时入队即 `blocked`；排队期间切走前台（慢宏占队列）时注入前二次检查 `blocked`，靶窗内容不变，错误窗口注入为 0。
- 非法 `requestId`（不符合协议 UUID 正则）经真实 DataChannel 被 Host WebRTC 层明确回 `failed/invalid-message`，Android 立即终态，无静默等待。
- Debug 受控入口注意点：`am broadcast` 必须带显式组件 `-n cn.touchdeck.app/.DebugActionReceiver`，隐式广播在后台限制下不会投递（表现为 logcat 完全无记录）。

## v0.2.3 安全配对（2026-08-09）

- Windows Host 首次建房时生成高熵一次性配对密钥；服务端只保留哈希，5 分钟后失效，首次成功配对即作废。
- Android 首次连接必须提供该密钥；成功后只保存应用私有的设备续连凭据与所属房号，不保存首次配对密钥。Manifest 已禁止 Android 备份。
- Host 使用本地高熵主机凭据恢复房间；服务端返回可对照的 16 位主机指纹。Android 在建连状态显示该指纹，Host 控制台显示首次密钥和指纹。
- Host 观察到首个 Client 加入后立即删除 Windows 本地的一次性密钥副本；无人加入时也会在到期后清除。
- 信令服务按来源地址限制加入尝试，错误凭据、已用密钥和错误主机恢复均返回明确拒绝；所有信令仍使用 `wss`。
- TURN 凭据改为短期 REST 凭据：服务端密钥只在服务器环境变量中，客户端只收到带过期时间的用户名和 HMAC 凭据。

### 多设备配对补强（2026-08-10）

- Host 可在控制台为下一台新设备请求另一枚 5 分钟一次性配对密钥；只有上一枚被消费或过期后才显示入口，避免已复制密钥被无提示替换。
- 服务端只保存当前密钥哈希；每枚只能登记一台新设备。新设备获发独立 `deviceKey`，已有设备续连不会消费或清除正在等待新设备使用的密钥。
- 同一公网地址下的合法首配与 `deviceKey` 续连不计入错误尝试限速；连续错误配对仍会被限制。
- 自动测试已覆盖第二设备登记、旧密钥重放拒绝、已有设备续连不误清新密钥、满房拒绝生成和错误尝试限速。
- 当前设备登记仍只存在于信令房间内；房间固定 TTL 到期、Host 主动关房或信令服务重启后需要重新配对，不能把同房间续连描述为跨房间永久登记。

双真机已验证：

- Xiaomi 15 与 REDMI K Pad 2（均为 Android 16 / API 36）原位升级到 Debug `0.2.3`；签名一致，应用数据和悬浮窗权限保留。
- 生产 `wss` 信令已部署多设备配对协议；黑盒检查完成 Host 鉴权、房间恢复、第一台登记、生成第二枚密钥和第二台登记。
- 手机消费第一枚密钥后，Host 才显示“添加另一台设备”；平板使用第二枚密钥登记。两台均与 Windows 的 16 位 Host 指纹一致，并保存互不相同的 `deviceKey`；Host 显示 2 条真实 DataChannel。
- 两台 App 强制结束后不再提供配对密钥，仅使用各自 `deviceKey` 恢复同一房间；凭据保持不变，合法同公网地址续连未触发错误尝试限速。
- 手机、平板分别用未知按钮发起请求时，各自收到 `failed`，另一台日志没有该 `requestId`；定向 ACK 未串设备。
- 手机、平板分别向可见专用靶窗发送一次 `/`，均只注入一次、收到 `executed`，前台始终保持靶窗。手机用同一 `requestId` 连发两次时仍只注入一次。
- 设备输入法会把 ADB 文本注入转换为候选汉字或全角符号，不能用它自动填写随机配对密钥；本轮以仅存在于 Debug APK 的 `DEBUG_PAIR` 接收器驱动同一 `P2PState.start` 真实链路，Release 不包含该入口。配对表单的人工输入体验仍需 owner 目检。
- Android 当前能显示等待、成功、拦截、失败、断线和超时文字，但尚未为成功与失败实现不同触感；验证矩阵中的触感项当前不能判定通过。

### 本轮验证记录（2026-08-09）

已验证：

- `npm test` 共 10 项通过：既有可靠性 8 项，以及安全配对的首次配对、一次性密钥重放拒绝、设备凭据续连、错误主机恢复拒绝、限速和 TURN 临时凭据结构。
- `npm run typecheck`、`npm run build`、Android Debug 构建均通过。
- Windows 隔离 Host 与 Android 模拟器经生产 `wss` 信令和真实 WebRTC DataChannel 成功首次配对；Android 显示已核验的主机指纹。
- 同一首次密钥在成功配对后再次加入被生产服务拒绝；Host 的本地一次性副本已清除。
- 无设备加入的隔离 Host 经过完整 5 分钟有效期后，也自动清除了本地一次性密钥；该计时使用服务端下发的相对有效期，不受 Windows 与 VPS 时钟偏差影响。
- Android 强制结束并重新打开后，使用保存的设备凭据再次建立 DataChannel；无需再次输入首次密钥。
- 生产服务黑盒检查确认：不同主机凭据不能恢复已进入宽限期的房间；正确主机凭据可以恢复并关闭自己的测试房间。

- 强制仅经 TURN 中继的端到端连接（2026-08-09 第二轮已验证）：临时强制 Android `IceTransportsType.RELAY` 后，唯一收集到的候选为 `typ relay 212.135.41.88`（临时凭据分配成功），ICE CONNECTED、DataChannel OPEN，动作经中继完成 `executed` 且注入目标窗；补丁已回退并重装正常 APK，直连重连正常。

未验证，后续若出现异常优先从这些路径排查：

- 真机（非模拟器）首次配对、设备凭据续连和指纹文案目检。两轮 v0.2.3 验证均在 Android 模拟器完成；不影响此前 v0.2.2 真机触感与焦点验证结论。

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
- 6 位房间码只用于定位房间，不提供指令发送权；首次配对密钥和设备续连凭据才是授权边界。当前 P2P 仍只适合受控测试，尚未进入公开发包。

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
