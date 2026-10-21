# 01 · 需求与范围（PCL2 基线 + 本轮 P0 验收）

| 项 | 值 |
|---|---|
| 文档编号 | `01-requirements` |
| 版本 | **1.6（定稿，可执行；1.6 修正 QA B8 的 A1.3/A1.4 上游数值笔误）** |
| 日期 | 2026-10-21 |
| 作者 | planner（产品经理 / 高级项目经理） |
| 上游证据 | `docs/research/10-feature-matrix.md`（本机勘察底稿）；本文件 §2 的独立复核；`docs/clean-room-log.md`（CR-001） |
| 合规基线 | `02-compliance-security.md`：PCL2 **非开源**（《PCL 分发有限许可》，GitHub `NOASSERTION`）；本项目按 clean-room C 档（不接触源码）执行 |
| 下游消费 | `02-compliance-security.md`、`03-architecture.md`、`04-multiplayer-design.md`、实现任务 t5+ |
| 约束 | 只定义"做什么 / 做到什么程度 / 怎么验收"，不定义实现方案，**不含产品代码** |

> **给实现者的最短路径**：先读 §0.2（范围裁定）和 §0.5（三个取舍）——它们决定你不需要做什么；再读 §5（P0 验收）——它决定你必须做到什么；其余章节是证据与背景，可查不必通读。

---

## 目录

