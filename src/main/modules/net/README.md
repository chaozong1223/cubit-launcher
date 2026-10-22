# `net` — 联机模块（t9）

实现 `docs/04-multiplayer-design.md` 的 MVP：房主开房 / 成员加入 / 邀请码 / EasyTier no-TUN 隧道 / 降级链 / 心跳与错误码。

## 注册与对外接口

- 目录：`src/main/modules/net/index.ts`，导出 `moduleId = 'net'` + `register(ctx)`；由 t5 文件系统注册表自动发现，**不改** `src/main/index.ts` / `package.json`。
- 契约：`src/shared/net.ts`（10 methods / 5 events）。t20 的内核 IPC 会自动发现 `net` 契约与 `handlers.ts`，无需改 preload/ipc。
- 发布服务：
  - `getService('net')` → `RoomService`
  - `getService('link')` → 同一实例（兼容 03 的模块名）
  - `getService('net.handlers')` → `makeHandlers(service)`（备用）
- `RoomService.onEvent(event, listener)` 支持 `state/members/world/error/lanWorlds`，t20 会桥接为 `mc:net:evt:*`。

## 主要流程

### 房主 `create({instanceId, transport:'lan'|'auto', consentTunnel})`

1. 生成 `roomId` / 6 位 Crockford 短码 / Ed25519 密钥 / 32B 网络密钥。
2. 在 `lanIp:0` 启动控制面（仅私网/回环；`0.0.0.0` 直接拒绝）。
3. `transport='auto' && consentTunnel`：校验/下载 EasyTier 2.7.0 → no-TUN 启动：
   - `-i 10.144.144.1 --no-tun -n 127.0.0.<alias>/32->192.168.77.1/32`
   - `-l tcp://<lanIp>:<peerPort>`（**永远显式传**）
   - `-r 127.0.0.1:<rpc> --rpc-portal-whitelist 127.0.0.1/32`
   - 在 alias 上再开一个控制面端口，供成员 `--port-forward`。
   - 失败只降级为 LAN 房间，错误码 `TUNNEL_START_FAILED`，不影响开房。
4. `issueTicket()` 生成 `MCL1.<code>.<payload>.<sig>`；`copyInvite` 返回完整 ticket（短码仅展示/LAN 发现）。
5. 订阅 `launch:evt:output`，并轮询 `dataRoot/logs/game/<实例>/` 最新日志，匹配 `Started serving on <port>` / `Local game hosted on port <port>`，更新世界端口并重签 ticket；也可由 UI 调 `setWorldPort`。这样房主在开房前已经开好的 LAN 世界也能被发现。
6. 成员列表始终包含房主（`role=host`、`pingMs=0`）；成员通过 `PING/PONG/STATS` 上报 RTT，列表带 `pingKnown/pingLabel/status`，无样本时为 `未知` 而不是 null 字段。

### 成员 `join({ticket, instanceId})`

1. 校验 ticket（格式/签名/短码派生/有效期/端点范围），实例版本/加载器不匹配直接 `VERSION_MISMATCH` / `LOADER_MISMATCH`。
2. 先试 ticket 的 LAN 控制面；成功 → `transport='lan'`，无需 sidecar。
3. 失败且 ticket 有隧道信息 → 启动成员 sidecar：
   - `--no-tun --no-listener -p tcp://<hostLan|relay>:<peerPort>`
   - `--port-forward tcp://127.0.0.1:<localControl>/192.168.77.1:<controlPort>`
   - 世界端口已知时再加 world 转发；未知则收到 `EVENT world` 后由 `easytier-cli port-forward add` 补上。
4. 通过 `127.0.0.1:<localControl>` 连控制面、HMAC 认证、进入 `connected`；`enterWorld` 调 launch，把 `{host:'127.0.0.1', port:<localWorld>}` 作为 `server` 注入（t6 对 1.20+ 转 `--quickPlayMultiplayer`）。
5. 只有存在隧道/中继路径且隧道失败时才进入 `transport='manual'`；LAN 直连失败且没有隧道路径时返回 `NETWORK_UNREACHABLE`（可区分“房主已关房/旧邀请码”与“需要手动映射”）。
6. LAN 世界发现：`lanWorlds({timeoutMs})` 读取 MC 组播 `224.0.2.60:4445` + 本机最新游戏日志，返回 `LanWorld[]` 和 `reason`（找不到世界时的可读中文原因）；`joinLanWorld({worldId,host,port,instanceId,accountId})` 校验目标后启动并注入 `server`。
7. **离线账户限制（t64 实测）**：原版 1.20.1 对 `--quickPlayMultiplayer` 直连会返回“登录失败：无效会话”，因此离线账户不能用 `enterWorld`/`joinLanWorld` 的一键直连进 LAN 世界；必须走原版“多人游戏 → 局域网世界列表”浏览器（房主日志会打印 `Failed to verify username but will let them in anyway!`）。正版账户或后续 main 侧 LAN 浏览器启动模式才能闭环离线一键进服。证据：`docs/08-p0-6-lan-e2e.md`。
8. **LAN 目标策略（t72）**：`joinLanWorld`/`enterWorld` 通过 `os.networkInterfaces()` 判定目标是否为回环、RFC1918、100.64/10（Tailscale/CGNAT）或与本机非内部接口同子网（Radmin 26.x、Hamachi 25.x、ZeroTier 等 VPN 网卡）；日志来源（`local:`）和组播来源（`lan:`）会传入策略。SSRF 仍拒绝公网 IP、解析到公网/混合地址的域名、`0.0.0.0`/`*`、组播和 169.254/16 link-local；域名只解析一次并使用解析后的 IP 启动，避免 DNS rebinding。房主监听也允许本机 VPN 网卡；`pickLanIp` 无 RFC1918 时回退到本机非内部 IPv4。

