# 04 · 联机方案选型、房间协议与连通性 PoC

**Status**: v1.0 · 可交付设计（t9 的联机实现基线；Q5 的决策输入）
**Author**: net-dev（🌐 网络工程师 / 🤝 实时协作工程师）  **Date**: 2026-10-21
**输入（必须消费）**: [`01-requirements.md`](01-requirements.md) v1.2（P0-6 / §5.7）、[`02-compliance-security.md`](02-compliance-security.md) v0.2（NET-01~18、SEC-NET-01~10、SEC-LINK-01~06）、[`03-architecture.md`](03-architecture.md) v1.0（ADR-013、§6.12、§12.7）、[`design/README.md`](../design/README.md)（联机页视觉稿）。
**权威顺序**: 合规红线以 02 为准 > 范围/验收以 01 为准 > 模块契约以 03 为准 > 本文补充联机实现细节；本文与前三者冲突处，以 02/01/03 为准并在 §10 记录差异。
**Clean-room 声明**: 本文只参考 PCL2 的**黑盒行为特征**（01 §3.4 已记录的页面/文案/流程，来自 exe 字符串与公开教程），未读取、未反编译、未移植 PCL2 源码；EasyTier 只作为**未修改的独立可执行文件**使用（LGPL-3.0），详见 §2.2 与 02 §6。

> **一分钟版本**：联机分三层——**L0 同机/局域网房间（P0 必验，零第三方二进制）**、**L1 直连 P2P（EasyTier no-TUN，条件验收）**、**L2 中继/手动映射（失败降级，P1）**。隧道引擎**只选 EasyTier 2.7.0**（LGPL-3.0，独立进程，运行时下载，固定版本 + SHA-256，不修改、不静态链接）；默认 **no-TUN 模式（免管理员）**：房主把**专用 loopback alias `/32`** 映射成固定虚拟 CIDR，成员用 `--port-forward` 把 `127.0.0.1:<本地端口>` 转到该 CIDR，启动器再把 `<本地端口>` 填进 `--server/--port`。本机 PoC 已用**真实 Minecraft 1.20.1 服务端**验证：两个 EasyTier 进程建立 P2P（TCP，0.09 ms），成员经隧道完成 MC status ping（7 ms），且未暴露的 25566 端口不可达；全程**非管理员、无 TUN、无驱动**。跨网 NAT/中继因本机只有单出口（STUN 实测 **Symmetric NAT**）且官方文档中的公共节点 `public.easytier.top` 已 **NXDOMAIN**，未能闭环——这是 §5.5 明确记录的阻塞点，不阻塞 L0/L1。**不**打包 nps / ZeroTier，**不**默认集成 frp，**不**自建中继；frp 仅作为“自带服务器”的高级文档路径，UPnP 默认关闭（P2 可选），手动端口映射是最后一道人话降级。

---

## 0. 决策摘要（给 captain / t9）

### 0.1 结论表

| 编号 | 决策 | 理由（一句话） | 依据 |
|---|---|---|---|
| **MP-01** | **EasyTier 2.7.0 是唯一随产品集成的隧道引擎** | 唯一同时满足 LGPL-3.0 可再分发、独立进程、Windows 免安装、P2P + 中继、MC TCP 适配的方案；本机 PoC 已验证数据面 | 02 §6.2/§6.6、§5 PoC |
| **MP-02** | **默认 `--no-tun`（免管理员）**；TUN 仅作为 P1 可选“性能/兼容模式”，必须 UAC + 明确同意 | 本机非管理员下 TUN 创建失败/不可依赖（捕获 0x80070005）；no-TUN + alias 映射已能跑通真实 MC | §5.2、§6.7、SEC-EXE-08 |
| **MP-03** | **房主映射专用 loopback alias `/32`（如 `127.0.0.55/32 -> 192.168.77.1/32`）**，不映射 `127.0.0.1/32` 整段 | 只暴露一个地址；实测整段映射会把宿主所有回环端口暴露给房间（`--tcp-whitelist` 在 proxy 路径未阻断，不能当边界） | §5.3、§7.1 |
| **MP-04** | **邀请码双层**：6 位 Crockford 短码（显示/LAN 发现）+ `MCL1.<code>.<payload>.<sig>` 完整 ticket（≥256-bit 能力凭证，Ed25519 自校验） | 6 位短码只有 30 bit，不能单独当跨网凭证；02 NET-13 要求 ≥128 bit。短码可暴力枚举，但只用于 LAN 发现 + 限速 + 10 min TTL；跨网必须 ticket | §6.2、§7.2 |
| **MP-05** | **不自建中继（P0/P1）**；中继只支持“用户自备 EasyTier 共享节点”或“用户显式同意后使用社区节点” | 自建中继 = 带宽/滥用/备案/隐私责任；EasyTier 中继可由用户一条命令自建，产品只做配置与提示 | §4.3、§10 Q5 |
| **MP-06** | **不打包 nps / ZeroTier**；frp 不默认集成，仅提供“自带 frps”文档与配置模板（P2） | nps GPL-3.0 但默认 `admin/123` + 8080 管理面；ZeroTier 非商业许可明确禁止“incorporation into any paid or unpaid product” | 02 NET-09/10、§3.3/§3.4 |
| **MP-07** | **UPnP/NAT-PMP/PCP 默认关闭**，P2 才考虑“用户显式同意后尝试”，不做自动改路由器/防火墙 | CGNAT 下无效、IGD 安全面大、Windows 防火墙仍需用户确认；手动映射指引更可控 | §3.6、§4.4 |
| **MP-08** | **降级链固定为**：LAN 房间 → 直连 P2P → 中继 → 手动端口映射 → 只复制地址/外部工具 | 每一级都有可读状态与错误码，不静默失败；L0/L1 不依赖隧道 | §4.2 |
| **MP-09** | **每个 `dataRoot` 只允许一个房主房间（P0）**；成员可加入一个房间；双开用不同 `--data-dir` 隔离 | 03 §6.12 已定；避免端口/状态串台，P1 再支持多房间 | §6.4 |
| **MP-10** | **隧道失败永不阻塞启动/单人游戏**；sidecar 退出即停，无后台常驻 | 02 NET-17、03 ADR-013；用户感知是“联机不可用”，不是“启动器坏了” | §6.7、§9 |

### 0.2 数字口径

| 指标 | 目标 | 实测/依据 |
|---|---|---|
| 创建房间（L0） | ≤ 5 s | PoC：`room_created` → `HOST_READY` < 1 s（本机） |
| 加入房间（L0） | ≤ 10 s | PoC：room_created → member_join ≈ 67 ms（本机房间日志） |
| 房主关闭 → 成员感知 | ≤ 5 s | PoC：511 ms（显式 CLOSE 帧） |
| 心跳超时判定 | 15 s（默认） | PoC 用 1.2 s 加速验证；默认 5 s 心跳 / 15 s 超时 |
| 邀请码有效期 | 10 min（可续期） | 01 R6.x + 02 NET-13；ticket `exp` |
| 房间最长生命周期 | 12 h | 防止僵尸房间；到点强制关闭 |
| 成员上限 | 8（可配 2–8） | 01 R6.x；PoC 用 max=2 验证 ROOM_FULL |
| LAN 世界端口发现 | ≤ 5 s，120 s 未发现给手动输入 | 01 R6.5；读取实例 `logs/latest.log` |
| EasyTier 下载 | 37.8 MB zip / 20.5 MB core | v2.7.0 Windows x64 官方 zip = 39,616,733 B |
| 隧道延迟（同机 PoC） | 目标 < 20 ms 额外 | 实测 MC status 7 ms（P2P，TCP tunnel，0.09 ms peer RTT） |
| 中继带宽预算 | 每玩家 30–100 KB/s；8 人 ≈ 2–6 Mbps | 经验值，需 L2 实测；见 §4.3 |

### 0.3 本机 PoC 一句话结果

- **房间协议 PoC：11/11 通过**（正常加入、世界更新、短码不完整、篡改、过期、版本不匹配、错误 token、满员、心跳超时、房主关闭、关闭后加入失败），证据见 [`poc/link/evidence/room/run-2026-10-21T05-28-28-309Z/RESULT.md`](../poc/link/evidence/room/run-2026-10-21T05-28-28-309Z/RESULT.md)。
- **隧道 PoC：数据面通过**（真实 MC 1.20.1 status ping 经 EasyTier 隧道成功，7 ms；decoy 端口不可达；非管理员；无 TUN），证据见 [`poc/link/evidence/tunnel/run-20261021-132614/summary.json`](../poc/link/evidence/tunnel/run-20261021-132614/summary.json)。
- **跨网/中继：未闭环**（单出口、Symmetric NAT、公共节点 NXDOMAIN），原因与缺口见 §5.5。

---

## 1. 范围、术语与验收口径

### 1.1 三层联机（与 01 §5.7 对齐）

| 层 | 场景 | P0 要求 | 依赖 | 本机可验证性 |
|---|---|---|---|---|
| **L0** | 同机双开（A 建房、B 加房、A 开 LAN、B 一键进世界） | **硬门禁（smoke 第 15 步）** | 仅本进程 + 本机回环/局域网，无第三方二进制 | ✅ 已用房间 PoC 验证协议；真实 MC 双开需 t9 集成后验 |
| **L1** | 同一局域网两台设备 | **条件项**（01 Q4：需第二台设备） | 局域网 UDP 发现 + 私网 TCP；可选 EasyTier no-TUN | ⚠️ 本机仅有单设备，未验 |
| **L2** | 跨 NAT（不同网络） | **条件验收**（按本文 PoC 结论；失败要有降级） | EasyTier sidecar + 可达的 P2P/中继 | ⚠️ 数据面已验证；跨网/中继未验 |

> 01 的失败判据保留：**需要手输 IP 才能进入、邀请码错误无限转圈、开 LAN 后 5 s 未发现端口、房主关闭无感知、默认连接公网中继**，任一条成立即 P0-6 不通过。

### 1.2 本文覆盖 / 不覆盖

**覆盖**：候选评估、选型与降级链；EasyTier 集成方式（下载/校验/启动/参数/端口/清理）；房间模型（房主/成员、邀请码、生命周期、心跳、错误码）；本地服务安全约束；本机 PoC 与证据；t9 实现设计、测试与验收映射。

**不覆盖**：Mojang 账户/正版校验（t11）；游戏内 Mod 一致性（P1，F42）；服务器列表/收藏/自动进服（P1）；跨平台（macOS/Linux）打包；自建中继的运维与备案（明确不做）；PCL2 源码级行为（clean-room 不读）。

### 1.3 术语

| 术语 | 含义 |
|---|---|
| **房主（host）** | 创建房间、运行 MC 世界、拥有房间 token 与 Ed25519 私钥的一方 |
| **成员（member）** | 用 ticket 加入房间、通过隧道/局域网连到房主世界的一方 |
| **短码（code）** | 6 位 Crockford Base32，`MCL-XXXXXX`，用于显示与 LAN 发现 |
| **ticket** | `MCL1.<code>.<payload_b64u>.<sig_b64u>`，自校验能力凭证，含网络密钥/端点/端口/过期时间 |
| **虚拟网络** | EasyTier 的 network（`network_name` + `network_secret`），本设计中一房间一网络 |
| **映射 CIDR** | 房主用 `-n <alias>/32-><虚拟CIDR>` 把专用 loopback alias 映射进虚拟网络 |
| **成员本地端口** | 成员 sidecar `--port-forward` 在 `127.0.0.1` 上监听的端口；MC 用 `--server 127.0.0.1 --port <它>` |
| **中继（relay）** | 一个可达的 EasyTier 节点，P2P 失败时转发加密流量；可由用户自建或用社区节点 |
| **TUN** | 操作系统虚拟网卡；Windows 上创建需要管理员；本设计默认不用 |

---

## 2. 约束与不可违反的边界

### 2.1 来自 02 的硬约束（联机相关）

