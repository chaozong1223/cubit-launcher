# 源码使用与隔离记录（LIC-02 / LIC-07 / LIC-13 / LIC-14）

> 目的：记录 PCL / HMCL 源码的接触与隔离，证明实现依据来自**行为规格 + 公开规范 + 黑盒行为**，而不是把 PCL 代码搬进项目。规则与裁定以 `02-compliance-security.md` §2/§10.3 为准；本文件只记录事实，冲突时以 02 为准。
>
> **2026-10-21 改判口径（LIC-13~20）**：PCL 源码**可以读**，但只允许**规格作者**读；读前/读后在本文件登记；产出只能是 `docs/specs/pcl-<module>.md` 行为规格；**实现者不得读 PCL 源码**、不得抄结构/命名/注释/资源。HMCL 为 GPL-3.0，**可以移植**，但须保留版权头 + NOTICE + 衍生 GPL + 改名/版本区分 + 保留版权声明（§10.3.3）。

## 1. 项目级承诺（所有模块适用）

| # | 承诺 | 依据 |
|---|---|---|
| C1 | **不复制、不移植 PCL 源码/资源/字符串表**；PCL 源码只由**规格作者**阅读并产出行为规格；实现者不读 PCL 源码 | 02 LIC-02/03/13/16 |
| C2 | 行为/规格证据来源：运行中的 PCL 二进制（UI/日志/落盘文件/进程命令行）、用户本机数据（`E:\MC\PCL`、`E:\MC\.minecraft`）、公开规范（Mojang 元数据、平台 API 文档、BMCLAPI apiDoc）、**规格作者产出的 `docs/specs/pcl-*.md`** | 02 LIC-01 |
| C3 | 目录树/源码阅读仅用于功能枚举与行为规格；规格只写行为事实（接口形状/参数/格式/状态机/错误分类/进度阶段），不写逐行伪代码/命名/注释/结构映射；实现依据为规格，不引用源码表达 | 02 LIC-02/15 |
| C4 | 本产品名称**不以 `PCL` / `Plain Craft Launcher` 开头或包含**；不使用龙腾猫跃的头像/名称；不使用 Minecraft 官方 Logo 作应用图标 | 02 LIC-06 |
| C5 | 界面主色**不使用 PCL 蓝**；视觉/信息架构自建，不做 1:1 复刻 | 02 LIC-03/LIC-06 |
| C6 | 正版购买/赞助劝导**文案自写**，不复刻 PCL 的劝导原文；不提供"离线进正版服"的任何提示或工具 | 02 MC-09 |
| C7 | 不使用 PCL 的图标/背景/音乐/皮肤资源；不复制其 XAML 结构与 UI 文案原句 | 02 LIC-03 |
| C8 | 读取用户 PCL 目录仅只读、不写回、不移动、不删除；UI 不宣称"PCL 官方兼容/合作" | 02 LIC-05 |
| C9 | HMCL 代码可在 GPL-3.0 下移植：保留版权头、NOTICE、衍生仍 GPL-3.0、分发提供源码、标注修改、改名/版本区分、保留软件内版权声明；不使用 HMCL 商标/Logo/资源 | 02 LIC-17/18/19 |
| C10 | 角色隔离：规格作者读 PCL 源码后**不得实现对应模块**；实现者不得读 PCL 源码；每次阅读登记（时间/作者/文件/目的/规格路径/是否复制） | 02 LIC-13/14/20 |

## 2. 模块记录

