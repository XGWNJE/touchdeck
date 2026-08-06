# TouchDeck 知识沉淀

> 本文件沉淀 AGENTS.md 拆出的长知识：踩坑实证、布局/皮肤规范、交互手势细节。事实变化时只更新本文件；AGENTS.md 只保留命令与约束索引。

## 悬浮球交互（2026-08-03 v5，小米 15 真机实测）

- **一滑到底滑选**：手指起点在球上直接滑动即展开菜单（锚定起点），球跟随手指、扇区高亮跟随，松手在扇区=选中生效、落空=取消。
- **长按拖球**：按住不动超 350ms 再动=拖球挪位；松手靠近边缘吸附（56dp 内），停中间保持原位。
- **快速点按**：展开/收起常驻菜单。
- **滑选中展开菜单必须 `skipBubbleRetop`**：展开时 remove/add 球视图会重建 ViewRoot 掐断当前触摸流（实证）。
- **手势判定阈值**：350ms 内位移未超阈值才进拖球。adb 慢速 swipe（位移太小）会被误判为拖动；模拟滑选要用快速 swipe。
- **模拟器注入限制**：`input swipe` 会被 CANCEL（`bubble CANCEL` 日志），需 `input motionevent DOWN/MOVE/UP` 分段注入，且**总时长 <350ms**（adb 命令间有 ~100-300ms 延迟，sleep 过多会误判拖球）；球被拖走后窗口位置会变，注入坐标须先查 `dumpsys window windows`。

## Windows 悬浮球（bubble.html + menu.html）

- **仅键鼠交互**（2026-08-05 定案，触控滑选手势已移除）：快速点球=展开/收起常驻菜单；按住 Tab（globalShortcut）展开菜单、悬停扇区高亮、左击或松 Tab（主进程轮询 GetAsyncKeyState(0x09) 发 `menu-confirm`）确认、再按 Tab 收起；长按球 350ms=拖球挪位。
- **长按拖动反馈**（2026-08-06）：按下即起 conic 进度环（rAF 驱动 `--p` 与 350ms 计时同源走满），到点进 armed 态（球放大 1.12 + 青色光晕 + 环常亮）——用户明确知道「现在可以拖了」；松手/取消即复位。**覆盖层必须 `pointer-events: none`**：进度环 div 盖在球上，漏了这条会把球的 pointerdown 全截走、鼠标完全失控（2026-08-06 实证）；教训——CDP `dispatchEvent` 直达目标元素、绕过命中测试，验证不了这类拦截，涉及命中的改动必须用真实输入（nut 点击）复验。
- **拖球边界与吸附**（2026-08-06）：拖动全程 `clampToWorkArea` 夹取（整球不出工作区，与边缘保持 EDGE_MARGIN=12 逻辑像素极限距离）；松手按阈值吸附——距某边 ≤64px（SNAP_THRESHOLD）才吸该边，四边独立判定、邻边同入阈即吸四角，否则停原位；~140ms 缓动滑边后持久化吸附后坐标；启动恢复位置同样过一遍夹取。验证注意：主进程 key-up 收尾依赖 GetAsyncKeyState(0x01)，**CDP 合成 pointerdown 与 nut pressButton 的按键状态它都读不到**（会立即 key-up 收尾）——合成环境测拖动中途态不可行，用「瞬时收尾=吸附立即触发」变相验证吸附/边距/持久化即可。
- **Tab 按住必须 `tabHoldActive` 守卫**（2026-08-05 实证）：按住 Tab 时 Windows 键盘自动重复会反复触发 globalShortcut 回调（RegisterHotKey 机理），无守卫时重复触发走到「再按 Tab 收起」分支，菜单在按住期间被误关掉。守卫区分「按住期间的重复触发」（忽略）与「松开后的再次按下」（收起）。
- 菜单窗口为展开时创建、收起销毁的全屏透明层；菜单窗口内按 `ballSize` 同尺寸绘制球芯（内环间隙动态 ≥ 球半径+6，球不被扇区压）；hover 高亮由 `pressedIndex` 统一驱动。
- **拖球收尾双兜底**（2026-08-05 本机模拟实证：SetWindowPos 移动窗口会中断 pointer capture 导致松手信号丢失）：主进程轮询 GetAsyncKeyState(0x01) 左键抬起（`drag end (key-up)`，本地鼠标可靠；UU 触控注入读不到按键状态）+ 静止 400ms idle；渲染端 pointerup 仍是最快路径。

