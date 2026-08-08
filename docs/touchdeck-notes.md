# TouchDeck 知识沉淀

> 本文件只记录已验证的实现事实、踩坑和当前缺口。产品路线以 `docs/roadmap.md` 为准，操作规则以 `AGENTS.md` 为准。

## 当前可靠性缺口

以下是实现现状，不是已完成能力：

- Android 当前发送 `{id}`，Windows 收到后只进入本地 FIFO 队列，没有 `requestId` 和远程 ACK。
- Android 的“已发送”只代表 DataChannel `send()` 调用成功，不能代表动作已执行。
- Windows 执行反馈目前只发给控制台，未定向回到原 Android 设备。
- `target` 当前在入队时检查，真正注入前还需要再次检查。
- 前台探测异常时当前缓存可能保留旧窗口，必须在可靠性闭环中引入明确的失效语义。
- 当前没有可靠性自动化测试，也没有 `test`/`lint` npm 脚本。
- `confirm` 字段已经在部分配置和传输代码中流转，但菜单端尚未形成完整的确认交互；可靠性闭环前不得继续扩展该能力。

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
