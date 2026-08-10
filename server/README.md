# touchdeck-signal 信令服务

TouchDeck 的 P2P 信令服务：负责 WebSocket 房间管理、SDP/ICE 信令交换和 TURN 凭据下发。

## 边界

- 服务端只负责建连和信令交换，不转发按钮、不执行宏、不保存用户输入。
- 按键必须经 WebRTC DataChannel 直达 Windows Host。
- 6 位房间码只用于定位房间；每台新设备使用独立的 5 分钟一次性配对密钥，Host 可在上一枚被消费或过期后请求下一枚。已登记设备使用各自续连凭据，Host 使用独立凭据恢复房间。
- 新配对密钥只保存哈希且只能成功使用一次；生成下一枚会撤销尚未消费的旧枚。Host 与设备凭据同样只保存哈希，普通关闭会话不撤销设备；Host 可显式忘记全部设备。P2P 当前仍只用于受控测试。
- 可靠指令闭环由 Android、WebRTC DataChannel 和 Windows 执行器共同完成，不在信令服务中实现 ACK。

## 依赖

- Node.js 18+
- TURN 中继（coturn）与信令服务分开部署
- 部署机需放行 8790 端口，或经 nginx 反代 `/signal` 到 `127.0.0.1:8790`

## 部署

1. 解压发行包到 `/opt/touchdeck-signal/`。
2. 在 `/etc/touchdeck-signal/security.env` 配置 TURN 临时凭据所需环境变量，不把密钥写入仓库或命令输出。
3. 创建运行用户：`useradd -r -s /usr/sbin/nologin touchsignal`。
4. 安装 systemd 单元并启动：

```bash
cp server/deploy/touchdeck-signal.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now touchdeck-signal
```

5. 如需 nginx 反代：

```nginx
location /signal {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## 当前运行参数

- 端口：`signal.mjs` 内 `PORT = 8790`。
- Host 在线期间房间滚动续期；Host 信令断开后保留 90 秒恢复窗口。
- Host 身份、设备凭据哈希和活动一次性密钥哈希由 systemd `StateDirectory` 持久化到 `/var/lib/touchdeck-signal/device-registry.json`；目录 `0700`、文件 `0600`。
- 生产设置 `TOUCHDECK_DEVICE_STORE_REQUIRED=1`：状态文件缺失、损坏或 schema 不兼容时拒绝启动，不静默退回空登记。
- 1 个 Host 最多 8 个 Client。
- 每个 Host 房号最多累计登记 32 个设备凭据；可从控制台“忘记全部设备”统一撤销。
- 心跳：30 秒 ping，60 秒无 pong 终止死连接。
- TURN 凭据文件缺失时，客户端仅收到 STUN 配置。