## 安卓悬浮球（Kotlin 薄壳 + RadialMenuView）

### MIUI 三个坑（2026-08-03 真机实证）

1. **展开层坐标偏移**：展开层窗口即使带 FLAG_LAYOUT_IN_SCREEN 实际也从状态栏之下开始（高 2530 < 物理 2670），与球窗口全屏坐标系差一个顶部偏移，必须挂载后 `getLocationOnScreen` 把球心换算进展开层坐标系，否则菜单不居中、扇区点不中。
2. **Toast 被静默拦截**：未授权通知时 Toast 被系统拦截（logcat: Suppressing toast），选中反馈用自绘小浮层 flashLabel（连续触发替换旧浮层防叠加）。
3. **重装后权限重置**：install -r 后 SYSTEM_ALERT_WINDOW 被重置为 ignore 且可能被 MIUI 回改。启动流程：force-stop → 开 MainActivity → `appops set cn.touchdeck.app SYSTEM_ALERT_WINDOW allow` → 立即点「启动悬浮球」。

### 布局规则（2026-08-05 修订）

- 全场景按钮等面积：弧长 L=dp108、环厚 T=dp70 恒定，每环槽位数=round(展开角×环中半径÷L)。
- **按钮区完整可见才落位**（双端同一规则）：判定点=按钮内容区（图标盒 0.38T + 文字盒 0.76T，中角方向，半宽 dp18）完整在屏内（含 dp10 margin）；被屏边挡住的槽位跳过、按键顺延到下一可见槽位（裁的是环上角度不是按键）。
  - 不查扇区角尖：贴角/出屏锚点下楔形角尖必然越界，全扇区检查会把首环整环卡死（2026-08-05 MIUI 状态栏锚点实测 0/12 菜单全空）。
  - 旧版只查扇区中点：按钮外缘越出屏幕（2026-08-05 用户实测报告）。
- 环停止条件：锚点出屏（MIUI 状态栏）时首环可能整环不可见、外环反而伸得回屏内——只有内径超过屏幕对角线才停；排不下宁可加外环，仍有丢弃则日志告警（`menu DROPPED`）。
- MIUI 展开层真实可视高（物理屏减状态栏）由 BubbleService 挂载后传入 RadialMenuView，不再用 displayMetrics 近似（底部判定才准确）。
- 默认布局 14 键（语音/Steer/中断/发送/退格/命令/Plan/全选/换行/继续/清空/文件/复制/粘贴，layouts/left-dock.json；「继续」= paste 继续+Enter、「清空」= Ctrl+A+Backspace 两个宏）。

### 皮肤（C 方案极简发光 HUD，design/menu-scheme2-C-minimal.png）

- 扇区不填色、发丝白环+径向分割线、白图标小标签、选中扇区青色（0xFF22D3EE）发光外弧（递宽递淡三描边近似，硬件加速下 BlurMaskFilter 不可靠）+ 淡青填充。
- 不要全局压暗遮罩（用户明确：只有菜单影响画面）；可识别度靠扇区黑透底 0xA6000000（局部磨砂近似，悬浮窗无截屏权限做不到真毛玻璃）。

## 宏引擎与目标绑定（2026-08-06 实证）