## 关键约束（t4 实测）

- 只用 EasyTier **2.7.0**；官方 zip SHA-256 `790fd9be…`，core `6490c6f5…`，cli `3afdf2e4…`，wintun `e5da8447…`；下载后逐文件校验；许可证全文内置 `license-text.ts`，安装时写到 sidecar 目录。
- 默认 `--no-tun`（免管理员）；TUN 未实现（P1）。
- **禁止** `127.0.0.1/32` 整段映射（`assertDedicatedAlias` 拒绝）；只映射 `127.0.0.<2-254>/32`。
- **禁止** `0.0.0.0` 监听；`assertListenerScoped` + 启动时校验。
- **禁止** loopback 作为 EasyTier peer（`assertPeerUsable` 拒绝；Windows 10049）。
- `--tcp-whitelist` 不用于安全边界（04 §5.3.4）。
- 公共节点不写死；只在 `config.json` / `MCL_LINK_RELAY` 里配置用户自备中继。
- `RoomInfo` 不含 ticket；`diagnose` 只输出 code/端口/状态，不含 secret。

## 配置

`dataRoot/modules/net/config.json`：

```json
{
  "relayPeers": ["tcp://relay.example.com:11010"],
  "maxMembers": 8,
  "lanIp": null,
  "aliasIp": null
}
```

环境变量覆盖：`MCL_LINK_RELAY`（逗号分隔）、`MCL_LINK_LAN_IP`、`MCL_LINK_ALIAS`。

## 测试

```powershell
npm.cmd --prefix mc-launcher exec vitest run src/main/modules/net
```

覆盖（44 个常规用例 + 1 个 opt-in 真实 LAN 用例，8 个文件）：ticket 签发/验签/篡改/过期/短码；EasyTier 参数约束（显式 `-l`、no-TUN、alias `/32`、拒绝 loopback peer）；host/member LAN 全流程、世界更新、`enterWorld`、房主关闭、版本不匹配、短码拒绝、隧道启动/失败降级、手动指引、事件流；HostControl 心跳超时与 HMAC 拒绝；房主在成员列表、PING/STATS 数值、隧道成员 enterWorld、LAN 日志发现与 joinLanWorld、latest.log 轮转/尾部截断、空结果可读 reason、Radmin 26.x/Tailscale 100.x/localhost/8.8.8.8/组播 SSRF 策略、旧邀请码 `NETWORK_UNREACHABLE`、过期/篡改/版本不匹配中文错误码；下载哈希门禁。

真实 LAN 端到端（需要桌面会话与 `.e2e` 1.20.1 实例，默认跳过）：

```powershell
$env:MCL_REAL_LAN='1'; npm.cmd --prefix mc-launcher exec vitest run src/main/modules/net/__tests__/real-lan.test.ts
```

t64 实测结果与截图：`docs/08-p0-6-lan-e2e.md`、`docs/evidence/t64/`。

## 已知边界

- 跨网 P2P/中继只实现配置与降级编排，未在真实双网络验收（t4 §5.5）。
- 离线账户无法用 `enterWorld` 的一键直连进原版 LAN 世界（Invalid session）；t64 用原版 LAN 浏览器完成真实进世界，闭环需正版账户或 main 侧 LAN 浏览器启动模式（见 `docs/08-p0-6-lan-e2e.md`）。
- 多成员并发未压测；HostControl 支持 ≤8 成员。
- UI 接线由 t16/t50 完成；本模块提供 `lanWorlds`/`joinLanWorld` 契约与 `mc:net:evt:lanWorlds` 事件，LinkPage 尚未消费。
- TUN 模式、自动 UPnP 不在本 MVP（04 的 P1/P2）。
