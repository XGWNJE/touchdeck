# touchdeck-signal 信令服务

TouchDeck P2P 直连的信令服务（部署在 VPS）：WebSocket 房间配对 + SDP/ICE 中继 + TURN 凭据下发。1 房间 1 host + 8 clients，clientId 路由；30s 心跳清理半开死连接。

## 依赖

- Node.js 18+
- TURN 中继（coturn）与信令服务分开部署，见 AGENTS.md 的 P2P 段落
- 部署机需放行 8790 端口（或经 nginx 反代 `/signal` → 127.0.0.1:8790）

## 部署

1. 解压发行包到 `/opt/touchdeck-signal/`（代码 + 依赖）。
2. 创建 TURN 凭据文件（供信令下发给客户端）：
   `/etc/touchdeck-signal/turn-credentials`，内容一行 `用户名:密码`。
3. 创建运行用户：`useradd -r -s /usr/sbin/nologin touchsignal`。
4. 安装 systemd 单元并启动：

```bash
cp server/deploy/touchdeck-signal.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now touchdeck-signal
```

5. （可选）nginx 反代：

```nginx
location /signal {
    proxy_pass http://127.0.0.1:8790;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
}
```

## 配置

- 端口：`signal.mjs` 内 `PORT = 8790`。
- 房间有效期 30 分钟；TURN 凭据文件缺失时客户端仅收到 STUN。
- 心跳：30s ping，60s 无 pong 视为死连接 terminate（触发 onclose → 房间回收）。