- **IME 是 text/keys 步骤的环境变量**：目标窗口挂着中文输入法时，`text` 步骤的字母进候选框不直接落字，此时 `Enter` 被 IME 吞去「上屏候选」而不是换行（实测：macro-ok 落字但尾部换行丢失；tgt 触发候选条）。`paste` 步骤完全免疫（剪贴板不经过 IME）。**宏设计原则：中文/关键文本走 paste；text 仅用于确定无 IME 的场景（终端/英文输入态）**。
- **前台探测用 koffi 直调**（不用 nut-js 异步窗口 API）：GetForegroundWindow → GetWindowTextW（标题）→ GetWindowThreadProcessId → OpenProcess(0x1000) + QueryFullProcessImageNameW（进程名）。500ms 轮询缓存，注入热路径不调 Win32。面板窗口 focusable:false，探测到的永远是目标应用。
- **UU 远程会话下合成点击的前台切换取决于落点**（2026-08-06 修订实证）：点击落在目标窗口可见区域时前台正常切换（key-target 靶窗实测）；此前「合成点击不改前台」实为最大化浏览器遮挡导致点击落空。验证脚本切前台的兜底仍是 AttachThreadInput 借道 SetForegroundWindow（`prototype/nputil.mjs forcefocus`）。生产环境无此问题：UU 触控注入是驱动级真实输入。
- **target 拦截语义**：fg 探测失败（fgCache 为空）时带 target 的按钮一律拦截——宁可拦错不放过，宏落错窗口比不执行更难发现。
- **队列串行语义**：三源（local/menu/peer）FIFO 单消费者，上限 16 溢出丢最新；步骤抛错中止当前宏继续队列。验证法：本机 press + peerPress 紧接触发两宏，记事本字符序列证明无交错。
- **纯修饰键组合按住时长可配**（`behavior.modifierHoldMs`，默认 120ms）：微信输入法 Ctrl+Win+Shift 这类 IME 热键靠「按住窗口」识别，过短可能漏触发。
- **配置热重载（2026-08-06）**：fs.watch 监听用户配置 + layouts/ + themes/，改动免重启——清图标缓存 → 重建面板 → 重推安卓按钮集 → 控制台 toast 配置错误。两个坑：①根目录监听必须按文件名过滤只认 touchdeck.config.json（state.json 拖球回写会触发重载循环）；②JSON 改坏时 resolveConfig 沿用进程内上一份有效配置（lastGood），注入链路不被坏保存打断，构建脚本（进程内首次解析）无缓存可沿照旧抛错。
- **ipcMain.on 注册必须一次性**（2026-08-06 实证）：toggle-menu/close-menu 曾挂在 createBubbleWindow 里，面板每次重建（启停/DPI/热重载）叠加一个监听——两个监听把一次 toggle 执行成「开+关」，菜单闪开即收。凡写在窗口创建函数里的 ipcMain.on 都是同款地雷。
- **nut-js 坐标是逻辑像素**：`screen.width()`=1707（逻辑屏），setPosition 超出被钳到屏边；而 Win32 MoveWindow/GetWindowRect 是物理像素，混用必偏（1.5x 屏差 1.5 倍）。宏端到端验证用按键靶窗 `prototype/key-target.cjs`（alwaysOnTop 自建 Electron 窗 + CDP 9223 读回事件流），比记事本聚焦战可靠；注意靶窗事件监听挂 document 而非 textarea——点击非聚焦区（log 面板）会把焦点挪到 body，挂 textarea 会漏记。
- 验证工具：`prototype/nputil.mjs`（focus 点击聚焦 / forcefocus 强切前台 / readtext Ctrl+A+C 读前台文本并回显前 200 字，注意会盖剪贴板）。

## P2P 直连（WebRTC）踩坑

- **client 必须先 createDataChannel 再 createOffer**，否则 SDP 无 m=application 段，连接永远建不起来（实测验证）。
- **PeerConnectionFactory 必须长持有**（类字段）：局部变量会被 GC 回收导致 native 悬挂，network_thread SIGABRT（2026-08-05 实证）。
- **必须声明 ACCESS_NETWORK_STATE 权限**：缺失时 webrtc NetworkMonitor.getNetworkState 抛 SecurityException → native CHECK 失败 SIGABRT（2026-08-05 实证）。
- **PeerConnectionFactory.initialize 需 Context**：InitializationOptions.builder(applicationContext)，在创建 factory 前调用（P2PState.appContext 由 MainActivity onCreate 设置）。
- 本机网络 UDP 被代理 TUN 挡死时走 TURN-TCP 兜底（信令返回 urls 数组带 transport=udp/tcp 两个地址）；VPN 开时打洞慢是预期。
- 信令 WebSocket 无心跳会半开僵死（TCP 没 FIN，onclose 不触发，UI 显示陈旧"等待手机加入"，实际信令已死）——服务端 30s 心跳 terminate 死连接 + 客户端断线自动重连；客户端手动停止须设 stopped 标志防僵尸重连。
- 多客户端（2026-08-05）：服务端 1 host + 8 clients，clientId 路由（client→host 消息自动附 from，host→client 消息带 to）；host 侧按 clientId 维护独立 RTCPeerConnection；一个房间多台设备同时连、同时按键。

