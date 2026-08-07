# CHANGELOG

加工历史：新增/修复/变更，只新增不改旧。每个版本一节，CI 发包时自动提取对应版本段落作为 GitHub Release 更新说明。

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