| ID | 约束 | 本设计的落点 |
|---|---|---|
| **NET-01** | EasyTier 只以独立进程使用；不链接、不修改 | sidecar `easytier-core.exe`，仅 CLI + 本地 RPC 交互 |
| **NET-02** | 分发须附 LGPL-3.0 全文 + 源码获取方式 + 不限制替换 | `dataRoot/modules/link/licenses/EasyTier-LICENSE.txt` + About 页源码链接 + 版本 tag；允许用户替换路径 |
| **NET-03** | 固定版本 + SHA-256 + 官方 release；不从 BMCLAPI/第三方镜像取二进制 | 版本清单钉死 `v2.7.0`；zip SHA-256 `790fd9be…`；镜像仅作传输且必须哈希匹配 |
| **NET-04** | 运行时下载 + 用户可见；失败可手动指定路径 | 首次联机弹窗展示版本/来源/哈希/许可证；`--easytier-path` 兜底 |
| **NET-05** | 若随包：独立目录 + LICENSE + 版本清单 + 卸载清理 | P0 不随包；P1 若随包按此执行 |
| **NET-12** | 下载失败不得“换镜像重试到成功”而跳过校验 | 任一镜像下载后必须匹配同一 SHA-256，否则删除并报 `TUNNEL_HASH_MISMATCH` |
| **NET-13** | 邀请码 ≥128 bit、可撤销、有有效期、日志脱敏 | ticket 256-bit + 10 min TTL + 房主轮换/关闭即失效；短码仅 LAN 发现 + 限速 |
| **NET-14** | 房间内不传输账号 token/refresh token/密码 | 控制协议只含房间元数据；`auth` 模块令牌不出现在 link 模块 |
| **NET-16** | 中继可见流量必须提示；离线 LAN 无加密也要提示 | 联机页/首次加入提示；中继状态徽标；MC 本身不加密的提示 |
| **NET-17** | 默认关闭、显式同意、退出即停、无后台常驻 | `link.enabled=false` 默认；创建/加入时同意；`leave`/`close`/app quit 杀进程树 |
| **SEC-NET-01~03** | 仅 127.0.0.1/私网 + 临时端口 + 一次性 token；禁止 0.0.0.0 | 见 §7.1；启动时断言 `server.address()`；CI 扫描 `listen(port)` 无 host |
| **SEC-NET-05/08** | 显式同意；不自动改防火墙；不请求管理员改防火墙 | UI 文案 + 不调用 netsh/防火墙 API；TUN 才请求 UAC |
| **SEC-EXE-08** | EasyTier 控制面只 127.0.0.1；TUN 需显式确认；不静默提权；失败回退 | RPC `127.0.0.1:<随机>` + whitelist；UAC 弹窗说明；失败回退 no-TUN/LAN |
| **SEC-LOG-01** | 邀请码/ticket 不进日志、不进崩溃报告 | 日志字段白名单；ticket 只在内存/加密状态文件；导出诊断包时剔除 |
| **LIC-09/11** | GPL-3.0 组合作品声明、第三方清单、源码可得 | `THIRD-PARTY-LICENSES` + About 页；EasyTier 独立进程声明 |

### 2.2 本设计额外自缚的规则

1. **不把 `--tcp-whitelist` 当安全边界**：PoC 实测它在 proxy CIDR 路径未阻断 25566（§5.3.4），因此边界是“只映射专用 alias `/32` + 只让 MC/控制端口监听在该 alias 上”。
2. **不把 `public.easytier.top` 写死**：2026-10-21 本机 DNS（223.5.5.5 / 8.8.8.8）均返回 NXDOMAIN；产品必须支持“自备节点/多节点列表/禁用中继”三态。
3. **不自动升级 EasyTier**：GitHub `releases/latest` 当前仍指向 v2.6.4，而 v2.7.0 已发布（2026-10-06）——`latest` 不可信，必须用固定 tag + 哈希清单。
4. **不把 sidecar 默认监听 `0.0.0.0`**：实测不传 `-l` 时 EasyTier 会监听 `0.0.0.0:11010`；产品必须显式传 `-l tcp://<lan-ip>:<port>` 或 `--no-listener`。
5. **不在 `127.0.0.1` 上做 EasyTier peer 连接**：实测 Windows 下 `-p tcp://127.0.0.1:11010` 报 `10049 AddrNotAvailable`（EasyTier 出站绑定物理网卡，回环不可用）；同机测试必须用 LAN IP。
6. **控制面不绑公网**：房间控制端口只绑 `127.0.0.1`（L0）或私网 IP（L1），跨网时通过成员侧 `--port-forward` 暴露给虚拟网络，绝不直接 `0.0.0.0`。

---

## 3. 候选方案评估

### 3.1 评估维度与权重

权重按“P0/P1 用户价值 × 风险”定，满分 5 分：

| 维度 | 权重 | 说明 |
|---|---:|---|
| NAT 穿透成功率 | 25% | 跨网能否直连；失败能否自动中继 |
| 延迟/吞吐 | 15% | 对 MC（TCP、~20 tick/s、区块流）是否可玩 |
| 许可证与再分发 | 20% | 能否随产品/运行时下载；是否需商业许可 |
| 体积/安装 | 5% | 下载大小、是否需要驱动/安装器 |
| 免安装/免驱动/免管理员 | 10% | Windows 普通用户能否直接用 |
| Windows 兼容 | 10% | Win10/11、防火墙、杀软、ARM64 |
| 自建服务器与成本 | 10% | 是否必须自建、带宽/运维成本 |
| MC LAN（25565 TCP/UDP）适配 | 5% | TCP 端口转发、UDP 发现、`--server` 注入 |

> 说明：NAT 成功率没有公开、统一、可复现的基准；本文用“协议能力 + 本机实测 NAT 类型 + 工程经验区间”评估，明确标注不确定性。任何“99% 穿透”的宣传都不作为选型依据。

### 3.2 EasyTier（推荐）

#### 3.2.1 事实卡（2026-10-21 实测/官方 release）

| 项 | 值 | 来源 |
|---|---|---|
| 版本 | **2.7.0**（`v2.7.0`，2026-10-06 发布） | GitHub releases atom |
| 许可证 | **LGPL-3.0**（LICENSE 全文 7,657 B，SHA-256 `dde23c73…`） | 官方仓库 LICENSE + 02 §6.2 |
| Windows x64 包 | `easytier-windows-x86_64-v2.7.0.zip`，**39,616,733 B（37.8 MB）** | 官方 release |
| zip SHA-256 | `790fd9be347b00753570ac2b65f874a591ede9427603fe34e74a86b2b084847f` | GitHub release 资产 digest |
| `easytier-core.exe` | 20,521,984 B；SHA-256 `6490c6f5b5b809065517bb3324ca34c0f1f367f81b7fda04a6352391508b8ff8` | 实测 |
| `easytier-cli.exe` | 6,255,104 B；SHA-256 `3afdf2e4306c3f8d65408ddd230c7e4118ffdb5d550921022aed9966693c82ba` | 实测 |
| `wintun.dll` | 427,552 B；SHA-256 `e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce` | 实测 |
| 包内多余组件 | `easytier-web.exe`（28.3 MB）、`easytier-web-embed.exe`（35.9 MB） | 不需要；只取 core/cli/wintun |
| 架构 | Rust；TCP/UDP/WS/WSS/QUIC/WireGuard/Ring 多种隧道；P2P + 中继 mesh | 官方文档 |
| 加密 | 默认开启，`--disable-encryption` 默认 false；算法默认 `aes-gcm`，可选 chacha20/aes-gcm-256 等；`--mtu` 默认加密 1360 / 非加密 1380 | `easytier-core --help` |
| 无 TUN | `--no-tun`：可被虚拟 IP 访问（TCP/UDP/ICMP），可做子网代理，但**不能主动发起**对其它节点的访问（用 `--socks5`） | 官方 no-root 文档 |
| 端口转发 | `--port-forward <proto>://<本地>/<虚拟目标>`，如 `tcp://127.0.0.1:25566/192.168.77.1:25565`；支持 TCP/UDP | `--help` |
| 子网代理 | `-n <本地CIDR>-><虚拟CIDR>`，如 `127.0.0.55/32->192.168.77.1/32` | `--help` + 实测 |
| LAN 发现 | `--enable-udp-broadcast-relay` 可转发 UDP 广播帮助“局域网游戏”列表发现，但**需要管理员** | `--help` |
| 控制面 | RPC portal 默认 `0`（先尝试 15888，具体见 `--help`）；多实例必须随机端口；支持 `--rpc-portal-whitelist` | `--help` |
| 中继 | 支持共享节点/自建节点；`--relay-network-whitelist`、`--private-mode`、`--foreign-relay-bps-limit` 等 | `--help` |
| 公共节点 | 官方文档示例 `tcp://public.easytier.top:11010`；**本机 2026-10-21 DNS NXDOMAIN**（223.5.5.5、8.8.8.8 均无解析） | 实测 |
| STUN | `stun.easytier.cn` TXT 可解析：`211.159.178.231:8489`、`47.115.208.211:11010`、IPv6 `[2402:4e00:c054:d400:…]:8489` | 实测日志 |
| 本机 NAT | `easytier-cli stun`：**UDP Symmetric**，TCP NoPat；public IP `114.247.65.125`、`219.143.23.125`；IPv6 `2001:da8:203:cc09:…`；端口 57063 | 实测 |

#### 3.2.2 优点

1. **许可可行**：LGPL-3.0 + 独立进程 + 运行时下载，GPL-3.0 项目可分发（02 §6.6 已裁定）。
2. **免安装/免驱动/免管理员路径成立**：`--no-tun` + 映射 CIDR + 成员 `--port-forward`，本机已跑通真实 MC。
3. **P2P + 中继同一引擎**：STUN、UDP 打洞、TCP/QUIC 隧道、relay 自动路由；失败可降级，不需要两套组件。
4. **对 MC 适配好**：TCP 端口转发即可承载 MC；UDP 广播中继是可选（需要管理员，我们不用，因为启动器直接注入 `--server`）。
5. **可观测**：`easytier-cli peer/route/stun/stats` 提供 NAT 类型、路径（p2p/relay）、延迟、丢包、流量，适合 UI 展示与诊断。
6. **Windows 单文件**：core 20.5 MB，无需安装器；ARM64 也有官方包。

#### 3.2.3 缺点/风险

1. **Symmetric NAT 下 P2P 成功率低**：本机即 Symmetric；双方都 Symmetric 时通常必须中继。IPv6 可显著改善（本机有公网 IPv6，但 PoC 为排除变量关掉了 IPv6）。
2. **中继不是“免费无限”**：公共节点无 SLA、随时可能下线（本次已 NXDOMAIN）；自建要带宽/运维/合规。
3. **TUN 需要管理员**：若产品想用 TUN（性能/兼容更好），必须 UAC；本机非管理员下创建失败（§5.4）。
4. **默认监听面危险**：不传 `-l` 会监听 `0.0.0.0:11010`；RPC 默认 15888；产品必须显式收紧（§7.1）。
5. **Windows 防火墙**：MC 集成服务器“对局域网开放”时 Windows 可能弹窗；启动器不能自动加规则（SEC-NET-08）。若用户拒绝，隧道可能连不上——需要可读失败与手动指引。
6. **版本/供应链**：`latest` 指向旧版；必须固定 tag + 哈希；无代码签名，只有 SHA-256。
7. **LGPL 义务**：运行时下载虽不“convey”，仍应展示许可证与源码；若未来随包，必须附全文与源码获取方式、允许替换。

### 3.3 frp（Apache-2.0，备选，自带服务器）

| 项 | 值 |
|---|---|
| 版本/许可 | v0.71.1 / **Apache-2.0**（LICENSE 实测） |
| Windows 包 | `frp_0.71.1_windows_amd64.zip`，13.5 MB |
| 组成 | `frpc`（客户端）+ `frps`（服务端）；**必须有公网服务端** |
| 配置 | TOML：`serverAddr/serverPort/auth.token` + `[[proxies]] type="tcp" localIP/localPort/remotePort` |
| 管理面 | `frpc` admin UI 默认 `127.0.0.1:7400`（02 NET-08：默认关闭；开启必须随机端口+强口令+仅 loopback） |
| MC 适配 | TCP 代理直接可用；UDP 需 `type="udp"`；不支持 P2P，所有流量经服务器 |
| 成本 | VPS（1C1G，国内/香港/新加坡）+ 带宽；8 人 MC 约 2–6 Mbps，按流量计费需估算 |
| 优点 | 许可宽松、成熟、配置简单、可自建、可观测（frpc 状态） |
| 缺点 | **必须有服务器**；不自带 NAT 穿透；服务器是单点与成本；frps 暴露公网需鉴权/限流/防滥用；与“零配置”目标冲突 |

**结论**：不作为默认；P2 提供“自带 frps”高级路径（文档 + 配置模板 + 端口检测），不随包分发 frpc，避免把运维责任带进产品。

### 3.4 nps（GPL-3.0，不采用）

| 项 | 值 |
|---|---|
| 版本/许可 | v0.26.10 / **GPL-3.0** |
| 体积 | Windows client 4.46 MB / server 5.47 MB（tar.gz） |
| 默认配置 | 管理面 8080；README 明示 **默认 `admin/123`，正式使用必须修改** |
| 风险 | 默认弱口令 + 公网管理面是常见入侵入口；项目维护活跃度低 |
| 结论 | 许可上与 GPL-3.0 项目兼容，但**不打包、不推荐默认配置**（02 NET-09） |

### 3.5 ZeroTier（非商业许可，禁止随产品分发）

| 项 | 值 |
|---|---|
| 版本 | 1.16.2 |
| 许可 | Agent = MPL-2.0；Controller/其他 = **ZeroTier Source-Available License 1.0（Non-Commercial）** |
| 关键条款 | “Commercial Use” 明确包括 **“Incorporation of the Software into any paid or unpaid product, platform, distribution or service”** → 即使免费产品也需商业许可 |
| 其它 | 需要 ZeroTier 账号/网络；Windows 安装器/服务；TUN 驱动 |
| 结论 | **禁止随产品分发、不代建网络、不作为默认方案**；用户已安装时最多“检测到并提示可手动组网”，不自动调用（02 NET-10/11） |