| ID | 日期 | 模块/文档 | 参考来源（逐条） | 看了什么 | 是否接触过 PCL 源码内容 | 结论 | 记录人 / 复核人 |
|---|---|---|---|---|---|---|---|
| CR-001 | 2026-10-21 | `01-requirements.md`（需求与范围、功能矩阵、P0 验收） | ① `E:\MC\PCL` 的 `Setup.ini`、`Log1..5.txt`、`LatestLaunch.bat`（用户数据，只读；读取内容用于行为分析）、`authlib-injector.jar`/`JavaWrapper.jar`（仅文件名/大小）；② `E:\MC\.minecraft\versions` 的目录、版本 JSON、`PCL\Setup.ini`/`config.json`（用户数据，只读）；③ `Plain Craft Launcher 2.exe` 的只读字符串扫描（运行产物）；④ GitHub 仓库 `Meloong-Git/PCL` 的**目录树**（`Plain Craft Launcher 2/Pages/**`、`Modules/**` 的路径名）；⑤ `LTCatt/PCL2Help`（PCL 内置帮助文档库，CC0-1.0）；⑥ Mojang/BMCLAPI 端点探测 | 仅目录/文件**名**、日志文本、落盘文件、可执行文件字符串、公开文档与端点响应 | **否**。未打开任何 `.vb/.xaml/.resx/.png/.ico/.wav`；未读取仓库文件内容；**只看了树，没看内容** | clean-room 合规；目录树仅用于功能枚举；实现依据可追溯到黑盒行为/公开规范 | planner / *待 reviewer 复核* |
| CR-002 | 2026-10-21 | 启动链 / Java 检测 / 进程与日志（t6 实现） | ① 本机 `E:\MC\.minecraft\versions\**\*.json`、`runtime\**\bin\java.exe`（用户数据，只读；作为互操作夹具与探测对象）；② 公开 `client.json` 格式说明（Minecraft Wiki 的 gamixo 镜像，2026-06-25 缓存；只取字段结构、rules 语义、natives/arguments 布局）；③ `java -XshowSettings:properties -version` 的公开输出格式（运行产物）；④ 按公开格式手写的 Forge / Fabric / legacy 夹具（自建，不含任何 PCL 内容） | 版本 JSON 字段、rules/natives/arguments 结构、Java 属性行；未读取任何 PCL 文件内容，未参考 PCL `Setup.ini`/`Log*.txt` | **否**。t6 全程未打开 `E:\MC\PCL` 下任何文件，未访问 PCL 仓库 | clean-room 成立；实现依据为公开格式 + 用户数据只读互操作 + 自建夹具 | core-dev / *待 reviewer 复核* |
| CR-003 | 2026-10-21 | 项目级（PCL / HMCL 许可重核，t37） | ① `Meloong-Git/PCL` 根 `LICENCE`（sha `ae3dd050…`，1,360 B）全文；② 其引用的《PCL 分发有限许可》原文（shimo.im/docs/rGrd8pY8xWkt6ryW，2026-06-18 修订版，2026-10-21 抓取）；③ `HMCL-dev/HMCL` 的 `LICENSE`（GPL-3.0，35,149 B）、README 的 Additional terms、`Launcher.java` 版权头；④ PCL `Modules/**` 与 HMCL `HMCLCore/**` 的**目录/文件名单**（仅枚举） | 许可证/README 全文；PCL 模块文件名（`ModLaunch.vb`、`ModDownload.vb`、`ModSecret.vb` 等）；HMCLCore 目录名（`auth/download/game/java/launch/modpack/task/util`）；**未打开任何 PCL `.vb/.xaml/.resx` 内容** | **否**（本次未读 PCL 源码内容；仅读许可证/README 与文件名）。此前项目只对 PCL 做目录级 clean-room；**HMCL 从未被使用/复制/移植**（仓库仅注释提及 HMCL，无代码） | PCL：阅读可由规格作者进行，但代码不得复制/移植/分发衍生；大范围参考有重度使用风险（§10.3.2/10.3.6）。HMCL：GPL-3.0 + §7 附加条款，可移植（§10.3.3）。本记录不改变“此前未使用 HMCL”的事实 | architect / *待 reviewer 复核* |

## 3. 后续模块记录（待各模块 owner 补充）

> 每个模块在 DoD 前必须新增一行；"接触过 PCL 源码的人不得实现对应模块"（02 LIC-07）。

| 模块 | 计划记录时机 | Owner |
|---|---|---|
| 客户端骨架/IPC/UI（t5） | 提交前 | client-dev |
| 安装/下载（t6+） | 提交前 | install-dev |
| 启动链路/Java/账户/日志（t6+） | 提交前 | core-dev |
| 联机（t4/P0-6） | 提交前 | net-dev |
| PCL 行为规格（t15/t16 如使用） | 每次阅读前登记；规格评审后 | architect（规格作者）/ reviewer |
| HMCL 移植（如使用） | 每个文件/PR 前 | 实现者 / reviewer |
| 文档/验收 | 每版文档定稿 | planner / qa |

## 4. 2026-10-21 许可重核与阅读登记（t37）

### 4.1 裁定摘要（详细条款见 02 §10.3）

- **PCL**：`LICENCE` 是《PCL 分发有限许可》的指针 + 《合理使用指南》；分发许可只授权**原样副本**的存储/镜像/再分发（非以软件为收费主体），**不授权修改/衍生/源码并入**。源码**可读**（用户 2026-10-21 授权），但只允许规格作者读、产出行为规格；代码不得复制/移植/分发衍生。大范围参考重实现实质功能可能触发「重度使用」义务（改名 PCL、蓝色、开源同指南、正版劝导），需按 02 §10.3.6 升级。
- **HMCL**：`HMCL-dev/HMCL`（与 `huanghongxun/HMCL` 同源）为 **GPL-3.0**；README 另有 GPLv3 §7 附加条款（修改后分发须改名/改版本以区分；不得移除软件内版权声明）。**可移植**，按 02 §10.3.3 八条履行；HMCL 的 Logo/图标/字体/资源/第三方 jar 不在 GPL 代码授权内。

