# touchdeck-signal 信令服务

TouchDeck 的 P2P 信令服务：负责 WebSocket 房间管理、SDP/ICE 信令交换和 TURN 凭据下发。

## 边界

- 服务端只负责建连和信令交换，不转发按钮、不执行宏、不保存用户输入。
- 按键必须经 WebRTC DataChannel 直达 Windows Host。
- 当前 6 位房间码不是完整的身份认证方案；在安全配对阶段完成前，仅用于受控测试，不作为公开分发的安全边界。
- 可靠指令闭环由 Android、WebRTC DataChannel 和 Windows 执行器共同完成，不在信令服务中实现 ACK。

## 依赖

- Node.js 18+
- TURN 中继（coturn）与信令服务分开部署
- 部署机需放行 8790 端口，或经 nginx 反代 `/signal` 到 `127.0.0.1:8790`

## 部署

1. 解压发行包到 `/opt/touchdeck-signal/`。
2. 创建 TURN 凭据文件 `/etc/touchdeck-signal/turn-credentials`，内容为一行 `用户名:密码`。
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
- 房间有效期 30 分钟。
- 1 个 Host 最多 8 个 Client。
- 心跳：30 秒 ping，60 秒无 pong 终止死连接。
- TURN 凭据文件缺失时，客户端仅收到 STUN 配置。