### 3.6 UPnP / NAT-PMP / PCP（默认关闭，P2 可选）

| 项 | 值 |
|---|---|
| 原理 | 向家庭路由器请求临时端口映射（IGD/UPnP、NAT-PMP、PCP） |
| 可用库 | `@xmcl/nat-api` 0.4.5（MIT，2026-08-10 更新）；`nat-api` 0.3.1（MIT）；`nat-upnp`（npm 无 license 字段，不选） |
| 优点 | 无需服务器；部分路由器可自动开端口 |
| 缺点 | CGNAT/多层 NAT 下无效；很多路由器默认关闭 UPnP；IGD 实现质量参差；**安全面大**（恶意软件可借 UPnP 开端口）；Windows 防火墙仍需用户确认；可能触发路由器告警 |
| 本机 | WLAN 私网 `10.33.135.230`，STUN 公网 `114.247.65.125`/`219.143.23.125`（两个出口），**Symmetric NAT** → UPnP 即使成功也未必可被外部访问 |
| 结论 | 默认关闭；P2 仅“用户显式同意后尝试一次”，失败立即转手动指引；不自动改防火墙/路由器设置；不把它写进 P0 验收 |

### 3.7 手动端口映射（最终降级，必须有）

**适用**：用户有公网 IPv4（非 CGNAT）或公网 IPv6，且能登录路由器。

**步骤（UI 内置指引）**：

1. **判断是否有公网 IP**：对比路由器 WAN IP 与 STUN 公网 IP；若 WAN IP 属于 `10/8`、`100.64/10`、`172.16/12`、`192.168/16`，或与 STUN 不一致 → 大概率 CGNAT，手动映射无效，转“IPv6/中继/外部工具”。
2. **IPv6 优先**：若双方都有公网 IPv6（本机有 `2001:da8:…`），直接 `[IPv6]:25565` 往往不需要端口映射；需路由器防火墙放行入站 TCP 25565。
3. **IPv4 端口映射**：路由器“端口转发/虚拟服务器”添加 `TCP 25565 -> <房主内网IP>:25565`；若游戏用随机端口，以房间面板显示的实际端口为准。
4. **防火墙**：Windows 首次“对局域网开放”时允许 Java；若没有弹窗，手动在“允许应用通过防火墙”勾选 `javaw.exe`（私网）。
5. **验证**：房间面板“检测端口”用外部回连/第三方端口检测；成功则把 `公网IP:端口` 写入 ticket 的 `endpoints`。
6. **安全**：只映射 MC 端口；不映射 RPC/控制面；用完删除规则；不在公网暴露启动器服务。

> 我们不能自动做 1–6（需要路由器/防火墙权限），只能提供检测、文案、复制地址与“重试”。

### 3.8 其它候选（简要）

| 方案 | 许可/模式 | 适配性 | 结论 |
|---|---|---|---|
| **playit.gg** | 商业闭源，免费中继 + 账号 | MC 专用，零配置较好 | 不集成（闭源、账号、隐私/可用性不可控） |
| **e4mc** | 开源 Mod + 中继（需装 Mod） | 仅 Mod 客户端/服务端 | 可作为 P2 “已装 Mod”提示，不集成 |
| **Tailscale** | BSD-3-Clause 客户端，需账号/协调服务器 | 通用 VPN，TUN/服务 | 不集成（账号、TUN 管理员、非 MC 专用） |
| **WireGuard** | 开源，需自建/配置 | 通用 VPN，需 TUN | 不集成（运维成本高，适合高级用户） |
| **bore** | MIT，需自建服务端 | TCP 隧道，简单 | 可作为“自建中继”的轻量替代文档；不随包 |
| **rathole** | Apache-2.0，需自建服务端 | TCP/UDP 反向代理 | 同上；不随包 |

### 3.9 加权矩阵

评分 1–5（5 最好），“许可”按“能否免费再分发”评；加权是**工程打分，不是精确测量**：

| 方案 | NAT 25% | 延迟 15% | 许可 20% | 体积 5% | 免管理员 10% | Win 10% | 成本 10% | MC 5% | 加权 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **EasyTier no-TUN** | 4 | 4 | 5 | 3 | **5** | 5 | 4 | 5 | **4.40** |
| EasyTier TUN | 4 | 5 | 5 | 3 | 2 | 5 | 4 | 5 | 4.25 |
| frp（自带 frps） | 2 | 4 | 5 | 4 | 4 | 5 | 2 | 5 | 3.65 |
| nps | 2 | 3 | 4 | 4 | 3 | 4 | 2 | 4 | 3.05 |
| ZeroTier | 4 | 4 | **1** | 3 | 2 | 4 | 3 | 3 | 3.00（许可一票否决） |
| UPnP | 2 | 5 | 5 | 5 | 4 | 4 | 5 | 3 | 3.95（但成功率/安全差） |
| 手动映射 | 1 | 5 | 5 | 5 | 3 | 5 | 5 | 3 | 3.70 |
| playit.gg | 4 | 4 | 1 | 4 | 5 | 5 | 3 | 5 | 3.55（闭源/账号否决） |

**结论**：**EasyTier no-TUN 是唯一同时满足“许可可再分发 + 免管理员 + MC 可用 + 本机已验证”的方案**；TUN 作为可选增强；frp 只做自带服务器；其余不采用。

> 矩阵未含“一票否决”项：ZeroTier/playit 的许可、UPnP 的安全/CGNAT 失效、nps 的默认弱口令；这些已在 §3.3–§3.6 单独否决，不能只看加权分。

#### 3.9.1 NAT 穿透成功率的工程预期（非测量，明确不确定）

> 没有公开、统一、可复现的基准；下表是“协议能力 + 本机 Symmetric NAT 实测 + 工程经验”的**规划区间**，用于决定降级策略，不作为产品承诺。实际成功率受路由器、运营商、IPv6、防火墙、时段影响。

| 双方网络形态 | IPv4 直连预期 | 说明 | 建议 |
|---|---:|---|---|
| 双方都有公网 IPv4 / 无 NAT | ~95–99% | 直接可达 | 直连 |
| 一方 Full-cone/Port-restricted，另一方 Symmetric | ~40–75% | 打洞可能成功；需重试/多端口 | 直连优先，失败中继 |
| 双方都 Symmetric | ~5–20% | 端口映射不可预测；本机即此类 | 默认预期中继/手动 |
| 一方 CGNAT（无公网 IPv4） | ~0–10% | 无法入站；UPnP 无效 | 中继/IPv6/手动 |
| 双方都有公网 IPv6 | ~70–95% | 无 NAT，但路由器防火墙可能拦入站 | **P1 优先测试** |
| 一方只有 IPv6、另一方只有 IPv4 | ~0% | 协议族不互通 | 中继 |

**本机实测**：UDP NAT = **Symmetric**，public IPv4 有两个（`114.247.65.125` / `219.143.23.125`），说明多出口/CGNAT 特征；IPv6 有公网地址。因此本机对“另一个 Symmetric NAT”的直连预期很低，**中继/手动映射必须是一等路径**。

**延迟预期**（工程估计，需 L2 实测）：

| 路径 | 额外 RTT | 说明 |
|---|---:|---|
| 同机/同 LAN P2P | < 2 ms | PoC 实测 peer RTT 0.09 ms，MC status 7 ms |
| 同城 P2P | 5–20 ms | 取决于 ISP 互联 |
| 跨省 P2P | 20–60 ms | 仍可玩；MC 对 100 ms 内较宽容 |
| 中继（同城/跨省） | 30–120 ms | 取决于中继位置/带宽；8 人共享时排队 |
| 手动映射 | 同 P2P/公网路径 | 取决于公网质量 |


---

## 4. 选型结论与完整降级链

### 4.1 最终选型

1. **默认隧道引擎**：EasyTier **2.7.0**，独立进程，运行时下载（官方 URL + 固定 SHA-256），默认 **no-TUN**。
2. **默认房间**：LAN/同机回环（L0）不加载任何第三方二进制；跨网才提示下载 EasyTier。
3. **中继**：不自建；支持“用户自备共享节点”（配置 `relay.peers`）与“显式同意后使用社区节点列表”；默认**不连接任何公共节点**。
4. **备选**：frp 仅“自带 frps”文档路径（P2）；UPnP 仅 P2 可选；手动端口映射始终可用。
5. **禁止**：nps、ZeroTier 随包/代建网络；EasyTier 静态链接/改包；控制面 `0.0.0.0`；自动改防火墙；静默提权。

### 4.2 降级链（每一级都有状态/错误码）

```
                    ┌──────────────────────────────────────────────┐
                    │ 用户点“创建/加入房间”                         │
                    └───────────────────┬──────────────────────────┘
                                        ▼
              ┌────────────────────────────────────────────────────┐
              │ L0 LAN 房间（无第三方二进制，P0 必验）               │
              │ 同机回环 / 同局域网 UDP 发现 + 私网 TCP 控制面       │
              └───────────────┬──────────────────────┬─────────────┘
                    同网可直连 │                      │ 跨网/发现失败
                              ▼                      ▼
              ┌────────────────────────────┐  ┌─────────────────────────────────┐
              │ 直接进世界（--server/--port）│  │ T0 直连 P2P（EasyTier no-TUN）   │
              │ 状态 connected/direct       │  │ 房主映射 alias /32；成员 port-forward │
              └────────────────────────────┘  └──────────────┬──────────────────┘
                                                             │ P2P 失败/超时
                                                             ▼
                                              ┌─────────────────────────────────┐
                                              │ T1 中继（用户节点/显式同意的社区节点）│
                                              │ 状态 connected/relay；UI 明示“经中继” │
                                              └──────────────┬──────────────────┘
                                                             │ 无可用中继/被拒
                                                             ▼
                                              ┌─────────────────────────────────┐
                                              │ M 手动端口映射（指引 + 检测 + 复制地址）│
                                              │ 状态 manual；不自动改路由器/防火墙     │
                                              └──────────────┬──────────────────┘
                                                             │ 仍失败
                                                             ▼
                                              ┌─────────────────────────────────┐
                                              │ X 只给地址/外部工具（playit 等）     │
                                              │ 状态 unavailable；错误可读、不转圈   │
                                              └─────────────────────────────────┘
```

| 级别 | 触发 | 用户看到 | 技术动作 | 错误码（失败时） |
|---|---|---|---|---|
| **L0** | 默认；同机/同 LAN | “房间已创建/已加入；等待 LAN 世界” | UDP 25999 发现 + 私网 TCP 控制面；无 sidecar | `ROOM_NOT_FOUND` / `INVITE_INVALID` / `VERSION_MISMATCH` |
| **T0** | L0 发现失败且用户勾选“跨网联机” | “正在建立直连（P2P）…” | 下载/启动 EasyTier；房主 alias 映射；成员 port-forward | `TUNNEL_START_FAILED` / `NETWORK_UNREACHABLE` / `TUNNEL_PERMISSION_DENIED` |
| **T1** | T0 超时/无 P2P 且配置了中继 | “直连失败，正在经中继…” | 加入 `relay.peers`；EasyTier 自动选 relay 路径 | `RELAY_UNAVAILABLE` / `RELAY_REQUIRED` |
| **M** | 无中继/用户选择手动 | “请按指引映射端口；已复制地址” | 生成公网地址候选、端口检测、复制 | `PORT_MAPPING_REQUIRED` / `FIREWALL_BLOCKED` |
| **X** | 以上都失败 | “当前网络无法自动联机；可复制地址或使用外部工具” | 只展示地址/诊断 | `NETWORK_UNREACHABLE`（带诊断） |

**铁律**：任何一级失败都**不静默**、不无限转圈、不自动降级到“公网中继”而不告知；L0/L1 不依赖隧道；隧道失败不影响单人启动。

### 4.3 为什么不自建中继 / 为什么不是 frp 默认

- **成本**：MC 每玩家约 30–100 KB/s；8 人 ≈ 2–6 Mbps 持续；1 TB/月 ≈ **350–730 小时**（约 15–30 天连续满员；中继双向计费则减半），且中国大陆节点还需备案/实名/内容责任。
- **滥用**：开放中继会被当作免费加速/穿透入口；需要鉴权、限流、滥用告警、隐私政策（02 NET-15/16），这不是 P0/P1 团队能承担的运维。
- **可用性**：公共节点无 SLA（本次 `public.easytier.top` 已 NXDOMAIN）；把产品体验绑在别人的免费节点上不可接受。
- **frp**：必须自备 `frps`；对普通用户仍是“先买服务器”，与“点邀请码就进”目标冲突；作为高级路径保留即可。
- **用户自建 EasyTier 节点**：一条命令（`easytier-core --relay-network-whitelist '*' ...`）即可，比 frp 更贴合；产品只做“填写节点地址 + 测试连通 + 保存”。