### 断线健壮性（2026-08-05 全套实证）

- **重连三大陷阱（全部真机踩过）**：
  1. 重连任务里主动 `closeWs()` 会触发 `onClose`，必须 `intentionalWsClose` 标记吞掉，否则 onClose 又排一次重连，健康连接被反复误拆（churn 环）。
  2. `ConnectivityManager.onAvailable` 在 VPN（Clash）下高频触发，每次都立刻重连会打断刚建好的连接（活锁）——只有长退避（>3s）才提前，短退避/在途任务不打扰。
  3. 多事件源（ICE CLOSED/通道 CLOSED/心跳看门狗）都会触发重连：已有在途任务时**不得取消重排**（看门狗 10s 一喊、30s 退避任务永远跑不了，活锁），只能事件去重、任务唯一。
- **健康判定按 pong 新鲜度**：通道 open 且 20s 内有 pong 才算健康（ICE 可自愈，不折腾）；开而不通的僵尸通道必须拆掉重建。
- **DataChannel 应用层心跳**：client 每 5s ping、host 回 pong；双端 20-25s 无消息判半开（WiFi 切网 TCP 无 FIN 的场景靠它发现）。
- **房间 reclaim**：host 持久化房号，重连 `create-room` 带原房号；服务端 host 掉线进 90s 宽限期（不删房，client 收 `host-gone` 保持 WebRTC），host 回来自动复房（client 收 `host-back`）；宽限期满才删房。信令整体重启后 host 也能用房号重建，WebRTC 连接本身不断——实测 VPS 重启信令后双端按键无感。
- **`room-not-found` 是瞬态**（信令重启/host 未 reclaim 窗口期）：按重连重试（退避上限内自愈）；room-full/room-expired 才是终态。
- **房间 TTL 30 分钟**：服务端 60s 定时清扫，到期主动通知 host（`room-expired`，控制台进终态提示重新开启）与 client（`peer-left`），不再有僵尸房号。
- **peer 窗口启动竞态**（2026-08-06 实证）：`peer-start` IPC 在页面加载完成前 send 会丢消息，卡「连接信令中」——主进程须 `isLoading()` 判断，挂 `did-finish-load` 再发。模块脚本（vite 构建）比内联脚本慢一拍，迁 TS 后才暴露。

## 正式版迁移（2026-08-06，TS + React + Tailwind）

- **electron-vite 5 四页多入口**（console/bubble/menu/peer）；`"type": "module"` 后主进程 ESM 输出，项目内残留 CJS 脚本须改 `.cjs`（key-target 实证）。
- **preload 必须保持 CJS 输出**（渲染进程默认 sandbox，ESM preload 不兼容）：electron.vite.config.ts 里 preload 强制 `format:"cjs"` + `.cjs` 后缀，窗口引用 `out/preload/index.cjs`。
- **路径基准**：`out/main/index.js` 上溯两级 = 包根（dev=项目根，打包=asar 根）；渲染页 dev 走 `ELECTRON_RENDERER_URL`，产物/打包走 `out/renderer/<页>/index.html`。
- **electron-builder files 必须显式带运行时数据**：`out/` + touchdeck.config.json + layouts/ + themes/ + icons/ + src/assets/——只列代码目录会把配置文件落在 asar 外，打包版启动即死（迁移时修复的存量隐患）。
- **打包版配置/状态必须外置 userData**（2026-08-06 v0.2.1 实证）：asar 只读，saveState 静默失败 → 面板关闭标记存不上 → 控制台启停逻辑每次必读 false → 关了就永远开不回来。外置规则：主进程首启把包内默认配置播种到 `userData/touchdeck.config.json`；此后配置/状态读写全走 userData（dev 仍用仓库根，保持改仓库配置即热重载的工作流）；layouts/themes/icons 外置优先、包内兜底（用户可往 userData 丢自定义包）；热重载监听 userData 根目录（文件名过滤，state.json 回写防循环）。
- **React 壳包 canvas 的范式**：CSS 原样留页头（选择器契约不变），逻辑进 `main.tsx`，高频 pointer 事件走 ref + body.classList 直操，不走 React state（零重渲染，行为逐行等价）。
- **@vitejs/plugin-react 须 ^5**：^6 要 vite 8，与 electron-vite 5 的 vite ^7 冲突。
- **真机 Clash VPN 下 ICE 周期性 DISCONNECTED→FAILED→自愈**（约每分钟一次）：属预期现象，连接保持 open 不干预即可，勿因此拆连接。
- host 侧设备计数按「通道实际 open」的设备数；channel.onclose 必须清理 peers Map（否则计数永久虚高）。

