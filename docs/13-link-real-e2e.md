# 联机真机验证（2026-10-24 晚）

> 目标：不是「单测绿了」，而是用**真实的 EasyTier sidecar** 走一遍「房主开房 → 邀请码带 WAN 端点 → 成员拨过去 → 端口转发 → 控制面握手」。
> 复现命令见文末。

## 1. 环境

| 项 | 值 |
|---|---|
| 机器 | 本机（Windows 10.0.26100），非管理员 |
| 网卡 | `10.91.60.10`（局域网）、`26.125.118.57`（Radmin VPN）、若干 169.254 自动地址 |
| EasyTier | 2.7.0，取 `release/win-unpacked/resources/easytier`（哈希校验通过的发行副本） |
| 入口 | `src/main/modules/net/__tests__/real-tunnel.test.ts`（`MCL_REAL_TUNNEL=1` 才跑，默认 skip） |

## 2. 结果：通了

```
✓ real EasyTier tunnel (opt-in: MCL_REAL_TUNNEL=1) > lets a member reach the host control plane through the invite WAN endpoint 2062ms

[real-tunnel] member args: ["-i","10.144.144.2","--network-name","mcl-4y6ja","--no-tun","--no-listener",
  "-p","tcp://10.91.60.10:51919","--port-forward","tcp://127.0.0.1:51928/192.168.77.1:51924",
  "-r","127.0.0.1:51926","--rpc-portal-whitelist","127.0.0.1/32","--private-mode","true",
  "--relay-network-whitelist","mcl-4y6ja","--enable-quic-proxy","--enable-kcp-proxy","--use-smoltcp",
  "--encryption-algorithm","chacha20","--disable-ipv6"]
[real-tunnel] member control listener accepted after 266ms
```

验证到的事实：

1. 房主 sidecar 起来，`tunnel.state = up`，`ports.peer > 0`；
2. `copyInvite()` 的 payload 里 `endpoints[0]` 是 **`{kind:'wan', host, port: peerPort}`**，`tunnel.controlPort` 与房间控制端口一致；
3. 成员 sidecar 用邀请码里的 WAN 端点做 `-p tcp://…`，`--port-forward` 在本地开出控制端口；
4. `MemberControl.connect()` 拿到 `WELCOME`：房间号一致、成员列表里有房主 → **控制面 HMAC 认证、版本/加载器校验、心跳都真实跑通了**；
5. 全流程 ~2.0s（两个 sidecar 冷启动）。

一台机器上两个 sidecar 互拨，走的是本机 LAN 地址而不是回环——因为 EasyTier 明确拒绝 loopback peer（`WSAEADDRNOTAVAIL 10049`，`args.ts` 里 `assertPeerUsable` 的守卫是对的）。

## 3. 顺手挖出的两个真问题

### 3.1 §4「公网探测拿到空 stdout」不是 asar 的锅

在**纯 Node**（不在 Electron、不在 asar）里对同一个 sidecar 执行 `easytier-cli --rpc-portal 127.0.0.1:<rpc> node`，原始输出是：

```
| Virtual IP     | 10.144.144.1/24                      |
| Hostname       | GL-SXWBSCOOREEJ                      |
| Proxy CIDRs    | 127.0.0.55/32->192.168.77.1/32       |
| Peer ID        | 3596975020                           |
| UDP Stun Type  | Unknown                              |
| Interface IPv4 | 26.125.118.57                        |
| Interface IPv4 | 10.91.60.10                          |
| Interface IPv6 | fdfd::1a7d:7639                      |
| Listener 1     | tcp://10.91.60.10:51459              |
```

**没有 `Public IPv4` 行**，exit code 0，stderr 空。原因写在表里：`UDP Stun Type | Unknown` —— STUN 没打通时 EasyTier 根本不打印公网地址。所以打包版日志里的 `candidates: []` 是**真实结果**，不是子进程环境问题；之前手工执行能拿到 IP，是那次 STUN 成功了。

结论与改动：

- `publicip.ts` 现在解析 `UDP Stun Type` 写进日志和 `probeDetail`，空结果会解释成「STUN 未打通」而不是无话可说；
- 公网地址的主来源改为 HTTPS echo（`ip.3322.net` → `icanhazip.com` → `api.ipify.org`），实测返回 `219.143.23.90`，与手工查的一致；
- 手填地址仍然优先（`effective: 10.91.60.10` 的例子见日志）。