### 4.4 成本模型（给 captain 拍板）

| 方案 | 固定成本 | 变动成本 | 运维 | 适用 |
|---|---|---|---|---|
| 公共社区节点 | 0 | 0（他人承担） | 无 SLA/隐私不可控 | 应急/试验，默认关闭 |
| 用户自建 EasyTier 节点 | VPS ¥20–60/月 | 带宽/流量 | 用户自己 | 高级用户/小圈子 |
| 我们自建中继 | VPS + 备案 + 监控 | 8 人 ≈ 2–6 Mbps；1 TB ≈ 350–730 h（15–30 天连续满员） | 高（鉴权/限流/滥用/隐私） | **P0/P1 不做**；用户量上来再评估 |
| frp 用户自备 | VPS ¥20–60/月 | 同上 | 用户自己 | P2 高级路径 |

> Q5 建议：**选 EasyTier；不自建中继；frp 仅文档；P1 观察真实用户中继需求后再决定是否提供“官方中继”付费/限额服务。**

---

## 5. 本机 PoC（可复现）

### 5.1 环境

| 项 | 值 |
|---|---|
| OS | Windows 11 家庭中文版 10.0.26100（64 位） |
| 权限 | **非管理员**（`whoami` 实测 Admin=False） |
| Node | v24.20.0（npm 11.19.0） |
| Java | `D:\DSH-工作文件\tools\jdk21\jdk-21.0.12.1+1\bin\java.exe` |
| 网络 | WLAN `10.33.135.230`（默认路由）；另有 Radmin VPN 虚拟网卡 `26.125.118.57`（PoC 显式排除） |
| NAT | `easytier-cli stun`：**UDP Symmetric**、TCP NoPat；public IPv4 `114.247.65.125` / `219.143.23.125`；public IPv6 `2001:da8:203:cc09:…`；STUN 端口 57063 |
| 公共节点 | `public.easytier.top`：A 记录 NXDOMAIN（223.5.5.5、8.8.8.8）；TCP 11010 不可达 |
| 时间 | 2026-10-21 13:20–13:29（UTC+8） |

### 5.2 PoC-A：房间协议（11/11 通过）

**代码**：`poc/link/room/`
- `protocol.mjs`：Crockford Base32、ticket 签发/校验（Ed25519）、HMAC、错误码。
- `host.mjs`：控制面 TCP、HELLO/WELCOME、PING/PONG、世界更新、关闭、冻结（模拟心跳丢失）。
- `member.mjs`：离线校验 ticket、HELLO 认证、心跳、结果输出。
- `run-room-poc.mjs`：编排 11 个用例并断言。

**运行**：

```powershell
cd D:\DSH-工作文件\mc-launcher\poc\link\room
node run-room-poc.mjs
```

**结果**（[`evidence/room/run-2026-10-21T05-28-28-309Z/RESULT.md`](../poc/link/evidence/room/run-2026-10-21T05-28-28-309Z/RESULT.md)）：

| # | 用例 | 结果 | 证据 |
|---|---|---|---|
| 1 | ticket 自校验（code 由 roomId 派生） | PASS | `ticket-self-verifies` |
| 2 | 正常加入 + 世界更新 + PONG | PASS | connected=true, worldUpdate=true |
| 3 | 只有 6 位短码 | PASS | `INVITE_INCOMPLETE` |
| 4 | 篡改 ticket（改 worldPort/max） | PASS | `TICKET_SIGNATURE_INVALID` |
| 5 | 过期 ticket | PASS | `INVITE_EXPIRED` |
| 6 | 版本不匹配（1.20.4 加入 1.20.1） | PASS | `VERSION_MISMATCH` |
| 7 | 错误网络 token | PASS | `AUTH_FAILED` |
| 8 | 满员（max=2，第三人） | PASS | `ROOM_FULL` |
| 9 | 心跳超时（房主冻结） | PASS | `HEARTBEAT_TIMEOUT`（1.56 s，加速配置） |
| 10 | 房主关闭 → 成员通知 | PASS | `ROOM_CLOSED`（511 ms） |
| 11 | 关闭后再加入 | PASS | `NETWORK_UNREACHABLE`（ECONNREFUSED） |

### 5.3 PoC-B：EasyTier 隧道 + 真实 Minecraft（数据面通过）

**代码/脚本**：`poc/link/tunnel/poc-easytier.ps1`、`poc/link/mc-status.mjs`、`poc/link/echo-server.mjs`。

**拓扑**（两台 EasyTier 进程同机，模拟房主/成员）：

```
┌────────────────────────────── Windows 11（非管理员） ──────────────────────────────┐
│                                                                                   │
│  Minecraft 1.20.1 server (:25565, 绑定 *:25565)                                    │
│        ▲                                                                          │
│        │ 127.0.0.55:25565（专用 loopback alias）                                   │
│  easytier-core (host)  --no-tun  -i 10.144.144.1                                  │
│        │  -n 127.0.0.55/32->192.168.77.1/32                                       │
│        │  -l tcp://10.33.135.230:<peerPort>  -r 127.0.0.1:<rpc>                   │
│        │                                                                          │
│        │  P2P over LAN IP（TCP tunnel, 0.09 ms）                                   │
│        ▼                                                                          │
│  easytier-core (member) --no-tun --no-listener -i 10.144.144.2                    │
│        │  --port-forward tcp://127.0.0.1:<local>/192.168.77.1:25565                │
│        ▼                                                                          │
│  node mc-status.mjs 127.0.0.1 <local>  ──► MC status JSON（version 1.20.1）        │
│                                                                                   │
│  decoy: --port-forward tcp://127.0.0.1:<decoy>/192.168.77.1:25566 → 超时（未暴露）  │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**运行**：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  D:\DSH-工作文件\mc-launcher\poc\link\tunnel\poc-easytier.ps1 -Backend mc
```

> 必须用 `powershell.exe -ExecutionPolicy Bypass -File`：本机执行策略禁止直接运行 `.ps1`（与 `npm.ps1` 同类问题；产品脚本用 `npm.cmd`）。

**结果**（[`evidence/tunnel/run-20261021-132614/summary.json`](../poc/link/evidence/tunnel/run-20261021-132614/summary.json)）：

| 步骤 | 结果 | 关键值 |
|---|---|---|
| 公共共享节点探测 | PASS（记录为失败事实） | `public.easytier.top` NXDOMAIN，TCP 11010 不可达 |
| TUN 模式探测 | 信息项 | 非管理员下未创建 TUN；早前一次抓到 `0x80070005`（见 `tunnel/logs/tun.err.log`） |
| 真实 MC 服务端启动 | PASS | 1.20.1，`Starting Minecraft server on *:25565` |
| 房主 sidecar 启动 | PASS | listener `tcp://10.33.135.230:52005`，RPC `127.0.0.1:52006` |
| P2P 建立 | PASS | `cost=p2p`，`tunnel_proto=tcp`，RTT 0.09 ms，0.0% loss |
| **MC status 经隧道** | **PASS** | `{"version":"1.20.1","protocol":763,"motd":"MCL Tunnel PoC 1.20.1"}`，7 ms |
| decoy 端口（25566） | PASS | 经隧道 5 s 超时，不可达 |
| 监听面 | PASS | sidecar：`127.0.0.1` + LAN IP；MC 自身 `*:25565`（游戏行为） |

**哈希证据**（`hashes.json`）：

```
zip             790fd9be347b00753570ac2b65f874a591ede9427603fe34e74a86b2b084847f  (39,616,733 B)
easytier-core   6490c6f5b5b809065517bb3324ca34c0f1f367f81b7fda04a6352391508b8ff8  (20,521,984 B)
easytier-cli    3afdf2e4306c3f8d65408ddd230c7e4118ffdb5d550921022aed9966693c82ba  (6,255,104 B)
wintun.dll      e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce
```

#### 5.3.1 关键发现（会改变实现）

1. **`--no-tun` 数据面可用**：房主映射 `127.0.0.55/32`，成员 `--port-forward` 到 `192.168.77.1:25565`，真实 MC status 成功。**无需 TUN、无需管理员、无需驱动。**
2. **不能映射 `127.0.0.1/32` 整段**：实测整段映射会把宿主所有回环端口暴露给成员（25566 decoy 可访问）；改成专用 alias `/32` 后 decoy 不可达。`--tcp-whitelist 25565` **没有**阻断 proxy 路径的 25566（§5.3.4），所以不能依赖它。
3. **`127.0.0.1` 不能做 EasyTier peer**：`-p tcp://127.0.0.1:11010` 报 `10049 AddrNotAvailable`；必须用 LAN IP（同机测试也一样）。
4. **默认监听会开 `0.0.0.0:11010`**：不传 `-l` 的成员进程实际监听 `0.0.0.0:11010`；产品必须显式 `-l tcp://<lan-ip>:<port>` 或 `--no-listener`。
5. **RPC 默认 15888**：多实例会冲突；产品必须每个实例随机端口 + `--rpc-portal-whitelist 127.0.0.1/32`（PoC 已用随机端口）。
6. **NAT 是 Symmetric**：跨网 P2P 预期差；必须把中继/手动映射作为一等降级，而不是“异常情况”。
7. **公共节点不可依赖**：文档示例节点已 NXDOMAIN；产品默认不连公共节点，配置里也不写死。

#### 5.3.2 为什么房主要映射 alias 而不是 LAN IP

- 映射 LAN IP `/32` 也可行，但会受 Windows 防火墙对 Java 入站规则影响（用户可能拒绝），且 LAN IP 会随 DHCP 变化。
- 映射专用 loopback alias（`127.0.0.55`）让 EasyTier proxy 从本机回环访问 MC，**绕过 LAN 防火墙路径**；MC 集成服务器“对局域网开放”绑定所有网卡（含 `127.0.0.0/8`），所以可达。
- alias 每个房间随机选一个（`127.0.0.2`–`127.0.0.254`），只映射该 `/32`；房间关闭即停止 sidecar，暴露面消失。
- 若实测某版本 MC 只绑 LAN IP（非 `0.0.0.0`），回退方案：映射房主 LAN IP `/32` + 提示用户允许 Java 防火墙；ticket 里记录 `exposeMode: "alias" | "lan-ip"`。

#### 5.3.3 控制面怎么跨网

房主把**控制面端口**也监听在 alias 上（如 `127.0.0.55:25998`），成员再加一条 `--port-forward tcp://127.0.0.1:<localControl>/192.168.77.1:25998`。这样控制面与 MC 走同一条虚拟网络，不需要额外公网端口，也不需要 TUN。PoC 的房间协议只验证了本机 TCP 控制面；跨网控制面属于 t9 集成验证项（§5.5）。

#### 5.3.4 `--tcp-whitelist` 实测（负面结果）

在 host 参数加 `--tcp-whitelist 25565`，同时映射 `127.0.0.1/32`，成员访问 `192.168.77.1:25566` 仍得到 `MCLPONG`（decoy 可达）。结论：**该白名单不覆盖 proxy CIDR 的入站端口**（至少 2.7.0 + 本配置），不能用作安全边界；已在 §2.2/§7.1 写成硬规则。

### 5.4 PoC-C：TUN 权限探测（阻塞点）

- 非管理员运行 `easytier-core -i 10.144.144.9`（不带 `--no-tun`）：
  - 一次运行捕获：`Failed to add Easytier to firewall allowlist ... 0x80070005`、`An error occurred: 拒绝访问 (os error 5)`（`poc/link/tunnel/logs/tun.err.log`）。
  - 后续运行未再复现错误，但也未创建 Wintun 适配器（`Get-NetAdapter` 无 EasyTier/Wintun）。
- 结论：**TUN 在非管理员下不可用/不可靠**；产品默认 no-TUN。若 P1 启用 TUN，必须 UAC + 明确说明（会创建虚拟网卡/可能修改路由），失败回退 no-TUN。
- 这也解释了为什么 PCL2 的 EasyTier 需要管理员：不是“必须”，而是它选了 TUN 路径；我们选择 no-TUN 以降低门槛。

### 5.5 未验证 / 阻塞点（必须写清）

| 项 | 状态 | 缺什么条件 | 影响 |
|---|---|---|---|
| **跨网 P2P 打洞** | ❌ 未验 | 第二台设备/第二网络；本机单出口 + Symmetric NAT | 不能宣称“跨网直连成功”；L2 仍为条件项 |
| **中继路径** | ❌ 未验 | 可达的共享节点（公共节点 NXDOMAIN；自建需服务器） | 不能给中继延迟/带宽数字；只能给配置与降级 |
| **L1 同 LAN 双设备** | ❌ 未验 | 第二台 Windows 设备/手机热点 | UDP 发现/防火墙行为未验 |
| **集成服务器 LAN 端口发现** | ❌ 未验 | 需要在真实客户端里“对局域网开放”并读 `latest.log` | t9 必须做；PoC 用 dedicated server 固定 25565 代替 |
| **Windows 防火墙拒绝** | ❌ 未验 | 需要用户拒绝弹窗的场景 | 失败文案/回退需 E2E |
| **长稳/并发/带宽** | ❌ 未验 | 8 人 + 30–120 min + 真实移动 | 中继成本模型是估算 |
| **多成员并发** | ❌ 未验 | PoC 只跑了 1 个成员/1 条 TCP；8 人并发需压测 | 代理连接数/带宽/延迟未知 |
| **IPv6 P2P** | ❌ 未验 | PoC 关闭 IPv6；本机有公网 IPv6 | 可能是 Symmetric NAT 的最佳解，P1 必测 |
| **Windows 10 / ARM64 / 杀软** | ❌ 未验 | 设备/镜像 | 兼容性风险 |
| **TUN 模式** | ⚠️ 仅捕获失败 | 管理员/UAC | P1 可选 |

