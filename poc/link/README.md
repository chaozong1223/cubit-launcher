# `poc/link/` — 联机方案与连通性 PoC

本目录是 [`docs/04-multiplayer-design.md`](../../docs/04-multiplayer-design.md) 的可复现证据。它**不是产品代码**，只用于证明：

1. **房间协议**（短码 + 自校验 ticket + HMAC 控制面 + 心跳/关闭/错误码）在本机双进程下成立。
2. **EasyTier 2.7.0 no-TUN 数据面**能把**真实 Minecraft 1.20.1** 的 TCP 流量从成员送到房主，且不需要管理员/TUN/驱动。
3. **暴露面可控**：只映射专用 loopback alias `/32` 时，未映射的端口不可达。
4. **哪些没有验证**：跨网 NAT 打洞、中继、双机 LAN、TUN、防火墙拒绝等（见 04 §5.5）。

## 目录

```
poc/link/
├── README.md                 # 本文件
├── echo-server.mjs           # 模拟 MC 的 TCP 服务（MCLPING/MCLPONG）
├── mc-status.mjs             # 最小 MC 1.20.1 status ping 客户端（protocol 763）
├── room/
│   ├── protocol.mjs          # Crockford Base32 / ticket(Ed25519) / HMAC / 错误码
│   ├── host.mjs              # 房间控制面 + 成员表 + 心跳 + 世界更新
│   ├── member.mjs            # ticket 校验 + HELLO + 心跳 + 结果输出
│   └── run-room-poc.mjs      # 编排 11 个用例并断言
├── tunnel/
│   ├── poc-easytier.ps1      # 双 EasyTier 进程 + MC + 端口转发 + 证据
│   └── logs/                 # 早期手工探测日志（含 TUN 0x80070005）
├── tools/                    # 仅 PoC 用，不随产品分发
│   ├── easytier-windows-x86_64-v2.7.0.zip
│   ├── easytier-2.7.0/...    # 解压后的 core/cli/wintun
│   ├── EasyTier-LICENSE.txt  # LGPL-3.0 全文（7,657 B）
│   ├── SHA256SUMS
│   └── mcserver/             # server-1.20.1.jar + run/（eula、properties、世界）
└── evidence/
    ├── room/run-.../         # 房间 PoC 证据
    └── tunnel/run-.../       # 隧道 PoC 证据（真实 MC）
```

## 复现

### 0. 准备 EasyTier（一次性）

官方来源（固定版本）：

```
https://github.com/EasyTier/EasyTier/releases/download/v2.7.0/easytier-windows-x86_64-v2.7.0.zip
SHA-256 790fd9be347b00753570ac2b65f874a591ede9427603fe34e74a86b2b084847f
```

解压到 `tools/easytier-2.7.0/easytier-windows-x86_64/`，确认包含 `easytier-core.exe`、`easytier-cli.exe`、`wintun.dll`。
> 本机下载时 GitHub 直连较慢，PoC 使用了镜像传输，但**落盘后必须匹配上面的官方 SHA-256**（`tools/SHA256SUMS` 可核对）。产品运行时下载只认官方 URL + 哈希。

### 1. 房间协议（无需 Java / EasyTier）

```powershell
cd D:\DSH-工作文件\mc-launcher\poc\link\room
node run-room-poc.mjs
```

期望：11 个用例全部 PASS，最后一行 `overall PASS`。证据在 `../evidence/room/run-<timestamp>/`。

### 2. EasyTier + 真实 MC（需要 JDK21 + server jar）

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  D:\DSH-工作文件\mc-launcher\poc\link\tunnel\poc-easytier.ps1 -Backend mc
```

- 默认 Java 路径 `D:\DSH-工作文件\tools\jdk21\jdk-21.0.12.1+1\bin\java.exe`；不同机器用 `-JavaExe` 指定。
- 默认自动选物理网卡（排除 Radmin/VPN/TAP/vEthernet）；多网卡用 `-BindIp 10.x.x.x`。
- 期望：`overall true`，`mc-status-through-tunnel` 返回 `version 1.20.1`，decoy 端口超时。
- 证据在 `../evidence/tunnel/run-<timestamp>/summary.json`。

### 3. 快速自检（不需要 Java / MC）

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  D:\DSH-工作文件\mc-launcher\poc\link\tunnel\poc-easytier.ps1 -Backend echo
```

用 `echo-server.mjs` 代替 MC，验证同一套 P2P + port-forward 数据面，约 30 秒。

## 本机实测结论（2026-10-21）

- 真实 MC 1.20.1 status 经隧道：**PASS**，7 ms（P2P，TCP tunnel，peer RTT 0.09 ms）。
- 非管理员、无 TUN、无驱动：**PASS**。
- 只映射 `127.0.0.55/32`：decoy `25566` 不可达：**PASS**。
- `127.0.0.1` 作为 EasyTier peer：**失败**（`10049 AddrNotAvailable`），必须用 LAN IP。
- 默认不传 `-l`：会监听 `0.0.0.0:11010`，产品必须显式收紧。
- `--tcp-whitelist` 在 proxy CIDR 路径**未阻断** 25566：不能当安全边界。
- 公共节点 `public.easytier.top`：**NXDOMAIN**（2026-10-21）。
- 本机 NAT：**UDP Symmetric**；有公网 IPv6 `2001:da8:...`；跨网/中继未验。

## 安全/合规注意

- `tools/` 下的 EasyTier 二进制是 **LGPL-3.0**，只用于 PoC；产品若分发/下载，必须遵守 02 NET-01~05：独立进程、不修改、固定版本、SHA-256、附许可证与源码获取方式、允许替换。
- 不把本目录的 `--tcp-whitelist` 用法当产品安全设计；产品边界是“只映射专用 alias `/32`”。
- PoC 的 `network_secret`、ticket 均为临时生成；不要复用。
- MC server 以 `online-mode=false` 运行，仅本机 PoC；不要暴露到公网。
- 端口/进程清理：脚本用 `taskkill /T /F` 结束 sidecar/MC；异常退出后请检查 `easytier-core`/`java` 残留。

## 证据索引

| 证据 | 路径 |
|---|---|
| 房间 11 用例 | `evidence/room/run-2026-10-21T05-28-28-309Z/RESULT.md` |
| 隧道（真实 MC） | `evidence/tunnel/run-20261021-132614/summary.json` |
| 哈希 | `evidence/tunnel/run-20261021-132614/hashes.json` |
| P2P 路径/NAT | `evidence/tunnel/run-20261021-132614/member-peer.json` |
| 监听面 | `evidence/tunnel/run-20261021-132614/listeners.json`、`netstat.txt` |
| TUN 权限失败 | `tunnel/logs/tun.err.log` |