## UU 触控注入限制（2026-08-02 实测）

- UU 触控注入下 pointermove 与 GetAsyncKeyState 均不可靠：不得用移动阈值判拖拽、不得用 GetAsyncKeyState 判松手。
- 拖拽双通道：小揪揪手柄（布局包 `handle`，原生拖拽区，面板贴顶/底边时自动翻面）与按钮长按抓起（`behavior.dragHoldMs` 默认 500ms，松手信号只信渲染端 pointerup）。
- 页面缩放已锁死（setVisualZoomLevelLimits(1,1)），UU 多点触控注入不得引发捏合缩放。

## 端到端验证工具链（2026-08-05 定型，通用方法）

- **CDP 驱动器**（`prototype/cdp-drive.mjs`，已入库）：`npx electron . --remote-debugging-port=9222` 启动后，`node prototype/cdp-drive.mjs <url子串> <JS>` 可在任意渲染窗口（console.html/peer.html/menu.html）内执行 JS——读状态文本、点按钮、触发断线，是控制台状态反馈与 P2P 链路自动化验证的主通道。返回值为 `Runtime.evaluate` 的 returnByValue 结果。
- **透明窗口截图目检**：渲染端调 `window.touchdeck.debugShot()`（desktopCapturer 实现）写 `prototype/screen-dbg.png`；普通 GDI/PrintScreen 抓不到透明分层窗口，勿用。
- **按键注入验收**：记事本置前 → 点按钮 → 前台窗口仍是记事本且字符落入（AGENTS.md 最小验证矩阵）；自动化版是把记事本句柄置前后用 CDP 触发按钮再读记事本内容/前台窗口标题。
- **安卓 UI 自动化坐标法**：`input tap` 按分辨率换算坐标（真机 1200x2670：高级设置 600,705、连接钮 982,919；模拟器 1080x2400：540,598、912,775）；**展开「高级设置」偶发点不中，须先 `uiautomator dump` 确认界面已是「▲ 高级设置」再点连接钮**，否则点到空处。
- **MIUI 触摸盲区**：球贴状态栏时上半部触摸被系统吞，点 (88,140) 之类偏下位置才生效。
- **真机 P2P 日志**：`adb logcat -s TouchDeckP2P TouchDeck`；ICE 周期性 DISCONNECTED→FAILED→自愈（Clash VPN 下约每分钟一次）属预期，勿当 bug 拆连接（判定规则见「断线健壮性」节）。动态按钮集下发成功的标记是 `buttons received: N`（N = aux + 场景按钮总数）。
- **信令服务运维**：VPS 部署路径 `/opt/touchdeck-signal/`，systemd 单元 `touchdeck-signal`（8790 端口，nginx 反代 wss://api.xgwnje.cn/signal）；改 signal.mjs 后 `systemctl restart touchdeck-signal`，host 重连带原房号可秒级 reclaim，双端 WebRTC 无感。

## 诊断知识点备查

- mWakefulness=Awake 不代表屏亮（dumpsys display 的 mState 才是）；KEYCODE_POWER 比 KEYCODE_WAKEUP 更接近真实亮屏。
- 模拟器截屏要 adb shell screencap 存设备侧再 pull（exec-out 重定向会破坏二进制）；PowerShell 里 curl 是 Invoke-WebRequest 别名，用 curl.exe。
- 模拟器 /data 不足时 install -r 会静默失败（INSUFFICIENT_STORAGE），须看完整输出；扩容：config.ini `disk.dataPartition.size` + `-wipe-data` 启动。