### 5.6 复现命令（最短路径）

```powershell
# 0) 准备（一次性）：下载官方 zip 并核对哈希
#    官方：https://github.com/EasyTier/EasyTier/releases/download/v2.7.0/easytier-windows-x86_64-v2.7.0.zip
#    SHA-256: 790fd9be347b00753570ac2b65f874a591ede9427603fe34e74a86b2b084847f
#    解压到 poc/link/tools/easytier-2.7.0/easytier-windows-x86_64/

# 1) 房间协议（11 用例）
cd D:\DSH-工作文件\mc-launcher\poc\link\room
node run-room-poc.mjs

# 2) 隧道 + 真实 MC（需 JDK21 与 server-1.20.1.jar）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  D:\DSH-工作文件\mc-launcher\poc\link\tunnel\poc-easytier.ps1 -Backend mc

# 3) 只跑 echo（不需要 Java/MC，最快自检）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
  D:\DSH-工作文件\mc-launcher\poc\link\tunnel\poc-easytier.ps1 -Backend echo
```

**注意**：
- 本机 `npm.ps1`/`.ps1` 被执行策略拦截 → 用 `npm.cmd` 与 `powershell.exe -ExecutionPolicy Bypass -File`。
- PoC 会自动选物理网卡（排除 Radmin/VPN/TAP/vEthernet）；若有多网卡，用 `-BindIp` 指定。
- PoC 结束会 `taskkill /T` 清理 sidecar 与 MC；加 `-KeepAlive` 可保留现场。
- 隧道 PoC 的 `--tcp-whitelist` 是**反面教材**，不要复制到产品代码里当安全边界。

### 5.7 证据清单

| 文件 | 内容 |
|---|---|
| `poc/link/evidence/room/run-2026-10-21T05-28-28-309Z/RESULT.md` | 11 用例表 |
| 同上 `summary.json` / `host-events.jsonl` / `host.out.log` | 房间事件、错误码、控制面日志 |
| `poc/link/evidence/tunnel/run-20261021-132614/summary.json` | 隧道 PoC 全量结果 |
| 同上 `hashes.json` / `member-peer.json` / `member-route.json` / `netstat.txt` / `listeners.json` | 哈希、P2P 路径、NAT、监听面 |
| 同上 `mc-direct-status.json` / `mc-tunnel-status.json` | 直连与隧道 status ping |
| `poc/link/evidence/tunnel/run-20261021-132614/tun-probe.*.log` | TUN 权限探测（脚本内） |
| `poc/link/tunnel/logs/tun.err.log` | 早前 TUN 创建失败 `0x80070005` 原始日志 |
| `poc/link/evidence/tunnel-run-console.txt` / `room-run-console.txt` | 控制台输出 |

---

## 6. 房间模型与协议规范

### 6.1 角色与状态机

**房主（host）**：

```
idle ──create──► creating ──sidecar/ticket ready──► waiting ──member join──► connected
  ▲                  │                                  │                        │
  │                  └──fail──► error                   └──close/leave──► closing ─┘
  └──────────────────────────── closed ◄──────────────────────────────────────────┘
```

**成员（member）**：

```
idle ──join──► resolving(ticket) ──verify──► connecting ──welcome──► connected
                    │                          │                        │
                    └──invalid/expired──► error└──timeout──► unreachable └──close/hb──► closed
```

**状态与 UI**：

| 状态 | UI | 说明 |
|---|---|---|
| `idle` | 联机页空态 | 未开房/未加入 |
| `creating` | “正在创建房间…” | 生成密钥/ticket、启动 sidecar（如启用隧道） |
| `waiting` | 房间号/邀请码/成员列表（0 人） | 等待成员；可复制邀请 |
| `connected` | 成员列表 + 路径（直连/中继）+ 延迟 | 至少 1 名成员 |
| `closing` | “正在关闭…” | 发送 CLOSE、停止 sidecar |
| `closed` | 空态 + 最近一次错误 | 邀请码失效 |
| `error` | 错误卡片 + 重试/降级按钮 | 不转圈，≤5 s 给出人话 |

### 6.2 邀请码与 ticket

#### 6.2.1 两层模型（解决 30 bit 短码 vs ≥128 bit 的矛盾）

| 层 | 形式 | 熵 | 用途 | 限制 |
|---|---|---|---:|---|
| **短码** | `MCL-XXXXXX`（6 位 Crockford Base32） | 30 bit | 显示、口头/手输、LAN UDP 发现 | 只用于同网发现；限速 5 次/分钟/IP；10 min 失效；跨网必须 ticket |
| **完整 ticket** | `MCL1.<code>.<payload_b64u>.<sig_b64u>` | 256 bit（网络密钥）+ Ed25519 | 复制/粘贴、二维码、跨网加入 | 视为秘密；不写日志；过期/关闭即失效；长度约 700–900 B |

> 02 NET-13 的“邀请码 ≥128 bit”由 **ticket 的网络密钥（32 B）** 满足；短码不是能力凭证，只是发现键。UI 必须把“复制邀请码”绑定到 ticket，短码只用于“同一局域网内输入”。

#### 6.2.2 ticket 格式（ABNF 风格）

```
ticket   = "MCL1." code "." payload-b64u "." sig-b64u
code     = 6( Crockford )                  ; 0-9 A-Z 去掉 I L O U
payload  = canonical-json( TicketPayload )  ; ≤ 2048 B
sig      = Ed25519( "MCL1." code "." payload-b64u )  ; 64 B → b64u
```

**TicketPayload 字段**：

| 字段 | 类型 | 说明 |
|---|---|---|
| `v` | int | 固定 1 |
| `code` | string(6) | 短码；必须等于 `deriveCode(roomId)` |
| `roomId` | b64u(16B) | 随机房间 ID |
| `host.name` | string | 房主显示名（≤32） |
| `host.pub` | b64u(32B) | Ed25519 公钥（JWK `x`） |
| `net.name` | string | EasyTier network name，如 `mcl-<code 小写>` |
| `net.secret` | b64u(32B) | EasyTier network secret，同时是控制面 HMAC token |
| `endpoints[]` | array | `{kind:"lan"|"relay", host, port}`；LAN 只允许私网/回环字面量；中继需在用户配置白名单 |
| `tunnel` | object | `{provider:"easytier", version:"2.7.0", vip, mappedCidr, worldPort, controlPort}` |
| `mc` | object | `{version, loader}`；P1 加 `modsetHash` |
| `max` | int | 2–8 |
| `iat` / `exp` | int | Unix 秒；`exp-iat=600`；允许 ±300 s 时钟偏差 |
| `jti` | b64u(8B) | 唯一 ID，用于日志关联（不写 ticket） |

**示例（密钥已替换）**：

```
MCL1.4SA2XE.eyJ2IjoxLCJjb2RlIjoiNFNBMlhFIiwi...<payload>...<sig>
```

**派生短码**：

```
code = CrockfordBase32( SHA-256(roomId) )[0..6]
```

#### 6.2.3 校验顺序（成员侧，全部通过才连接）

1. 字符串长度 ≤ 4096；恰好 4 段；前缀 `MCL1`。
2. 短码符合 Crockford（6 位）；base64url 字符集；payload ≤ 2048 B。
3. JSON 解析；`v==1`；`payload.code==code`；`deriveCode(roomId)==code`。
4. Ed25519 验签（公钥来自 payload；签名覆盖前缀+code+payload）。
5. `exp >= now-300`；`iat <= now+300`；`net.secret` 为 32 B；`endpoints` 非空。
6. `mc.version/loader` 与本地实例比对（不匹配 → `VERSION_MISMATCH`，在连接前就拦）。
7. 只有在用户确认“加入此房间”后才连接；连接后控制面再做 token 认证（双保险）。

**防篡改**：签名覆盖 endpoint/端口/roomId/网络密钥；改任何字段 → `TICKET_SIGNATURE_INVALID`。
**防重放**：`exp` + `jti` + 房主关闭即销毁 token；P1 可加成员 nonce 缓存。
**可撤销**：房主关闭房间/轮换 token 即失效；ticket 无法单独撤销（无后端），所以 TTL 必须短。
**钓鱼**：ticket 可自签（任何人都能造自己的房间）——这是预期行为；用户需确认房主名/房间号；不把“签名有效”宣传成“房主可信”。

#### 6.2.4 短码穷举与限速

- 30 bit = 1,073,741,824 种；LAN 发现响应含 ticket（含网络密钥），若无限速，攻击者可在局域网内枚举。
- 控制：每 IP 5 次/分钟、每房间 20 次/分钟；连续失败 10 次锁定 60 s；发现响应只回给请求的 nonce；短码 TTL 10 min；房主可随时关闭。
- 跨网不走短码，必须 ticket（≥256 bit），不存在穷举问题。

### 6.3 控制协议（NDJSON over TCP）

**帧**：一行一个 JSON，`\n` 结尾；单行 ≤ 64 KB；超限断开。所有消息带 `t`。

| 方向 | 消息 | 字段 | 说明 |
|---|---|---|---|
| C→S | `HELLO` | `v, code, nonce, member{id,name,mcVersion,loader,path}, auth` | `auth=HMAC-SHA256(token,"HELLO|code|nonce|memberId")` |
| S→C | `WELCOME` | `v, room, members, world, auth` | `auth=HMAC(token,"WELCOME|code|nonce")`；room 不含 token |
| C→S | `PING` | `seq, ts` | 默认 5 s |
| S→C | `PONG` | `seq, ts, members, world` | 更新成员/世界 |
| S→C | `EVENT` | `event:"members"|"world", ...` | 成员变化/世界端口 |
| S→C | `CLOSE` | `reason:"HOST_LEFT"|"KICKED"|"ROOM_CLOSED"` | 显式关闭，≤5 s |
| S→C | `ERROR` | `code, message, detail` | 失败即断开 |
| C→S | `LEAVE` | — | 主动离开 |

**认证**：token = ticket 的 `net.secret`（32 B）；HMAC-SHA256；恒定时间比较；nonce 128 bit；HELLO 只接受一次；失败即断开（不泄露细节）。
**心跳**：成员每 5 s PING；房主 15 s 未收到任何消息 → 移除并广播；成员 15 s 未收到 PONG → `HEARTBEAT_TIMEOUT`。
**成员上限**：默认 8；满员 `ROOM_FULL`；重复 memberId `AUTH_FAILED`。
**版本/加载器**：HELLO 携带；不匹配 `VERSION_MISMATCH`（不启动游戏）。
**顺序**：HELLO → WELCOME → PING/PONG；未 HELLO 的其他消息一律 `AUTH_FAILED`。

### 6.4 生命周期与定时器

| 定时器 | 默认 | 触发 | 行为 |
|---|---:|---|---|
| 短码/ticket TTL | 600 s | 到期 | `INVITE_EXPIRED`；房间可续期（重新签发） |
| 房间最长 | 12 h | 到期 | 强制 `CLOSE`，停止 sidecar |
| 心跳间隔 | 5 s | 成员 | 发 PING |
| 心跳超时 | 15 s | 任一方 | 移除成员 / `HEARTBEAT_TIMEOUT` |
| 世界端口发现 | 5 s 轮询 / 120 s 上限 | 房主开 LAN | 更新 `world`；120 s 未发现 → `WORLD_NOT_FOUND` + 手动端口输入 |
| 关闭通知 | 立即 + ≤5 s | 房主 close | 广播 `CLOSE`；超时断开 |
| sidecar 健康检查 | 2 s | 隧道启用 | RPC/peer 查询；连续 3 次失败 → `SIDECAR_CRASHED`，回退 |
| sidecar 启动超时 | 20 s | 创建/加入 | `TUNNEL_START_FAILED` |
| 端口映射检测 | 手动触发 | 降级 M | 外部回连/第三方检测；超时 10 s |
| 空闲关闭 | 30 min | 无成员且无游戏 | 提示后关闭（P1） |

### 6.5 错误码总表（扩展 03 §9.2）

