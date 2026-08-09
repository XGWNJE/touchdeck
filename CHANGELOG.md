# CHANGELOG

加工历史：新增/修复/变更，只新增不改旧。每个版本一节，CI 发包时自动提取对应版本段落作为 GitHub Release 更新说明。

## v0.2.3（2026-08-10）

可靠指令闭环（v0.2.2）与安全配对（v0.2.3）按路线要求合并发布，不拆分中间版本。

### 新增

- 远程指令可靠性闭环：每次远程按键带版本化消息与唯一 `requestId`，贯穿 Android、WebRTC、Windows 执行器与日志；统一六态回执 `queued`/`executed`/`blocked`/`failed`/`disconnected`/`timeout`，`executed` 只代表 Windows 宏真实完成
- Host 幂等去重：同一 `(clientId, requestId)` 最多执行一次，重复包只回已知状态；Android ACK 超时以同一 `requestId` 重试一次后报 `timeout`，迟到 ACK 不覆盖终态
- 目标保护：带 `target` 的按钮在入队和实际注入前双重前台探测，不匹配或探测失败一律 `blocked`，不向未知窗口注入；宏队列上限 16，溢出明确 `failed`
- Android 反馈区分等待、成功、拦截、失败、断线与超时，不只依赖颜色；非法消息 Host 明确回 `failed`，不再静默等待
- 安全配对：首次配对密钥服务端只存哈希、5 分钟失效、首用即作废；设备续连凭据保存在应用私有区（禁止备份）；主机凭据 reclaim 房间并出示 16 位主机指纹供双端对照；信令按来源限速，错误凭据/重放/冒名 reclaim 明确拒绝；TURN 改短期 REST 凭据
- 控制台：房间码与配对密钥均可点击复制，显示主机身份指纹
- Android：长按 350ms 进入拖球模式时震动 40ms，明确感知可移动时机

### 修复

- 动作处于 `queued` 时 Host 断线，Android 约 8 秒后误报 `timeout`；现立即报 `disconnected / host-gone`
- 双端应用图标不统一：Windows 与 Android 统一为新标识

### 变更

- Android 远程消息从 `{id}` 单向包迁移为带版本和 `requestId` 的协议消息，ACK 定向回发起设备，不再广播执行结果
- 6 位房间码只用于定位房间，不再是授权边界；当前 P2P 仍仅适合受控测试
- 自动化测试补齐协议格式、幂等、目标保护、队列溢出、配对与限速共 10 项；`npm test` 成为可靠性验证入口

## v0.2.1（2026-08-06）

### 修复

- 打包版面板关闭后无法重新打开
- 打包版 asar 只读导致配置/状态不可写：配置与状态外置 userData，首启播种包内默认配置，此后读写全走外置；layouts/themes/icons 外置优先、包内兜底，用户可丢自定义包

### 变更

- 产品路线定案：定位（远程 vibe coding 触控操作台）、自定义能力边界、三场景预设包、版本排期（docs/roadmap.md）

## v0.2.0（2026-08-06）

### 变更

- 正式版迁移：Electron + TypeScript + React + Tailwind（electron-vite 构建），主进程拆模块，渲染层多页入口；此前为原生 JS 原型期
- 控制台迁 React + Tailwind，bubble/menu 迁 React 壳（视觉零变化）

### 新增

- 配置热重载：用户配置 / layouts / themes 三源 fs.watch，改动免重启；JSON 改坏沿用上一份有效配置
- 纯修饰键组合按住时长可配（behavior.modifierHoldMs）
- 宏引擎 + 按钮目标绑定（target 前台匹配拦截）+ 常驻辅助键（auxButtons）

## v0.1.7 及更早（原型期）

原生 JS 原型：悬浮球 + 径向菜单（Windows/安卓双端）、P2P 直连远程按键（WebRTC）、按键宏四型步骤、场景感知切换。详见 git 历史。
