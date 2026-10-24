# 14 · 联机对比：Cubit Launcher / PCL / HMCL（2026-10-24）

> 问题：我们的联机（`net` 模块）和 PCL、HMCL 的联机到底差在哪、强在哪，接下来该往哪走。
> 方法：三家都读了可读的一手材料（源码分析、官方文档、官方讨论），**没有复制任何代码**；`clean-room-log.md` 的规则不变。
> 我们的状态以 `docs/12`、`docs/13` 为准（真机通了"邀请码 WAN 端点 → 隧道 → 控制面"，中继未通）。

## 0. 一句话结论

**2025 年之后，PCL（社区版）、HMCL、FCL 已经收敛到同一个生态：EasyTier + Scaffolding 协议 + 房间码 + "大厅"（多人游戏列表里直接出现）+ 社区打洞/中继节点。我们是这四家里唯一自研房间协议、也没有大厅的一方。** 传输层我们用得对（同为 EasyTier、同样 `--no-tun`），差的是**协议互通**和**进入游戏那最后一步的体验**。

## 1. 三家现状

| | HMCL | PCL（官方 2.11.x / 社区版 PCL-CE） | 我们（Cubit Launcher） |
|---|---|---|---|
| 隧道引擎 | EasyTier（经 **Terracotta 陶瓦联机**） | EasyTier（直接集成，`ETController` / `EasyTierEntity`） | EasyTier 2.7.0（直接集成，`net/easytier.ts`） |
| 房间协议 | **Scaffolding**（Terracotta 实现） | PCL-CE：**Scaffolding**；官方版另有"简洁联机标记约定"，并在 issue 里推进支持 Scaffolding | **自研 MCL1 ticket**（Ed25519 签名，6 位短码展示） |
| 与他人互通 | HMCL ↔ PCL CE ↔ FCL 已互通（Scaffolding） | 同左 | ❌ 孤岛，只能和我们自己联 |
| 房间码 | 有（Terracotta 房间码） | 有（两种格式，编码网络凭据） | 6 位 Crockford 短码 + 完整 `MCL1.<code>.<payload>.<sig>` |
| 大厅体验 | 多人游戏列表里出现「陶瓦联机大厅」，双击加入 | 房客侧 `BroadcastLocal` 往 MC 组播发 UDP，本地 MC 把大厅当普通局域网世界 | ❌ 启动游戏 + 让玩家自己进「多人游戏 → 局域网世界」 |
| 世界发现 | 内置 MC 服务扫描 | 组播 `224.0.2.60:4445` + `McPing` 校验，扫 3 秒 | 组播 + 房主日志 `Started serving on`（`discovery.ts`） |
| 网络质量展示 | 有 | NAT 类型（Open/Full Cone/Port Restricted/…）+ 连接类型（Local/P2P/Relay）+ 质量三档 | 只有 `p2p / relay / lan` |
| 中继 | 社区志愿者提供的打洞/中继节点，P2P 优先 | `ETRelay`：Community / Selfhosted / Custom；`ForceRelay` 时加 `--disable-p2p` | 用户自填 `relayPeers`（最多 4 个）+ TCP 可达性测试；**不自建**（`MP-05`） |
| 账号 | 不需要注册 | 不需要注册 | 不需要注册（房间密钥即凭证） |
| 平台 | Win/macOS/Linux | Windows（PCL 是 .NET/WPF） | Windows（Electron） |
| 许可 | HMCL GPL-3.0；**Terracotta AGPL-3.0 + 例外** | PCL 官方 NOASSERTION；PCL-CE Apache-2.0 | GPL-3.0 |

来源：
- HMCL/Terracotta 官方说明（基于 EasyTier、房间码、大厅、无需账号）：<https://burningtnt.github.io/Terracotta/>
- HMCL 文档「多人联机反馈」（三家互通、P2P 优先、社区提供打洞服务器）：<https://docs.hmcl.net/multiplayer/feedback.html>
- PCL-CE 联机/大厅系统的源码级分析（Scaffolding 客户端/服务端、EasyTier 虚拟 IP、BroadcastLocal、NAT 文案、ForceRelay）：<https://zread.ai/PCL-Community/PCL-CE/19-multiplayer-and-lobby-system>
- PCL 官方推进 Scaffolding 的 issue：<https://github.com/Meloong-Git/PCL/issues/7401>
- PCL "简洁联机标记约定" 讨论：<https://github.com/Meloong-Git/PCL/discussions/7443>
- Terracotta 的 AGPL 例外原文（打包未修改二进制 / 通过 IPC 交互并标注版权则不传染）：<https://gitee.com/burningtnt/Terracotta>

## 2. 协议层：Scaffolding 是事实标准，我们是另一套

**Scaffolding**（`Scaffolding-MC/Scaffolding-MC`）已经有多语言实现：Terracotta（Rust）、`Scaffolding.NET`、`SwiftScaffolding`、`Florolding`（EasyTier-PyO3）、`Terracotta-lib`（Rust 库分支）。它做的事很清楚：

- 一条 TCP 控制连接：`Handshaking → Connected`，房客首个 `PlayerPingRequest` 兼做握手与身份声明；
- 5 秒心跳（`c:player_ping` + `c:player_profiles_list`），房主 10 秒没收到就踢人；
- 玩家列表、机器 ID、延迟都在协议里；
- 房间码编码的是"网络成员凭据"，不只是一串展示用的数字。

我们的 `MCL1` ticket 在**安全模型上不弱**：Ed25519 签名、≥256-bit 能力凭证、短码只做展示与 LAN 发现（`MP-04`）。差别在**生态**：别人拿到我们的邀请码进不来，我们拿到别人的房间码也进不去。