| code | 分类 | 可重试 | 用户文案（示例） | 触发/恢复 |
|---|---|---:|---|---|
| `ROOM_NOT_FOUND` | link | 否 | 房间不存在或已关闭 | 短码错误/房间关闭；重新创建 |
| `ROOM_FULL` | link | 否 | 房间人数已满（最多 8 人） | 等成员退出/房主扩容 |
| `ROOM_CLOSED` | link | 否 | 房主已关闭房间 | 重新要邀请 |
| `VERSION_MISMATCH` | link | 否 | 双方游戏版本不一致，暂时不能加入 | 切换实例/升级 |
| `LOADER_MISMATCH` | link | 否 | 加载器不一致（Forge/Fabric/…） | P1；切换实例 |
| `NETWORK_UNREACHABLE` | net | 是 | 无法连接到房主，请检查网络 | 重试/换中继/手动映射 |
| `INVITE_INVALID` | link | 否 | 邀请码不正确或已过期 | 重新复制 |
| `INVITE_EXPIRED` | link | 否 | 邀请码已过期（10 分钟） | 房主重新生成 |
| `INVITE_INCOMPLETE` | link | 否 | 跨网联机需要完整邀请码，不是 6 位房间号 | 复制完整邀请 |
| `TICKET_SIGNATURE_INVALID` | link | 否 | 邀请码被修改，无法验证 | 重新复制 |
| `TICKET_MALFORMED` | link | 否 | 邀请码格式不正确 | 重新复制 |
| `AUTH_FAILED` | link | 否 | 无法验证房间身份 | 重新加入/新邀请 |
| `HEARTBEAT_TIMEOUT` | net | 是 | 与房主失去连接 | 重连/换中继 |
| `HOST_LEFT` | link | 否 | 房主已离开 | 等房主重开 |
| `TUNNEL_FAILED` | net | 是 | 联机组件未能启动，已退回直连 | 查看诊断/手动映射 |
| `TUNNEL_DOWNLOAD_FAILED` | net | 是 | 联机组件下载失败 | 重试/手动指定路径 |
| `TUNNEL_HASH_MISMATCH` | net | 否 | 联机组件校验失败，已拒绝运行 | 重新下载/检查网络 |
| `TUNNEL_START_FAILED` | process | 是 | 联机组件启动失败 | 重试/看日志 |
| `TUNNEL_PERMISSION_DENIED` | process | 否 | 该模式需要管理员权限 | 用默认 no-TUN 模式 |
| `SIDECAR_CRASHED` | process | 是 | 联机组件异常退出 | 自动重启一次；再失败降级 |
| `RELAY_UNAVAILABLE` | net | 是 | 中继节点不可用 | 换节点/手动映射 |
| `RELAY_REQUIRED` | net | 是 | 当前网络无法直连，需要中继 | 配置中继/手动映射 |
| `PORT_MAPPING_REQUIRED` | net | 是 | 需要手动映射端口 | 打开指引 |
| `FIREWALL_BLOCKED` | net | 是 | Windows 防火墙可能拦截了 Java | 允许 Java/换模式 |
| `WORLD_NOT_FOUND` | link | 是 | 未检测到 LAN 世界 | 游戏内“对局域网开放”/手输端口 |
| `ADMIN_REQUIRED` | process | 否 | 此操作需要管理员权限 | 取消/用 no-TUN |
| `ALIAS_UNAVAILABLE` | net | 是 | 本机回环别名不可用 | 换 alias/映射 LAN IP |

> 所有 code 进 `src/shared/link.ts` 的 zod enum；`category` 用于 UI 图标/重试策略；`retryable` 决定是否显示“重试”。

### 6.6 版本/加载器一致性

- **P0**：HELLO 带 `mcVersion` + `loader`；房主比对；不一致直接在 `WELCOME` 前返回 `VERSION_MISMATCH`/`LOADER_MISMATCH`，**不启动游戏**。
- **P1**：`modsetHash`（排序后的启用 mod 文件名+大小+sha1）进 HELLO；不一致提示“模组可能不同”，可强制加入（房主设置）。
- **世界数据**：不传存档/模组；只传连接参数；成员必须已有同版本实例。
- **实例选择**：加入时 UI 默认选与 ticket `mc.version/loader` 匹配的实例；没有则提示创建/安装。

### 6.7 EasyTier sidecar 编排（给 t9 的参数矩阵）

#### 6.7.1 房主（host）

| 模式 | 参数 |
|---|---|
| **no-TUN（默认）** | `-i 10.144.144.1 --network-name mcl-<code> --network-secret <32B> --no-tun -n 127.0.0.<alias>/32->192.168.77.1/32 -l tcp://<lan-ip>:<peerPort> -r 127.0.0.1:<rpc> --rpc-portal-whitelist 127.0.0.1/32 --disable-ipv6`（P1 可开 IPv6） |
| TUN（P1 可选） | 去掉 `--no-tun`，加 `-i 10.144.144.1`；需要 UAC；`-n` 可省略（虚拟 IP 直接可达）；仍只监听私网/回环 |
| 中继（可选） | 加 `-p tcp://<relay>:11010`（用户自备/显式同意的社区节点） |

> 房主不需要 `--port-forward`；它用 `-n` 把 alias 映射进虚拟网络。
> 房主的控制面（25998）也监听在 alias 上，供成员 `--port-forward` 转发。

#### 6.7.2 成员（member）

| 模式 | 参数 |
|---|---|
| **no-TUN（默认）** | `-i 10.144.144.2 --network-name ... --network-secret ... --no-tun --no-listener -p tcp://<host-lan-or-relay>:<peerPort> --port-forward tcp://127.0.0.1:<localWorld>/192.168.77.1:<worldPort> --port-forward tcp://127.0.0.1:<localControl>/192.168.77.1:<controlPort> -r 127.0.0.1:<rpc> --rpc-portal-whitelist 127.0.0.1/32 --disable-ipv6` |
| TUN（P1） | 去掉 `--no-tun`/`--no-listener`，用虚拟 IP 直连；需要 UAC |

> 成员 `--no-listener` 防止 `0.0.0.0:11010`；`-p` 用 **LAN IP 或中继域名**，不用 `127.0.0.1`。
> 成员本地端口由 OS 分配（`listen(0)`），MC 用 `--server 127.0.0.1 --port <localWorld>`。

#### 6.7.3 端口与别名分配

| 端口/地址 | 分配 | 绑定 | 生命周期 |
|---|---|---|---|
| EasyTier peer（host） | OS 临时端口（LAN IP） | 私网 IP | 房间期间 |
| EasyTier RPC（host/member） | OS 临时端口 | `127.0.0.1` + whitelist | 进程期间 |
| 控制面（host） | OS 临时端口，监听 alias；LAN 模式另开私网端口 | alias/私网 | 房间期间 |
| 成员 localWorld/localControl | OS 临时端口 | `127.0.0.1` | 房间期间 |
| alias | `127.0.0.2`–`127.0.0.254` 随机，避开 `.1` | loopback | 房间期间 |
| 虚拟 CIDR | `192.168.<roomHash>.1/32`（或固定 `192.168.77.1` + 每房间随机） | EasyTier 内部 | 房间期间 |

> 别名/CIDR 每房间随机，降低冲突与“可预测暴露面”；ticket 里记录，成员无需配置。

#### 6.7.4 启动/健康/清理

1. **下载**（如未安装）：官方 URL + 固定 SHA-256；下载到 `dataRoot/tmp`；校验；解压只取 `easytier-core.exe`、`easytier-cli.exe`、`wintun.dll`、`LICENSE`；原子 rename 到 `dataRoot/modules/link/bin/easytier/2.7.0/`；写 `manifest.json`（版本/哈希/来源/时间）。
2. **启动**：分配端口 → spawn（隐藏窗口，`windowsHide:true`）→ 等 RPC 可用（≤20 s）→ 查询 `peer`/`node` 健康 → 更新状态。
3. **健康检查**：每 2 s 查 RPC（`easytier-cli -p 127.0.0.1:<rpc> node`/peer）；连续 3 次失败 → `SIDECAR_CRASHED`；自动重启一次；再失败 → 降级。
4. **停止**：先发 `CLOSE`（房间协议）→ `SIGTERM`/`taskkill /T` → 等 2 s → 强杀；删除临时 token 文件；关闭所有 listener。
5. **日志**：sidecar stdout/stderr 重定向到 `dataRoot/logs/link/easytier-<role>-<room>.log`；滚动 5 MB×3；不含 ticket/token；诊断包只带最后 200 行 + 哈希/版本。
6. **禁止**：不自动加防火墙规则；不自动改路由；不把 RPC 暴露到非 loopback；不在 app 退出后留进程（注册 `before-quit`/`will-quit` + 进程树清理）。

### 6.8 与 launch 模块的集成

1. **世界端口发现**：房主启动实例 → 订阅 `launch:evt:output` + tail `mcRoot/versions/<dir>/logs/latest.log`；匹配 `Started serving on <port>` / `Local game hosted on port <port>`；≤5 s 更新房间 `world.port`；120 s 未发现 → `WORLD_NOT_FOUND` + 手动输入。
2. **成员进世界**：`enterWorld()` → 检查实例版本/加载器 → `launch.start({instanceId, extraArgs:["--server","127.0.0.1","--port",String(localWorld)]})`；dry-run 里可见；不修改实例 JSON。
3. **同机双开**：两个进程不同 `--data-dir`；房间状态按 dataRoot 隔离；MC 端口不同（房主 25565，成员用本地转发端口）；不启用全局单实例锁（01 R0.8）。
4. **失败**：成员启动失败不关闭房间；提示“重试/换实例”；房主关闭 → 成员收到 `CLOSE`，已启动的 MC 不受影响（只是无法重连）。
5. **不自动进服**：P0 只通过房间面板“进入世界”按钮；服务器列表/收藏是 P1。

### 6.9 UI 流程（联机页）

**房主页**：

```
┌ 联机 ──────────────────────────────────────────────┐
│ [创建房间]  [加入房间]                              │
│                                                    │
│ 房间号  MCL-4SA2XE        状态 等待成员 (0/8)       │
│ 邀请码  [复制完整邀请] [二维码]                     │
│ 世界    未检测到 LAN 世界（请在游戏内“对局域网开放”）│
│ 成员    （空）                                     │
│ 路径    直连（P2P） / 中继（经 xxx） / 局域网        │
│ 延迟    --                                         │
│ [关闭房间] [诊断]                                   │
└────────────────────────────────────────────────────┘
```

**成员页**：

```
┌ 加入房间 ──────────────────────────────────────────┐
│ 邀请码 [MCL1.…… 粘贴]  [加入]                       │
│ 房主 poc-host · 1.20.1 · 直连 · 预计 12 ms          │
│ 实例   [1.20.1 ▼]  （自动匹配 ticket）              │
│ [进入世界]  [复制地址]  [诊断]                      │
│ 提示：经中继时，网络流量对中继运营方可见（元数据）。 │
└────────────────────────────────────────────────────┘
```

**文案原则**：
- 不承诺“一定能连”；用“正在尝试直连/中继/需要手动映射”。
- 失败卡片必须有：错误码、人话、下一步（重试/换中继/手动映射/复制诊断）。
- 首次隧道下载弹窗：版本、来源 URL、SHA-256、许可证（LGPL-3.0）、源码链接、磁盘/流量大小；用户勾选同意才下载。
- 中继提示：默认加密（AES-GCM），中继可见连接元数据（IP/流量/时长），不可见 MC 内容；敏感场景用自建节点/直连。
- 离线 LAN 提示：MC 局域网世界本身不加密，同网设备可嗅探；不要在公共 Wi-Fi 开房。

---

## 7. 本地服务与安全约束

### 7.1 监听面清单（硬约束）

| 服务 | 绑定 | 端口 | 认证 | 生命周期 | 约束 |
|---|---|---|---|---|---|
| 房间控制面（L0） | `127.0.0.1` 或私网 IP | OS 临时 | ticket token HMAC + nonce | 房间期间 | 禁止 `0.0.0.0`；启动断言 |
| 房间控制面（跨网） | 专用 alias（`127.0.0.<x>`） | OS 临时 | 同上 | 房间期间 | 仅经成员 port-forward 可达 |
| EasyTier RPC | `127.0.0.1` | OS 临时 | `--rpc-portal-whitelist 127.0.0.1/32`；token 文件 ACL 0600（若支持） | 进程期间 | 不用默认 15888；不暴露 |
| EasyTier peer | 私网 IP（host） | OS 临时 | network secret（AES-GCM） | 进程期间 | 不用 `0.0.0.0`；成员 `--no-listener` |
| 成员 localWorld/localControl | `127.0.0.1` | OS 临时 | MC 自身/控制面 token | 房间期间 | 仅本机 |
| LAN 发现（UDP） | 私网 IP | 25999（可配） | nonce + ticket 签名 | 房间期间 | 只回请求 nonce；≤4 KB；限速 |
| MC 集成服务器 | 游戏决定（通常 `*:25565`） | 游戏端口 | MC 自身 | 游戏期间 | 启动器不改；提示防火墙 |

**启动时断言**（SEC-NET-03）：所有 `net.Server.listen` 必须显式 host；启动后检查 `server.address().address` 不是 `0.0.0.0`/`::`；CI grep 禁止无 host 的 `listen(port)`。