### 3.2 成员侧原来会「抢跑」握手

`startMember()` 只等 sidecar 的 RPC 端口就返回，**本地 port-forward 监听还要 ~250ms 才起来**。原来的 `tryTunnel` 紧接着就 `MemberControl.connect()`，于是：

```
LinkError: connect ECONNREFUSED 127.0.0.1:63604
    at Socket.<anonymous> src/main/modules/net/control.ts:520
```

——隧道其实是好的，却被判成 `NETWORK_UNREACHABLE`，然后整个候选被放弃。现在 `connectMemberControl()` 会对 `NETWORK_UNREACHABLE` / `HEARTBEAT_TIMEOUT` 重试 4 次（400/800/1200ms 退避），版本/加载器/认证类错误立即失败。单测覆盖：`retries the control handshake while the sidecar is still opening its port-forward`。

## 4. 中继真机实验：没通（2026-10-24 19:06）

想验证"双方都连不上对方、只能靠中继"的场景，起了**第三个** EasyTier 进程当中继：

- 拓扑：房主 `-p tcp://<lan>:<relayPort>`，成员 `-p tcp://<lan>:<relayPort>`（成员完全不知道房主地址），中继节点在同一网络名/密钥下 `-l tcp://<lan>:<relayPort>`、无 port-forward、无 TUN。
- 观察：
  - 中继节点 202–216ms 就绪（RPC 可连）；
  - 成员的 sidecar 确实连上了中继：`CORE::INSTANCE::CONNECTION … new peer connection added … remote_addr: tcp://10.33.135.230:<relay>`；
  - 成员的本地 port-forward 端口能 accept TCP；
  - 但控制面握手**每次都是 `read ECONNRESET`**：5 次重试、跨 ~40 秒，全部一样。
- 结论：**"仅靠中继"这条路径没有被证明可用**。要么三个节点没真正合并进一个虚拟网络（网络名/密钥不一致、或 `--private-mode true` 拒绝转发），要么房主的 `192.168.77.1` 代理映射在中继链路上不可路由。
- 下一步诊断（下次开工先做这个）：房主和成员都起来后，用
  `easytier-cli --rpc-portal 127.0.0.1:<relayRpc> peer`
  读中继自己的 peer 表，看房主和成员是否互相可见；再对比 `--private-mode true` 与不加它的差别。
- 复现脚本保留在 `src/main/modules/net/__tests__/real-relay.test.ts`（**`describe.skip`**，文件头写了现象），等有真公网中继时改回 `describe` 直接跑。

## 4.5 出口地址是会变的（2026-10-24 两次实测）

同一台机器一个小时内：出口公网 IP `219.143.23.90` → `219.143.23.125`；局域网地址 `10.91.60.10` → `10.33.135.230`。所以：

- 手填的公网地址**会过期**（运营商 NAT 池、DHCP 换网），「设置 → 联机」里手填只适合做兜底，长期还是靠探测；
- 文档、邀请码、截图里的地址都不能当常量引用。

## 5. 没验证到的

- **真正的跨网络**：两个不同出口的设备之间（需要对方机器，或一次真实的端口映射）。
- **中继转发**：见 §4——配置/UI/TCP 可达性测试都有，真机"仅中继"拓扑未通。
- **CGNAT 场景**：运营商级 NAT 下没有端口映射，必须中继；这一点只能靠用户侧的机器验证。
- **打包后 UI**：agent 会话起不了 Electron GUI（见 `docs/12` §9），`设置 → 联机` 面板要本人双击启动后点一次。

## 5. 复现

```powershell
# 需要 release/win-unpacked/resources/easytier（或设置 MCL_EASYTIER_BUNDLE 指向别处）
$env:MCL_REAL_TUNNEL='1'
npm.cmd --prefix mc-launcher exec vitest run src/main/modules/net/__tests__/real-tunnel.test.ts --reporter=verbose
```

默认（不设环境变量）该文件整组 skip，不会拖慢常规 `npm test`。