> 注意：Scaffolding 的具体线上格式（帧编码、房间码字符集/长度）我没能拿到一手源码（GitHub 在本机 DNS 被解析到私网，抓不到 raw 文件），上面的行为描述来自 PCL-CE 的源码分析页。真要对接，必须再读原始 spec。

## 3. 传输层：都是 EasyTier，用法有三处可比的细节

| 细节 | PCL-CE | 我们 |
|---|---|---|
| 虚拟网络入口 | 房主固定虚拟 IP `10.114.51.41`，hostname `scaffolding-mc-server-{scfPort}` | 房主 `10.144.144.1`，房客 `10.144.144.2` |
| 回环暴露方式 | 白名单列出 Scaffolding 端口 + MC 端口 | 专用 alias `127.0.0.x/32 -> 192.168.77.1/32`（`MP-03`，不映射整段 `127.0.0.1`） |
| 强制中继开关 | `RelayType == ForceRelay` → 附加 `--disable-p2p` | 没有显式开关；靠"只给中继地址"达到类似效果（`tunnelPeers` 里优先 wan/lan，最后 relay） |
| TUN | 有 TUN 模式 | 默认 `--no-tun`（免管理员），TUN 只作 P1 可选（`MP-02`） |

结论：传输层我们没有明显劣势，`--no-tun` + alias 的取舍甚至更保守；**缺的是"强制中继"这个显式开关**，以及 NAT 类型的可见性。

## 4. 体验层：差距集中在"最后一步"

这是最该抄（按思路重写，不复制代码）的地方：

1. **大厅（Lobby）**：PCL-CE 房客侧会起 `BroadcastLocal`，往 Minecraft 的组播地址发兼容 UDP 包，本地 MC 的「多人游戏」列表里就出现一个大厅条目，双击即进。我们目前是"启动游戏 + 弹一张步骤卡，让玩家自己点"。
2. **NAT / 连接质量文案**：PCL-CE 把 NAT 类型、连接类型（Local/P2P/Relay）、质量三档都摆出来。我们只有 `tunnel.state` 和 `p2p/relay`。
3. **房间码双格式**：PCL-CE 的码"编码网络凭据"，我们要求贴完整 `MCL1...` 串（6 位短码只能同网）。

## 5. 成本与合规：为什么"不自建中继"是对的

一篇中文社区长文把 PCL 联机的现实成本讲得很直白（<https://m.bilibili.com/opus/1136282681104924672>）：

- 公共 EasyTier 节点被当作"标好标签的高价值 IP 列表"打 DDoS；
- 国内云厂商服务条款普遍禁止"VPN / 代理 / 内网穿透 / 网络加速"，节点主被停机、销号；
- 大规模集成联机入口的启动器，在监管视角里"带一点组织网络服务入口的味道"。

这把我们的 `MP-05`（不自建中继、只做配置与提示）从"省钱"升级成"风险控制"。Terracotta 的对策也是同一逻辑：**极大程度基于 P2P**，官方明说"不会比基于服务器中继的方案稳定"。

**合规上有一条对我们很重要的信息**：Terracotta 是 AGPL-3.0，但附了例外——(1) 打包未修改的二进制且不链接，或 (2) 通过它的 IPC 接口交互且在 UI 明显处标注版权，则**不会**导致我们的作品被 AGPL 覆盖。也就是说"打包 Terracotta + 调它的 HTTP API + 在关于页标注"这条路在法律上是通的（仍需 NOTICE 与法务复核）。

## 6. 三条路

| 选项 | 做什么 | 代价 | 收益 |
|---|---|---|---|
| **A. 保持自研** | 继续修 WAN/中继，补大厅与 NAT 文案 | 自己承担协议正确性；永远不能和 PCL/HMCL 互通 | 完全可控、无 AGPL 顾虑、可慢慢做 |
| **B. 接入 Scaffolding** | 实现/移植 Scaffolding 客户端+服务端（TS），房间码对齐 | 要读 spec、要复刻大厅的 `BroadcastLocal`、要和 Terracotta 的行为对齐 | 与 HMCL/PCL-CE/FCL 互通；房间码体系立刻有"行业标准"背书 |
| **C. 双栈（推荐）** | 保留 `MCL1` 作为"我们自己的房间"，另加"Scaffolding 房间"入口 | 两套 UI/状态机、双份测试 | 老邀请码不废弃、又能立刻拥抱生态 |

短期（P1）建议按这个顺序：

1. **先补大厅**：房客侧往 `224.0.2.60:4445` 发 MC 兼容的 LAN 广播（我们已有 `discovery.ts` 的解析侧，反过来发即可），让游戏里直接出现条目——这是体验提升最大的一步，和协议选型无关。
2. **补 NAT/连接质量文案**：`easytier-cli node` 已经给了 `UDP Stun Type`，把它映射成可读文案即可（`publicip.ts` 已经在解析）。
3. **加 `ForceRelay` 开关**：设置里一个开关 → `--disable-p2p`，配合我们已有的 `testRelay`。
4. **再决定 B/C**：等 Scaffolding 的原始 spec 读透、且中继实验（`docs/13` §4）有结论之后再动，别在半懂的状态下实现一个"看起来能互通"的假协议。

## 7. 不确定 / 未核实

- Scaffolding 的线上帧格式与房间码编码（只看到二手分析，未见原始 spec）。
- PCL2 **官方版**当前是否已内置 Scaffolding（只有 issue #7401 与社区版源码分析；官方 2.11.1 的更新说明没抓到原文）。
- Terracotta 的公共打洞/中继节点由谁出资、可用性如何（HMCL 文档只说"社区志愿者"）。
- 我们与 Terracotta/Scaffolding 的互通**没有任何实测**——本文只做设计对比，不做能力声明。