### 4.2 本次实际阅读（PCL 源码内容：未读）

| 日期 | 作者 | 仓库/版本 | 文件或目录 | 目的 | 产出规格 | 是否复制 | 复核 |
|---|---|---|---|---|---|---|---|
| 2026-10-21 | architect | `Meloong-Git/PCL` main（2026-10-20 push） | 根 `LICENCE`（sha `ae3dd050…`） | 核对许可证原文 | 02 §2.1/§10.3.2 | 否（仅引用） | 待 reviewer |
| 2026-10-21 | architect | shimo.im `rGrd8pY8xWkt6ryW`（2026-06-18 修订版） | 《PCL 分发有限许可》全文 | 核对其“原样副本”授权范围 | 02 §10.3.2/A.12 | 否（仅引用） | 待 reviewer |
| 2026-10-21 | architect | `HMCL-dev/HMCL` main（2026-10-20 push） | `LICENSE`、README、`HMCL/src/main/java/org/jackhuang/hmcl/Launcher.java` 头 20 行 | 确认 GPL-3.0 + §7 条款、版权头 | 02 §10.3.3/A.13 | 否（仅引用） | 待 reviewer |
| 2026-10-21 | architect | `Meloong-Git/PCL` | `Plain Craft Launcher 2/Modules/**`、`Modules/Minecraft/**` 的**文件名清单** | 给“可读/别碰”清单提供准确路径 | 02 §10.3.5 | 否（仅文件名） | 待 reviewer |
| 2026-10-21 | architect | `HMCL-dev/HMCL` | `HMCLCore/src/main/java/org/jackhuang/hmcl/**` 目录名 | 给可移植清单提供准确路径 | 02 §10.3.5 | 否（仅目录名） | 待 reviewer |

> **结论**：本次没有打开任何 PCL `.vb/.xaml/.resx` 内容，也没有复制/移植 HMCL 代码；仓库中此前只有注释提及 HMCL（`src/shared/java.ts` 的“HMCL-style”），**无 HMCL 代码**。

### 4.3 此前状态（供审计）

- 项目此前只对 PCL 做**目录级 clean-room**（CR-001/CR-002：只看了树/文件名单，未读内容）；
- **HMCL 从未被使用、复制或移植**；本次之前也没有 HMCL 相关实现依据；
- 本次改判后，若后续要读 PCL 源码，必须按 §4.4 登记并产出规格，且**规格作者不得实现对应模块**。

### 4.4 后续阅读登记模板（强制）

| 日期 | 作者 | 仓库/commit | 文件（精确到路径） | 要回答的行为问题 | 产出规格路径 `docs/specs/pcl-*.md` | 是否复制（必须否） | 实现者（未读源码） | 复核 |
|---|---|---|---|---|---|---|---|---|

规则：
1. **一问题一登记**；单次阅读 ≤2 个文件；超过 3 个文件或整文件通读 → 先报 captain/法务（02 §10.3.6）。
2. 规格只写行为白名单（接口形状/参数/格式/状态机/错误分类/进度阶段），禁止逐行伪代码、命名、注释、结构映射。
3. 规格作者与实现者必须是不同人；实现者 PR 必须声明“未读 PCL 源码”。
4. 发现实现者读源码/复制表达 → 按 02 §2.5 taint 处置，并在本文件记录事件。

## 5. 变更记录

| 版本 | 日期 | 变更 | 作者 |
|---|---|---|---|
| 0.1 | 2026-10-21 | 首建：C1–C8 承诺 + CR-001（01 需求文档） | planner |
| 0.2 | 2026-10-21 | 新增 CR-002（t6 启动链/Java/日志：公开格式 + 本机数据只读 + 自建夹具） | core-dev |
| 0.3 | 2026-10-21 | t37 许可重核：PCL 源码改为“规格作者可读、实现者不可读、只产出行为规格”，代码仍禁止复制/移植；HMCL 确认 GPL-3.0 + §7，可移植；新增 C9/C10、CR-003、§4 阅读登记与模板；记录此前只对 PCL 做目录级 clean-room、HMCL 从未使用 | architect |