**“仅 127.0.0.1”的精确口径**：

- **L0**：控制面、成员本地端口、RPC 全部只绑 `127.0.0.1`（临时端口）。
- **L1**：房主控制面可绑**私网 IP**（用户显式“创建房间”即同意局域网可见），仍禁止 `0.0.0.0`；UDP 发现绑私网 IP。
- **跨网**：控制面/MC 只监听专用 loopback alias（`127.0.0.<x>`），由 EasyTier 映射进虚拟网络；不直接开公网端口。
- **一次性 state/token**：控制面 `HELLO` 的 nonce 只接受一次（重放即 `AUTH_FAILED`）；RPC token 每次 sidecar 启动重新生成并写入 ACL 0600 的临时文件，退出即删除；OAuth 回调的 `state` 由 auth 模块单次使用（02 SEC-NET-01），link 不实现 HTTP 回调。

### 7.2 秘密与日志

| 秘密 | 存放 | 日志 | 渲染进程 |
|---|---|---|---|
| ticket（含 net.secret） | 内存；可选 `safeStorage` 加密的房间状态文件 | **绝不** | 只在用户点“复制邀请”时经一次 IPC 返回；不放进全局 store |
| net.secret | 同上 | 绝不 | 不暴露 |
| 控制面 token | 内存 | 绝不 | 不暴露 |
| Ed25519 私钥 | 内存（房间结束即销毁） | 绝不 | 不暴露 |
| 成员 ID/名称 | 内存/房间状态 | 可（脱敏） | 可 |
| 公网 IP/端点 | 房间状态 | 可（诊断包需脱敏） | 可 |

**日志规则**：link 模块的日志字段白名单（`code/roomCode/memberId/transport/latency/bytes/errorCode`）；ticket/token/secret 永不进日志；`exportDiagnostics` 自动正则剔除 `MCL1.` 开头的字符串。

### 7.3 权限与提权

- **默认 no-TUN**：不需要管理员、不创建虚拟网卡、不装驱动。
- **TUN 可选（P1）**：只在用户选择“兼容/性能模式”时请求 UAC；弹窗说明“将创建虚拟网卡、可能修改路由表”；拒绝则回退 no-TUN；**不静默提权**（SEC-EXE-08）。
- **防火墙**：不自动 `netsh advfirewall`；不请求管理员改防火墙；只提示用户允许 Java/端口（SEC-NET-08）。
- **杀软**：sidecar 首次运行可能被拦截；提示“允许 easytier-core.exe”；提供哈希供用户核对。

### 7.4 中继隐私

- EasyTier 默认对 peer 通信加密（AES-GCM），中继转发的是密文；中继可见：源/目的虚拟 IP、连接时间、流量大小、时长；不可见：MC 协议内容。
- UI 必须在“经中继”时显示徽标 + 一句话说明；首次使用中继弹窗确认。
- 自建节点：用户自己承担可见性；产品不代建、不代管。
- 公共社区节点：默认关闭；用户显式添加；不写入产品默认配置；不保证可用/隐私。

### 7.5 滥用与限额

- 成员上限 8；房间 TTL 10 min（ticket）/12 h（房间）；短码限速；控制面消息 ≤64 KB；UDP 发现 ≤4 KB。
- 不做“公网大厅/匹配”；不做“跨房间转发”；不做“启动器 HTTP API”（SEC-NET-06）。
- 中继：不自建；用户自建节点由用户负责限流/鉴权（文档给出 `--private-mode`/`--relay-network-whitelist` 建议）。
- 诊断包：脱敏 + 用户确认后导出；不上传。

### 7.6 供应链

| 项 | 要求 |
|---|---|
| 版本 | 固定 `2.7.0`；清单文件记录 tag/URL/SHA-256/日期 |
| 来源 | 官方 GitHub release；镜像仅传输，必须匹配官方 SHA-256；不落盘未校验文件 |
| 校验 | zip SHA-256 + 解压后每个 exe/dll SHA-256；失败即删除并报错 |
| 解压 | 只取白名单文件；防 zip-slip；限制解压大小；不执行包内脚本 |
| 许可证 | 随附 LGPL-3.0 全文 + 源码 URL（tag）+ 修改声明（无修改）；About 页可见 |
| 替换 | 允许用户指定已安装的 `easytier-core.exe` 路径；仍校验版本/哈希（或明确“用户自担风险”开关） |
| 升级 | 不自动升级；新版本走版本清单评审 + 哈希更新 + 回归 |
| 卸载 | 删除 `dataRoot/modules/link/bin/easytier/2.7.0/`；保留用户配置；提示许可证文件可保留 |

---

## 8. 实现设计（t9 可直接照写）

### 8.1 模块结构

```
src/main/modules/link/
├── index.ts                 # register(ctx)
├── service.ts               # RoomService（host/member 编排）
├── handlers.ts              # IPC handlers
├── config.ts                # zod 配置（默认关闭、中继列表、别名范围）
├── room/
│   ├── host.ts              # 控制面 server + 成员表 + 心跳
│   ├── member.ts            # 连接 + 认证 + 心跳
│   ├── control.ts           # NDJSON 编解码/限额
│   ├── ticket.ts            # 复用 src/shared/link-ticket.ts（纯函数）
│   └── discovery.ts         # LAN UDP 发现（25999）
├── tunnel/
│   ├── easytier.ts          # EasyTierManager（下载/启动/健康/停止）
│   ├── args.ts              # 参数纯函数（host/member 矩阵）
│   ├── download.ts          # 官方 URL + SHA-256 + 解压白名单
│   ├── relay.ts             # 中继配置/连通测试
│   └── fallback.ts          # 降级链状态机
└── ui/                      # 仅类型/文案常量（渲染层在 src/renderer/features/link）
```

**依赖方向**：`link → instance, launch, net, store, log`；`launch` 不 import `link`；`link` 可选 lazy 加载（03 ADR-013），失败不影响主链路。

### 8.2 `src/shared/link.ts` 契约增补（相对 03 §12.7 的兼容扩展）

```ts
// 03 已有：RoomState/RoomMember/RoomInfo/contract（create/join/leave/status/enterWorld）
// 建议新增（不破坏旧字段）：

export const Transport = z.enum(['lan', 'p2p', 'relay', 'manual', 'none'])
export const TunnelState = z.enum(['idle','downloading','starting','up','degraded','failed','stopped'])

export const InviteInfo = z.object({
  code: z.string().length(6),                 // 短码，可显示
  ticketReady: z.boolean(),                   // 完整 ticket 是否已生成
  expiresAt: z.number().int(),                // Unix ms
  endpoints: z.number().int(),                // 端点数（不暴露地址细节给渲染层？可见）
  transport: Transport,
})

export const RoomInfoV2 = RoomInfo.extend({
  transport: Transport.default('lan'),
  tunnel: z.object({ state: TunnelState, version: z.string().nullable(), relay: z.boolean() }),
  inviteInfo: InviteInfo,
  host: z.object({ name: z.string(), mcVersion: z.string(), loader: z.string() }),
  error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
})

// 方法增补
copyInvite: { input: z.void(), output: z.object({ ticket: z.string() }) }, // 用户手势；不落日志
diagnose:   { input: z.void(), output: z.object({ json: z.string() }) },   // 脱敏诊断
```

> 03 §12.7 的 `invite` 正则保持 `^MCL-[0-9A-HJKMNP-TV-Z]{6}$/i`（短码）；完整 ticket 用 `copyInvite` 返回，不塞进 `invite` 字段，避免破坏既有契约。若 UI 需要展示 ticket 尾部，只显示 `jti` 前 4 位。

### 8.3 `RoomService` 接口（main 内部）

```ts
interface RoomService {
  create(opts: { instanceId: string; transport: 'lan'|'auto'; consentTunnel: boolean }): Promise<RoomInfoV2>
  join(opts: { ticket: string; instanceId?: string }): Promise<RoomInfoV2>
  leave(): Promise<void>
  status(): RoomInfoV2 | null
  copyInvite(): Promise<string>
  enterWorld(): Promise<{ sessionId: string }>
  diagnose(): Promise<string>
  dispose(): Promise<void>
}
```

### 8.4 数据文件（`dataRoot/modules/link/`）

```
link/
├── config.json                 # enabled=false, relay.peers[], aliasRange, maxMembers
├── rooms/<roomId>.json         # 非秘密状态（code/transport/world/成员摘要）；ticket 用 safeStorage 加密或仅内存
├── bin/easytier/2.7.0/
│   ├── easytier-core.exe
│   ├── easytier-cli.exe
│   ├── wintun.dll
│   ├── LICENSE-LGPL-3.0.txt
│   └── manifest.json            # tag/url/sha256/extractedAt
└── logs/easytier-<role>-<room>.log
```

**写入**：原子写（tmp→fsync→rename）；`config.json` 单写者；房间文件关房删除；不写 ticket。

### 8.5 `EasyTierManager` 关键流程

```
ensureInstalled():
  if manifest exists and all hashes match -> return
  download official zip -> verify zip sha256 -> extract whitelist -> verify each -> atomic move -> manifest
  on any failure: delete tmp, throw LinkError(TUNNEL_DOWNLOAD_FAILED|TUNNEL_HASH_MISMATCH)

start(role, room):
  ports = allocate()
  args = buildArgs(role, room, ports)
  proc = spawn(core, args, {windowsHide:true, stdio:['ignore','pipe','pipe']})
  waitHealth(rpcPort, 20s) else stop + throw TUNNEL_START_FAILED
  return handle

health():  every 2s -> rpc node/peer; 3 failures -> SIDECAR_CRASHED
stop():    close control -> SIGTERM -> 2s -> taskkill /T /F -> cleanup temp token
```

**日志脱敏**：stdout 行过滤 `MCL1.`、`network_secret`、`token`；只保留 level/模块/错误码。

### 8.6 降级链实现（伪代码）

```ts
async function joinWithFallback(ticket, instanceId) {
  const parsed = parseTicket(ticket)                 // 失败 -> INVITE_*
  assertInstanceMatches(parsed.mc, instanceId)       // 失败 -> VERSION_MISMATCH
  if (sameLanReachable(parsed.endpoints)) return joinLan(parsed)
  if (!config.tunnelEnabled) throw needsConsent()
  const sidecar = await easytier.ensureInstalled()    // 失败 -> TUNNEL_DOWNLOAD_FAILED
  try {
    await sidecar.start('member', parsed)
    await joinControl(parsed, sidecar.localControl)   // 失败 -> NETWORK_UNREACHABLE
    return { transport: 'p2p' }
  } catch (e) {
    if (canRelay(parsed, config.relay)) {
      await sidecar.start('member', parsed, { relay: config.relay })
      await joinControl(...)
      return { transport: 'relay' }
    }
    return manualMappingGuide(parsed)                 // PORT_MAPPING_REQUIRED
  }
}
```

### 8.7 测试计划

| 层 | 用例 | 工具/证据 |
|---|---|---|
| 单测 | ticket 生成/校验/篡改/过期/时钟偏差/长度；Base32；canonical JSON | vitest；复用 `poc/link/room/protocol.mjs` 逻辑移植 |
| 单测 | 参数矩阵（host/member/relay/TUN）快照；端口分配；日志脱敏 | vitest golden |
| 集成 | 双进程 room（11 用例）；LAN 发现；错误码 | vitest + child_process（PoC 脚本改 TS） |
| 集成 | EasyTier 下载哈希失败回滚；zip-slip；sidecar 崩溃重启 | mock HTTP + 临时目录 |
| E2E | 双开建房/加入/开 LAN/进世界；关闭通知；错误邀请 | Playwright + 本地 MC 1.20.1（P0-6 L0） |
| 安全 | 无 `0.0.0.0`；RPC 仅 loopback；ticket 不进日志；导出包脱敏 | 启动断言 + 日志扫描 + 人工 |
| L1 | 两台设备同 LAN | 手工/条件；记录防火墙与延迟 |
| L2 | 跨网 P2P/中继/手动映射 | 条件；第二网络/中继节点 |

### 8.8 工作量（P0-6 30 pd 拆分建议）

| 工作 | pd | 备注 |
|---|---:|---|
| 房间协议 + ticket/短码 + 单测 | 6 | PoC 已有参考实现 |
| LAN 发现 + 控制面 + 生命周期 | 4 | UDP 25999、限速 |
| 联机页 UI + 状态机 + 文案 | 5 | design 稿 link-host/member |
| launch 集成（端口发现/--server/双开） | 3 | 依赖 t6 |
| 隧道管理（下载/校验/启动/清理）+ no-TUN 参数 | 5 | 条件项；PoC 已验证 |
| 测试（单测/集成/E2E/安全） | 5 | L0 硬门禁 |
| 文档/诊断/证据 | 2 | 本文件 + 手册 |
| **合计** | **30** | 与 01 P0-6 一致 |

---

## 9. 验收与证据

### 9.1 01 §5.7 A6.1–A6.10 映射