- [0. 一页结论](#0-一页结论)
- [1. 背景、目标与产品原则](#1-背景目标与产品原则)
- [2. 证据与方法（含本机实测）](#2-证据与方法含本机实测)
- [3. PCL2 能力基线（parity 标尺）](#3-pcl2-能力基线parity-标尺)
- [4. 功能矩阵（价值 / 成本 / 依赖 / 联网 / 优先级）](#4-功能矩阵价值--成本--依赖--联网--优先级)
- [5. P0 范围与可复现验收](#5-p0-范围与可复现验收)
- [6. 本轮非目标](#6-本轮非目标)
- [7. 约束与依赖](#7-约束与依赖)
- [8. 风险与缓解](#8-风险与缓解)
- [9. 待决问题（给 captain）](#9-待决问题给-captain)
- [10. 交付物与证据规范](#10-交付物与证据规范)
- [附录 A–H](#附录-a-本机实例清单实测)

---

## 0. 一页结论

### 0.1 产品定义

> 一个 **Windows x64、中文优先、clean-room** 的 Minecraft 启动器（Electron + TypeScript + React）：能把**全新空目录**变成"原版 1.20.1 可启动"，能用**离线账户**进游戏，能**自动找到本机 Java**，能**正确设置内存与 JVM 参数**，**崩了能看懂**，并且能**一键建房让朋友进入你的 LAN 世界**。

本轮不做"PCL2 全功能复刻"。PCL2 的功能面在 §3/§4 完整列出并分入 P0/P1/P2，**只有 P0 是本轮的交付门禁**（§0.2）。

### 0.2 范围裁定（本文件最重要的一张表）

| 层级 | 含义 | 本文件条目 | 是否进本轮验收 |
|---|---|---|---|
| **P0** | 本轮交付门禁：不做完不能对外说"可用" | P0-0 骨架/UI/数据目录/实例识别；P0-1 版本解析+原版 1.20.1 安装与启动；P0-2 离线账户；P0-3 Java 自动检测；P0-4 内存/JVM 参数；P0-5 日志与崩溃提示；P0-6 联机（一键房间 + LAN 世界 + 隧道降级）；P0-7 微软设备码流程（真实登录 P1）/Authlib 账户；P0-8 模组/资源包/光影管理 + 整合包导入 | **是（§5）** |
| **P1** | 紧随其后的 parity 补齐；本轮**不验收**，有余量按 §6.4 顺序加做 | Forge/NeoForge/Fabric 安装、服务器自动进服与收藏、备份、完整设置、系统集成、Java 自动下载、下载增强、PCL 目录只读兼容、实例删除/多 MC 文件夹、联机重连/一致性指纹 | 否 |
| **P2** | 暂缓/可选 | Quilt/OptiFine/LiteLoader 安装、整合包导出、Mod 在线更新/翻译、数据包/世界下载、自定义主页/音乐、皮肤、帮助/公告/反馈、遥测、启动器更新器 | 否 |
| **永久不做** | 法律/定位底线 | 盗版与绕过正版验证、服务端托管、社交/好友大厅、插件市场、账号云同步 | 永不 |

**一句话取舍**：P0 的核心不是功能数量，而是 **"装得上、起得来、崩了看得懂、朋友进得来、账户能登、整合包能导入"**；Forge/加载器安装、备份、服务器列表、更新器仍不做。对应 P0-1/P0-2/P0-5/P0-6/P0-7/P0-8。

### 0.3 P0 一览（9 张验收卡）

| ID | 能力 | 硬验收（一句话） | 产品级成本 |
|---|---|---|---|
| **P0-0** | 骨架、UI 页面/状态机/主题、数据目录、实例识别 | 全部页面可达、明暗主题可切换并持久化；只读识别 15 个实例并标出 3 个缺 JSON 的异常实例，零文件改动 | 25 人日 |
| **P0-1** | 版本解析（含 inheritsFrom）+ 全新目录安装原版 1.20.1 + 启动到主菜单 | `inheritsFrom` 可合并、dry-run 可出完整命令行；空目录 → 下载 ~700 MiB → `Sound engine started`；≤ 15 min，SHA1 全对 | 33 人日 |
| **P0-2** | 离线账户 | `--username TestUser --uuid 097d…466c --accessToken 0 --userType legacy`，进游戏用户名为 TestUser；重启后仍记住 | 3 人日 |
| **P0-3** | Java 自动检测 | 在 `where java` 为空的机器上仍识别 3 个 Mojang runtime + 便携 JDK21；1.20.1 自动选 Java 17 并在命令行体现 | 8 人日 |
| **P0-4** | 内存与 JVM 参数（含分辨率/全屏） | 4 GiB 自定义 → `-Xmx4096m` 恰好一次；1280×720 → `--width/--height`；全屏 → `--fullscreen`；参数落盘可复核 | 9 人日 |
| **P0-5** | 日志与崩溃提示 | 人为制造 JVM 参数错误/游戏崩溃 → ≤ 10 s 弹出可读结论 + 可复制报告 + `launch-last.bat`；正常退出不误报 | 11 人日 |
| **P0-6** | 联机：一键房间 + 进入 LAN 世界 + 隧道降级 | 同机双开：A 建房 → B 输邀请码 → A 开 LAN → B 一键进世界；跨网隧道按 t4 PoC 条件验收，失败有可读降级路径 | 30 人日 |
| **P0-7** | 微软设备码流程 / Authlib / 多账户（**真实微软登录为 P1**） | 设备码流程可演示，未配置/未获批有明确提示且**不伪造成功**；Authlib jar 固定版本下载 + `-javaagent` 注入不崩溃；token 不落明文 | 17 人日 |
| **P0-8** | 模组/资源包/光影管理 + 整合包导入 | 扫描/启停/冲突/**拖入（拖拽）安装 + 选择文件安装 + 打开实例目录**可用；`.mrpack`/本地 CF zip 可导入并按清单校验；**CF 不调 API**，缺失文件列清单 + 打开项目页 | 28 人日 |
| | **合计** | | **164 人日**（产品级口径，见 §4.6；agent 并行只压缩墙钟时间） |

### 0.4 十个本机实测事实（决定验收怎么写）

1. 参照物是 **PCL 2.14.0.0 快照版 build 412**（`E:\MC\PCL`，日志自报），不是最新正式版；结论只对该快照负责。
2. 本机 `E:\MC\.minecraft\versions` 有 **15 个实例**；其中 **12 个版本 JSON 有效且全部扁平化（无 `inheritsFrom`）**，**3 个缺同名 JSON**（`1.21.1-Forge_52.1.1`、`1.21.1-Forge_52.1.10`、`The Last Voyage of the Harpy Express`）。研究底稿说的"2 个 JSON 损坏"是 PowerShell 以 ANSI 读 UTF-8 的**假阳性**（§2.3）。
3. 原版 1.20.1 的 Windows 实际下载足迹：客户端 jar 23,028,853 B + **64 个 Windows 适用 library（58 MiB，21 个 natives jar）** + **3575 个 assets 对象（索引 `totalSize=651,728,646` B；磁盘去重后 651,496,644 B）** + 索引 413,067 B ≈ **702 MiB**；解压后需 ≥ 1.5 GiB 空闲。
4. 本机 Java：3 个 Mojang runtime（17.0.15 / 21.0.7 / 25.0.1）+ 便携 JDK 21.0.12.1，但 **`where java` 输出为空**——只查 PATH 的检测方案在本机必然失败。
5. 网络实测（2026-10-21 12:2x）：`launchermeta.mojang.com`、`piston-data.mojang.com`、`libraries.minecraft.net`、`resources.download.minecraft.net` 均 200；**`piston-meta.mojang.com` 连续超时**；BMCLAPI 路径映射全部可用且支持 Range。→ 安装器必须有镜像回退，否则本机原地失败（§3.5/§7.2）。
6. PCL2 **没有"备份/还原"，也没有独立"服务器列表"**：可执行文件 UTF-16 检索"备份"0 次、"还原"0 次、"服务器列表"0 次，无对应页面。→ 这两项是我们 P1 的差异点，不是 parity。
7. PCL2 **有完整联机**：`PageLink` + `PageLinkMain.xaml`，EasyTier 运行时下载、房主/成员、邀请码、社区/自定义节点中继、NAT/延迟提示。→ "加联机"本身不是差异化，P0 的差异化只能是**更简单 + 可离线 + 进房前版本/加载器一致性校验**（mod 指纹 P1，§3.4）。
8. PCL 2.14.0.0 二进制/日志实测启动链路 12 阶段与耗时：点击→进程 8.3 s（内存优化占 8.1 s）、进程→窗口 4.5 s、窗口→材质加载完成 70 s（358 mods）、崩溃→报告 2.3 s。这些是**我们的验收上限参照**（§3.2）。
9. 锁定本机的工程事实：Windows 11 家庭中文版 10.0.26100、24 核、31.4 GiB RAM、Intel iGPU + RTX 5070 Ti Laptop、Node v24.20.0、npm 11.19.0（**`npm.ps1` 被执行策略 `Restricted` 拦截，验收命令必须用 `npm.cmd`**）、无 .NET SDK、PowerShell 5.1。
10. PCL2 的"可解释失败"是产品护城河：崩溃分析三步（收集日志→准备文本→分析原因）、错误报告复制、"下载源已被禁用/已无可用下载源"、`LatestLaunch.bat` 命令落盘。P0 只做其中**能读懂的最小集**，P1 再扩规则库。

### 0.5 三个必须现在拍板的取舍（默认值已写入本文件，可被 captain 否决）

| # | 取舍 | 本文件默认裁定 | 若否决的后果 |
|---|---|---|---|
| **A** | 联机 P0 做到哪一层？ | **LAN/同机必验 + 隧道按 t4 PoC 条件验收**：L0 同机回环是硬门禁；L1 同 LAN 双设备条件项；L2 跨网隧道（EasyTier/中转/手动映射）以 t4 PoC 结果为准，失败必须在 UI 给可读降级路径，完整 WAN 稳定性放 P1 | 若要求 L2 必须成功，本机可能无第二网络/设备，验收不可闭环 |
| **B** | 账户 P0 是否只做离线？ | **否**：P0 = 离线 + 微软设备码流程 + Authlib 注入。微软在**未配置 client id / 未获批**时只验"明确提示 + 不伪造成功"；真实登录与刷新依赖 Azure/MCE 审批（以周计），P1 验收 | 若不接受条件验收，正版登录会因外部审批阻塞整个 P0 |
| **C** | 安装 P0 是否只做原版 1.20.1？ | **是**（加载器安装 P1）；但 P0 必须能**解析并启动已有的 Forge/Fabric 风格版本**（`inheritsFrom` 合并，t6），只是不提供安装器 | 把 Forge/NeoForge/Fabric 安装器塞进 P0 会让验收链变长且行为漂移 |

> 这三条对应 §9 的 Q1（联机范围）与 Q2（P0 范围）。默认值自本文定稿起生效；captain 若要改，必须在实现任务开始前书面覆盖，并同步改 §5/§6。

### 0.6 发布门禁（Release Gate）

本轮交付必须通过 **§5.10 的端到端冒烟剧本**，其中：

- **阻断项**：安装/启动（第 3/4 步）、崩溃可读（第 8 步）、整合包导入（第 13 步）、联机 L0（第 15 步）任一失败 → 不得对外称"可用"；
- **证据要求**：每一步留下"落盘文件 + 进程命令行 + 启动器日志"三件套（§10.2）；
- **禁止**：用 mock/假进度/预置结果通过验收；禁止修改 `E:\MC\PCL` 与 `E:\MC\.minecraft` 的既有文件。

---

## 1. 背景、目标与产品原则

### 1.1 任务与约束（来自团队目标）

| 维度 | 约束 | 对本文件的影响 |
|---|---|---|
| 目标 | 具备 PCL2 主要功能：实例/版本、安装下载、Java、账户、启动参数、模组/资源包/光影、整合包、日志、联机；**额外提供联机** | 功能面必须完整列出（§4），但本轮只交付 P0（§5） |
| 技术栈 | Electron + TypeScript + React（本机无 .NET SDK，Node v24 可用） | 不做 WPF/C#；所有验收命令围绕 Node/npm/打包产物 |
| 实现方式 | **clean-room**：不复制 PCL2 源码 | 只参考行为、文件格式、目录/文件名；证据来源见 §2.1；代码审查按 02 文档执行 |
| 本机参考 | `E:\MC\PCL`（PCL2 安装，只读）、`tools\jdk21`（便携 JDK21） | 验收夹具与 Java 来源；**验收不得写这两个目录** |
| 交付位置 | `D:\DSH-工作文件\mc-launcher\` | 文档、代码、证据都在此树下 |

### 1.2 用户与 JTBD（从本机证据反推，不是拍脑袋）

**主画像**：中文整合包玩家，Windows 11，独显笔记本，自己攒了十几个实例，玩 200~360 mod 的重整合包；想和朋友一起玩，但不想租服务器。

| 证据 | 用户含义 |
|---|---|
| 15 个实例、最大 10,859 MiB / 311 mods、`史前世界 2` 358 mods | 实例隔离与扫描性能是刚需；"串实例"等于丢档 |
| `PCL.ini` 有 3 张主页卡片（`CardCount:3`），卡片值是实例名 | 用户把"最近在玩什么"当首页 |
| Java 17/21/25 三套共存，且单个实例强制 Java 21 | Java 选择必须 per-instance；全局一刀切会崩 |
| `1.20.4\PCL\Setup.ini` 有 `LittleSkin 登录` + yggdrasil 地址 + `VersionServerLogin:4` | 第三方 Authlib 是真实使用路径（P1，但功能面不能漏） |
| 整合包根目录的"想多人联机游玩？点我点我.txt"是开服广告（58 元/月起） | 联机需求真实且已在付费；官方联机体验没接住这批人 |

**JTBD**：

1. "我想在 5 分钟内把一个包跑起来，别让我调 Java 和内存。"
2. "我想知道它为什么崩了，而不是对着一屏英文发呆。"
3. "我想让朋友点一个邀请码就进我的世界，不用他装别的东西。"
4. "我有一堆旧实例，别让我为了用新启动器重装一遍。"（→ P1 的"零迁移只读兼容"）

### 1.3 产品原则（P0 验收会检查）

1. **不读、不复制源码**：只做黑盒行为观察（运行日志/落盘文件/进程命令行）与公开规范；GitHub 仓库只允许看目录/文件**名**（仅路径），不得打开 `.vb/.xaml/.resx/.png` 等内容；不得拷贝其源码/资源/字符串表。每次参考都记入 `docs/clean-room-log.md`，代码审查按 `02` 执行。
2. **失败可解释**：每次失败必须给出"一句人话 + 一个可复制的证据文件/文本"，禁止只弹异常堆栈。
3. **不写他人配置**：P0 对 `PCL\Setup.ini`、`PCL\config.json`、`launcher_profiles.json` **不读不写**；P1 最多只读解析，绝不写回。
4. **网络最小化**：除用户主动触发的安装/联机外不发请求；无遥测；更新检查 P1 再做。
5. **可降级**：下载源、联机路径、Java 选择都必须有"失败后的人话退路"，不静默卡死。
6. **表达层独立**（t2 LIC-03/06）：产品名不以 `PCL`/`Plain Craft Launcher` 开头或包含；界面主色不用 PCL 蓝；正版/赞助劝导文案自写；不使用 PCL 图标/背景/音乐/皮肤资源，不做 1:1 UI 复刻。

### 1.4 P0 成功指标（可测量）

| 指标 | 目标 | 测量方式 |
|---|---|---|
| 全新目录安装成功率 | ≥ 95%（连续 3 次，网络正常） | §5.2 步骤重复 3 次 |
| 安装耗时（100 Mbps） | ≤ 15 min | 启动器日志时间戳 |
| 启动到主菜单（原版 1.20.1） | ≤ 60 s | 进程创建 → `Sound engine started` |
| 崩溃报告生成 | ≤ 10 s，5 类高频原因可读 | §5.6 用例 |
| 微软账户错误路径 | 100% 诚实失败（无假成功、无明文 token） | §5.8 A7.1/A7.3 |
| 模组启停/冲突 | 100% 正确，不串实例 | §5.9 A8.1/A8.2 |
| 整合包导入 | 清单文件哈希/overrides 100% 一致 | §5.9 A8.3/A8.4 |
| 15 实例扫描 | ≤ 2 s，零文件改动 | §5.1 用例 |
| 同机联机进世界 | ≤ 60 s（从 B 点"进入世界"起算） | §5.7 用例 |
| 邀请码错误反馈 | ≤ 5 s 且不无限转圈 | §5.7 负向用例 |

---

## 2. 证据与方法（含本机实测）

### 2.1 证据源

| 证据源 | 位置/链接 | 取到了什么 | 局限 |
|---|---|---|---|
| PCL2 安装目录 | `E:\MC\PCL\`（只读） | `Setup.ini` 13 个全局键；`LatestLaunch.bat` 完整命令行；`authlib-injector.jar`、`JavaWrapper.jar`（仅文件名/大小）；`Log1..5.txt` | 只有 2.14.0.0 快照版一个版本；**未读源码**（也不需要） |
| 运行日志 | `E:\MC\PCL\Log1..5.txt` | 启动 12 阶段、崩溃分析三步、整合包安装、下载源切换、内存优化 | 轮转文件，非全量 |
| 实例磁盘 | `E:\MC\.minecraft\versions\`（15 个） | 真实规模、扁平化 JSON、3 个缺 JSON、`PCL\Setup.ini`/`config.json` 键 | 只覆盖被打开过的实例 |
| 可执行文件字符串 | `E:\MC\Plain Craft Launcher 2.exe`（5.99 MB，只读扫描） | 页面/模块枚举、联机文案、下载源域名、更新/帮助/皮肤/整合包等关键字 | 字符串不能证明运行时行为；中文资源有压缩 |
| GitHub 仓库**目录树**（仅路径，未读文件内容） | [Meloong-Git/PCL](https://github.com/Meloong-Git/PCL)（PCL2 **非开源**；许可证裁定见 `02` §2.1） | 仅 `Pages/`、`Modules/` 下的**目录/文件名**，用于功能面枚举；未打开任何文件内容（`clean-room-log.md` CR-001） | **不是开源代码，不能作为实现依据**；实现者不得顺着链接读源码；边界按 `02` LIC-01/02 |
| PCL 内置帮助文档库 | [LTCatt/PCL2Help](https://github.com/LTCatt/PCL2Help)（CC0-1.0，PCL 内置帮助，日志实测 40 条） | 帮助/公告/反馈类功能的存在与分类 | 未逐条读完 40 条 |
| 在线端点探测 | 本机 PowerShell HEAD/GET（2026-10-21 12:2x） | Mojang/BMCLAPI 可达性与 Range 支持（§3.5） | 单时点、单网络；结论需在验收时复测 |
| 用户侧材料 | `E:\MC\.minecraft\versions\史前世界 2\...`、整合包内"联机广告" | 联机是付费需求；实例迁移成本高 | 属用户自建内容，非 PCL 官方 |

### 2.2 本机环境（验收基线机）

| 项 | 实测值 | 备注 |
|---|---|---|
| OS | Windows 11 家庭中文版 10.0.26100（x64） | 只支持 Windows x64（§6.3） |
| CPU / RAM | Intel Core Ultra 9 275HX（24 核）/ 31.4 GiB（验收时剩余 18.7 GiB） | 同机双开 MC 客户端可行（各 2 GiB） |
| GPU | Intel iGPU + NVIDIA RTX 5070 Ti Laptop | 双实例窗口化可行；若失败改用第二设备（§9 Q4） |
| Node / npm | v24.20.0 / 11.19.0 | `npm.ps1` 被 ExecutionPolicy `Restricted` 拦截 → **用 `npm.cmd`** |
| PowerShell | 5.1.26100（Desktop） | 脚本示例按 5.1 语法写 |
| JDK | `tools\jdk21\jdk-21.0.12.1+1`（JAVA_HOME 指向它）；另有 Mojang runtime 17/21/25 | `where java` 为空（PATH 无 java） |
| .NET SDK | 无（仅 6.0/7.0 runtime） | 排除 WPF/C# 路线 |
| 磁盘 | C: 75 GiB / D: 53.5 GiB / E: 43.3 GiB 空闲 | 验收目录放在 `%TEMP%`（C:），需 ≥ 1.5 GiB |

### 2.3 复核修正（研究底稿 → 本文件）

| # | 底稿说法 | 复核结果 | 对需求的影响 |
|---|---|---|---|
| 1 | "2 个实例缺同名 JSON（空壳/异常）" | 实为 **3 个**缺 JSON；`[神道传说]…` 与 `落幕曲` 的 JSON **有效**，底稿的"解析失败"是 PowerShell 以 ANSI/GBK 解码 UTF-8 造成的假阳性（Node `JSON.parse` 均成功） | P0-0 的异常实例用例改为 3 个；**强制 UTF-8 读取版本 JSON**（§7.7） |
| 2 | "PCL 2.14.0.0 快照版" | 日志自报一致；`Setup.ini` 与 `LatestLaunch.bat` 均与 412 对得上 | 基线可信 |
| 3 | "PCL2 无备份/无服务器列表" | 字符串检索 0 命中复现；但未逐页人工点击复核 | 判为"未见"，P1 差异点仍成立 |
| 4 | 下载源"官方源可用" | 本机 `piston-meta.mojang.com` **超时**；其余 Mojang 端点正常；BMCLAPI 全路径可用 | 安装器必须有镜像回退（P0 硬要求） |
| 5 | 模组数量 311 / 358 | `.jar` 计数一致（311 / 358）；`史前世界 2` 另有 2 个 `.jar.disabled`（禁用态文件） | 数字口径写进附录 A |
| 6 | 成本 163 人日（P0 17 项） | 那是"产品级完整 parity"口径；本文件 P0 为 9 张卡、164 人日，其余进 P1/P2 | 避免把"季度计划"误当"本轮承诺"（§4.6/附录 F） |

### 2.4 未知与假设（不允许在验收里假装知道）

- **未验证**：PCL2 联机实际连通性（本机从未使用，Log 中"联机"0 命中）；PCL2 更新器下载/替换行为；Forge/NeoForge/Fabric 安装器在本机的实际产物（P1 才需要）。
- **假设**：验收机为 §2.2 配置；联机 L1 需要第二台 Windows 设备（§9 Q4）；验收网络可访问 Mojang/BMCLAPI。
- **不在本文件范围**：许可证结论（`02`）、模块与 IPC（`03`）、联机技术选型与协议（`04`）。

---

## 3. PCL2 能力基线（parity 标尺）

> 本章回答"PCL2 到底有什么"。功能**是否本轮做**由 §4/§5 决定；本章只保证矩阵不漏项。

### 3.1 页面与模块地图（GitHub 仓库目录树（仅路径）+ 可执行文件字符串，双证据）

| 层 | 枚举结果 | 证据 |
|---|---|---|
| 页面 | `PageLaunch`（启动）、`PageSelectRight`（实例选择）、`PageDownload` + `PageDownloadInstall`（下载/安装）、`PageVersion` + `PageInstance` + `PageInstanceOverall` + `PageInstanceExport`（版本管理/设置/导出）、`PageResource`（Mod/资源包/光影/世界）、**`PageLink`（联机）**、`PageSetup` + `PageSetupLaunch` + `PageSetupSystem` + `PageSetupUI` + `PageSetupLink`（设置五页）、`PageLoginMsSkin` + `PageLoginAuthSkin`（微软/Authlib 登录与皮肤）、`PageOther` + `PageOtherHelpDetail` + `PageOtherTest`（更多/帮助/测试）、`PageSpeedLeft/Right`（任务卡片） | 目录树 `Pages/`（仅路径）；exe 字符串。**只看了树，没看内容** |
| 模块 | `ModLaunch`、`ModDownload` + `ModDownloadLib`、`ModMinecraft`、`ModJava`、`ModCrash`、`ModModpack`、`ModLoader`（加载器链）、`ModNet`、`ModSecret`（配置/公告/主题）、`ModBase`、`ModMain`、`ModMusic`、`ModDevelop`、`ModEvent` | 目录树 `Modules/`（仅路径）；exe 字符串。**只看了树，没看内容** |
| 关键页面文件 | `Pages/PageLink/PageLinkMain.xaml(.vb)`；`Pages/PageSetup/{PageSetupLaunch,PageSetupLink,PageSetupSystem,PageSetupUI,Settings,SettingService}` | 目录树（2026-10-21，仅路径；未读文件内容） |

### 3.2 启动链路 12 阶段（Log1 实测，22:46:04 → 22:47:28）

| # | 阶段 | 日志证据 | 产物/副作用 | 失败会怎样 |
|---|---|---|---|---|
| 1 | 预检测 | `预检测已通过` | 校验实例完整性、Java 可用性 | 直接弹错，不进入后续 |
| 2 | 资源索引 | `版本 X 对应的资源文件索引为 5`；`无需更新资源文件索引` | `assets/indexes/5.json` | 降级为无索引启动（材质缺失） |
| 3 | 登录 | `登录方式：正版（…）`；`AccessToken 将在 … 过期` | 内存中的 token/uuid | 阻塞启动 |
| 4 | Java 选择 | `版本设置中强制指定的 Java … → Java 21` | 选定 Java 路径 + 版本 | 提示手动选择 |
| 5 | 补全支持库/资源 | `分析缺失支持库文件` → `下载支持库文件` | `libraries/`、`assets/objects/` | 自动重试 → 换源 → 失败中止 |
| 6 | 内存优化 | `内存优化完成，可用内存改变量：5.89 G` | 释放系统缓存（需管理员；无权限退化） | 跳过，不影响启动 |
| 7 | 组装参数 | `GC 设置：4，选取 G1GC`；`使用编码：GB18030` | 完整命令行 | 参数错 = 启动即崩 |
| 8 | Natives 解压 | `正在解压 Natives 文件` | `versions\<实例>\<实例>-natives\` | 0xC0000135 类崩溃 |
| 9 | 预启动处理 | `已更新 launcher_profiles.json`；`无需调整显卡设置` | 写 profiles、语言、GPU 偏好 | 第三方工具识别不到实例 |
| 10 | 自定义命令 | `执行自定义命令` | 启动前 shell | 用户自担 |
| 11 | 启动 + 监控 | `已启动游戏进程`；`日志 1/5..5/5` | 进程 + 5 个里程碑 | 20 s 无输出 → 崩溃分析 |
| 12 | 结束处理 | `Minecraft 已退出，返回值：0` | 恢复启动器可见性、清理 | — |

**耗时基线（PCL 2.14.0.0 二进制/日志实测，作为我们的上限参照）**：点击→进程 8.3 s（其中内存优化 8.1 s）；进程→窗口 4.5 s；窗口→材质加载完成 70 s（358 mods）；崩溃→报告 2.3 s；首屏三阶段 121 ms + 219 ms + 59 ms。

### 3.3 文件与配置契约（PCL 的事实标准；P0 只读对齐，不写）

**全局 `E:\MC\PCL\Setup.ini`（13 键，实测）**

| 键 | 本机值 | 含义 |
|---|---|---|
| `LaunchVersionSelect` | `1.20.1-Fabric 0.18.4` | 上次选中的实例 |
| `LaunchFolderSelect` | `$.minecraft\` | MC 文件夹（`$` = 启动器目录） |
| `LaunchArgumentIndieV2` | `4` | 版本隔离模式 |
| `LaunchRamType` / `LaunchRamCustom` | `0` / `25` | 内存自动/自定义（25%） |
| `SystemSystemUpdate` | `3` | 更新检查策略（3 = 不检查） |
| `UiCustomType` / `UiLogoType` / `UiLauncherTheme` | `0` / `1` / `10` | 主题/Logo/配色 |
| `WindowHeight` / `WindowWidth` | `652` / `947` | 窗口尺寸 |
| `LoginPageType` | `0` | 登录页形态 |
| `LaunchArgumentWindowType` | `0` | 窗口化/全屏 |

**版本级 `versions\<实例>\PCL\Setup.ini`（实测键）**：`VersionVanilla`、`VersionVanillaName`、`VersionForge`、`VersionNeoForge`、`VersionLiteLoader`、`VersionArgumentIndie(V2)`、`VersionRamType`/`VersionRamCustom`、`VersionArgumentJavaV2`、`ReleaseTime`、`Logo`、`State`、`Info`、`VersionServerAuthName`/`VersionServerAuthServer`/`VersionServerAuthRegister`、`VersionServerLogin`（4 = Authlib）、`VersionServerEnter`（自动进服）。

**其它落盘契约**：

| 契约 | 实测 | 我们要不要兼容 |
|---|---|---|
| `launcher_profiles.json` | 每次启动前重写 `profiles.PCL`、`clientToken`、`authenticationDatabase`、`selectedUser` | P0 不写；P1 再评估（第三方工具识别实例） |
| Natives 目录 | `versions\<实例>\<实例>-natives`（含空格/中文） | **P0 采用同样命名**（最稳，见 §5.4） |
| 版本 JSON | PCL 倾向**扁平化**（`史前世界 2.json` 117 个 libraries、无 `inheritsFrom`） | P0 安装产物必须自洽可解析；是否扁平由 `03` 决定，但不得要求多级继承才能启动 |
| 启动标记 | `-Dminecraft.launcher.brand=PCL`、`-Dminecraft.launcher.version=412`、`--versionType PCL` | P0 用我们自己的 brand/version（不冒充 PCL） |
| `LatestLaunch.bat` | 把最后一次真实命令行落盘（复现利器） | **P0 必须做等价物**（§5.6 P0-5） |
| `JavaWrapper.jar` + `libjlw-*.dll` | 仅安装 Forge 时用（可选） | P0/P1 都不引入（02 SEC-EXE-04） |
| `authlib-injector.jar` | 根目录随包 | **P0-7 需要**：固定版本 + SHA-256（§5.8） |

### 3.4 联机实现（PCL2 已有一等公民，别把"有联机"当差异化）

| 维度 | 实测/枚举到的事实 | 对我们的含义 |
|---|---|---|
| 组网 | EasyTier（`EasyTier CLI`、`准备下载联机模块`→`下载联机模块`→`启动联机模块`，**运行时下载，不随包分发**） | 若我们也用，必须运行时下载 + 校验 + 可关闭；P0 不依赖第三方二进制 |
| 房间模型 | 房主/成员；邀请码（"嘿，是否使用复制的邀请码加入房间？"）；"即将加入第三方联机房间" | P0 沿用"创建房间/邀请码/加入"三件套 |
| 网络质量 | ping、NAT 类型、是否中继；"正使用社区节点进行中继""正通过自定义节点进行中继" | P0 只展示真实延迟；中继/ NAT 提示 P1 |
| 体验文案 | "你和房主的网络环境都不太好""你的网络环境比房主更好！如果你来当房主……""连接优化中" | 这是 PCL 的体验细节，P0 只做必要状态 |
| UI 位置 | `PageLink`（独立页）+ 启动页状态条 | P0 做独立"联机"页 + 启动页状态徽标 |
| 用户实际路径 | 搜到的公开教程描述：创建房间 → 复制地址 → 朋友在多人游戏"直接连接"粘贴 | P0 要**一键填好**（1.20+ `--quickPlayMultiplayer host:port`；≤1.19 `--server host --port port`），不能只给地址 |

**结论**：联机的技术路线清楚（P2P 组网 + 房间 + 中继回退），难点在 **NAT 穿透成功率、中继成本、与正版/实例一致性绑定**。P0 把可验证的部分（LAN/同机房间 + LAN 世界发现 + 一键进服）做扎实；隧道按 t4 PoC 条件接入；WAN 稳定性/重连交 P1 的 `04-multiplayer-design.md`。

### 3.5 下载与源（实测域名 + 本机可达性）

| 用途 | 官方端点 | 本机实测 | BMCLAPI 映射（实测） |
|---|---|---|---|
| 版本清单 | `launchermeta.mojang.com/mc/game/version_manifest_v2.json` | **200** | `/mc/game/version_manifest.json` **200** |
| 版本 JSON | `piston-meta.mojang.com/v1/packages/<sha1>/<ver>.json` | **超时（连续）** | `/version/1.20.1/json` **200**；`/v1/packages/<sha1>/5.json` **200** |
| 客户端 jar | `piston-data.mojang.com/v1/objects/<sha1>/client.jar` | **200**（23,028,853 B） | `/version/1.20.1/client` **200** |
| 资源索引 | `piston-meta.mojang.com/v1/packages/<sha1>/5.json` | **超时** | `/v1/packages/<sha1>/5.json` **200**（413,067 B，Range: bytes） |
| 资源对象 | `resources.download.minecraft.net/<ab>/<hash>` | **200**（Range: bytes） | `/assets/<ab>/<hash>` **200**（Range: bytes） |
| 支持库 | `libraries.minecraft.net/<path>` | **200** | `/maven/<path>` **200** |
| Forge 版本列表 | `bmclapi2.bangbang93.com/forge/minecraft/1.20.1` | **200**（56,543 B） | 同左 |
| NeoForge 元数据 | `bmclapi2.bangbang93.com/neoforge/meta/api/maven/details/...` | **200** | 同左 |
| Modrinth API/CDN | `api.modrinth.com/v2`、`cdn.modrinth.com` | **未探测**（P0-8 验收时记录 UA/限流/哈希） | 无（不镜像） |

**PCL2 的容错行为（字符串证据，作为我们的需求下限）**：分段下载探测、`该下载源不支持分段下载`、`(416)`/`(502)` 分类、`下载源连接超时`、`{0}下载源已被禁用`、`已无可用下载源，下载失败`、`文件大小不一致`、单线程回退。→ 这些不是"高级功能"，是**第一次失败后用户还回不回来的分水岭**（P0-1 硬要求）。

### 3.6 我们刻意与 PCL2 不同的地方（写下来，避免后面吵）

| 能力 | PCL2 | 我们 | 本轮 | 理由 |
|---|---|---|---|---|
| 备份/还原 | 未见（字符串 0 命中） | P1 做实例快照 | 否 | 空白且痛点真实，是最佳差异点（但不阻断主链路） |
| 服务器列表 | 仅"启动即进服" | P0 无；P1 收藏列表 | 否 | 不做过度设计 |
| 联机 | EasyTier + 房间 + 中继 | P0 LAN/同机必验 + 隧道降级条件验收；P1 重连/一致性 | 部分 | 先保证本机可验收 |
| 崩溃分析 | 规则库 + 三步分析 | P0 5 类规则 + 可复制报告 | 是 | 支持成本的分水岭 |
| 账户 | 离线/微软/Authlib | P0 三态（微软按审批条件验收） | 是 | 用户身份是主链路 |
| 模组/资源包/光影 + 整合包 | 完整管理 + 导入/导出 | P0 基础管理 + 导入（不装加载器）；导出 P2 | 部分 | 玩家每天会用，但加载器安装可后置 |
| 主题/自定义主页 | 很重（XAML 主页/音乐/百宝箱） | P0 基础明暗主题；P2 自定义 | 部分 | 复刻 UI 细节不产生用户价值 |
| 版本 JSON | 扁平化写入 | P0 支持继承合并与扁平（自洽可解析） | 是 | 继承链是缺陷来源（用户已有缺陷登记表） |
| 更新器 | 完整（公告通道/原子替换） | P2 | 否 | 本轮无发布通道 |
| PCL 配置兼容 | 自身格式 | P0 不读不写；P1 只读零迁移 | 否 | 尊重原作者 + 降低风险 |

---

## 4. 功能矩阵（价值 / 成本 / 依赖 / 联网 / 优先级）

### 4.1 口径（先定义，避免各说各话）

| 维度 | 取值 | 定义 |
|---|---|---|
| **用户价值** | 高 / 中高 / 中 / 低中 / 低 | 高 = 缺了它用户当天就用不下去/直接流失；中 = 影响留存或口碑；低 = 锦上添花 |
| **实现成本** | 人日（1 人日 = 1 名熟悉 MC 启动链路的工程师 1 天，含自测，不含 QA/设计） | S ≤ 5 / M ≤ 10 / L ≤ 15 / XL > 15；**产品级口径，不等于本会话 agent 工作量** |
| **依赖** | 其他功能项 / 外部资源 | 外部资源单列：网络、服务端、Azure 应用、发布通道等 |
| **联网** | 否 / 是（下载源）/ 是（LAN）/ 是（服务端/中继） | "是（LAN）"指不需要公网，只需局域网/回环 |
| **优先级** | **P0** / P1 / P2 | P0 准入条件见 §4.7 |

**优先级判定规则（三条同时满足才进 P0）**：

1. **有行为证据**：本机日志/磁盘/可执行文件字符串/官方文档至少一处能证明 PCL2 这么做（GitHub 仓库只允许目录名级别的功能枚举，不作为实现依据）；
2. **用户真的会用到**：本机 15 实例、账号/Java/联机数据能支撑；
3. **不做会阻断 P0 主链路**（空目录 → 原版 1.20.1 进主菜单 → 崩了能看懂 → 朋友进得来）。

> 只满足"PCL2 有"但不满足 2/3 的，一律 P1/P2，不因为"法理上属于主要功能"就塞进 P0。

### 4.2 主矩阵

#### A. 实例与版本管理

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F01 | 实例扫描与状态识别（可用/缺 JSON/缺 jar/损坏） | 高 | 5 | — | 否 | **P0**（P0-0） | 15 实例中 3 个缺 JSON；PCL 列表仍显示异常实例（Log1 选中"史前世界 2"时目录异常仍可交互） |
| F02 | 实例级设置（Java/内存/参数/窗口/隔离） | 高 | 5 | F01 | 否 | **P0**（P0-2/3/4） | 版本级 `PCL\Setup.ini` + `config.json` 实测键；per-instance 强制 Java 21 是真实用法 |
| F03 | 版本隔离（`--gameDir versions/<实例>`） | 高 | 3 | F01 | 否 | **P0**（P0-1） | `LaunchArgumentIndieV2:4`、`VersionArgumentIndieV2:True`；LatestLaunch.bat 实证 `--gameDir` 指向实例目录 |
| F04 | 多 MC 文件夹（多个 `.minecraft`） | 中 | 3 | F01 | 否 | P1 | `LaunchFolderSelect:$.minecraft\` |
| F05 | 实例删除/重命名/修复/打开目录 | 中高 | 4 | F01 | 否 | P1（打开目录 P0 附带） | 删除确认列出存档（Log2 16:56:01） |
| F06 | PCL 目录只读兼容（零迁移读取） | 中高 | 5 | F01 | 否 | P1 | 15 实例 + 用户"别让我重装"的 JTBD；R10 |

#### B. 安装与下载

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F07 | 原版安装（manifest→版本 JSON→client/libs/assets→SHA1） | 高 | 12 | 网络 | 是（下载源） | **P0**（P0-1） | 16:53 实测 1.19 安装成功；1.20.1 footprint 见附录 B |
| F08 | 安装后校验/修复（只补缺失项） | 高 | 3 | F07 | 是 | **P0**（P0-1 断言） | `分析缺失支持库文件`→`下载支持库文件`（Log1） |
| F09 | Forge 安装（installer + 产物自洽） | 高 | 12 | F07、Java | 是 | P1 | `开始进行 Forgelike 安装`、`com.bangbang93.ForgeInstaller`、Forge 缓存 |
| F10 | NeoForge 安装 | 中高 | 5 | F07 | 是 | P1 | `DlNeoForgeList Bmclapi`；本机 1.21.1-NeoForge 实例 5.2 GiB |
| F11 | Fabric 安装（loader + API） | 中高 | 5 | F07 | 是 | P1 | `Fabric 安装器`、`已自动选择 Fabric API` |
| F12 | Quilt 安装 | 低 | 4 | F07 | 是 | P2 | 大小写敏感检索 0 命中；仅版本识别正则 `org.quiltmc:quilt-loader` |
| F13 | OptiFine / LiteLoader 安装 | 中 | 8 | F07 | 是 | P2 | `OptiFine` 33 次、`LiteLoader` 14 次（UTF-16 字符串） |
| F14 | 下载基础：多源回退 + 8 并发 + SHA1 + 断点续传 + 原子落盘 | 高 | 8 | 网络 | 是（下载源） | **P0**（P0-1） | 本机 `piston-meta` 超时（§3.5）；PCL 的坏源禁用/重试文案 |
| F15 | 下载增强：测速优选、限速、坏源禁用、离线导入 | 中高 | 6 | F14 | 是 | P1 | `官方源加载耗时 575ms`；`{0}下载源已被禁用`；`已无可用下载源` |
| F16 | 版本清单与元数据缓存（10 min TTL） | 中 | 2 | 网络 | 是 | **P0**（P0-1） | PCL `已读取本地缓存的配置`；manifest 必须可缓存 |

#### C. Java

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F17 | Java 扫描/识别/选择（注册表/JAVA_HOME/PATH/Mojang runtime/常见路径/便携） | 高 | 6 | — | 否 | **P0**（P0-3） | `共有 3 个可用的 Java`；本机 `where java` 为空 |
| F18 | Java 兼容判定 + per-instance 强制 | 高 | 2 | F17 | 否 | **P0**（P0-3） | `版本设置中强制指定的 Java … → Java 21`；版本 JSON `javaVersion.majorVersion` |
| F19 | Mojang Java runtime 自动下载 | 中 | 5 | F17 | 是 | P1 | `电脑中没有合适的 Java，开始获取 Mojang 提供的 Java 下载列表`；只走 Mojang java-runtime（有 sha1）/Adoptium（sha256），**禁用 BMCLAPI java 列表**（无哈希，02 SRC-08） |

#### D. 账户（其余见 §4.4）

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F20 | 离线账户（用户名/UUID/持久化） | 高 | 2 | — | 否 | **P0**（P0-2） | `离线` 7 次命中；联机房必须允许离线成员 |
| F21 | 微软正版登录（设备码/回调/XSTS/token 加密/刷新） | 高 | 10 | Azure 应用 + MCE 权限审批（外部，以周计） | 是（服务端） | **P0（仅设备码流程/错误路径）**；真实登录 P1 | `登录方式：正版（…）`、`微软登录结束，AccessToken 将在 … 过期`、`--userType msa`；未获批时 `api.minecraftservices.com` 返回 403；P0 只验流程与"不伪造成功" |
| F22 | Authlib 第三方登录（地址/名称/注册链接/注入） | 高 | 5 | 第三方服务器 | 是（服务端） | **P0**（P0-7） | `LittleSkin 登录`+yggdrasil 地址+`VersionServerLogin:4`；`PageLoginAuthSkin` |
| F23 | 多账户管理与切换 | 中 | 2 | F20-F22 | 否 | **P0**（P0-7） | 三态互切不串号（底稿 P0-08 负向） |
| F24 | 皮肤/披风 | 低 | 4 | F21/F22 | 是 | P2 | `PageLoginMsSkin`；`可能由于网络问题，更改皮肤失败` |

#### E. 启动参数与启动链路

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F25 | 参数组装（rules/变量替换/去重/Windows 规则） | 高 | 6 | F07 | 否 | **P0**（P0-1） | `已去重单个{0}参数`、`已覆盖重复的{0}参数`；LatestLaunch.bat 完整实证 |
| F26 | 内存与 JVM 参数（`-Xmx`/G1/编码/natives/自定义） | 高 | 4 | F25 | 否 | **P0**（P0-4） | `-Xmx15974m`、`GC 设置：4，选取 G1GC`、`使用编码：GB18030` |
| F27 | 分辨率/全屏/窗口 | 中高 | 2 | F25 | 否 | **P0**（P0-4） | `--width 854 --height 480 --fullscreen`（LatestLaunch.bat） |
| F28 | 自动进服（1.20+ `--quickPlayMultiplayer host:port`；≤1.19 `--server/--port`） | 中高 | 3 | F25 | 是（服务器） | P1 | `VersionServerEnter`、`JoinServerOnLaunch` |
| F29 | 启动前命令/进程优先级/显卡偏好/JLW/LUA | 低 | 6 | F25 | 否 | P2 | `执行自定义命令`、`无需调整显卡设置`、`使用 JLW：False` |
| F30 | 启动命令行落盘（LatestLaunch 等价） | 中高 | 1 | F25 | 否 | **P0**（P0-5） | `LatestLaunch.bat`（PCL 的排障利器） |

#### F. 模组 / 资源包 / 光影 / 世界

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F31 | Mods 管理（列表/启停/冲突/拖入安装/选择文件安装） | 高 | 8 | F01 | 否 | **P0**（P0-8） | `目前同时存在启用和禁用的两个 Mod 文件`、`存在文件冲突`；实例 mods 最多 358；用户 2026-10-21 明确要求拖拽安装 |
| F32 | 资源包管理（列表/启停/拖入安装/选择文件安装） | 中高 | 4 | F01 | 否 | **P0**（P0-8） | `资源包` 8 次命中；实例 `resourcepacks/`；拖拽安装 P0 |
| F33 | 光影管理（列表/启停/拖入安装/选择文件安装） | 中 | 4 | F01 | 否 | **P0**（P0-8） | `光影` 4 次命中；`shaderpacks/`；拖拽安装 P0 |
| F59 | Mod 在线更新/下载/翻译（Modrinth） | 中 | 10 | F31 | 是（Modrinth API） | P2 | 研究底稿字符串：`Mod 更新确认`、`已成功更新 {0} 个 Mod`、`点击以更新，右键查看更新日志`（未独立复核） |
| F34 | 世界/存档管理（列表/打开/删除） | 中 | 3 | F01 | 否 | P2 | `存档` 7 次命中；`saves/` |

#### G. 整合包

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F35 | 整合包导入（zip/mrpack/CF、overrides、加载器推断） | 高 | 12 | F07、F01 | 是（Modrinth CDN；**CF 不调 API**） | **P0**（P0-8；文件导入） | `整合包种类：Modrinth`、`整合包 Forge 版本：47.4.20`、`处理整合包覆写文件夹`；CF zip 只解析本地 `manifest.json`+`overrides`，缺失文件列清单并「打开项目页」；**加载器安装 P1**，P0 只保证文件/实例落地 |
| F36 | 整合包导出 | 中 | 6 | F35 | 否 | P2 | `PageInstanceExport`；`导出` 19 次命中 |
| F37 | 实例一致性指纹（mod 清单/版本比对） | 中 | 3 | F31 | 否 | P1（联机增强） | PCL 未见；我们 P0-6 只做版本/加载器比对 |

#### H. 服务器列表与多人管理

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F38 | 服务器收藏/列表/ping/在线人数 | 中 | 5 | 网络 | 是 | P1 | PCL "服务器列表"字符串 0 命中（只有自动进服）→ 我们的差异点 |

#### I. 联机

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F39 | 一键房间（创建/邀请码/加入/成员/状态，**LAN 范围**） | 高 | 10 | 网络（LAN） | 是（LAN/回环） | **P0**（P0-6） | `PageLink`、`PageLinkMain.xaml`；`加入联机房间`；本机整合包在卖开服 |
| F40 | LAN 世界发现与一键进入（读日志端口 / `--quickPlayMultiplayer` 或 `--server` 直连） | 高 | 5 | F39、F25 | 是（LAN） | **P0**（P0-6） | 公开教程：创建房间→复制地址→多人游戏"直接连接"；我们要做到"不用手输" |
| F41 | 跨 NAT P2P/中继（EasyTier/自建中继） | 高 | 15 | F39 | 是（中继/服务端） | **P0（P0-6，条件验收）** | `准备下载联机模块`、`正使用社区节点进行中继`、NAT/ping 文案；按 t4 PoC 结果验收，失败必须有可读降级路径（中转/手动映射指引） |
| F42 | 房间实例一致性校验（mod/版本） | 中高 | 3 | F39、F37 | 否 | P1 | PCL 未见；这是联机差异化的核心一条 |
| F43 | 断线重连/房间生命周期/心跳 | 中高 | 4 | F39 | 是 | P1 | `你和房主的网络环境都不太好`；房主退出/断线体验 |

#### J. 启动器更新

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F44 | 更新检查/下载/校验/原子替换/回滚/通道 | 中高 | 6 | 发布通道 | 是（服务端） | P2 | `notice.cfg`、`PCL\update.exe`、`PCL 已更新至快照版 2.14.0.0`；本轮无发布通道 |

#### K. 日志与崩溃分析

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F45 | 日志采集/落盘/查看/轮转 | 高 | 3 | — | 否 | **P0**（P0-5） | `步骤 1 收集日志文件`；`可能可用的日志文件：latest.log / debug.log` |
| F46 | 崩溃检测 + 5 类规则诊断 | 高 | 5 | F45 | 否 | **P0**（P0-5） | `Minecraft 返回值异常，可能已崩溃`；`步骤 3：分析崩溃原因`；2.3 s 出报告 |
| F47 | 错误报告生成/复制/打开目录 | 高 | 2 | F46 | 否 | **P0**（P0-5） | "请把错误报告文件发给对方，而不是截图" |
| F48 | 日志/报告上传反馈 | 低 | 3 | 服务端 | 是 | P2 | `匿名数据上报失败`；`PCL 不是最新版，无法提交反馈` |

#### L. 备份与存档

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F49 | 实例备份/还原（快照/增量/还原点） | 中高 | 10 | F01 | 否 | P1 | PCL "备份/还原" 0 命中 → 差异点；重整合包丢档损失极大 |
| F50 | 单世界备份/还原 | 中 | 4 | F34 | 否 | P2 | 存档级需求（`saves/`） |

#### M. 主题、设置与系统集成

| ID | 功能项 | 用户价值 | 成本 | 依赖 | 联网 | 优先级 | 判定依据 / 证据 |
|---|---|---|---|---|---|---|---|
| F51 | 基础主题（明暗配色/语义色） | 中 | 4 | — | 否 | **P0**（P0-0） | t7 设计规范；`UiLauncherTheme:10`（PCL 主题机制仅作参考，不复刻） |
| F52 | 设置中心（最小：Java/内存/参数/日志/关于） | 高 | 3 | 全部 | 否 | **P0**（P0-3/4/5/7） | `PageSetup` 五页；P0 只做必需项 |
| F53 | 完整设置（下载/联机/主题/更新） | 中 | 4 | F51/F14/F39 | 否 | P1 | `PageSetupLaunch/Link/System/UI` |
| F54 | 自定义主页/音乐/XAML | 低 | 6 | F51 | 否 | P2 | `主页` 50 次命中；`xaml 作为主页加载`；`Musics/` |
| F55 | 帮助/公告/反馈/投票 | 中 | 5 | 服务端 | 是 | P2 | 帮助库 40 条；`新功能投票`；`notice.cfg` |
| F56 | 遥测/匿名统计（默认关） | 低 | 2 | 服务端 | 是 | P2 | `匿名数据上报失败` |
| F57 | 系统集成（快捷方式/文件关联/单实例） | 中 | 3 | — | 否 | P1 | 拖拽整合包安装（Log2 17:08:18）已提升 P0-8（用户 2026-10-21 明确要求）；F57 只保留快捷方式/文件关联/单实例 P1；P0 要求**允许双开**以便联机验收 |
| F58 | 启动器版本号/关于/日志导出 | 低 | 1 | — | 否 | **P0**（P0-0/5） | 版本号与日志是验收证据的前提 |
| F60 | UI 页面与状态机（主页/实例/下载/联机/设置/日志/关于；空/加载/错误态） | 高 | 10 | F01/F52 | 否 | **P0**（P0-0） | t7 设计稿 + t10 落地；`design/index.html` 为视觉基准 |

### 4.3 加载器安装矩阵（F07~F13 的细化）

| 加载器 | PCL 2.14.0.0 二进制/日志实测 | 我们的本轮 | 我们的 P1 | 安装方式（P1 参考） | 主要风险 |
|---|---|---|---|---|---|
| 原版 | ✅ 全版本（manifest 驱动） | ✅ **P0**（仅 1.20.1 验收） | 全版本 | manifest + 镜像 | 合规（§7.3） |
| Forge | ✅ 推荐/最新/指定版 | ⚠️ **仅解析/启动已有版本**（`inheritsFrom` 合并，t6）；**安装 ❌** | ✅ 1.7.10~当前主流（安装器） | installer jar + 产物校验 | 安装器漂移；"可能由其他启动器改过 Forge"类脏状态 |
| NeoForge | ✅ 版本列表（bmclapi maven） | ⚠️ **仅解析/启动已有版本**；**安装 ❌** | ✅ 1.20.1+（安装器） | maven 元数据 + installer | 三套版本号体系（47.x/20.x/21.x） |
| Fabric | ✅ loader + API + OptiFabric 适配 | ⚠️ **仅解析/启动已有版本**；**安装 ❌** | ✅ loader + API（安装器） | meta API + profile JSON | API 与 MC 版本适配 |
| Quilt | ⚠️ 只能识别，无安装入口 | ❌ | ❌（P2） | — | 无安装基线 |
| OptiFine | ✅（含与 Fabric 组合） | ❌ | ❌（P2） | 官方下载 + 半自动 | 兼容矩阵爆炸 |
| LiteLoader | ✅ | ❌ | ❌（P2） | — | 1.12 及更早 |
| 整合包 | ✅ zip/mrpack/CF，overrides | ✅ **文件导入**（P0-8；mrpack/本地 CF zip）；加载器安装 ❌（P1） | ✅ 完整导入 + 加载器安装 | 解析 + 覆写 + 推断 | 覆写目录差异；来源条款 |

### 4.4 账户矩阵（F20~F24）

| 方式 | 凭据 | 必须支持的能力 | 本轮 | 备注 |
|---|---|---|---|---|
| 离线 | 用户名（可选自定 UUID） | 本地生成、单机/LAN 进服、联机可用 | ✅ **P0** | 联机房内必须允许离线成员 |
| 微软 | OAuth + XSTS + profile | 设备码、刷新、过期提示、加密落盘；未获批时只验错误路径 | ✅ **P0（条件）** | 需自建 Azure 应用（public client + PKCE）并申请 Minecraft API 权限；未获批返回 403，审批以周计；token 不能明文落盘；**不得伪造成功** |
| Authlib | 服务器地址 + 账号密码 | 注入 `authlib-injector`、拉皮肤、注册链接 | ✅ **P0** | 固定版本 jar + SHA-256；默认不预置任何第三方地址 |
| 其它通行证 | — | — | ❌ | 无证据 |

### 4.5 启动参数矩阵（F25~F30）

| 参数组 | 来源 | 本轮 | 证据/备注 |
|---|---|---|---|
| 内存 `-Xmx` | 全局/实例独立；自动按物理内存比例 | ✅ **P0** | `-Xmx15974m`、`LaunchRamCustom:25`、`VersionRamCustom:26` |
| GC | 按 Java 版本选 G1/ZGC | ✅ **P0** | `GC 设置：4，选取 G1GC，Java 版本：21` |
| 编码 | 系统代码页（GBK/GB18030） | ✅ **P0** | `-Dstdout.encoding=GBK`、`使用编码：GB18030` |
| Natives 路径 | 实例内 `<实例>-natives` | ✅ **P0** | 4 个 `-D` 路径参数（LatestLaunch.bat） |
| 窗口 | 宽高/全屏 | ✅ **P0** | `--width 854 --height 480 --fullscreen` |
| 登录四件套 | username/uuid/accessToken/userType | ✅ **P0**（离线） | `--username/--uuid/--accessToken/--userType` |
| 自动进服 | 1.20+ `--quickPlayMultiplayer host:port`；≤1.19 `--server/--port` | ⏸ P1 | `VersionServerEnter`、`JoinServerOnLaunch` |
| 自定义命令（启动前/后） | 用户配置 | ⏸ P2 | `执行自定义命令` |
| 进程优先级/显卡偏好 | 系统 | ⏸ P2 | `设置进程优先级失败`、`无需调整显卡设置` |
| JLW / LUA workaround | 兼容层 | ⏸ P2 | `使用 JLW：False`、`使用 LUA：False` |
| 参数去重/覆盖 | 版本 JSON + 用户参数合并 | ✅ **P0** | `已去重单个{0}参数`、`已覆盖重复的{0}参数` |

### 4.6 成本汇总

| 归属 | 人日 | 占比 | 说明 |
|---|---|---|---|
| **P0** | **164** | 53% | F01/F02/F03/F07/F08/F14/F16/F17/F18/F20/F21/F22/F23/F25/F26/F27/F30/F31/F32/F33/F35/F39/F40/F41/F45/F46/F47/F51/F52/F58/F60；其中安装+启动+下载基础约占 33（P0-1），联机 30（P0-6） |
| **P1** | **80** | 26% | Forge/NeoForge/Fabric 安装 22、实例管理/多文件夹/PCL 兼容 12、下载增强 6、Java 自动下载 5、自动进服+服务器收藏 8、联机增强（一致性/重连）7、备份 10、完整设置 4、系统集成 3、Mods 一致性指纹 3 |
| **P2** | **67** | 21% | Quilt 4、OptiFine/LiteLoader 8、整合包导出 6、兼容 workaround（F29）6、Mod 在线更新/下载/翻译 10、数据包/世界 7、自定义主页/音乐 6、皮肤 4、帮助/公告/反馈 5、日志/报告上传 3、遥测 2、更新器 6 |
| **合计** | **311** | 100% | 不含设计/QA/本地化；含则约 ×1.25 ≈ 389 人日 |

**与本轮的关系**：164 人日是"人类团队从零到 P0"的产品级估算；本会话以 agent 并行实现，**墙钟时间被压缩，但复杂度排序不变**。若本轮资源不足，按 §6.4 的逆序砍 P1/P2，**不得砍 P0-1/5/6 的验收断言**。

### 4.7 与任务书功能面的覆盖检查（确保不漏项）

| 任务书要求的功能面 | 对应矩阵项 | 本轮归属 |
|---|---|---|
| 实例/版本管理 | F01–F06 | P0：F01/F02/F03；P1：F04/F05/F06 |
| 安装与下载（原版/Forge/NeoForge/Fabric/Quilt） | F07–F16 | P0：F07/F08/F14/F16（仅原版安装；Forge/Fabric 仅解析/启动）；P1：加载器安装/增强；P2：Quilt/OptiFine |
| Java 管理 | F17–F19 | P0：F17/F18；P1：F19 |
| 账户（离线/微软/Authlib） | F20–F24 | P0：F20–F23（微软条件验收）；P2：F24 |
| 启动参数（内存/JVM/分辨率/全屏/高级） | F25–F30 | P0：F25/F26/F27/F30；P1：F28；P2：F29 |
| MODS/资源包/光影管理 | F31–F34、F59 | P0：F31–F33；P2：F34/F59 |
| 整合包导入导出 | F35–F37 | P0：F35（文件导入）；P1：F37；P2：F36 |
| 服务器列表与多人管理 | F38 | P1 |
| 联机 | F39–F43 | P0：F39/F40/F41（L2 条件）；P1：F42–F43 |
| 启动器更新 | F44 | P2 |
| 日志与崩溃分析 | F45–F48 | P0：F45–F47；P2：F48 |
| 备份与存档 | F49/F50 | P1：F49；P2：F50 |
| 主题与设置 | F51–F58、F60 | P0：F51/F52/F58/F60；P1：F53/F57；P2：F54–F56 |

> 结论：13 类功能面 **全部有归属**，没有"漏掉但以为做了"的项；本轮只对 P0 列负责（§5）。

---

## 5. P0 范围与可复现验收

### 5.0 P0 总览、依赖与验收约定

| ID | 能力 | 依赖 | 产品级成本 | 建议 owner | 验收 |
|---|---|---|---|---|---|
| P0-0 | 骨架、UI 页面/主题、数据目录、实例识别 | — | 25 | client-dev | §5.1 |
| P0-1 | 版本解析（含 inheritsFrom）+ 原版 1.20.1 安装 + 启动到主菜单 | P0-0、P0-2、P0-3、P0-4 | 33 | install-dev + core-dev | §5.2 |
| P0-2 | 离线账户 | P0-0 | 3 | core-dev | §5.3 |
| P0-3 | Java 自动检测 | P0-0 | 8 | core-dev | §5.4 |
| P0-4 | 内存/JVM/窗口参数 | P0-0、P0-3 | 9 | core-dev | §5.5 |
| P0-5 | 日志与崩溃提示 | P0-1 | 11 | core-dev | §5.6 |
| P0-6 | 联机（LAN 房间 + LAN 世界 + 隧道降级） | P0-1、P0-2、P0-3 | 30 | net-dev + client-dev | §5.7 |
| P0-7 | 微软设备码 / Authlib / 多账户 | P0-0、P0-1、P0-2、P0-4 | 17 | core-dev + client-dev | §5.8 |
| P0-8 | 模组/资源包/光影 + 整合包导入 | P0-0、P0-1 | 28 | core-dev + client-dev | §5.9 |
| | **合计** | | **164** | | |

> **依赖与验收顺序说明**：P0-2/3/4 的"配置/选择"逻辑可在 P0-1 之前单测或 dry-run（只生成命令行、不启动游戏）；它们的"启动断言"需要 P0-1 的闭环，因此在 P0-1 完成后补跑。推荐顺序：**P0-0 → P0-2/3/4（配置）→ P0-1（集成启动）→ P0-5 → P0-7 → P0-8 → P0-6**。P0-1 是集成点，不是其它卡的"前置阻塞"。

**验收环境与通用约定（所有 P0 用例共用）**

| 约定 | 内容 |
|---|---|
| 机器 | §2.2 基线机；**必须用打包产物**（`npm.cmd run pack` 的输出），开发模式只用于迭代 |
| 隔离 | 全部在 `%TEMP%` 下新建目录；**禁止**写入 `E:\MC\PCL` 与 `E:\MC\.minecraft`（P0-0 的只读扫描除外） |
| 启动参数 | 应用必须支持 `--data-dir <path>`/`--mc-dir <path>`（或等价 CLI/环境变量，README 写明）；P0 **不得启用全局单实例锁**（P0-6 需要双开） |
| 命令 | PowerShell 5.1；npm 一律用 `npm.cmd`（`npm.ps1` 被 ExecutionPolicy 拦截） |
| 时间 | 以启动器日志时间戳为准；安装/启动的"≤ N min"按整机空闲、网络 ≥ 20 Mbps 计 |
| 证据 | 每次验收把日志、截图、命令行、哈希输出复制到 `docs/evidence/p0/<ID>/`（§10.2） |
| 判定 | 断言**全部**成立才通过；禁止"人工判断通过"；任一硬断言失败即该卡不通过 |

**一次性准备（下文案例如无特别说明均使用这些变量）**

```powershell
$E2E  = Join-Path $env:TEMP ("mcl-e2e-" + (Get-Date -Format "yyyyMMdd-HHmm"))
New-Item -ItemType Directory -Path $E2E | Out-Null
$MC   = Join-Path $E2E 'mc';   New-Item -ItemType Directory $MC | Out-Null
$DATA = Join-Path $E2E 'data'
$APP  = 'D:\DSH-工作文件\mc-launcher\release\win-unpacked\mc-launcher.exe'  # 以 t5 实际产物路径为准
& $APP --data-dir $DATA --mc-dir $MC
```

### 5.1 P0-0 骨架、UI 页面/主题、数据目录与实例识别

**目标**：应用能启动、能选目录、能只读识别实例，且不碰用户既有文件。

**必须满足（可测）**

| # | 要求 |
|---|---|
| R0.1 | 首次启动 ≤ 2 s（冷启动，SSD；以进程创建→窗口可交互计） |
| R0.2 | `--data-dir`（或环境变量 `MCL_DATA_DIR`）指定配置/日志/账户目录；未指定时**默认应用目录下 `data/`（便携）**，并在 README 写明 |
| R0.3 | `--mc-dir` 指定 MC 目录；首次启动允许用户选择/新建空目录；选择结果持久化 |
| R0.4 | 只读扫描 `<mc-dir>/versions/*/`：识别 可用 / 缺版本 JSON / JSON 损坏 / 缺客户端 jar 四种状态；异常实例可见但不可启动 |
| R0.5 | 路径含中文、空格、方括号、全角冒号（如 `Hunt：History 1949 - Blood Testament`）时列表与详情不崩溃、不乱码 |
| R0.6 | P0 不读取也不写入 `PCL\Setup.ini`、`PCL\config.json`、`launcher_profiles.json` |
| R0.7 | 所有落盘写入只发生在 `--data-dir`、`--mc-dir` 与系统临时目录（临时文件退出时清理） |
| R0.8 | 渲染进程不得直接 `require('fs')`/`child_process`；所有文件操作经 IPC（由 `03-architecture.md` 定义通道） |
| R0.9 | 页面齐全：主页、实例/版本管理、安装/下载、联机房间、设置、日志、关于；导航可达，每页有 空/加载/错误 三态；启动按钮状态机（未安装/就绪/安装中/启动中/运行中/崩溃） |
| R0.10 | 基础主题：明/暗两套语义色，可切换并持久化；视觉以 `design/index.html`（t7）为基准，不复制 PCL 品牌/图标/主色 |
| R0.11 | 设置页至少可改：Java 路径、内存、JVM 参数、下载源、语言（P0 仅 zh-CN）、主题；落盘后重启生效 |
| R0.12 | UI 不出现 mock 数据/假进度；所有列表/进度来自真实 IPC（t10） |

**明确不要求**：多 MC 文件夹、实例删除/重命名、PCL 配置只读兼容、自定义主页/音乐（P1/P2）。

**验收步骤（人可复现）**

1. 按 §5.0 设置 `$E2E/$MC/$DATA/$APP`，启动应用；记录进程创建到窗口可交互的时间（启动器日志首行到"首屏就绪"行）。
2. 在首次启动页选择 `$MC`（空目录）；确认它被记住。
3. 关闭应用，重新启动；确认仍指向 `$MC`。
4. 关闭应用；用**独立数据目录**只读打开本机参照目录：`& $APP --data-dir "$E2E\data-readonly" --mc-dir 'E:\MC\.minecraft'`，打开实例列表（不要求 P0 提供"多 MC 文件夹"UI，F04 属 P1）。
5. 记录 `E:\MC\.minecraft\versions` 下 4 个代表文件的 mtime 与 SHA1（如 `1.20.1\1.20.1.json`、`史前世界 2\史前世界 2.json`、`PCL.ini`、`launcher_profiles.json`）；退出应用后再算一次。
6. 检查 15 个实例是否按 §附录 A 显示：3 个"缺少版本 JSON"、其余显示 MC 版本/加载器/资源索引。
7. 点击异常实例（`The Last Voyage of the Harpy Express`）→ 应给出"缺少版本 JSON，无法启动"的可读提示，且不创建任何进程。
8. 打开含全角冒号的实例详情（`Hunt：History 1949 - Blood Testament`）→ 名称/路径完整显示。
9. 在 `$E2E\mc-fixtures` 建两个异常夹具并用 `& $APP --data-dir "$E2E\data-fixtures" --mc-dir "$E2E\mc-fixtures"` 打开：

```powershell
$FX = Join-Path $E2E 'mc-fixtures'
New-Item -ItemType Directory -Force -Path (Join-Path $FX 'versions\broken-json') | Out-Null
[IO.File]::WriteAllText((Join-Path $FX 'versions\broken-json\broken-json.json'), '{', (New-Object System.Text.UTF8Encoding($false)))
New-Item -ItemType Directory -Force -Path (Join-Path $FX 'versions\no-jar') | Out-Null
$text = (Get-Content -LiteralPath 'E:\MC\.minecraft\versions\1.20.1\1.20.1.json' -Raw -Encoding UTF8) -replace '"id"\s*:\s*"1\.20\.1"', '"id": "no-jar"'
[IO.File]::WriteAllText((Join-Path $FX 'versions\no-jar\no-jar.json'), $text, (New-Object System.Text.UTF8Encoding($false)))
```

预期：`broken-json` 显示"JSON 损坏"、`no-jar` 显示"缺少客户端 jar"，两者均不可启动。
10. 依次打开 7 个页面（主页/实例/下载/联机/设置/日志/关于），每页触发一次空态（如无实例/无房间/无日志）与错误态（如无效下载源）；截图。
11. 切换明暗主题 → 关闭应用 → 重启 → 主题保持；对照 `design/index.html` 检查组件尺寸/色板/间距（允许合理差异，不允许完全另一套视觉）。

**断言**

- A0.1 首次启动 ≤ 2 s；二次启动 ≤ 1.5 s。
- A0.2 `$DATA` 下生成配置与日志（至少 `config.json`、`logs/`）；应用退出后无残留临时文件。
- A0.3 实例列表数量 = 15；其中"缺少版本 JSON"= 3，名称与附录 A 完全一致。
- A0.4 第 5 步前后文件 mtime 与 SHA1 **完全一致**（零改动）。
- A0.5 异常实例点击后无 `javaw.exe` 新进程（`Get-Process javaw` 计数不变）。
- A0.6 中文/空格/全角路径的实例能打开详情，无乱码、无异常弹窗。
- A0.7 `broken-json` 显示"JSON 损坏"、`no-jar` 显示"缺少客户端 jar"，两者均不可启动、无进程创建。
- A0.8 7 个页面全部可达；每页有 空/加载/错误 三态；启动按钮 6 状态可演示（至少 未安装/就绪/启动中/运行中/崩溃）。
- A0.9 明暗主题切换后重启仍保持；视觉与 `design/index.html` 同一套色板/组件规范；`grep` 无 mock 常量。

**证据**：首屏截图、实例列表截图、异常实例提示截图、两次哈希/时间输出、`$DATA\logs\launcher.log`。

**失败判据**：任一既有文件被修改；异常实例被允许启动；中文实例崩溃/乱码；启动 > 2 s。

### 5.1.1 一键启动（P0 跨卡口径，用户 2026-10-21 明确要求）

**主按钮**：主页只保留**一个主按钮**。点击后由主进程按 `instance → java → auth → launch` 顺序一气呵成（选中实例 → 解析 Java → 生成参数 → 启动），**不弹向导、不要求逐项确认**；只有失败时才展开详情（错误码 + 可复制日志 + 下一步按钮）。

| 阶段 | 依赖模块 | 成功判据 | 失败分支（UI 动作） |
|---|---|---|---|
| 选中实例 | `instance` | 有 `state=ready` 的选中实例 | 无实例 → 主按钮变「安装/选择实例」，打开安装页；异常实例（缺 JSON/缺 jar）→「需要修复」，打开修复/安装入口 |
| 解析 Java | `java` | 按版本要求选中 Java（1.20.1→17） | 无 Java / 版本不符 →「选择/下载 Java」，打开设置·Java；不得直接崩溃 |
| 账户 | `auth` | 有选中账户（离线账户可用） | 未登录 → 打开账户页；微软会话失效 → `AUTH.INVALID_GRANT` + 重新登录 |
| 生成参数/启动 | `launch`（内部用 `version`/`instance`） | `launch.status=running` 或 `evt:exited` | 版本 JSON 损坏 → `VERSION.JSON_CORRUPT`；参数非法 → `LAUNCH.PLAN_INVALID`；均在当前页展开详情 |

**规则**：按钮状态只来自 `launch.status` / `launch:evt:*`，UI 不推断；点击 ≤100 ms 进入「启动中」并禁用，防重复启动；失败详情必须含错误码；不得用 mock/假进度。无实例是 UI 状态（不走错误码），其余失败必须有已声明错误码。

**验收**：§5.10 第 4 步从主页主按钮点击一次即进入主菜单；无实例/无 Java/未登录/版本损坏四个负向分支分别按 §5.1（异常实例）、§5.4 A3.4、§5.3 A2.*、§5.2 A1.13 的夹具复现，且都能从主按钮的失败详情回到对应修复入口。

### 5.2 P0-1 版本解析（含 inheritsFrom）+ 全新目录安装原版 1.20.1 + 启动到主菜单

**目标**：空目录 → 下载 → 校验 → 启动 → 主菜单。这是本轮唯一"从零到可玩"的闭环。

**必须满足（可测）**

| # | 要求 |
|---|---|
| R1.1 | 从 `version_manifest_v2` 解析 1.20.1（release），不硬编码版本 JSON 内容；清单可缓存（10 min TTL） |
| R1.2 | 下载客户端 jar、64 个 Windows 适用 library、assets 索引、3575 个 assets 对象、日志配置；逐文件 SHA1 校验 |
| R1.3 | 下载源自动回退：**默认 BMCLAPI → 官方**（顺序可配）；单请求超时 10 s、每源重试 3 次；日志记录每个文件由哪个源提供 |
| R1.4 | 并发可配（1–16，默认 8；单主机 ≤ 4）；支持 Range 断点；服务器不支持 Range 时回退单连接 |
| R1.5 | 原子落盘：`.part` → 校验 → rename；取消/失败清理 `.part`；不得留下"看起来存在但损坏"的文件 |
| R1.6 | 开始前预检磁盘（≥ 1.5 GiB），不足则明确报错，不产生半文件 |
| R1.7 | 安装产物：`versions/1.20.1/{1.20.1.json,1.20.1.jar}`、`assets/indexes/5.json`、`assets/objects/**`、`libraries/**` |
| R1.8 | 启动参数按版本 JSON 的 `arguments`/`rules`/`${...}` 变量生成；Windows 规则生效；每个受管参数只出现一次；**命令行中不得残留未替换的 `${...}`**（PCL 2.14.0.0 的落盘命令行实测会残留 `${clientid}`，我们不接受） |
| R1.9 | 使用 P0-2/3/4 的账户、Java、内存/JVM 设置；实例隔离 `--gameDir versions/1.20.1` |
| R1.10 | 启动前解压 natives 到 `versions/1.20.1/1.20.1-natives`；缺失时自动重解压 |
| R1.11 | 启动后 60 s 内到达主菜单；到达判据见断言 A1.9 |
| R1.12 | 首次启动前若发现缺失/损坏文件，自动只补缺失项（日志下载条目 ≤ 5） |
| R1.13 | 每次启动写 `$DATA\logs\launch-last.json` 与 `launch-last.bat`（供 P0-1/P0-5 共用；脱敏规则见 P0-5 R5.8） |
| R1.14 | 版本解析支持 `inheritsFrom` 链合并（Forge/Fabric 风格）：libraries/arguments 合并、子版本 mainClass 优先、循环/缺失父版本报错；P0 只解析/启动已有版本，不安装加载器 |
| R1.15 | 提供 dry-run：生成完整命令行与合并结果并落盘（`logs/dry-run.json`），**不创建游戏进程**；供 P0-2/3/4/7/8 断言 |
| R1.16 | 安装进度通过 IPC 事件推送（文件数/字节数/当前文件/速度），不阻塞主进程；取消可即时生效 |

**明确不要求**：Forge/NeoForge/Fabric、整合包、Mods、微软/Authlib、自动下载 Java、离线导入（P1）。

**验收步骤**

1. 按 §5.0 创建**全新** `$MC`（无 `versions/`、`assets/`、`libraries/`）。
2. 启动应用 → 选择 `$MC` → 打开"下载/安装" → 选择 `1.20.1` → 开始安装；记录开始时间。
3. 观察进度至少包含：版本清单 → 版本 JSON → 客户端 jar → 支持库 → 资源索引 → 资源对象；取消按钮可用。
4. 安装完成后等待 10 s（确保无后台残留），记录结束时间与总耗时。
5. 执行下面的文件断言脚本（PowerShell 5.1）：

```powershell
$V = Join-Path $MC 'versions\1.20.1\1.20.1.json'
$j = Get-Content -LiteralPath $V -Raw -Encoding UTF8 | ConvertFrom-Json
"id=$($j.id) main=$($j.mainClass) libs=$($j.libraries.Count) asset=$($j.assetIndex.id) java=$($j.javaVersion.majorVersion)"
(Get-FileHash -LiteralPath (Join-Path $MC 'versions\1.20.1\1.20.1.jar') -Algorithm SHA1).Hash
(Get-FileHash -LiteralPath (Join-Path $MC 'assets\indexes\5.json') -Algorithm SHA1).Hash
(Get-ChildItem -LiteralPath (Join-Path $MC 'assets\objects') -Recurse -File | Measure-Object).Count
$libRoot = Join-Path $MC 'libraries'
$libs = Get-ChildItem -LiteralPath $libRoot -Recurse -File -Filter *.jar
"winLibs=$($libs.Count)"
```

6. 启动：选择实例 `1.20.1`，确认账户为 P0-2 的 `TestUser`、Java 为 P0-3 的自动选择结果、内存按 P0-4 默认；点"启动游戏"。
7. 等待游戏窗口出现与主菜单；记录从点击到 `Sound engine started` 的时间。
8. 退出游戏（主菜单 → 退出游戏），确认启动器记录退出码 0。
9. 负向 1（取消）：以下负向用例在独立目录 `$E2E\neg`（独立 `--data-dir`/`--mc-dir`）执行，避免破坏主安装；在下载中途点取消，检查 `versions\1.20.1` 不存在或为空、无 `.part` 残留。
10. 负向 2（续传）：重新安装到 40% 时关闭启动器进程，重新打开并继续；最终 SHA1 全部通过，无"文件大小不一致"残留。
11. 负向 3（坏文件）：把 `libraries\com\mojang\logging\1.1.1\logging-1.1.1.jar` 覆盖成 10 字节垃圾；再次启动；确认日志出现"校验失败/重新下载"，文件恢复为 15,343 B 且 SHA1 为 `832b8e6674a9b325a5175a3a6267dfaf34c85139`。
12. 负向 4（不存在版本）：安装 `1.20.1-does-not-exist` → 明确报错，不创建 `versions\1.20.1-does-not-exist`。
13. 构造 `inheritsFrom` 夹具并 dry-run：

```powershell
$FV = Join-Path $MC 'versions\forge-like'
New-Item -ItemType Directory -Force -Path $FV | Out-Null
$child = '{"id":"forge-like","inheritsFrom":"1.20.1","mainClass":"cpw.mods.bootstraplauncher.BootstrapLauncher"}'
[IO.File]::WriteAllText((Join-Path $FV 'forge-like.json'), $child, (New-Object System.Text.UTF8Encoding($false)))
```

用 dry-run 启动 `forge-like`：断言合并后的 mainClass 为 `cpw.mods.bootstraplauncher.BootstrapLauncher`、classpath 含 1.20.1 的库、无未替换 `${...}`、**无 `javaw` 进程**。
14. 负向 5：把 `forge-like.json` 的 `inheritsFrom` 改成 `no-such-parent` → dry-run 报 `VERSION_PARENT_NOT_FOUND`，不启动。

**断言（精确值）**

| # | 断言 |
|---|---|
| A1.1 | `$j.id = "1.20.1"`；`mainClass = "net.minecraft.client.main.Main"`；`libraries.Count = 88`；`assetIndex.id = "5"`；`javaVersion.majorVersion = 17` |
| A1.2 | `1.20.1.jar` 大小 = **23,028,853** B，SHA1 = `0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838` |
| A1.3 | `assets\indexes\5.json` 大小 = **413,067** B，SHA1 = `8a45c6be38ac9486b04944bffcb96f8aae1b0649`（与版本 JSON 上游 `assetIndex.sha1` 一致；05 `artifact-facts.txt`） |
| A1.4 | `assets\objects` 文件数 = **3575**；随机抽 20 个文件，SHA1 与索引一致；索引 `totalSize=651,728,646` B，磁盘去重后 **651,496,644** B |
| A1.5 | Windows 适用 library **64** 个 jar 全部存在且 SHA1 正确；21 个 natives jar 已下载 |
| A1.6 | 安装总耗时 ≤ **15 min**；下载界面显示当前源（默认 BMCLAPI；可切官方）；切换到官方时若 `piston-meta` 超时 → 自动回退镜像并记录；若验收网络下官方全通，则改为"日志可证明所用源"，并记录网络条件 |
| A1.7 | 启动命令行（`$DATA\logs\launch-last.json` 与 `.bat`）包含：Java 路径、`-cp`、`net.minecraft.client.main.Main`、`--username TestUser`、`--uuid 097d3392-865a-3f3c-8b4a-da1c3473466c`、`--accessToken 0`、`--userType legacy`、`--version 1.20.1`、`--gameDir <$MC>\versions\1.20.1`、`--assetsDir <$MC>\assets`、`--assetIndex 5`；`-Xmx` 恰好 1 次；**不含 `${...}` 残留** |
| A1.8 | `versions\1.20.1\1.20.1-natives\` 至少存在 `lwjgl.dll`、`glfw.dll`、`jemalloc.dll`、`OpenAL.dll` 等 6 个 DLL |
| A1.9 | 游戏日志 `versions\1.20.1\logs\latest.log` 同时包含：`Setting user: TestUser`、`Backend library: LWJGL`、`textures/atlas/blocks.png-atlas`、`Sound engine started`；窗口标题为 `Minecraft 1.20.1` |
| A1.10 | 点击→`Sound engine started` ≤ **60 s**；启动器日志记录退出码 `0` |
| A1.11 | 负向 1/2/3/4 全部按预期；取消后无残留、续传后 SHA1 全对、坏文件被修复、不存在版本不建目录 |
| A1.12 | `inheritsFrom` 合并：mainClass 取子版本；classpath 含父版本库；dry-run 落盘 `logs/dry-run.json`；无 `${...}` 残留；无 `javaw` 进程 |
| A1.13 | 父版本缺失 → `VERSION_PARENT_NOT_FOUND`，可读提示，不启动 |

**证据**：目录树（`tree /F` 或 `Get-ChildItem` 导出）、上述哈希输出、启动器日志、`launch-last.json` + `.bat`、`latest.log` 片段、主菜单截图、耗时记录。

**失败判据**：任何 SHA1 不符；安装 > 15 min；启动 > 60 s；`piston-meta` 超时导致整体失败（说明回退未实现）；启动器写入了 `E:\MC`。

### 5.3 P0-2 离线账户

**目标**：无正版账号也能单机/LAN 进游戏，并且不引入任何"绕过验证"的能力。

**必须满足**

| # | 要求 |
|---|---|
| R2.1 | 用户名规则：3–16 位 `[A-Za-z0-9_]`；不合法时就地提示，不进入启动 |
| R2.2 | UUID = 标准离线 UUID（MD5(`OfflinePlayer:<name>`) 的 v3 变体）；同一名字稳定、不同名字不同 |
| R2.3 | 账户持久化在 `$DATA\accounts.json`（明文只含 name/uuid，无密码/token）；重启后保留选中账户 |
| R2.4 | 启动参数固定为 `--username <name> --uuid <uuid> --accessToken 0 --userType legacy`；不得带 `--clientId/--xuid` 假值 |
| R2.5 | UI 明确提示："离线账户仅用于单机与局域网；不能进入正版服务器" |
| R2.6 | 切换账户后不得串号（新启动日志中不出现上一个用户名） |

**明确不要求**：微软/Authlib、皮肤、多账户云同步（P1/P2）。

**验收步骤**

1. 在账户页新建 `TestUser`；打开 `$DATA\accounts.json` 检查字段。
2. 启动 1.20.1；检查 `launch-last.json` 的四个参数；检查 `latest.log` 的 `Setting user: TestUser`；进入主菜单后看左上角/聊天栏用户名（可选）。
3. 退出游戏；重启启动器；确认选中账户仍是 `TestUser`。
4. 新建 `SecondUser` 并启动；检查命令行与日志只出现 `SecondUser`。
5. 输入非法名：`ab`、`a b`、`abcdefghijklmnopq`（17 位）、`张三`（P0 默认拒绝非 ASCII）→ 均应就地报错，不创建账户、不启动。
6. 用 `TestUser` 进入 P0-6 的 LAN 世界，确认对方看到的名字是 `TestUser`。

**断言**

- A2.1 `accounts.json` 含 `TestUser`，`uuid = 097d3392-865a-3f3c-8b4a-da1c3473466c`；`SecondUser = a06ca53b-ae4a-364c-aa73-1254960523a6`（标准离线 UUID，可独立复算）。
- A2.2 命令行四件套与 R2.4 完全一致；`--accessToken` 为 `0`。
- A2.3 `Setting user: TestUser` 出现；切换到 `SecondUser` 后新日志不含 `TestUser`。
- A2.4 4 个非法输入全部被拦截，无账户写入、无 `javaw` 进程。
- A2.5 重启后选中账户保持。

**证据**：`accounts.json`、`launch-last.json`、`latest.log` 片段、非法输入截图。

### 5.4 P0-3 Java 自动检测

**目标**：在本机 `where java` 为空的条件下，仍能找到可用 Java，并为 1.20.1 选对版本。

**必须满足**

| # | 要求 |
|---|---|
| R3.1 | 扫描来源：用户手动路径、`JAVA_HOME`、Mojang runtime（`<mc-dir>/runtime/*`、`%APPDATA%\.minecraft\runtime\*`）、启动器目录 `runtime/`/`jre/`、`PATH`、注册表 `HKLM/HKCU\SOFTWARE\JavaSoft\{JDK,JRE}`（含 WOW6432Node）、常见路径（`Program Files\Java`、Adoptium、Microsoft、Zulu、`%LOCALAPPDATA%\Programs\*`） |
| R3.2 | 探测命令：`java.exe -XshowSettings:properties -version`（超时 8 s），解析 `java.version`、`java.vendor`、`os.arch`、`java.home`；失败回退 `-version` |
| R3.3 | 去重（realpath）；列表展示：主版本、完整版本、位数、vendor、路径、来源；扫描缓存 10 min |
| R3.4 | 选择规则：版本 JSON `javaVersion.majorVersion` 为 required（1.20.1 → 17）；优先精确匹配；否则选 **≥ required 的最小主版本**（17→17/18/…）；若只有更高版本，允许但给出警告；均无 → 阻塞并提示 |
| R3.5 | per-instance 强制 Java 优先于全局；强制路径不存在/不可执行 → 阻塞启动，提示"重新选择"，不抛原始异常 |
| R3.6 | P0 不自动下载 Java；无可用 Java 时给出"选择 Java 文件"与"打开 Java 下载页"两个出口 |
| R3.7 | 选择结果与"实际使用的 Java 版本"写入启动日志与 `launch-last.json` |

**明确不要求**：Mojang Java runtime 自动下载（P1）、按 GC/内存自动调参（P2）。

**验收步骤**

1. 先记录前置：`cmd /c "where java"` 应无输出；`$env:JAVA_HOME` 指向 `D:\DSH-工作文件\tools\jdk21\jdk-21.0.12.1+1`。
2. 打开设置 → Java 页；记录识别到的 Java 列表。
3. 用 P0-1 的 1.20.1 启动；检查 `launch-last.json` 中 Java 路径与日志"自动选择 Java：17 …"。
4. 在实例设置中强制 Java 21（`java-runtime-delta`）→ 再次启动 → 命令行 Java 路径变化。
5. 把强制 Java 路径改成一个不存在的路径（`C:\no-such-dir\java.exe`）→ 启动 → 阻塞 + 可读提示 + "重新选择"可用。
6. 手动"选择 Java 文件"指向 `C:\Windows\System32\cmd.exe` → 明确提示"不是有效的 Java"，不写入配置。
7. 重启启动器 → Java 列表与选择保留。

**断言**

- A3.1 列表至少 4 条，且包含：`java-runtime-beta`（17.0.15）、`java-runtime-delta`（21.0.7）、`java-runtime-epsilon`（25.0.1）、`tools\jdk21\jdk-21.0.12.1+1`（21.0.12.1）；路径/版本与 `-XshowSettings` 输出一致。
- A3.2 1.20.1 自动选择 `17.0.15`（`java-runtime-beta`），日志与命令行一致。
- A3.3 强制 21 后命令行切换为 `java-runtime-delta`。
- A3.4 不存在路径 → 错误码 `JAVA.NOT_FOUND`，无 `javaw` 进程；非 Java 文件 → `JAVA.INVALID`。
- A3.5 扫描缓存生效（第二次打开 ≤ 500 ms，且日志不重复执行 4 次探测——可接受缓存命中记录）。

**证据**：Java 列表截图、4 条 `-XshowSettings` 输出、`launch-last.json`、错误提示截图、日志。

### 5.5 P0-4 内存与 JVM 参数（含分辨率/全屏）

**目标**：参数由设置决定、可解释、可复现，且不会因为参数错误导致"启动即崩"。

**必须满足**

| # | 要求 |
|---|---|
| R4.1 | 全局默认 + 实例覆盖；内存自动 = `clamp(物理内存 × 25%, 2048 MiB, 8192 MiB)`，自定义 1024–32768 MiB；UI 显示最终生效值 |
| R4.2 | 生成的受管 JVM 参数：`-Xmx<N>m`、`-XX:+UnlockExperimentalVMOptions`、G1 参数（`-XX:+UseG1GC`、`-XX:G1NewSizePercent=20`、`-XX:G1ReservePercent=20`、`-XX:G1HeapRegionSize=32M`、`-XX:MaxGCPauseMillis=50`、`-XX:+PerfDisableSharedMem`、`-XX:MinHeapFreeRatio=25`、`-XX:MaxHeapFreeRatio=40`）、`-Dlog4j2.formatMsgNoLookups=true` |
| R4.3 | 编码：系统代码页 936 → `-Dstdout.encoding=GBK`、`-Dstderr.encoding=GBK`；`-Dfile.encoding` 用与代码页匹配的值（Java 17：`GBK`；Java 18+：`COMPAT`）；其它代码页按系统值生成 |
| R4.4 | 4 个 natives 参数（`-Djava.library.path`、`-Djna.tmpdir`、`-Dorg.lwjgl.system.SharedLibraryExtractPath`、`-Dio.netty.native.workdir`）全部指向 `versions\<实例>\<实例>-natives` |
| R4.5 | 品牌参数：`-Dminecraft.launcher.brand=mc-launcher`、`-Dminecraft.launcher.version=<semver>`（不冒充 PCL） |
| R4.6 | 窗口：宽/高（320–7680）+ 全屏开关；窗口化时**不出现** `--fullscreen`；全屏时出现 |
| R4.7 | 高级参数：允许追加自定义 JVM 参数；受管参数（`-Xmx/-Xms/-cp/-jar/--username/--uuid/--accessToken/--width/--height/--fullscreen` 等）在自定义中**拒绝并提示**，避免歧义 |
| R4.8 | 受管参数去重：每个参数最终命令行中恰好 1 次；重复合并写日志 |
| R4.9 | 设置持久化；切换实例不串值 |

**明确不要求**：进程优先级、显卡偏好、JLW/LUA、启动前命令（P2）。

**验收步骤**

1. 打开设置/实例设置，记录自动内存显示值 `M`（MiB）。
2. 启动一次；读取 `$DATA\logs\launch-last.json` 的 argv 数组，统计 `-Xmx` 出现次数与值。
3. 设为自定义 4096 MiB；重启应用；再启动；断言 `-Xmx4096m`。
4. 设窗口 1280×720、关闭全屏；启动；断言 `--width 1280 --height 720` 且无 `--fullscreen`。
5. 打开全屏；启动；断言 `--fullscreen` 存在（游戏窗口全屏，截图可选）。
6. 在高级参数追加 `-Dmcl.acceptance=1`；启动；断言 argv 含该参数且游戏仍进主菜单。
7. 在高级参数追加 `-Xmx2G`；启动；断言被拒绝并提示"受管参数请在上方设置"。
8. 实例 A 设 4096、实例 B 设 2048；分别启动，断言 argv 各自正确。
9. 重启应用；断言内存/分辨率/全屏设置保留。

**断言**

- A4.1 自动内存值 ∈ [2048, 8192]；`-Xmx<M>m` 恰好 1 次且 M 与 UI 一致。
- A4.2 自定义 4096 → `-Xmx4096m` 恰好 1 次。
- A4.3 G1 关键参数存在（含 `-XX:+UnlockExperimentalVMOptions`）；`-Dstdout.encoding`/`-Dstderr.encoding` 与代码页匹配。
- A4.4 4 个 natives 路径均以 `1.20.1-natives` 结尾。
- A4.5 `--width/--height` 各 1 次；窗口化无 `--fullscreen`，全屏有。
- A4.6 自定义 `-Dmcl.acceptance=1` 存在；自定义 `-Xmx2G` 被拒绝且无进程启动。
- A4.7 实例 A/B 的参数互不串；重启后保留。

**证据**：设置截图、`launch-last.json`（完整 argv）、`launch-last.bat`、游戏窗口截图（可选）、错误提示截图。

### 5.6 P0-5 日志与崩溃提示

**目标**：正常时能复盘，异常时 10 秒内说人话；不误报、不上传。

**必须满足**

| # | 要求 |
|---|---|
| R5.1 | 启动器日志：`$DATA\logs\launcher.log`（UTF-8 无 BOM，ISO 时间戳，级别 INFO/WARN/ERROR，模块名）；轮转保留 10 个文件 |
| R5.2 | 游戏日志（启动器捕获流）：`$DATA\logs\game\<dirName>\<yyyyMMdd-HHmmss>.log`（`<dirName>` = `instance.json.dirName`，不是内部 id；同秒冲突加 `-2` 后缀），**按行流式**合并 stdout/stderr 并标注 `[stdout]`/`[stderr]`；单次启动一个文件；`launcher.log` 记录路径与退出码/耗时。与游戏自身写的 `versions\<dirName>\logs\latest.log` 是两份文件，不要混淆 |
| R5.3 | 沿用 P0-1 R1.13 的 `launch-last.json`/`launch-last.bat`；P0-5 负责路径、脱敏与轮转（`chcp <系统代码页>` + `cd /d <gameDir>` + 完整命令行） |
| R5.4 | 崩溃判定：退出码非 0 → 崩溃；进程被杀 → 崩溃；退出码 0 且未出现 `Sound engine started` 且存活 < 30 s → "启动异常"提示（非崩溃）；其余正常退出不弹窗 |
| R5.5 | 崩溃后 ≤ 10 s 生成报告并弹出：时间、实例、MC/加载器、Java 路径/版本、内存、退出码、最后 100 行、≥ 1 条结论（规则命中） |
| R5.6 | 规则至少 5 类：Java 版本不符（`UnsupportedClassVersionError`/`requires Java`）、JVM 参数错误（`Unrecognized VM option`/`Could not create the Java Virtual Machine`）、缺失依赖/类（`NoClassDefFoundError`/`ClassNotFoundException`）、内存不足（`OutOfMemoryError`/`Java heap space`）、图形/OpenGL（`GLFW error`/`Pixel format not accelerated`）；未命中 → "未匹配到已知原因（已附完整日志）" |
| R5.7 | 报告落盘 `$DATA\crash-reports\<yyyyMMdd-HHmmss>-<实例>.txt`；"复制报告"写入剪贴板纯文本；"打开日志文件夹"定位到实例 `logs/` |
| R5.8 | 报告不得包含 accessToken/密码等敏感信息（P0 离线账户无 token，仍须过滤） |
| R5.9 | 启动前预检缺失 `1.20.1.jar` 时阻塞启动，列出缺失文件并提供"修复"，不产生崩溃弹窗 |
| R5.10 | 每次启动记录启动耗时、退出码、退出耗时；日志面板支持 跟随/暂停/清空/搜索，不阻塞主进程 |

**明确不要求**：日志上传、反馈、规则库热更新（P2）。

**验收步骤**

1. 正常启动到主菜单并退出；检查 `launcher.log`、游戏日志、`launch-last.json`、`launch-last.bat`；确认无崩溃弹窗、退出码 0。
2. 在高级参数加入 `-XX:+UseDefinitelyNotARealGC`；启动；记录从失败到弹窗的时间；检查报告文本与"复制报告"（`Get-Clipboard`）。
3. 正常启动到主菜单；在 PowerShell 执行 `Stop-Process -Name javaw -Force`；检查弹窗与报告结论。
4. 运行 P0-5 的规则单测（注入 `java.lang.OutOfMemoryError: Java heap space` 日志样本）→ 结论命中"内存不足"；实机可选：把内存设为 1024 MiB 启动重整合包（不作为硬门禁）。
5. 关闭启动器，把 `versions\1.20.1\1.20.1.jar` 改名为 `.bak`；启动；确认预检弹窗列出缺失文件 + "修复"按钮，且无 `javaw` 进程。
6. 点"修复"；确认 jar 被重新下载且 SHA1 正确；再启动进主菜单。
7. 检查 `launch-last.bat` 内容：`chcp <系统代码页>`（本机为 936）、`cd /d <gameDir>`、Java 路径、`-cp`、主类、`--username` 均在。
8. 连续启动 11 次（可用快速失败参数），确认日志轮转不超过 10 个文件（或配置上限生效）。

**断言**

- A5.1 正常退出：无弹窗；`launcher.log` 有"退出码 0"；4 类日志文件齐全。
- A5.2 JVM 参数错误：≤ 10 s 弹窗；报告含 `Unrecognized VM option`；结论命中 JVM 参数类；剪贴板内容与报告一致。
- A5.3 杀进程：≤ 10 s 弹窗；结论命中"进程被终止/异常退出"。
- A5.4 OOM 规则单测命中"内存不足"（注入日志样本）；实机 OOM 为可选加分项。
- A5.5 缺 jar：预检拦截、无进程、修复后 SHA1 正确。
- A5.6 `launch-last.bat` 字段齐全；日志轮转 ≤ 10。
- A5.7 报告中搜索 `accessToken`/`eyJ` 无命中。
- A5.8 日志面板 跟随/暂停/清空/搜索 均可用；日志行出现延迟 ≤ 1 s。

**证据**：四类日志、两份报告全文、剪贴板截图、预检弹窗截图、`launch-last.bat`。

### 5.7 P0-6 联机：一键房间 + 进入 LAN 世界 + 隧道降级

**范围裁定**：P0 只做 **LAN / 同机回环**；跨 NAT/中继（EasyTier 或自建）为 P1（`04-multiplayer-design.md`）。P0 允许但不要求使用 EasyTier；若使用，必须运行时下载、校验、可关闭，**随附 LGPL-3.0 许可证与源码获取方式**，且 **LAN 验收不得依赖任何第三方中继**（02 NET-02/03）。

**目标**：A 建房 → B 输邀请码 → A 开 LAN 世界 → B 一键进入；全程不手输 IP。

**必须满足（行为契约）**

| # | 要求 |
|---|---|
| R6.1 | 联机页提供"创建房间/加入房间"；房间显示：房间号（6 位 Crockford Base32）、邀请码（`MCL-XXXXXX`，大小写不敏感）、成员列表、地址、延迟、状态 |
| R6.2 | 状态机：`idle → creating → waiting → connected → closing → closed`；错误码：`ROOM_NOT_FOUND`、`ROOM_FULL`、`ROOM_CLOSED`、`VERSION_MISMATCH`、`NETWORK_UNREACHABLE`、`INVITE_INVALID` |
| R6.3 | 同机回环必须可用（本机双开验收）；同 LAN 双设备在条件具备时可用（L1） |
| R6.4 | 发现失败时降级：房间面板显示 `host-lan-ip:port` + 一键复制；**不得无限转圈** |
| R6.5 | 房主在游戏内"对局域网开放"后，启动器 ≤ 5 s 从实例 `logs/latest.log` 解析端口（`Started serving on <port>` 或 `Local game hosted on port <port>`），并更新房间地址；120 s 未发现 → 提示"未检测到 LAN 世界" + 手动端口输入 |
| R6.6 | 成员点"进入世界"→ 启动游戏直连：**MC ≥1.20（或版本 JSON 的 `arguments.game` 含 `--quickPlay*`）用 `--quickPlayMultiplayer <地址>:<端口>`；≤1.19 用 `--server <地址> --port <端口>`**；从点击到进世界 ≤ 60 s；全程 ≤ 3 次点击、不手输 IP |
| R6.7 | 版本/加载器不一致（A 1.20.1 vs B 1.20.4）→ 启动前拦截 `VERSION_MISMATCH`，不启动游戏 |
| R6.8 | 房主关闭房间/退出 → 成员 ≤ 5 s 收到"房间已关闭"；邀请码立即失效 |
| R6.9 | 默认只监听私网/回环；不连接任何中继（L0/L1 证据：`netstat` 无外部 ESTABLISHED）；成员上限 8 |
| R6.10 | 双开：应用允许两个实例（不同 `--data-dir`）同时运行；房间数据互不污染 |
| R6.11 | 隧道（按 t4 PoC 结果）：支持 EasyTier/中转 sidecar；运行时下载、固定版本、SHA-256 校验、LGPL-3.0 随附、可关闭；不得静态链接或改包分发（02 NET-02/03） |
| R6.12 | 降级链：P2P → 中转 → 手动端口映射指引；每一步在 UI 有可读状态/错误码，**不得静默失败**；L0/L1 不依赖隧道 |
| R6.13 | 隧道仅在用户显式开房/加房时启动；失败不影响本机/LAN 房间 |

> **进服参数的版本差异（2026-10-21 实测）**：Minecraft 1.20.1 客户端 `Main.class` 只有 `quickPlay*`，**没有 `--server/--port`**；因此 1.20+ 一律用 `--quickPlayMultiplayer host:port`，仅 ≤1.19 用 `--server host --port port`。判定规则：版本 JSON 的 `arguments.game` 中出现 `--quickPlay*`，或 MC 版本 ≥1.20（见 `03-architecture.md` §6.7 `supportsQuickPlay()`）。**MC 版本取实例元数据 `instance.json.mcVersion`**；像 `1.20.1-b` 这种改过目录/id 的实例仍按 `1.20.1` 判定，不要用改后的 id 去猜。A6.4 与验收步骤 8 按此断言，不要写死旧参数。

**明确不要求**：跨 NAT、中继、NAT 类型提示、房主迁移建议、mod 清单哈希比对（P1）。

**验收步骤（L0，同机双开，必跑）**

1. 准备两个实例（共享 assets/libraries，游戏目录隔离）：

```powershell
Copy-Item -LiteralPath "$MC\versions\1.20.1" -Destination "$MC\versions\1.20.1-b" -Recurse
Rename-Item -LiteralPath "$MC\versions\1.20.1-b\1.20.1.json" -NewName '1.20.1-b.json'
Rename-Item -LiteralPath "$MC\versions\1.20.1-b\1.20.1.jar"  -NewName '1.20.1-b.jar'
node -e "const fs=require('fs');const p=process.argv[1];const o=JSON.parse(fs.readFileSync(p,'utf8'));o.id='1.20.1-b';fs.writeFileSync(p,JSON.stringify(o));" "$MC\versions\1.20.1-b\1.20.1-b.json"
```

2. 启动两个启动器实例：`& $APP --data-dir "$E2E\dataA" --mc-dir $MC` 与 `& $APP --data-dir "$E2E\dataB" --mc-dir $MC`。
3. 在 A 创建离线账户 `TestUser`，在 B 创建 `SecondUser`；分别选中 `1.20.1` 与 `1.20.1-b`；两边都设为 **854×480 窗口化**（避免全屏/分辨率影响双开）。
4. A：联机页 → 创建房间；记录房间号、邀请码、状态 `waiting`（≤ 5 s）。
5. B：联机页 → 加入房间 → 输入邀请码；断言状态 `connected`（≤ 10 s），双方成员列表各显示 2 人，延迟数值显示。
6. A：启动 `1.20.1` → 单人游戏 → 创建新世界（默认设置即可）→ 进入世界 → `Esc` → "对局域网开放" → 记下聊天栏端口。
7. 观察 A 的房间面板 ≤ 5 s 内出现"已发现 LAN 世界 :<port>"，地址变为 `127.0.0.1:<port>`。
8. B：房间面板点"进入世界"；断言启动器启动 `1.20.1-b` 且命令行含 `--quickPlayMultiplayer 127.0.0.1:<port>`（1.20+；仅 ≤1.19 才断言 `--server 127.0.0.1 --port <port>`）。
9. 断言 B 进入 A 的世界：A 游戏日志出现 `SecondUser joined the game`；B 日志出现 `Connecting to 127.0.0.1` 且无连接失败；双方截图（同一世界、看到对方）。
10. 断言延迟显示 ≤ 100 ms（同机）；房间面板显示 2 人。
11. A 点"关闭房间"；断言 B 的启动器 ≤ 5 s 显示"房间已关闭"；B 再用旧邀请码加入 → `INVITE_INVALID`/`ROOM_CLOSED`（≤ 5 s）。
12. 负向：B 输入 `MCL-000000` → `ROOM_NOT_FOUND`（≤ 5 s，不启动游戏）；B 选中 `1.20.4` 实例后加入 A 的房间 → `VERSION_MISMATCH`（不启动游戏）。
13. 安全：`netstat -ano | findstr <roomPort>` 只显示回环/私网监听；`Get-NetTCPConnection` 无外部 ESTABLISHED。

**L1（同 LAN 双设备，条件项）**：第二台 Windows 设备同网段，重复步骤 4–10；断言 B 使用 A 的 **LAN IP**（非 `127.0.0.1`）、防火墙提示只放行"专用网络"、延迟 ≤ 100 ms。若本轮无第二设备，记录"环境不具备"，**不阻塞 P0**，但必须在交付说明中写明。

**L2（跨网隧道，条件项）**：若 t4 PoC 通过且具备第二网络/设备：A/B 在**不同网络**重复步骤 4–10；断言隧道建立（直连或中继）、UI 显示直连/中继状态、延迟真实；若只能中继，UI 必须明示"经中继"。若 PoC 未通过：记录阻塞点（NAT/权限/成本），UI 提供手动端口映射指引；**不阻塞 L0/L1**。

**断言**

- A6.1 创建房间 ≤ 5 s；房间号/邀请码格式正确；状态机日志完整（`room.create`/`room.join`/`room.ready`/`room.close`）。
- A6.2 同机回环加入 ≤ 10 s；双方成员列表一致；延迟数值非 0 且真实。
- A6.3 LAN 端口发现 ≤ 5 s；地址正确；房间面板可见。
- A6.4 成员"进入世界" ≤ 3 次点击、≤ 60 s 进世界；1.20+ 命令行含 `--quickPlayMultiplayer <地址>:<端口>`（≤1.19 才含 `--server/--port`）；双方日志互证"joined the game"。
- A6.5 版本不匹配拦截；错误邀请码 ≤ 5 s 报错且不启动游戏。
- A6.6 房主关闭 ≤ 5 s 通知；邀请码失效；进服参数按 A6.4 的版本规则（1.20+ `--quickPlayMultiplayer`）。
- A6.7 房间端口仅回环/私网监听；无外部中继连接。
- A6.8 双开不互相污染（两个 `data` 目录、两个账户、两个实例）。
- A6.9 L2（条件）：隧道/中转/手动映射至少一条可用；UI 状态与真实路径一致；失败可读。
- A6.10 隧道 sidecar（若使用）哈希校验通过、许可证随附、可关闭；未启动时无外部连接。

**证据**：两端启动器日志（含房间 trace id）、两端 `latest.log`、`launch-last.json`、房间面板截图、双人同世界截图、`netstat` 输出、时间戳。

**失败判据**：需要手输 IP 才能进入；邀请码错误无限转圈；开启 LAN 后 5 s 内未发现端口；房主关闭后成员无感知；默认连接公网中继。

### 5.8 P0-7 微软设备码 / Authlib / 多账户

**目标**：三种账户都能在 UI 走通；微软流程在**没有 Azure 审批**时也必须诚实失败（不伪造成功）；Authlib 注入不崩；账户切换不串号。

**必须满足**

| # | 要求 |
|---|---|
| R7.1 | 微软设备码：client id 可配置（构建期注入 + 仅开发期运行期覆盖）；public client + PKCE，无 client secret；scope 含 `XboxLive.signin`/`offline_access`；展示 `verification_uri` + `user_code` 并轮询 |
| R7.2 | 微软未配置 client id 或接口 403（未获 MCE 审批）→ 明确错误码（`MS_CLIENT_ID_MISSING`/`MS_AUTH_NOT_APPROVED`）+ 文档指引；**禁止伪造成功回调**；P0 验收允许此路径 |
| R7.3 | 若取得令牌：refresh token 用 Electron `safeStorage`/DPAPI 加密落盘；access token/XSTS 不持久化；任何日志/报告不含 token（`eyJ` 搜索为空） |
| R7.4 | Authlib：固定版本 `authlib-injector.jar` 从官方 release 下载 + SHA-256 白名单；`-javaagent:<绝对路径>=<HTTPS api root>`；启用前弹窗确认"将把登录信息发送给 <host>"；随附 LICENSE（AGPL-3.0 + 例外）；不可达时明确错误，不崩溃 |
| R7.5 | 多账户：离线/微软/Authlib 同一列表，切换后启动参数/用户名/UUID 正确，旧 token 不残留 |
| R7.6 | 微软真实登录为**条件项**：只有在 client id + 审批就绪并配置后才做端到端登录；否则只验错误路径 |

**明确不要求**：皮肤/披风上传、账号云同步（P2）。

**验收步骤**

1. 打开账户页 → 微软登录（不配置 client id）→ 5 s 内出现 `MS_CLIENT_ID_MISSING` 与文档链接；`$DATA` 下无 token 文件；无伪造成功页。
2. 若拿到可用 client id：重新登录 → 展示 `verification_uri` + `user_code`；在浏览器完成授权 → 账户列表出现微软账户；若返回 403 → `MS_AUTH_NOT_APPROVED`（条件项，记录结果）。
3. 在 `$DATA` 全目录搜索 `eyJ`/`accessToken` → 无明文；refresh token 文件存在且非明文。
4. Authlib：填写 `https://littleskin.cn/api/yggdrasil`（或 QA 指定的测试服）→ 下载 jar → 校验 SHA-256 → 启动；命令行含 `-javaagent:<abs>=<api>`；进程不因注入崩溃；若认证失败，启动器/游戏给出可读错误。
5. 离线 → Authlib → 离线 切换三次；每次命令行 `--username/--uuid` 正确，新日志不含上一个账户 token/用户名。
6. 停止 Authlib 服务器/断网 → 启动 → 明确提示服务器不可达，不卡死。

**断言**

- A7.1 无 client id → `MS_CLIENT_ID_MISSING`，无 token 文件，无假成功。
- A7.2 403 → `MS_AUTH_NOT_APPROVED`（条件项）。
- A7.3 token 不落明文（`eyJ`/`accessToken` 搜索为空）。
- A7.4 Authlib 命令行含 `-javaagent`；jar SHA-256 与配置一致；进程不崩溃。
- A7.5 三态切换不串号。
- A7.6 Authlib 不可达 → 可读错误，不卡死。

### 5.9 P0-8 模组/资源包/光影管理 + 整合包导入

**目标**：本地资源可管、整合包可导入；**不调用 CurseForge API**，加载器安装不在本卡。

**必须满足**

| # | 要求 |
|---|---|
| R8.1 | 扫描选中实例的 `mods/`、`resourcepacks/`、`shaderpacks/`：名称、大小、启用状态；启停用 `.disabled` 重命名；同名启用+禁用并存 → 冲突提示；删除/打开目录 |
| R8.2 | **拖入（拖拽）/选择文件**安装到**当前实例** + 打开实例目录：只接受 `.jar`/`.zip` 等合法类型；非法类型明确拒绝；写盘前校验路径。拖拽与文件选择器共用同一个安装入口（后端不区分来源）；用户 2026-10-21 明确要求两者都要 |
| R8.3 | `.mrpack` 导入：解析 `modrinth.index.json`，按清单下载到新实例；Modrinth CDN 单一 User-Agent、≤300 rpm、`sha1`+`sha512` 双校验；处理 `overrides/`、`client-overrides/`；**不安装加载器**（P1），需在 UI 明示"实例已导入，加载器需 P1 安装" |
| R8.4 | 本地 CurseForge zip：只解析本地 `manifest.json` + `overrides`；**不调用 `api.curseforge.com`**；缺失文件列清单 + "打开项目页"；不伪装成功 |
| R8.5 | Zip-Slip/路径穿越防护；文件数/大小上限；不执行压缩包内任何文件 |
| R8.6 | 导入进度/结果可读；失败清理半成品；不污染其它实例 |
| R8.7 | 其它整合包 zip：识别 `overrides/`/`mods/`/`config/` 等常见结构并按本地文件导入；无法识别 → 明确错误；不执行内容 |

**明确不要求**：Mod 在线更新/翻译、CF API、加载器安装、数据包/世界下载（P1/P2）。

**验收步骤**

1. 在 P0-1 实例的 `mods/` 放入 3 个测试 jar + 1 个 `.jar.disabled` + 1 组同名启用/禁用冲突（测试后清理，保证 1.20.1 仍可启动）；打开实例详情 → 模组页；断言列表状态/大小/冲突提示。
2. 启用/禁用各一次 → 文件后缀变化；删除一个 → 列表即时刷新；打开目录 → 资源管理器定位正确。
3. 拖入一个合法 jar → 安装到当前实例；拖入 `.txt` → 明确拒绝；再用「选择文件」重复一次（两条入口都要通）；切换到另一实例 → 文件不在另一实例。
4. 资源包/光影页各放 1 个文件 → 列表/启停/删除可用。
5. 构造最小 `.mrpack`（含 `modrinth.index.json`：1 个 <5 MiB 的 Modrinth 文件 + 1 个 `overrides/config/test.txt`）→ 导入；断言新实例目录、文件哈希（sha1+sha512）、overrides 内容；启动器日志有 UA/速率记录；`netstat`/日志无 `api.curseforge.com`。
6. 构造本地 CF zip（`manifest.json` + `overrides/` + 一个不存在的文件）→ 导入；断言 overrides 落地、缺失文件清单、项目页链接；无 CF API 请求。
7. Zip-Slip 夹具（条目 `../evil.txt`）→ 拒绝导入，`$E2E` 外无文件写入。
8. 导入后实例无加载器 → UI 明示"加载器需 P1 安装"，不宣称可启动。
9. 清理 `1.20.1/mods` 的测试文件，确认 P0-6 的 LAN 世界仍可启动。
10. 普通 zip（含 `overrides/config/test.txt`）→ 可导入；无 `overrides`/`mods` 的随机 zip → 明确报"无法识别整合包结构"。

**断言**

- A8.1 列表/启停/冲突/删除/打开目录全部正确。
- A8.2 拖入与选择文件两条入口都能安装到当前实例，非法类型拒绝，不串实例；两者落盘结果一致。
- A8.3 mrpack 导入文件/哈希/overrides 正确；Modrinth UA/速率合规；无 CF API。
- A8.4 CF zip 仅本地解析；缺失清单 + 项目页；无 CF API。
- A8.5 Zip-Slip 被拒；失败无残留。
- A8.6 无加载器提示明确，不宣称可启动。
- A8.7 普通 zip 结构可识别/导入；无法识别时明确报错。

### 5.10 端到端冒烟剧本（发布前必跑，约 60 min）

| 步 | 动作 | 通过判据 |
|---|---|---|
| 1 | 全新 `data` + 空 `mc` 首次启动 | 首屏 ≤ 2 s，可选目录，无报错 |
| 2 | 用独立 `data` + `--mc-dir 'E:\MC\.minecraft'` 只读扫描 | 15 实例、3 异常、零文件改动（P0-0） |
| 3 | 空目录安装 1.20.1 | 文件/SHA1/数量全对，≤ 15 min（P0-1） |
| 4 | 用离线 `TestUser` 从主页主按钮**一次点击**启动 | 进主菜单，用户名正确（P0-2 + P0-1 + §5.1.1）；失败时展开详情 |
| 5 | 检查 Java 自动选择 | 17.0.15，命令行一致（P0-3） |
| 6 | 内存 4096 + 1280×720 窗口化再启动 | argv 正确、进主菜单（P0-4） |
| 7 | 开全屏再启动 | `--fullscreen` 存在、窗口全屏（P0-4） |
| 8 | 高级参数注入错误 GC 后启动 | ≤ 10 s 报告，结论可读（P0-5） |
| 9 | 正常退出 | 无崩溃弹窗、退出码 0（P0-5） |
| 10 | 缺 jar 预检 + 修复 + 再启动 | 拦截、修复、进主菜单（P0-5） |
| 11 | 7 个页面导航 + 明暗主题切换 + 重启保持 | 页面齐全、状态机、主题持久（P0-0） |
| 12 | 模组启停/冲突/拖入安装 + 选择文件安装 + 资源包/光影页 | 文件后缀/列表/拒绝非法类型；两条入口一致（P0-8） |
| 13 | mrpack 导入 + 哈希校验 + overrides | 实例文件一致、无 CF API（P0-8） |
| 14 | 微软无 client id 错误路径 + Authlib 注入 | 诚实失败、`-javaagent` 不崩（P0-7） |
| 15 | 双开建房/加入/开 LAN/一键进世界 | ≤ 60 s 进世界、双方互证（P0-6 L0） |
| 16 | 关房 + 错码 + 版本不匹配 + 隧道降级 | 均 ≤ 5 s 明确报错；L2 按 PoC 记录（P0-6） |

**16/16 通过**才允许对外称"P0 可用"；第 3、4、8、13、15 步任一失败即阻断发布。

### 5.11 Definition of Done（P0 交付定义）

**功能**

- 全部 P0 断言通过；UI 接真实 IPC，**禁止 mock/假进度/预置日志**；
- 安装、启动、崩溃、联机、账户、模组/整合包六条链路都能在干净 `%TEMP%` 目录复现；
- 所有失败路径有中文人话 + 错误码 + 日志；不得把 P1 能力写成"已支持"。

**质量**

- `npm.cmd run typecheck`、`npm.cmd run build`、`npm.cmd run test` 全绿；
- `npm.cmd run e2e:install-launch` 在全新目录完成 1.20.1 安装并启动到主菜单，退出码 0；
- 单测覆盖：版本 JSON/inheritsFrom、参数组装、Java 版本选择、离线 UUID、房间状态机、SHA1/SHA-256、mrpack 解析、zip-slip、微软错误码、Authlib 参数注入；
- `contextIsolation=true`、`nodeIntegration=false`、preload 白名单 API；渲染进程无 `fs`/`child_process`；
- 无 `eval`、无远程代码加载；外链走系统浏览器；下载 URL 白名单；
- 仓库根含 `COPYING`（**GPL-3.0 / GPLv3**，02 LIC-09）+ `NOTICE` + 源文件 SPDX 头；发布物附 `THIRD-PARTY-LICENSES.txt`（02 LIC-10）。

**文档**

- `README.md`：安装/运行/打包/数据目录/已知限制（含 `npm.cmd` 说明）；
- 本文档若范围变更必须同步版本号与变更记录；
- `docs/evidence/p0/` 有 16 步冒烟的证据。

**工程**

- `npm.cmd run pack` 产出可执行目录，双击可启动；不要求安装器/签名（P2）；
- `package.json` 的 scripts 至少含 `typecheck`/`build`/`test`/`pack`/`e2e:install-launch` 五个入口；`package-lock.json` 入库；
- 冷启动不依赖开发工具；崩溃时 main 进程不静默退出（写日志）；
- 缓存/日志/下载临时文件可清理，不写入安装目录之外的系统位置（除用户显式选择）。

**评审**

- reviewer 按 `02` 安全基线审查通过（非自我批准）；QA 按 §5.10 复跑并归档证据。

### 5.12 需求追溯（P0 → 验收 → 建议任务）

| P0 | 验收用例 | 建议 owner | 前置任务 | 证据目录 |
|---|---|---|---|---|
| P0-0 | §5.1 A0.1–A0.9 | client-dev | t5/t7/t10 | `docs/evidence/p0/P0-0/` |
| P0-1 | §5.2 A1.1–A1.13 | install-dev + core-dev | t5/t6/t8 | `docs/evidence/p0/P0-1/` |
| P0-2 | §5.3 A2.1–A2.5 | core-dev | t6/t11 | `docs/evidence/p0/P0-2/` |
| P0-3 | §5.4 A3.1–A3.5 | core-dev | t6 | `docs/evidence/p0/P0-3/` |
| P0-4 | §5.5 A4.1–A4.7 | core-dev | t6 | `docs/evidence/p0/P0-4/` |
| P0-5 | §5.6 A5.1–A5.8 | core-dev | t6 | `docs/evidence/p0/P0-5/` |
| P0-6 | §5.7 A6.1–A6.10 | net-dev + client-dev | t4/t9/t10 | `docs/evidence/p0/P0-6/` |
| P0-7 | §5.8 A7.1–A7.6 | core-dev + client-dev | t6/t11 | `docs/evidence/p0/P0-7/` |
| P0-8 | §5.9 A8.1–A8.7 | core-dev + client-dev | t8/t15/t16 | `docs/evidence/p0/P0-8/` |

> 任务拆分仅为建议，实际以 captain 的任务列表为准；但 **owner 与验收的对应关系不得改变**，否则无法追责。

---

## 6. 本轮非目标

> 本章是**范围合同**：以下能力本轮**不实现、不验收、不写入交付说明的"已支持"**。任何一项被临时加进来，必须走 §10.4 的变更控制，并相应削减其它 P0 或延期交付。

### 6.1 本轮明确不做（P1/P2）

| 非目标 | 层级 | 为什么本轮不做 | 不做的风险 | 何时重排 |
|---|---|---|---|---|
| 微软**真实登录**（拿到令牌/进正版服） | P1 | 依赖自建 Azure 应用 + Minecraft API 权限审批（**以周计**，未获批 403）；P0 只验设备码流程与错误路径 | 正版玩家暂时只能用离线账户（不能进正版服） | 审批通过后立即 |
| Forge / NeoForge / Fabric **安装器** | P1 | 安装器行为随版本漂移，需要独立验证矩阵；P0 只要求**解析/启动已有版本** + 原版安装 | 重整合包用户暂时只能用 PCL 装好再由本启动器启动 | P0 全绿后第 1 优先 |
| CurseForge 接入（自带官方 key） | P1 | P0 不接 CF API；P1 需自备 key + 法务对代理/缓存/竞品条款出意见（02 API-16~22） | P0 用本地 zip + 打开项目页，功能可用但不自动补文件 | 02 法务前置满足后 |
| Quilt / OptiFine / LiteLoader 安装 | P2 | 无 PCL 安装基线/份额小/兼容矩阵爆炸 | 少数老包不可装 | 有真实诉求时 |
| 服务器列表/收藏/自动进服 | P1 | PCL 本身也"未见服务器列表"；P0 联机走房间 | 玩家需在游戏内手动加服 | 第 3 优先 |
| 启动器更新器 | P2 | 本轮无发布通道与签名；自更新高风险 | 用户需手动换版本 | 有稳定发布节奏后 |
| 备份/还原 | P1 | 不阻断主链路；但这是最佳差异点 | 丢档风险由用户自担（P0 不承诺） | 第 4 优先（建议提前） |
| 自定义主页/背景音乐/皮肤/披风 | P2 | 基础明暗主题已进 P0；自定义不影响"能不能玩" | 观感朴素 | 有余量时 |
| Java runtime 自动下载 | P1 | 本机已有 Java 17/21，P0 用检测即可闭环 | 无 Java 机器需手动装 | 第 6 优先 |
| 下载增强（测速/限速/离线导入） | P1 | P0 只需"能下、能校验、能回退" | 弱网体验差 | 第 5 优先 |
| 联机重连/实例一致性指纹 | P1 | P0-6 已含生命周期/错误码；mod 指纹需要 P1 模组数据 | 断线体验一般；进房不校验 mod | t9 后 |
| PCL 目录只读兼容（零迁移） | P1 | 15 个实例是真实留存关键，但工程独立 | 老用户需重新配置 Java/内存（实例文件仍可被扫描） | 第 9 优先（建议提前） |
| 整合包导出 | P2 | 导入是刚需，导出是创作者需求 | 创作者需手工打包 | 用户量起来后 |
| Mod 在线下载/更新/翻译（Modrinth） | P2 | P0 只保证"本地能玩 + 导入"；在线更新需要平台限流/缓存策略 | 用户需手动下 Mod | 有 Modrinth 更新设计后 |
| 帮助/公告/反馈、数据包/世界下载、遥测 | P2 | 与"第一次能不能玩"无关 | 口碑加分项缺失 | 视用户量 |
| 实例删除/重命名/多 MC 文件夹 | P1 | 删除有数据风险，需确认 UI 与存档列举 | 用户需手动删目录 | 第 10 优先 |
| 完整设置页（下载/联机/更新/高级） | P1 | P0 设置已覆盖 Java/内存/JVM/下载源/语言/主题 | 高级项需改配置文件 | 第 7 优先 |

### 6.2 永久不做（法律/定位底线）

| 不做的事 | 原因 |
|---|---|
| 盗版/绕过正版验证/伪造 session/离线进正版服 | 法律与生态底线；会让我们进不了正版服务器生态 |
| 自建"规避合规"的 MC 下载通道 | 上游已因合规下架（PCL 公告 230）；不能把合规风险转成产品功能（详见 `02`） |
| 服务端托管/云开服/代部署 | 重资产业务，与"启动器"定位冲突 |
| 启动器内社交/好友系统/大厅匹配 | 联机只需"房间+邀请码"；社交是另一个产品 |
| 插件/脚本 API、第三方主题市场 | 生态冷启动成本极高 |
| 账号云同步、跨设备配置同步 | 涉及账号体系与隐私合规 |
| 客户端内嵌 CurseForge API key / 代理缓存 CF 数据 | 条款禁止：key 不可转让/不可披露、禁止缓存 API 数据、禁止竞品用途（02 API-07~12） |

### 6.3 工程级不做

- **只支持 Windows x64**（不做 macOS/Linux/ARM64；本机证据全是 Windows）；
- **只做简体中文**（不做多语言框架；代码内文案集中管理即可）；
- **不做安装器/卸载器/代码签名**（P2；P0 交付"解压即用"的打包目录）；
- **不做多用户/多开隔离**（同一 Windows 用户一份配置；但 P0 必须允许**双进程**用于联机验收）；
- **不做自动更新/静默升级**（P2）；
- **不做遥测**（P2，且默认关闭）。

### 6.4 提前完成 P0 后的加做顺序（P1 排序，给 captain 排任务用）

1. F09 Forge 安装（1.20.1 47.4.20 优先）
2. F10/F11 NeoForge / Fabric 安装
3. F28 自动进服 + F38 服务器收藏
4. F49 备份/还原（差异点）
5. F15 下载增强
6. F19 Java 自动下载
7. F53 完整设置
8. F57 系统集成（快捷方式/拖拽/文件关联）
9. F06 PCL 目录只读兼容
10. F05 实例删除/重命名
11. F37 实例一致性指纹（联机增强）
12. F42/F43 联机校验与重连
13. F04 多 MC 文件夹
14. F36 整合包导出
15. F44 启动器更新器
16. F59 Mod 在线更新/翻译
17. F12/F13 Quilt/OptiFine/LiteLoader
18. F54/F55/F56 自定义主页/帮助/遥测

> 排序依据：**先补"用户每天都会碰到"的（加载器/服务器/备份/下载），再补"工程与兼容"的（设置/系统集成/迁移），最后补"锦上添花"的**。注意：F31/F32/F33/F35/F21/F22/F23/F41/F51/F60 已在 P0，不在本清单。

---

## 7. 约束与依赖

### 7.1 技术栈与运行环境

| 约束 | 内容 | 验收影响 |
|---|---|---|
| 运行时 | Electron + TypeScript + React；Node v24.20.0；主进程/预加载/渲染三进程 | `03-architecture.md` 定义边界；P0 验收只看行为 |
| 构建 | Vite/electron-builder 由 `03` 定；`npm.cmd run pack` 必须产出可执行目录 | §5.0 的 `$APP` 路径 |
| 命令 | **`npm.ps1` 被 ExecutionPolicy `Restricted` 拦截**；所有验收/CI 命令用 `npm.cmd`（或 `cmd /c npm`） | 任务 verify 命令需同步改写（§9 Q7） |
| 无 .NET | 不得依赖 C#/WPF/安装器；Java 相关只调用 `java.exe` | 排除 WPF/C# 路线 |
| 权限 | 普通用户权限即可；P0 不做内存优化/注册表写入 | 启动器不得要求管理员 |
| 屏幕/DPI | 中文 Windows，默认 100%/125% 缩放；窗口最小 800×600 | UI 验收不因缩放错位 |
| 路径 | 安装/数据目录可含中文/空格；不得假定 `C:\` | §7.6 |
| 网络 | 家庭宽带/NAT；代理可选（P1 再做代理设置） | 下载与联机验收 |

### 7.2 网络与下载源（本机实测，详见附录 D）

| 规则 | 要求 |
|---|---|
| 源顺序 | 默认 `BMCLAPI → 官方`；设置可切"仅官方/仅镜像/自动"（P0 要求自动 + 日志可读） |
| 超时/重试 | 单请求 10 s；每源重试 3 次；失败切下一源；全失败 → 明确错误（列出失败 URL） |
| HTTPS | 只允许 HTTPS；不允许 HTTP 明文下载 |
| 校验 | 每个文件 SHA1 必须与元数据一致；不一致删除重下（最多 2 次） |
| 并发 | 可配 1–16（默认 8）；单主机 ≤ 4；Range 探测失败回退单连接 |
| 取消 | 用户取消 → 停止新任务、清理 `.part`、保留已校验文件（下次续传） |
| 日志 | 每个文件记录：URL、源、字节数、耗时、校验结果 |
| 来源标注 | 下载页/任务卡片必须显示当前源（「Mojang 官方」/「BMCLAPI（bangbang93）」）并可点击到来源主页；镜像可关闭（02 SRC-01/06） |
| 合规 | 下载源是**可配置适配层**；不得内置"规避合规"的私有通道（`02` 裁定） |

### 7.3 合规、许可证与 clean-room 边界（需求级，结论以 `02` 为准）

| 项 | 本轮要求 |
|---|---|
| 代码 | 不读、不复制 PCL2 源码/资源/字符串表；不反编译其私有实现；只做黑盒行为观察（日志/落盘文件/进程命令行）；GitHub 仓库只允许看目录/文件**名**（仅路径），并记入 `clean-room-log.md` |
| 参考物 | `E:\MC\PCL` 只读；PCL2 **非开源**（《PCL 分发有限许可》，GitHub `NOASSERTION`）——目录树仅用于功能枚举，**不得读文件内容**；许可结论由 `02` 给出 |
| 用户数据 | 读取 `PCL\Setup.ini`/`config.json` 属互操作：只读、不写回、不复制其默认模板/文案；P0 甚至不读 |
| 命名/视觉/文案 | 产品名不以 `PCL`/`Plain Craft Launcher` 开头或包含；主色不用 PCL 蓝；正版/赞助劝导文案自写；不使用 PCL 图标/背景/音乐/皮肤；不做 1:1 UI 复刻；PCL 的模块名（`ModLaunch`/`ModDownload` 等）**只用于描述参考产品，不得作为我们的模块名**（02 LIC-03/06、MC-09） |
| Mojang | 只使用官方 manifest/资源；不重分发 client.jar 之外的 Mojang 资产包；下载 URL 可替换 |
| 第三方服务 | P0 **只接入 Modrinth**（整合包导入的文件下载）：单一 User-Agent、≤300 rpm、`sha1`+`sha512` 校验（02 API-01~05）。**CurseForge API 在 P0 不接入**：P0 只做「浏览器打开项目页」+「本地 zip 的 manifest/overrides 解析」。P1 若接入 CF，必须自备官方 key 且满足 02 API-16~22（key 只放后端、禁缓存、禁代理隐匿、竞品条款法务意见）；客户端零 key |
| 免责声明 | README 写明"非官方启动器，与 Mojang/PCL 作者无关联"；离线账户提示仅单机/LAN；About 页末尾放礼貌声明（不暗示关联） |
| 删除权/隐私 | P0 无遥测、无上传；日志仅本地；用户可一键清空 `data/` |

> **口径说明（2026-10-21）**：captain 消息强调「P0 只做 Modrinth + 打开项目页」；`02-compliance-security.md` v0.2 的「用户裁定」写明「CF = P1 接入且自备官方 key，P0 不接」。两者在 P0 上一致；本文件按 **P0 不接 CF、P1 仅在 02 API-16~22 前置满足时接入** 执行，客户端永不内嵌 CF API key。微软登录 P0 只验设备码流程与错误路径（02 同一口径：P0 不依赖审批），真实登录/刷新为 P1，依赖 Azure 应用 + Minecraft API 权限审批（以周计）。

### 7.4 数据与隐私

- P0 只存：配置、账户名/UUID、实例索引、日志、崩溃报告；**不存密码/token**（微软 P1 才引入加密存储）。
- 日志默认脱敏：绝对路径中的用户名可用 `%USERPROFILE%` 替代（可选）；报告中不得出现 `accessToken`/`eyJ`。
- 无网络请求除非用户主动安装/联机；启动器启动时不"偷偷"检查更新（P2）。

### 7.5 安全基线（P0 必须）

| # | 要求 |
|---|---|
| S1 | `contextIsolation=true`、`nodeIntegration=false`、`sandbox=true`（若 Electron 版本允许）；preload 只暴露白名单 API |
| S2 | 渲染进程不得直接访问 `fs`/`child_process`/`shell`；URL 打开走系统浏览器 + 域名白名单 |
| S3 | 所有子进程用 `spawn(file, argsArray)`，禁止字符串拼接 shell 命令；实例名/路径做参数化 |
| S4 | 实例名/版本名用于路径前必须校验：拒绝 `..`、绝对路径、盘符、NTFS 保留名（`CON`/`NUL` 等） |
| S5 | 下载仅 HTTPS + SHA1；不执行下载的任意 jar（vanilla jar 只作为 `-cp` 类路径；P1 安装器例外：需用户确认 + 来源/哈希校验）；**不引入** `JavaWrapper.jar`/`libjlw-*.dll`（02 SEC-EXE-04） |
| S6 | 房间服务默认只绑定私网/回环；不自动改防火墙；邀请码不是安全边界（文档写明） |
| S7 | 解压（P1 整合包）必须防 Zip-Slip；P0 不实现解压用户压缩包 |
| S8 | 崩溃报告/日志不含 token；报告复制前做敏感串过滤 |

### 7.6 路径、编码与本地化

| 项 | 要求 | 证据 |
|---|---|---|
| JSON 读写 | **一律 UTF-8（无 BOM）**；禁止用 ANSI/GBK 读取 | 研究底稿的"2 个 JSON 损坏"就是 ANSI 误读（§2.3） |
| 中文路径 | 支持中文/空格/`[]`/`：`；全链路 `path.join`，不手拼分隔符 | 本机 7 个实例名含中文或全角符号 |
| 长路径 | 超过 260 字符时使用 `\\?\` 前缀或 Node 长路径 API | 重整合包路径可能超长 |
| 控制台编码 | 启动游戏时按系统代码页传 `-Dstdout.encoding`/`-Dstderr.encoding` | PCL `使用编码：GB18030` |
| 文案 | 简体中文；错误信息含错误码（如 `JAVA.NOT_FOUND`） | 便于 QA 断言 |
| 时间 | 日志用 ISO8601 带时区（`2026-10-21T12:34:56.789+08:00`） | 跨时区排障 |

### 7.7 性能预算

| 场景 | 预算 | 测量 |
|---|---|---|
| 冷启动到可交互 | ≤ 2 s | 启动器日志 |
| 15 实例扫描（冷/热） | ≤ 2 s / ≤ 500 ms | 日志 |
| 安装 1.20.1（≥20 Mbps） | ≤ 15 min | 日志 |
| 原版启动到主菜单 | ≤ 60 s | 游戏日志 |
| 崩溃→报告 | ≤ 10 s | 时间戳 |
| 内存（启动器空闲） | ≤ 300 MiB（目标，不作硬门禁） | 任务管理器 |

---

## 8. 风险与缓解

| # | 风险 | 类型 | 可能性 | 影响 | 缓解 |
|---|---|---|---|---|---|
| R1 | 下载源合规口径变化（PCL 公告 230 已发生过一次） | 法律 | 中 | 高（产品不成立） | 源适配层可换/可关；`02` 出书面结论；P1 离线导入 |
| R2 | `piston-meta` 类端点在本机/某些网络不可达 | 技术 | **高（已实测）** | 高（安装失败） | 官方→BMCLAPI 自动回退；日志可读；重试/换源 UI |
| R3 | 微软 OAuth 需自建 Azure 应用 + 申请 Minecraft API 权限（`aka.ms/mce-reviewappid`），**审批周期以周计**，未获批接口 403 | 依赖 | 中 | 高（P0-7 条件/P1 真实登录） | 立即启动审批（与 P0 并行）；P0 只验"明确错误 + 不伪造成功"；未获批前不把"真实正版登录"写进交付说明 |
| R4 | 联机 LAN 发现被防火墙/AP 隔离阻断 | 技术 | 中高 | 中 | 手动地址降级；文档写清"同网段/专用网络"；L1/L2 条件验收 |
| R5 | 同机双开资源不足（两个 MC 客户端/GPU） | 环境 | 中 | 中（P0-6 验收） | 854×480 窗口化；各 2 GiB；失败改用第二设备/降低画质 |
| R6 | `npm.ps1` 执行策略导致 verify 失败 | 工程 | **高（已实测）** | 中 | 全部命令改 `npm.cmd`；CI/QA 固定写法 |
| R7 | 中文/全角路径导致读文件失败 | 技术 | 高 | 中 | UTF-8 强制；路径 fixture；长路径前缀 |
| R8 | Java 25 与 1.20.1 兼容性不确定 | 技术 | 中 | 中 | 选择规则限定 17/21；允许手动覆盖并警告 |
| R9 | P0 164 人日产品级工作量在本会话无法全部完成 | 进度 | 高 | 高 | 按 P0 顺序推进（0→2/3/4→1→5→7→8→6）；先保 P0-1/5/6-L0；**不允许**用 mock 充数 |
| R10 | 联机 30 人日不确定（LAN 发现/端口解析/隧道 PoC） | 成本 | 中 | 中 | 第 1 周做双开 Spike；L0 通过即锁定；L2 按 t4 结果降级 |
| R11 | 杀软误报（注入 authlib/监听端口/隧道 TUN） | 运营 | 中 | 中 | P0 不做自更新；注入/隧道需用户确认；文档说明 |
| R12 | 验收误用 `E:\MC` 真实目录导致用户数据损坏 | 操作 | 中 | 高 | 所有用例在 `%TEMP%` 新建；P0-0 只读并校验哈希；证据目录留痕 |
| R13 | Authlib jar 供应链（AGPL-3.0 + 例外） | 依赖 | 中 | 中 | 固定版本 + SHA-256；官方 release；02 SEC-EXE-01/03 |
| R14 | Modrinth API 限流/条款（UA、≤300 rpm、缓存限制） | 依赖 | 中 | 中 | 单 UA + 限速 + 重试；只取清单所需字段；02 API-01~05 |

---

## 9. 待决问题（给 captain，含默认值）

> 规则：**未在对应实现任务开始前书面否决，则默认值生效**；否决请直接改本文件对应章节并升版本。

| # | 问题 | 为什么必须现在答 | 默认裁定 | 截止 |
|---|---|---|---|---|
| **Q1** | 联机 P0 是否接受"L0/L1 必验、L2 隧道按 t4 PoC 条件验收"？ | 决定 P0-6 的 30 人日是否成立、本机能否闭环验收 | **是**（§0.5-A、§5.7）：L0 硬门禁，L1/L2 条件项，失败必须有可读降级 | P0-6 开工前 |
| **Q2** | P0 是否接受"**不含 Forge/NeoForge/Fabric 安装器**（但可解析/启动已有 Forge/Fabric 版本）"？ | 本轮实现任务已包含账户/模组/整合包（t11/t15/t16），唯独加载器安装未排任务；若要求 P0 含 Forge 安装，成本 +12 人日且验收链变长 | **是**（§0.5-C、§6.1）；加载器安装进 P1 第 1 优先 | 立即（影响任务拆分） |
| **Q3** | 数据目录默认位置：便携 `data/` 还是 `%APPDATA%\mc-launcher`？ | 影响首次启动写权限与卸载残留 | **便携 `data/`**（交付目录可写；`--data-dir` 可覆盖） | P0-0 开工前 |
| **Q4** | 是否有第二台 Windows 设备/第二网络做 L1/L2 联机验收？ | 决定 L1/L2 是"必验"还是"条件项" | **无**：L0 必验，L1/L2 条件项（§5.7） | P0-6 开工前 |
| **Q5** | 验收是否允许真实下载 ~700 MiB（而不是预置离线包）？ | 决定 P0-1 耗时与网络依赖 | **允许真实下载**；离线导入 P1 再做 | P0-1 开工前 |
| **Q6** | 打包产物路径与 CLI 开关是否按 §5.0 约定？ | 验收脚本依赖 | **是**：`release/win-unpacked/mc-launcher.exe --data-dir --mc-dir` | t5 验收前 |
| **Q7** | 任务 verify 命令是否统一改 `npm.cmd`？ | 否则 t5 验收在 PowerShell 下必失败 | **是**；请 captain 同步 t5 及后续任务 | 立即 |
| **Q8** | P0 是否要求读取 PCL 的 `Setup.ini`/`config.json`（零迁移）？ | 影响 P0-0 成本与法律边界 | **否**（P1 F06）；P0 只扫描实例目录 | P0-0 开工前 |
| **Q9** | P0 联机是否允许引入 EasyTier 二进制？ | 影响体积/许可/下载校验 | **不依赖**；若用，必须运行时下载+校验+可关闭（§5.7） | P0-6 开工前 |
| **Q10** | 微软 Azure 应用 + Minecraft API 权限审批的负责人/启动时间？ | 审批以周计（未获批 403）；P0-7 只验错误路径，P1 真实登录依赖它 | **尚未启动**；建议 captain 立即指派负责人并开始申请（与 P0 并行） | 立即 |
| **Q11** | 整合包导入是否接受"只导入文件/实例，加载器安装放 P1"？ | t15 验收只要求按清单写实例；没有加载器，导入的包不可直接启动 | **是**；UI 必须明示"加载器需 P1 安装"，不得宣称可启动 | P0-8 开工前 |

---

## 10. 交付物与证据规范

### 10.1 本轮交付物清单

| # | 交付物 | 位置 | 验收 |
|---|---|---|---|
| 1 | 需求与范围（本文件） | `mc-launcher/docs/01-requirements.md` | 本文档 |
| 2 | 合规与安全基线 | `mc-launcher/docs/02-compliance-security.md` | 02 自身评审 |
| 3 | clean-room 记录 | `mc-launcher/docs/clean-room-log.md` | 每模块一条（LIC-07） |
| 4 | 架构与接口 | `mc-launcher/docs/03-architecture.md` | 03 自身评审 |
| 5 | 联机设计 | `mc-launcher/docs/04-multiplayer-design.md` | 04 自身评审 |
| 6 | 设计原型与规范 | `mc-launcher/design/index.html` + `design/README.md`（t7） | UI 视觉基准 |
| 7 | 可运行代码 | `mc-launcher/`（main/preload/renderer/shared/tests） | §5.10 16 步 |
| 8 | 打包产物 | `mc-launcher/release/win-unpacked/`（或 t5 约定） | 双击可启动 |
| 9 | README | `mc-launcher/README.md` | 含运行/打包/数据目录/限制 |
| 10 | 用户手册 / 交接 | `mc-launcher/docs/06-user-guide.md`、`07-handoff.md`（t14） | 对照真实状态 |
| 11 | 验收报告 | `mc-launcher/docs/05-acceptance-report.md`（t12） | P0 逐条 pass/fail + 证据 |
| 12 | 证据 | `mc-launcher/docs/evidence/p0/` | §10.2 |
| 13 | 验收记录 | `mc-launcher/docs/evidence/p0/acceptance.md`（QA 填） | 16/16 |

### 10.2 证据目录与命名

```
docs/evidence/p0/
  P0-0/
    01-instances.txt          # 实例列表导出
    02-before-after-hash.txt  # 只读校验
    03-launcher.log
  P0-1/
    01-install-tree.txt
    02-hashes.txt
    03-launcher.log
    04-launch-last.json
    05-launch-last.bat
    06-latest.log
    07-mainmenu.png
    notes.md
  P0-2/ ... P0-8/
  acceptance.md               # 16 步冒烟记录表
```

规则：

- 截图用 PNG；日志用 UTF-8 文本；哈希用 `Get-FileHash` 原始输出；
- 文件名前缀两位序号，按执行顺序；
- 不含 token/密码/隐私；含用户路径时可用 `<USER>` 替换；
- 证据目录随代码入库；大文件（>5 MiB）只留片段 + 哈希。

### 10.3 验收执行模板（QA 用）

| 用例 | 执行人 | 时间 | 结果（PASS/FAIL） | 关键证据 | 备注 |
|---|---|---|---|---|---|
| P0-0 A0.1–A0.9 | | | | | |
| P0-1 A1.1–A1.13 | | | | | |
| P0-2 A2.1–A2.5 | | | | | |
| P0-3 A3.1–A3.5 | | | | | |
| P0-4 A4.1–A4.7 | | | | | |
| P0-5 A5.1–A5.8 | | | | | |
| P0-6 A6.1–A6.10（L0 必验；L1/L2 条件） | | | | | |
| P0-7 A7.1–A7.6 | | | | | |
| P0-8 A8.1–A8.7 | | | | | |
| P0-6 L1（条件） | | | | | |

**判定**：任一 P0 卡 FAIL → 整体 FAIL；修复后**全量重跑该卡**（不做"只跑失败项"）。

### 10.4 变更控制

1. 任何 P0 范围/断言变更：改本文件 + 升版本（1.x → 1.x+1）+ 记录 §附录 H；
2. **只能加严，不能放宽**：删除断言必须由 captain 书面批准并说明原因；
3. 新增 P1 功能进本轮：必须同时说明"砍掉哪个 P0/延期多久"，否则不接；
4. 验收证据与代码同 commit；不接受"事后补证据"。

---

## 附录 A. 本机实例清单（实测）

> 采集时间 2026-10-21 12:2x；`libs` = 版本 JSON 的 `libraries` 条目数；`mods` = `mods/*.jar` 顶层文件数；`MB` = 目录总大小（四舍五入）；`saves` = `saves/` 下目录数。

| # | 实例 | 版本 JSON | libs | mainClass | assetIndex | MB | mods | saves | 状态 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `1.20.1` | ✅ | 88 | `net.minecraft.client.main.Main` | 5 | 44 | 0 | 1 | 可用（P0 目标） |
| 2 | `1.20.4` | ✅ | 88 | `net.minecraft.client.main.Main` | 12 | 23 | 0 | 0 | 可用 |
| 3 | `1.21.1-Forge_52.1.1` | ❌ | — | — | — | 0 | 0 | 0 | **缺版本 JSON（空壳）** |
| 4 | `1.21.1-Forge_52.1.10` | ❌ | — | — | — | 0 | 1 | 0 | **缺版本 JSON** |
| 5 | `1.21.1-NeoForge_21.1.233` | ✅ | 144 | `cpw.mods.bootstraplauncher.BootstrapLauncher` | 17 | 5,255 | 102 | 1 | 可用（P1 参考） |
| 6 | `1.21.3` | ✅ | 113 | `net.minecraft.client.main.Main` | 18 | 59 | 0 | 0 | 可用 |
| 7 | `Hunt：History 1949 - Blood Testament` | ✅ | 117 | `cpw.mods.bootstraplauncher.BootstrapLauncher` | 5 | 2,660 | 285 | 1 | 可用（全角冒号） |
| 8 | `Immersive Fight 4.2.3` | ✅ | 117 | `cpw.mods.bootstraplauncher.BootstrapLauncher` | 5 | 10,859 | 311 | 2 | 可用（最大实例） |
| 9 | `The Last Voyage of the Harpy Express` | ❌ | — | — | — | 344 | 4 | 1 | **缺版本 JSON（有存档）** |
| 10 | `[神道传说]GodRoad-人类群星闪耀时` | ✅ | 117 | `cpw.mods.bootstraplauncher.BootstrapLauncher` | 5 | 1,470 | 187 | 0 | 可用（方括号/中文） |
| 11 | `史前世界 2` | ✅ | 117 | `cpw.mods.bootstraplauncher.BootstrapLauncher` | 5 | 1,483 | 358 | 1 | 可用（Log1 实测启动） |
| 12 | `方可梦：炽白真形` | ✅ | 144 | `cpw.mods.bootstraplauncher.BootstrapLauncher` | 17 | 4,024 | 278 | 1 | 可用 |
| 13 | `落幕曲` | ✅ | 117 | `cpw.mods.bootstraplauncher.BootstrapLauncher` | 5 | 1,713 | 296 | 2 | 可用 |
| 14 | `远梦之棺` | ✅ | 117 | `cpw.mods.bootstraplauncher.BootstrapLauncher` | 5 | 1,710 | 199 | 1 | 可用 |
| 15 | `逆转未来2.3.2` | ✅ | 117 | `cpw.mods.bootstraplauncher.BootstrapLauncher` | 5 | 3,373 | 238 | 1 | 可用 |

**统计**：15 个实例；12 个 JSON 有效（**全部无 `inheritsFrom`**）；3 个缺 JSON；总占用约 32.2 GiB。`史前世界 2` 的 358 个 `.jar` 之外另有 2 个 `.jar.disabled`（禁用态，P1 模组管理才需要处理）。

## 附录 B. 原版 1.20.1 安装足迹（实测，验收精确值）

| 项 | 值 | 说明 |
|---|---|---|
| 版本 JSON `id` / `mainClass` | `1.20.1` / `net.minecraft.client.main.Main` | `assetIndex.id=5`、`javaVersion.majorVersion=17` |
| 客户端 jar | **23,028,853 B**；SHA1 `0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838` | `piston-data` / BMCLAPI `/version/1.20.1/client` |
| 支持库 | JSON 88 条；**Windows 适用 64 个 jar**，58 MiB；其中 natives 21 个 | 规则 `os.name=windows`/`os.arch=x86_64` |
| 资源索引 | **413,067 B**；SHA1 `8a45c6be38ac9486b04944bffcb96f8aae1b0649`；`totalSize=651,728,646` | `assets/indexes/5.json`；磁盘去重后 651,496,644 B |
| 资源对象 | **3575 个唯一 hash**（索引 3598 条） | SHA1 目录分片 |
| 日志配置 | `client-1.12.xml` 888 B；SHA1 `bd65e7d2e3c237be76cfbef4c2405033d7f91521` | `logging.client.file` |
| 下载合计 | ≈ **702 MiB**（≈ 736 MB 十进制） | 651.7 MB assets + 60.9 MB libs + 23.0 MB jar + 0.4 MB index |
| 解压后磁盘 | ≥ **1.5 GiB**（含 natives 解压与临时文件） | 预检阈值 |

## 附录 C. PCL 启动命令行样本（实测，已脱敏，仅作行为参照）

> 来源：`E:\MC\PCL\LatestLaunch.bat`（快照版 412）。**不复制其实现**，仅用于确认参数形状与验收断言。

```
"C:\Users\<USER>\AppData\Roaming\.minecraft\runtime\java-runtime-delta\bin\java.exe"
-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump
"-Djava.library.path=E:\MC\.minecraft\versions\史前世界 2\史前世界 2-natives"
"-Djna.tmpdir=<...>-natives" "-Dorg.lwjgl.system.SharedLibraryExtractPath=<...>-natives" "-Dio.netty.native.workdir=<...>-natives"
-Dminecraft.launcher.brand=PCL -Dminecraft.launcher.version=412
-cp "<libraries + 实例 jar 的完整类路径>"
... -Xmx15974m -XX:+UnlockExperimentalVMOptions -XX:+UseG1GC -XX:G1NewSizePercent=20 -XX:G1ReservePercent=20
    -XX:G1HeapRegionSize=32M -XX:MaxGCPauseMillis=50 -XX:+PerfDisableSharedMem -XX:MinHeapFreeRatio=25 -XX:MaxHeapFreeRatio=40
    -Dlog4j2.formatMsgNoLookups=true -Dstdout.encoding=GBK -Dstderr.encoding=GBK -Dfile.encoding=COMPAT
cpw.mods.bootstraplauncher.BootstrapLauncher
--username <name> --version "史前世界 2" --gameDir "...\versions\史前世界 2"
--assetsDir ... --assetIndex 5 --uuid <uuid> --accessToken <token>
--clientId ${clientid} --xuid ${auth_xuid} --userType msa --versionType PCL
--width 854 --height 480 --launchTarget forgeclient --fml.forgeVersion 47.4.20 ... --fullscreen
```

**观察到的坑（写进我们的需求）**：

1. PCL 把未替换的 `${clientid}`/`${auth_xuid}` 原样传给游戏 → 我们**禁止**留下任何未替换的 `${...}`（P0-1 R1.8/A1.7 断言补充）。
2. 参数里同时出现 `--width/--height` 与 `--fullscreen`，语义由游戏处理；我们按设置显式二选一。
3. 编码用 `GBK/COMPAT` 而非 UTF-8，是中文 Windows 的兼容做法；我们沿用并按代码页生成。

## 附录 D. 端点探测记录（2026-10-21 12:2x–12:3x，本机）

| # | 端点 | 方法 | 结果 |
|---|---|---|---|
| 1 | `https://launchermeta.mojang.com/mc/game/version_manifest_v2.json` | HEAD | 200 |
| 2 | `https://piston-meta.mojang.com/v1/packages/e1e23f09.../5.json` | GET | **超时（重试仍超时）** |
| 3 | `https://piston-data.mojang.com/v1/objects/0c3ec5.../client.jar` | HEAD | 200，23,028,853 B |
| 4 | `https://libraries.minecraft.net/ca/weblite/java-objc-bridge/1.1/java-objc-bridge-1.1.jar` | HEAD | 200，1,330,045 B |
| 5 | `https://resources.download.minecraft.net/b6/b62ca8...` | HEAD | 200，9,101 B，`Accept-Ranges: bytes` |
| 6 | `https://bmclapi2.bangbang93.com/mc/game/version_manifest.json` | HEAD | 200，210,058 B |
| 7 | `https://bmclapi2.bangbang93.com/version/1.20.1/json` | HEAD | 200，34,974 B |
| 8 | `https://bmclapi2.bangbang93.com/version/1.20.1/client` | HEAD | 200，23,028,853 B |
| 9 | `https://bmclapi2.bangbang93.com/v1/packages/e1e23f09.../5.json` | HEAD | 200，413,067 B，Range |
| 10 | `https://bmclapi2.bangbang93.com/assets/b6/b62ca8...` | HEAD | 200，9,101 B，Range |
| 11 | `https://bmclapi2.bangbang93.com/maven/com/mojang/logging/1.1.1/logging-1.1.1.jar` | HEAD | 200，15,343 B（首次曾超时，重试通过） |
| 12 | `https://bmclapi2.bangbang93.com/forge/minecraft/1.20.1` | HEAD | 200，56,543 B |
| 13 | `https://bmclapi2.bangbang93.com/neoforge/meta/api/maven/details/releases/net/neoforged/neoforge` | HEAD | 200，78,304 B |
| 14 | `https://meta.fabricmc.net/v2/versions/loader` | HEAD | 200 |

**结论**：本机必须**默认镜像优先 + 官方回退**；P0-1 的"官方超时→镜像成功"不是可选优化，而是通过验收的必要条件。

## 附录 E. GitHub 仓库目录树（仅路径，未读文件内容；仅功能枚举，2026-10-21）

```text
Meloong-Git/PCL
├─ MeloongCore/                 # 核心库
├─ PCLCS/                       # 安装/更新相关
├─ Plain Craft Launcher 2/
│  ├─ Modules/
│  │  ├─ Base/                  # 基础模块
│  │  ├─ Minecraft/             # ModCrash, ModDownload, ModJava, ModLaunch,
│  │  │                         # ModMinecraft, ModModpack, ModWatcher
│  │  ├─ Resource/              # 资源/UI 资源
│  │  ├─ ThirdParty/
│  │  ├─ ModDevelop.vb / ModEvent.vb / ModMain.vb / ModMusic.vb / ModSecret.vb
│  ├─ Pages/
│  │  ├─ PageDownload/ PageInstance/ PageLaunch/ PageLink/
│  │  ├─ PageOther/ PageSetup/（Launch/Link/System/UI/Settings）
│  │  ├─ PageSelectLeft/Right, PageSpeedLeft/Right
├─ patches/                     # 补丁
├─ LICENCE
```

> 用途：确认"功能面有没有漏"和"PCL 把哪些能力放在哪些页面"。
>
> **合规声明**：`Meloong-Git/PCL` **不是开源仓库**（许可证为《PCL 分发有限许可》，GitHub `NOASSERTION`；裁定见 `02` §2.1）。此处只有**目录/文件名**，未打开任何文件内容（`clean-room-log.md` CR-001）。**不得复制任何源码/资源，也不得把目录树当实现依据**；实现依据只能是黑盒行为/公开规范（02 LIC-01/02）。

## 附录 F. 与研究底稿的差异与合并说明

| 项 | `docs/research/10-feature-matrix.md` | 本文件 | 处理 |
|---|---|---|---|
| P0 范围 | 17 项，163 人日（产品级完整 parity） | 9 张卡，164 人日（本轮交付门禁） | 本文件按 captain 任务书 + t5–t16 实现任务重划；Forge/加载器安装等进 P1/P2 |
| 联机 | P0 做 EasyTier/中继 | P0 做 LAN/同机（硬门禁）+ 隧道降级（按 t4 PoC 条件） | 本机无法闭环 WAN 验收（§0.5-A、§5.7） |
| 账户 | P0 含微软/Authlib | P0 含微软设备码（条件）+ Authlib；真实登录依赖 Azure/MCE 审批 | t11 验收要求；§0.5-B、§5.8 |
| 许可证/源码引用 | 以 GitHub 仓库目录树为证据 | 改为"GitHub 仓库目录树（仅路径，未读内容）"，并记 `clean-room-log` | t2 裁定 PCL2 非开源（02 §2.1、LIC-02/07） |
| 加载器/模组/整合包 | P0 含 Forge/NeoForge/Fabric/模组/整合包 | P0：模组/资源/光影 + 整合包文件导入；加载器安装 P1 | t15/t16 验收；§5.9 |
| 实例 JSON 状态 | "2 个损坏" | 3 个缺 JSON；2 个"解析失败"是 ANSI 误读 | §2.3 修正；需求增加"UTF-8 强制" |
| 下载源 | 官方+镜像可用 | `piston-meta` 本机超时；镜像全路径可用 | §3.5/附录 D；安装器必须回退 |
| 成本 | 245 人日（全 parity） | 311 人日（P0 164 + P1 80 + P2 67） | 口径不同（本文件把设置/系统集成等单列、并补 Mod 在线项）；均 ±25% |
| 底稿 Q1–Q8 | 待拍板 | 已用默认裁定回答（§9 Q1–Q11） | 未否决即生效 |

## 附录 G. 术语表

| 术语 | 含义 |
|---|---|
| 实例（instance） | `versions/<名字>/` 下的一套版本配置 + 游戏目录（PCL 叫"版本"） |
| 版本 JSON | `<实例>.json`，含 `libraries/arguments/assetIndex/mainClass/javaVersion` |
| 加载器（loader） | Forge/NeoForge/Fabric/Quilt 等修改游戏启动的组件 |
| Natives | LWJGL 等本地库 DLL，需解压到独立目录并通过 `-Djava.library.path` 指定 |
| assets | 游戏资源（贴图/声音/语言），按 SHA1 分片存放于 `assets/objects` |
| LAN 世界 | 单人游戏内"对局域网开放"，在随机端口提供 TCP 服务 |
| 房间 | 本启动器的联机会话（房间号/邀请码/成员/地址/状态） |
| 中继（relay） | 无法 P2P 直连时转发流量的服务器 |
| 受管参数 | 由启动器生成并去重的参数（`-Xmx`、`--width` 等），不允许用户在高级参数里重复 |
| 产品级人日 | 1 名熟悉 MC 启动链路的工程师 1 天，含自测，不含 QA/设计 |

## 附录 H. 变更记录

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| 1.0 | 2026-10-21 | 首版：PCL2 功能矩阵、P0 六项+前置、可复现验收、本轮非目标、风险/待决 | planner |
| 1.1 | 2026-10-21 | 按 t2 合规裁定修订：①证据来源措辞改为"GitHub 目录树（仅路径，未读内容）"，新增 `clean-room-log.md` CR-001；②命名/主色/劝导文案的 clean-room 约束（§1.3-6、§7.3）；③CurseForge API 明确不接入（CF 仅本地 zip + 打开项目页），Modrinth 为 P1 唯一平台候选；④微软登录标注 P1 + Azure/MCE 审批依赖（Q10） | planner |
| 1.2 | 2026-10-21 | 按 captain 实际任务 t5–t16 重划 P0：新增 P0-7（微软设备码/Authlib/多账户）、P0-8（模组/资源包/光影 + 整合包导入）、P0-6 隧道降级、P0-0 UI/主题、P0-1 inheritsFrom/dry-run；P0 成本 90→164，P1 144→80，总计 301→311；默认镜像优先/重试 3 次/并发可配；Modrinth 为 P0 唯一平台，P0 不接 CF API（P1 按 02 前置条件）；Q11 记录"导入不含加载器安装" | planner |
| 1.3 | 2026-10-21 | 按 t6 真实机验证校准文档口径：①自动进服改为 1.20+ `--quickPlayMultiplayer host:port`、≤1.19 `--server/--port`（1.20.1 `Main.class` 无 `--server`），同步 R6.6/步骤 8/A6.4/§3.4/§4.5/F28/F40；②R5.2 明确游戏捕获日志 `$DATA\logs\game\<dirName>\<yyyyMMdd-HHmmss>.log`、`[stdout]/[stderr]` 标注、与游戏自身 `latest.log` 区分；③A3.4 与 §7.6 的 Java 错误码统一为 `JAVA.NOT_FOUND`/`JAVA.INVALID`。影响任务：t6（实现依据）、t9（联机进服）、t10（UI 文案/日志页）、t12（验收断言）、t21（本次对齐） | architect |
| 1.4 | 2026-10-21 | 按 captain 裁定把「拖拽文件安装」统一降为 P1：P0 只保留「选择文件安装 + 打开实例目录」。改 P0-8 摘要、F31–F33、R8.2、验收步骤 3、A8.2、§5.10 冒烟第 12 步、§5.9「明确不要求」；F57 注明拖拽安装=P1（依赖文件关联/DnD）。原因：t26 时用户未要求（**2026-10-21 14:26 用户明确要求「拖拽安装 + 一键启动」，见 1.5**），且 01 内部 F31–F33/R8.2（P0）与 F57（P1）自相矛盾；PCL 日志证明拖拽整合包存在，当时保留 P1。影响任务：t15/t16（当时按 P0 不做 Dropzone 处理） | architect |
| 1.5 | 2026-10-21 | 按用户明确选择「拖拽安装与一键启动」两件都要：①**拖拽安装恢复为 P0**（P0→P1→P0 的来回原因：t26 基于“用户未要求”降 P1；用户随后明确要求，故恢复）。改 P0-8 摘要、F31–F33、R8.2、验收步骤 3、A8.2、§5.10 冒烟第 12 步；F57 改为只保留快捷方式/文件关联/单实例 P1，拖拽整合包归 P0-8；②新增 **§5.1.1 一键启动（P0 跨卡）**：主页单一主按钮按 instance→java→auth→launch 一气呵成，失败才展开详情；写清依赖模块与「无实例/无 Java/未登录/版本损坏」四个失败分支；§5.10 第 4 步改为“一次点击启动”。影响任务：t15/t16（拖拽 P0）、t10/t11（主页一键启动与错误分支）、t12（验收） | architect |
| 1.6 | 2026-10-21 | 修正 QA B8 的 A1.3/A1.4 上游数值笔误（以 `docs/05` 的 `artifact-facts.txt` 为准）：A1.3 资源索引 SHA1 改为 `8a45c6be…b0649`；A1.4 `totalSize` 改为 `651,728,646`（磁盘去重 `651,496,644`）；同步 §0.4 第 3 条与附录 B 的下载足迹。**不改验收口径**：产品若与上游哈希不符仍判失败 | planner |

---

**文档结束**。下游文档引用约定：`01-requirements.md#5-p0-范围与可复现验收`、`#6-本轮非目标`。

## 附录 I. 游戏进程环境变量白名单（t53）

游戏 Java 进程不继承全量 `process.env`，`cleanEnvironment()` 只发送以下白名单键（并再次排除 `MCL_*`、`*_OPTIONS`、`CLASSPATH`）：

`PATH`、`Path`、`PATHEXT`、`SystemDrive`、`SystemRoot`、`windir`、`ProgramData`、`ProgramFiles`、`ProgramFiles(x86)`、`CommonProgramFiles`、`CommonProgramFiles(x86)`、`PUBLIC`、`APPDATA`、`LOCALAPPDATA`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`USERNAME`、`USERDOMAIN`、`COMPUTERNAME`、`LOGONSERVER`、`SESSIONNAME`、`NUMBER_OF_PROCESSORS`、`PROCESSOR_ARCHITECTURE`、`PROCESSOR_IDENTIFIER`、`PROCESSOR_LEVEL`、`PROCESSOR_REVISION`、`TEMP`、`TMP`、`OS`、`LANG`、`LC_ALL`、`TZ`。

`LaunchPlan.env` 同样只含该白名单；任何 API key/refresh token/数据根变量都不会出现在 plan 或子进程环境。EasyTier sidecar 走独立的 `installerEnvironment()` 白名单，仅额外注入 `ET_NETWORK_SECRET`。