| 01 验收 | 本文落点 | 验证方式 |
|---|---|---|
| A6.1 创建 ≤5 s；房间号/邀请格式；状态日志 | §6.1/§6.2/§6.4 | E2E + 日志 `room.create/join/ready/close` |
| A6.2 加入 ≤10 s；成员列表 2 人；延迟 | §6.3/§6.4 | 双开 E2E |
| A6.3 LAN 端口发现 ≤5 s；地址正确 | §6.8 | 读 latest.log + 房间面板 |
| A6.4 一键进世界（`--server/--port`） | §6.8 | dry-run + 启动断言 |
| A6.5 版本不匹配/错误邀请 ≤5 s 不启动 | §6.3/§6.5 | 负向 E2E |
| A6.6 房主关闭 ≤5 s；邀请失效 | §6.4 | E2E；PoC 511 ms |
| A6.7 仅回环/私网监听；无外部中继连接 | §7.1 | netstat + 启动断言 |
| A6.8 隧道 sidecar 哈希/许可证/可关闭 | §6.7/§7.6 | 单测 + 安装目录检查 |
| A6.9 L2 条件：隧道/中继/手动至少一条可用 | §4.2/§5 | 本机数据面 PASS；跨网条件 |
| A6.10 未启用时无外部连接 | §6.7/§7.1 | 进程/网络快照 |

### 9.2 发布门禁（联机部分）

- [ ] L0 双开全流程通过（P0 硬门禁，smoke 第 15 步）。
- [ ] 错误码/文案齐全；无“无限转圈”；失败 ≤5 s。
- [ ] netstat 证明无 `0.0.0.0` 的启动器服务；RPC 仅 loopback。
- [ ] ticket/token 不出现在日志/诊断包/崩溃报告。
- [ ] EasyTier 版本/哈希/许可证/源码链接随安装目录可见；未启用时无 sidecar。
- [ ] 关闭房间/退出 app 后无 easytier-core 残留（进程树清理）。
- [ ] L2 若宣称“可用”，必须有跨网证据；否则 UI 明确“条件支持/需中继”。

### 9.3 失败判据（沿用 01）

需要手输 IP 才能进入；邀请码错误无限转圈；开 LAN 后 5 s 未发现端口；房主关闭后成员无感知；默认连接公网中继；任一成立 → 不通过。

---

## 10. 风险、未决问题与差异

### 10.1 风险登记

| ID | 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|---|
| R1 | Symmetric NAT/CGNAT 导致 P2P 失败 | 高 | 跨网不可直连 | 中继/手动映射一等公民；IPv6 优先；UI 不承诺直连 |
| R2 | 公共节点下线/无 SLA | 高（已发生） | 中继不可用 | 不默认公共节点；支持自备；多节点列表 |
| R3 | 中继成本/滥用 | 中 | 不可持续 | 不自建；用户自备；限额/文档 |
| R4 | Windows 防火墙拦截 | 中 | 房主世界不可达 | 提示允许 Java；alias/回环映射；手动指引 |
| R5 | TUN 需管理员 | 高 | 性能/兼容模式受限 | 默认 no-TUN；P1 UAC 可选 |
| R6 | LGPL 合规疏漏 | 低 | 法务/发布 | 固定清单/许可证/源码/可替换；发布门禁 |
| R7 | 短码被枚举 | 中 | 未授权加入 | 短码仅 LAN + 限速 + TTL；跨网 ticket |
| R8 | ticket 泄露 | 中 | 陌生人加入 | 10 min TTL、成员上限、关闭即失效、P1 房主确认 |
| R9 | 杀软误杀 sidecar | 中 | 隧道失败 | 哈希展示/用户允许/回退 LAN |
| R10 | 版本 `latest` 漂移 | 中 | 供应链 | 固定 tag + 哈希；不自动升级 |
| R11 | MC 只绑 LAN IP（非 0.0.0.0） | 低 | alias 映射失效 | 回退映射 LAN IP + 防火墙提示；ticket `exposeMode` |
| R12 | 双开端口/状态冲突 | 中 | L0 失败 | dataRoot 隔离；OS 临时端口；单房间限制 |

### 10.2 未决问题（给 captain / 后续）

| ID | 问题 | 建议 | Owner |
|---|---|---|---|
| **Q5** | 联机方案与是否自建中继 | **EasyTier + 不自建 + frp 仅文档**；P1 观察需求后再评估官方中继 | captain + net-dev |
| Q12 | 是否 P1 做 TUN 模式 | 先 no-TUN；若 IPv6/性能不足再做 UAC 引导 | captain + t9 |
| Q13 | 公共社区节点是否允许用户添加 | 允许但默认空；首次添加需确认隐私/无 SLA；不内置列表 | captain + 法务 |
| Q14 | 是否提供二维码/短链邀请 | P1；二维码只编码 ticket；短链需要后端，不做 | t9 + t10 |
| Q15 | 中继隐私文案法务复核 | 按 02 NET-16 草案；上线前法务确认 | captain + 法务 |
| Q16 | Windows 10/ARM64 验收机 | 需设备；至少 Win10 x64 回归 | t14 |
| Q17 | 真实双机 L1/L2 验收安排 | 需第二网络/设备；可借手机热点 + 另一台 PC | captain |

### 10.3 与 01/02/03 的差异/补充

1. **03 §12.7 `invite` 仍是 6 位短码**：本文不破坏它，新增 `copyInvite` 返回完整 ticket；t9 需在 `shared/link.ts` 增补字段（§8.2），并在实现后同步 03 的契约附录（或由 captain 决定是否改 03）。
2. **01 说“P0 允许但不要求 EasyTier”**：本文进一步明确 **L0 不加载、L2 才加载**，且默认 no-TUN；与 01 的“条件验收”一致。
3. **02 要求“隧道组件运行时下载”**：本文给出具体版本/哈希/解压白名单/镜像校验规则；与 NET-03/04 一致。
4. **`--tcp-whitelist` 的负面结果**：02 未把它列为安全边界；本文明确不得依赖（新增实现约束）。
5. **公共节点**：02 只要求“UI 标来源”；本文进一步要求**默认不连、可禁用、多节点、不可写死**（因实测 NXDOMAIN）。

---

## 11. 附录

### 11.1 EasyTier 2.7.0 常用参数速查（联机相关）

| 参数 | 用途 | 本设计用法 |
|---|---|---|
| `-i/--ipv4` | 虚拟 IPv4 | host `10.144.144.1`；member `10.144.144.2`（每房间可随机） |
| `-p/--peers` | 初始对等节点 | host 可指向中继；member 指向 host LAN IP/中继 |
| `-l/--listeners` | 监听器 | host `tcp://<lan-ip>:<port>`；member `--no-listener` |
| `--no-listener` | 不监听 | member 必开 |
| `--no-tun` | 不建 TUN | 默认 |
| `-n/--proxy-networks` | 子网代理/映射 | host `127.0.0.<alias>/32->192.168.77.1/32` |
| `--port-forward` | 本地→虚拟转发 | member `tcp://127.0.0.1:<local>/192.168.77.1:<port>` |
| `--mapped-listeners` | 手动公网地址 | 手动映射场景可用 |
| `--socks5` | SOCKS5 入口 | 备用（P2） |
| `-r/--rpc-portal` | 管理 RPC | `127.0.0.1:<random>`（不要默认 15888） |
| `--rpc-portal-whitelist` | RPC 白名单 | `127.0.0.1/32` |
| `--relay-network-whitelist` | 允许转发的网络 | 自建中继节点用 `'*'` 或房间前缀 |
| `--private-mode` | 只允许同 secret/credential | 自建中继建议开 |
| `--enable-udp-broadcast-relay` | LAN 广播中继 | **不用**（需管理员；我们直接注入 `--server`） |
| `--disable-encryption` | 关闭加密 | **禁止**（默认 false） |
| `--encryption-algorithm` | 加密算法 | 默认 `aes-gcm`；不改 |
| `--mtu` | MTU | 默认 1360（加密）/1380；异常时再调 |
| `--latency-first` | 低延迟优先 | 可选（P1） |
| `--p2p-only` | 只用 P2P | 不启用（否则无法中继） |
| `--lazy-p2p` | 按需打洞 | 可选（P1） |
| `--compression` | zstd 压缩 | 默认 none；MC 流量压缩收益低，P2 再评估 |
| `--check-config` | 校验配置后退出 | CI/诊断 |

### 11.2 ticket 示例（字段裁剪；秘密已替换）

```json
{
  "v": 1,
  "code": "4SA2XE",
  "roomId": "VtynQN3dkxyNXAtUwi3ulg",
  "host": { "name": "poc-host", "pub": "C1mCeyyz0JcUsse...redacted" },
  "net": { "name": "mcl-4sa2xe", "secret": "QYVZ6tgSFqzrgnIH...redacted" },
  "endpoints": [{ "kind": "lan", "host": "10.33.135.230", "port": 52005 }],
  "tunnel": {
    "provider": "easytier",
    "version": "2.7.0",
    "vip": "10.144.144.1",
    "mappedCidr": "192.168.77.1/32",
    "worldPort": 25565,
    "controlPort": 25998
  },
  "mc": { "version": "1.20.1", "loader": "vanilla" },
  "max": 8,
  "iat": 1792560472,
  "exp": 1792561072,
  "jti": "fGcXBjrKYA8"
}
```

> 实际 ticket 为 `MCL1.<code>.<base64url(canonical-json)>.<base64url(sig)>`，约 700–900 B；示例中的 `roomId` 用 base64url 显示，长度 16 B。

### 11.3 frp 自带服务器配置模板（P2 文档用，不随包）

`frps.toml`（服务器）：

```toml
bindPort = 7000
auth.method = "token"
auth.token = "<32+ 字节随机>"
# 不开启 dashboard；如开：webServer.addr = "127.0.0.1"，随机端口 + 强口令
```

`frpc.toml`（房主/成员侧）：

```toml
serverAddr = "<frps 公网 IP 或域名>"
serverPort = 7000
auth.method = "token"
auth.token = "<同 frps>"

[[proxies]]
name = "mc-<room>"
type = "tcp"
localIP = "127.0.0.1"
localPort = 25565
remotePort = 25565
```

> 安全：`frpc` admin UI 默认 `127.0.0.1:7400`，产品默认关闭；如开，随机端口 + 强口令 + 仅 loopback（02 NET-08）。frps 公网暴露需限流/鉴权/防滥用；本产品不代管。

### 11.4 MC LAN 日志与端口

| 场景 | 日志/文案 | 处理 |
|---|---|---|
| 集成服务器开 LAN | `Started serving on <port>`；聊天 `Local game hosted on port <port>` | 正则 `Started serving on (\d+)` / `Local game hosted on port (\d+)`；≤5 s 更新 |
| 专用服务器 | `Starting Minecraft server on *:25565` | 仅 PoC 用；产品不启动专用服务器 |
| 世界关闭 | `Stopping server` / 连接断开 | 房间 `world.state=closed`；成员提示 |
| 120 s 未发现 | — | `WORLD_NOT_FOUND` + 手动端口输入 |

### 11.5 参考资料（均为 2026-10-21 访问）

- EasyTier 仓库/发布：<https://github.com/EasyTier/EasyTier>、<https://github.com/EasyTier/EasyTier/releases/tag/v2.7.0>
- EasyTier 无公网 IP 组网（公共节点示例）：<https://doc.easytier.cn/guide/network/networking-without-public-ip.html>
- EasyTier 无 TUN 模式：<https://doc.easytier.cn/guide/network/no-root.html>
- EasyTier 完整配置：<https://doc.easytier.cn/guide/network/configurations.html>
- frp：<https://github.com/fatedier/frp/releases/tag/v0.71.1>、<https://github.com/fatedier/frp>
- nps：<https://github.com/ehang-io/nps>（README 默认 `admin/123`）
- ZeroTier 许可：<https://github.com/zerotier/ZeroTierOne/blob/dev/nonfree/LICENSE.md>
- `@xmcl/nat-api`：<https://www.npmjs.com/package/@xmcl/nat-api>（MIT）
- Minecraft 1.20.1 server：本机 `poc/link/tools/mcserver/server-1.20.1.jar`（SHA-1 `84194a2f286ef7c14ed7ce0090dba59902951553`，BMCLAPI 下载）

### 11.6 术语/缩写

| 缩写 | 含义 |
|---|---|
| P2P | 点对点直连（不经过中继） |
| NAT | 网络地址转换 |
| CGNAT | 运营商级 NAT（用户无公网 IPv4） |
| STUN | 用于发现公网映射的协议 |
| TUN | 虚拟网卡（三层） |
| LGPL | GNU 宽通用公共许可证 |
| HMAC | 基于哈希的消息认证码 |
| Ed25519 | EdDSA 椭圆曲线签名 |
| NDJSON | 每行一个 JSON |

---

**文档结束**。实现时若与 01/02/03 冲突，按文首权威顺序处理；PoC 证据与脚本可复现，跨网/中继缺口已在 §5.5 与 §10 明确登记，不作为“已验收”。
