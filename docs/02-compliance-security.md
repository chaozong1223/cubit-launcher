# 02 · 许可证/合规与信任边界基线

**Status**: v0.3 · 2026-10-21 改判（PCL 源码可读、HMCL GPL 可移植），结论已写回，可直接转工程约束
**Author**: architect（🏛️ 软件架构师 / 🛡️ 安全架构师）  **Date**: 2026-10-21  **Version**: 0.3
**Scope**: 任务 t2/t37。为 `01-requirements.md`（范围/验收）与 `03-architecture.md`（架构/安全基线）提供**法律边界与信任边界**，并把结论落成可执行的工程约束。
**免责**: 本文是工程合规判断，**不是法律意见**。标注「需法务」的条目必须在对外发布前取得书面结论（§10.2）。

> **v0.3 变更（用户 2026-10-21 补充裁定）**：PCL **源码可以读**（此前只允许目录级观察），但阅读产出只能是**行为规格**、实现者不得读源码（双人隔离）；PCL **代码仍不得复制/移植/分发衍生**。HMCL 为 **GPL-3.0 + §7 附加条款**，**可以移植**（保留版权头、NOTICE、衍生仍 GPL-3.0、改名/版本区分、保留版权声明）。新增 **§10.3 第三方源码使用政策** 与 LIC-13~20；§2.2/§2.3/§2.4/§2.5 重写；§0 增至 18 条裁定。
>
> 阅读顺序建议：先看 §0 的 18 条裁定（够拍板）→ §10.3（够写规格/移植）→ §8 的约束总表（够写代码）→ 需要出处时再回 §2~§7 与附录 A。

---

## 0. 一页结论（18 条裁定）

| # | 问题 | 裁定 | 关键依据 | 约束 |
|---|---|---|---|---|
| 1 | 能否**参考 PCL2 的行为**（黑盒） | **可以**。行为/功能不受版权保护；只观察运行中的程序、日志、落盘文件 | 版权只保护表达；PCL LICENCE 约束的是「参考存储库**内容**」 | LIC-01 |
| 2 | 能否**复制/移植 PCL2 源码** | **不可以**。PCL 的《分发有限许可》只授权「原样副本」的存储/镜像/再分发，**不授权修改、衍生或把源码并入其它项目**；《合理使用指南》的重度使用义务也不适合本产品 | PCL `LICENCE` + 《PCL 分发有限许可》原文（见 §2.1/§10.3） | LIC-02/03/16 |
| 3 | 社区镜像 `tangge233/PCL2` 能否作准 | **不能**。它是 `Meloong-Git/PCL` 的 GitHub fork（API 的 `fork:true`/`parent` 可证），不是独立授权来源；许可证判断只认上游 | GitHub API 实测 | LIC-04 |
| 4 | 能否读取用户机器上 PCL 的目录/配置 | **可以（只读）**。属互操作与用户自有数据；**不得写回、不得复制其资源、不得暗示关联** | 著作权不保护文件格式与字段名；PCL LICENCE 不管辖用户数据 | LIC-05 |
| 5 | 能否再分发 Mojang 的**版本 JSON / 游戏文件** | **不能随包分发游戏文件**；版本 JSON 也**不进安装包**，一律运行时下载 + 本地缓存 | Minecraft EULA（不得再分发游戏或其部分）+ 最小暴露原则 | MC-10/11 |
| 6 | BMCLAPI 能不能用 | **能**，但有硬条件：**下载界面必须标明来源**、不得二次封装其协议、它是**非开源**服务且无 SLA/无赔偿 | BMCLAPI 官方 apiDoc「协议/关于」原文 | SRC-01~05 |
| 7 | Modrinth 能不能用 | **能**。必须唯一 `User-Agent`（含项目名/版本/联系方式）、遵守 300 req/min、直连 CDN 下载并校验 sha1+sha512、不自建转存 | Modrinth API 文档 + ToS「API Usage」 | API-01~06 |
| 8 | CurseForge 能不能内嵌 | **P1 接入、P0 不接**（用户裁定）。必须**自备官方 key**；key 不可披露 → 只能放后端 secrets，客户端/仓库零 key；同时受「禁缓存 API 数据」「禁代理隐匿身份」「禁做与 CF 竞争的产品」三条约束，接入前需法务对竞品条款出书面意见 | CurseForge 3rd Party API Terms 原文 + 用户裁定 | API-07~12、API-16~22 |
| 9 | EasyTier 能否用 | **能**（LGPL-3.0）。只作**独立进程**、不修改、不静态链接；附许可证与源码地址；固定版本 + 哈希校验 | GitHub license 实测 = LGPL-3.0 | NET-01~05 |
| 10 | frp / nps / ZeroTier | frp（Apache-2.0）可用但需自备服务端；nps（GPL-3.0，默认 `admin/123`）**不打包**；ZeroTier（源码可见、非商业许可）**禁止随产品分发** | 各自的 LICENSE / README 实测 | NET-06~11 |
| 11 | 微软账户怎么接 | 自建 Azure 应用（`consumers` 租户，public client，PKCE），**必须**申请 Minecraft API 权限（`aka.ms/mce-reviewappid`），否则 `api.minecraftservices.com` 返回 403。**用户已启动申请；P0 不依赖审批**：client_id 可配置，未获批时诚实报错（§3.1.1 给出获批后的端点/权限清单）。**禁止**冒用官方 client id、**禁止**导入其它启动器的 token | Minecraft Wiki(Microsoft authentication) + Microsoft 文档 + 用户裁定 | MC-01~06、MC-21~23 |
| 12 | 令牌怎么存 | 只持久化 MSA refresh token，经 Electron `safeStorage`（Windows=DPAPI）加密 + 用户级 ACL；access token 只在内存；**Linux `basic_text` 时拒绝持久化** | Electron safeStorage 文档 | SEC-AUTH-01~06 |
| 13 | 离线账户能不能做 | **能做**，但必须：独立账户类型、显式警告「需自备正版/仅本地与局域网」、启动前正版劝导、**不做任何伪造会话/绕过验证**、联机房间明示离线成员 | EULA 要求持有正版；产品风险最小化 | MC-05~09 |
| 14 | 第三方 jar 能不能跑 | authlib-injector：**可以**（AGPL-3.0 + 明确例外，允许未修改二进制打包/Java Agent 加载），但固定版本+SHA-256；PCL 的 `JavaWrapper`/`libjlw`：**不引入**（无公开源码、原生 DLL）；Forge/NeoForge installer：校验哈希 + 提示 + 临时目录 | authlib-injector `LICENSE`；本机 `E:\MC\PCL` 文件实测 | SEC-EXE-01~08 |
| 15 | 本地要开哪些端口 | 只允许 `127.0.0.1` + 临时端口 + 一次性 token/state；OAuth 回调用 PKCE+state；sidecar 管理面默认关闭或 loopback 鉴权；**任何服务不得绑 `0.0.0.0`** | RFC 8252 + 40-architecture §3.1/§6.9 | SEC-NET-01~10 |
| 16 | 我们自己的许可证 | **GPL-3.0**（GPLv3，用户 2026-10-21 裁定，非 Apache-2.0）：分发二进制须提供 Corresponding Source、不得附加冲突限制；依赖须 GPL-3.0 兼容（禁 GPL-2.0-only/CDDL/专有/SSPL/BSL）；LGPL 仅独立进程；AGPL 仅 authlib 例外。见 §6.6 兼容性复核 | 用户裁定 + FSF 兼容性 + 本文件 §6.6/§7.9 | LIC-09、LIC-11/12、SEC-SUP-01/09 |
| 17 | PCL 源码**能不能读**、读到什么程度 | **可以读**（用户 2026-10-21 明确授权；阅读本身不是复制/分发）。但只有**规格作者**读，产出只能是**行为规格**（接口形状/参数含义/文件格式/状态机/错误分类/进度阶段）；**实现者不得读源码**；禁止抄结构/命名/注释/资源。大量参考重实现实质功能仍可能触发 PCL 指南的「重度使用」义务，须按 §10.3 控制范围并在超范围时升级 captain/法务 | PCL `LICENCE`；著作权法一般原理；用户裁定 | LIC-13~16/20 |
| 18 | HMCL 代码**能不能移植** | **可以**。HMCL 为 **GPL-3.0**，另有 GPLv3 §7 附加条款：修改后分发须以合理方式改软件名或版本号以区分原版（§7(c)），且不得移除软件中显示的版权声明（§7(b)）。移植为 TS 属衍生：保留版权头、加 NOTICE、衍生仍 GPL-3.0、分发提供源码、标注修改；商标/Logo/资源不在 GPL 范围 | HMCL `LICENSE` + README「Additional terms」；Launcher.java 版权头 | LIC-17~19 |

> **2026-10-21 用户裁定（写回）**：Q2 原版下载 = **只做下载器**（官方源 + BMCLAPI；不分发游戏文件/Mojang 资源；无需额外法务动作，见 §3.6）；Q6 自身许可证 = **GPL-3.0**（见 §2.3、§6.6、§7.9）；Q7 微软登录 = **立即自建 Azure 应用并提交 MCE 审核，P0 不依赖审批**（见 §3.1.1、MC-21~23）；CurseForge = **P1 接入且自备官方 key**（见 §5.2、API-07~12/16~22）。
>
> **2026-10-21 补充裁定**：PCL **源码可读**（仅规格作者，产出行为规格；实现者不读；代码仍不可复制/移植/分发衍生）；HMCL 为 **GPL-3.0 + §7 附加条款，可移植**（八条义务见 §10.3.3）。

**三条红线（写进 PR 模板，违反即拒收）**

1. **实现者不读 PCL 源码**：只有规格作者可读，产出只能是行为规格（`docs/specs/pcl-*.md`）；实现者只读规格，禁止抄结构/命名/注释/资源。阅读记录必须进 `docs/clean-room-log.md`（LIC-13~16/20）。
2. **不把凭据交给第三方**：MSA refresh/access token 不出本机、不进日志、不进房间协议、不写进导出的错误报告（SEC-AUTH-05、SEC-LOG-01）。
3. **不执行未校验的二进制**：Java、authlib-injector、EasyTier、加载器 installer、自更新包，都必须「来源固定 + 哈希/签名校验 + 失败即失败」（SEC-DL-01、SEC-EXE-01）。

---

## 1. 方法与证据

### 1.1 取证方式

| 类别 | 做法 | 结果 |
|---|---|---|
| 许可证 | GitHub REST API `/repos/{owner}/{repo}` 的 `license` 字段 + `/license` 取全文（base64 解码） | 拿到 SPDX 判定与全文（PCL、EasyTier、frp、nps、ZeroTier、authlib-injector、Prism、Forge/NeoForge/Fabric） |
| 条款 | 直接抓官方文档页（BMCLAPI apiDoc、Modrinth docs、CurseForge Freshdesk、Microsoft Learn、Electron docs） | 原文摘录见附录 A |
| 实测 | 用本机 Node/PowerShell 打真实端点：`launchermeta.mojang.com`、`bmclapi2.bangbang93.com`、`api.modrinth.com` | 版本 JSON 哈希字段、Modrinth sha1/sha512 均实测 |
| 本机留存物 | `E:\MC\PCL` 只读枚举 + SHA-256 | `authlib-injector.jar`、`JavaWrapper.jar` 指纹见附录 A.4 |

### 1.2 取不到的源（必须知道结论的置信度）

| 目标 | 结果 | 处置 |
|---|---|---|
| `https://www.minecraft.net/en-us/eula`、`/usage-guidelines` | 本机网络 `ERR_CONNECTION_TIMED_OUT`（直连与浏览器渲染均失败） | EULA 只作**条款要点归纳**并标注「需法务核对原文」；Usage Guidelines 的**免责声明原文**改用第三方条款库的逐字引文（ConductAtlas，抓取于 2026-09-11，含原文与哈希）交叉验证 |
| `web.archive.org`、`r.jina.ai` | 同样超时 | 同上 |
| `docs.curseforge.com` 的 OpenAPI JSON | 超时（页面为 JS 渲染） | 使用 Freshdesk 上的**条款原文**与「Project Distribution Toggle」说明；API 字段级细节标记为「待接入时核实」 |

> 工程含义：**凡是依赖 Mojang 条款原文的判断，都必须在发布前由法务复核一次**（§10 Q1）。本文件其余结论（PCL 许可证、BMCLAPI、Modrinth、CurseForge、各组件 LICENSE）均为一手页面/API 实测，可直接作为工程依据。

### 1.3 与既有文档的关系

- `01-requirements.md` §1.1/§1.3 已写「clean-room、不复制代码、审查按 02 执行」——本文件是那份「02」。
- `40-architecture.md` §3.1 已定 Electron 安全基线（contextIsolation/sandbox/CSP/IPC 发送方校验/zip-slip/spawn 无 shell）——本文件**不重复**，只补齐它未覆盖的：令牌、下载完整性、第三方代码、监听面、供应链、合规。
- 冲突处理：若本文与 01/40 冲突，**以本文的合规红线为准**，并提 PR 修 01/40（§11.3 列了当前需要修的两处）。

---

## 2. PCL2 许可证：能做什么、不能做什么

### 2.1 一手事实

1. **仓库**：`Meloong-Git/PCL`，`license` 字段 = `{key:"other", spdx_id:"NOASSERTION"}`；根目录许可证文件名是 **`LICENCE`**（不是 `LICENSE`），SHA `ae3dd050edaf0c4f2bf50bf7b4d8d508319394f1`，1360 字节。
2. **它不是开源许可证**。根 `LICENCE` 顶部是《PCL 分发有限许可》的**指针**（shimo 链接），正文是《PCL 存储库合理使用指南》，并自我声明「本指南仅作为说明，不是法律文件或协议」，紧接着写「**除《PCL 分发有限许可》明确授予的权利外，开发者保留软件及其相关知识产权中的全部权利**」。
3. **两档使用**（原文要点）：
   - **轻度使用**：只参考「极小部分内容」，或做出的软件与 PCL **实质功能不存在重叠**。义务：①适当署名；②不得混淆/暗示与 PCL 有关（不得叫 `Potato Craft Launcher`、`PCL 手机版` 等）。
   - **重度使用**：基于仓库修改，或「参考存储库中**较大量的内容**，以制作或重新实现 PCL 的部分实质功能（例如启动或下载 Java 版 Minecraft，下载或管理 Mod 等）」。义务：①声明是第三方二次创作；②名称必须以 `Plain Craft Launcher (PCL)` 开头并加第三方后缀；③关于页首位给龙腾猫跃署名+赞助链接、**公开源代码**、**继续使用本文件作为指南**；④实现与 `McLaunchPrecheck` 一致的**正版购买劝导/赞助劝导**；⑤Windows 上不得有类似赞助解锁的表现（例如**界面主色必须是蓝色**）。
   - 结尾备注：「如果你只是参考了一小段代码，署个名就行啦」——**这是容忍度表述，不是授权条款**。
4. **镜像**：`tangge233/PCL2` 的 API 返回 `fork: true`，`parent`/`source` 都是 `Meloong-Git/PCL`，`license` 同样是 `NOASSERTION`。它是**派生副本**，不是独立授权；且可能滞后/被改动。**许可证结论只认上游**。
5. **子模块**：`.gitmodules` 只有一个 `MeloongCore`（`Meloong-Git/MeloongCore`，GitHub license = **Apache-2.0**，.NET 通用库）。它**只对那个子模块**有意义，不能反推主仓库；我们不用 .NET，天然不涉及。
6. **仓库里还有 `最新正式版.zip`（2.6 MB 二进制）**：没有授予再分发权，**不得随包或镜像分发 PCL 二进制**。
7. **《PCL 分发有限许可》不在仓库里，而在 `https://shimo.im/docs/rGrd8pY8xWkt6ryW`**（2026-06-18 修订版，2026-10-21 可访问）。原文关键句：
   - 「“软件” 是指 Plain Craft Launcher（以下简称 “PCL”）及许可方有权许可的相关源代码、二进制文件、资源文件、文档和随附内容。」
   - 「除本许可明确授予的权利外，许可方保留软件及其相关知识产权中的全部权利。」
   - 「在不以软件为收费主体的前提下，许可方授予您一项全球范围内、非排他、免版税、不得再许可的有限许可：您可以存储、镜像、备份、上传、下载、向公众提供、传播和再分发**原样副本**。」
   - **只授权「原样副本」**，没有修改权、没有衍生作品权、没有把源码并入其它项目的权利。

**法律定性（工程口径）**：PCL 是「source-available + 自定义限制」，默认著作权（全部权利保留）。**阅读源码本身通常不构成复制/分发**（用户 2026-10-21 已明确授权阅读）；但**复制表达**（代码、结构、命名、注释、资源）与**分发衍生代码**受许可证限制：分发许可只覆盖「原样副本」，不覆盖修改/衍生。其《指南》不是 OSI 许可证，也不构成对世授权；「重度使用」会要求一套与我们产品定位不兼容的义务，因此阅读必须按 §10.3 做范围控制与角色隔离。

### 2.2 三档判定：我们落在哪一档

| 情形 | 触发条件 | 义务 | 我们是否采用 |
|---|---|---|---|
| A. 轻度使用 | 参考极小部分，或功能不重叠 | 署名 + 不混淆 | 不单独采用；作为兜底声明 |
| B. 重度使用 | 修改仓库，或「参考存储库中较大量的内容」重实现启动/下载/Mod 管理等实质功能 | 改名 `PCL ...`、开源、同指南、正版劝导、蓝色主色 | **明确拒绝**（等于把产品交给别人的许可证） |
| C. **规格隔离阅读（source-read spec）** | 规格作者读 PCL 源码，只为回答具体行为问题，产出行为规格；实现者只读规格、不读源码；不复制表达 | 记录阅读痕迹；规格只含行为事实；无表达复制；控制阅读范围 | **采用 C**（用户 2026-10-21 授权阅读；见 §10.3） |

**结论**：

- **能读**：用户已明确授权；阅读本身通常不构成复制/分发。但 PCL 指南把「参考较大量的内容重实现实质功能」定义为**重度使用**——即使不复制文本，若规格本质上是整模块源码的转述，仍可能触发 B 档义务。因此阅读必须**按问题限定范围**，规格只写行为事实（§10.3.4），超范围升级 captain/法务。
- **不能复制/移植表达**：代码、结构、变量命名、注释、UI 文案、资源一律不抄；「把 VB.NET 逐行翻译成 TypeScript」是典型衍生作品，禁止。
- **不能分发 PCL 衍生代码**：分发许可只授权「原样副本」；没有修改/衍生授权。
- **HMCL 是另一条路**：GPL-3.0 允许移植，按 §10.3.3 履行义务即可（保留版权头、NOTICE、衍生 GPL、改名/版本区分、保留版权声明）。

### 2.3 源码使用与隔离规程（强制）

| ID | 约束 | 验证方式 | 责任 |
|---|---|---|---|
| **LIC-01** | 实现依据只允许来自：①运行中的 PCL 二进制（UI/日志/落盘文件/进程命令行）；②`E:\MC\PCL` 与 `E:\MC\.minecraft` 的用户数据；③公开规范（Mojang 元数据、各平台 API 文档、BMCLAPI apiDoc）；④**规格作者**从 PCL 源码提炼的**行为规格**（`docs/specs/pcl-*.md`）。实现者不得把 PCL 源码内容直接作为依据 | 每个模块 PR 的「参考来源」栏逐条列出；reviewer 抽查规格与实现 | 全员 / reviewer |
| **LIC-02** | PCL 源码**只允许规格作者阅读**；读前在 `docs/clean-room-log.md` 登记（时间/作者/文件或目录/目的），产出只能是行为规格；**实现者不得打开 PCL 源码**；禁止复制源码片段、结构、命名、注释、资源；仓库中不得出现 PCL 源文件副本 | clean-room log 有阅读条目与规格路径；实现者 PR 无 PCL 源码接触记录；CI 检查无 PCL 源文件 | architect / reviewer |
| **LIC-03** | 禁止出现与 PCL 相同或近似的：标识符命名体系（如 `ModLaunch`/`ModDownload` 作为我们模块名）、变量命名/注释/文档结构、UI 文案原句、图标/背景/音乐资源、XAML 结构、配置键名的**成组复制**。允许的键名仅限「互操作必需」的少量字段（如 `Setup.ini` 的读入映射），且只读 | 代码评审 + 字符串/结构相似度抽查；`grep` 关键词黑名单（附录 A.5） | reviewer |
| **LIC-04** | 许可证判断只引用上游 `Meloong-Git/PCL`；任何「镜像/ fork 说它 MIT/Apache」的说法一律不采信 | 本文件 + 复核记录 | architect |
| **LIC-05** | 读取用户已有 PCL 目录必须：只读、失败不阻塞、不写回、不移动、不删除；UI 注明「兼容 PCL 目录格式（只读）」；不得宣称「PCL 官方兼容/合作」 | 集成测试：对 15 个实例做只读扫描后校验 mtime/哈希不变（01 文档 P0-0 已要求） | core-dev / qa |
| **LIC-06** | 产品名、图标、关于页、安装包元数据中不得出现 `PCL`、`Plain Craft Launcher`、龙腾猫跃的头像/名称；不得使用 Minecraft 官方 Logo 作为应用图标 | 发布检查清单 + 安装包资源审查 | client-dev / architect |
| **LIC-07** | 建立 `docs/clean-room-log.md`：每模块记录（日期/模块/参考来源/是否接触过 PCL 源码/复核人）；**PCL 源码阅读必须逐次登记**（时间/作者/文件或目录/目的/产出规格路径）；**读过源码的规格作者不得实现对应模块**；实现者读源码按 §2.5 污染处置 | 每模块 DoD + 阅读记录完整；reviewer 抽查 | 全员 / reviewer |
| **LIC-08** | 代码评审增设「源码使用检查」三项：①是否出现 PCL 源文件片段/结构/命名/注释；②命名/文案是否成组相似；③实现依据是否能追溯到公开规范或 `docs/specs/pcl-*.md`（且规格未含源码表达） | PR 模板勾选 | reviewer |
| **LIC-09** | 本项目代码采用 **GPL-3.0（GPLv3）**（用户裁定；若未来要改 `or-later` 须 captain 决策并通知下游），仓库根放 `COPYING`（GPLv3 全文）+ `NOTICE` + 每个源文件 SPDX 头；**对外分发二进制时必须提供 Corresponding Source**（公开仓库 tag + 构建脚本 + 依赖安装说明），且不得附加与 GPL-3.0 冲突的额外限制 | 仓库 `COPYING`/`NOTICE`；发布页源码链接；CI 校验 SPDX | architect |
| **LIC-10** | 发布物附 `THIRD-PARTY-LICENSES.txt`（自动生成 + 人工复核），覆盖 Electron/React/Node 依赖与随包二进制（若有） | 发布脚本产出 + 人工签字 | architect / qa |
| **LIC-11** | 第三方依赖必须与 GPL-3.0 兼容：允许 MIT/BSD-2/3/Apache-2.0/ISC/0BSD/MPL-2.0/LGPL-3.0（仅独立进程）；**禁止** GPL-2.0-only、CDDL、EPL-1.0、专有、SSPL、BSL、Commons Clause；AGPL-3.0 **仅** authlib-injector（其例外条款），其余 AGPL 一律禁止 | CI 许可证清单 + 人工复核（SEC-SUP-01） | architect |
| **LIC-12** | 商标与许可证分离：GPL-3.0 **不授予商标权**，产品名/图标/域名另受 LIC-06 与 MC-15 约束；用户协议不得限制用户对 GPL 代码的复制/修改/再分发，也不得把 GPL 代码与「不得商用」捆绑 | 法务复核 + 用户协议评审 | architect |

### 2.4 阅读源码后的边界（2026-10-21 改判）

- **阅读不等于复制**：理解行为、跑通流程、看错误处理分支，通常不构成复制/分发；用户已明确授权阅读。
- **但 PCL 指南看的是「参考量」**：若规格作者把整个 `ModLaunch.vb` / `ModDownload.vb` 的行为逐条转述，规格虽不含代码，仍可能被认定为「参考较大量的内容，以制作或重新实现 PCL 的部分实质功能」→ 触发重度使用义务（改名 PCL 前缀、蓝色主色、开源同指南、正版劝导）。**这不是版权侵权，而是许可证/容忍条件风险**。
- **因此**：阅读必须按**具体行为问题**限定（例如“1.20+ 进服参数怎么选”“natives 何时解压”），规格只写行为事实（§10.3.4）；不得把源码结构原样映射成模块/类/函数结构；不得整文件通读后写“逐段规格”。超范围时按 §10.3.6 升级 captain/法务。
- **表达层独立**：即使行为来自 PCL，UI 布局、文案、图标、命名必须自建；不得 1:1 复刻（LIC-03）。
- **关于“独立实现”声明**：不再声称“未读过 PCL 源码”；如实写“行为规格由独立规格作者基于源码/黑盒行为编写，实现者未读 PCL 源码，未复制源代码”。不要放在关于页首位（避免暗示关联）。

### 2.5 污染处置预案（taint）

区分两种接触：

| 情形 | 判定 | 处置 |
|---|---|---|
| 规格作者读源码、写行为规格，未实现该模块 | **允许**（不构成污染） | 记录阅读；规格归档；该模块由未读源码的实现者写 |
| 实现者读了 PCL 源码（无论是否复制） | **污染** | 该模块停止合并；由未读源码的人按规格重写；记录 taint 事件 |
| 出现 PCL 代码/结构/命名/注释/资源片段 | **污染 + 侵权风险** | 立即删除/重写；reviewer 全量扫同模块；必要时法务评估 |
| 阅读范围过大（整模块转述） | **重度使用风险** | 按 §10.3.6 升级 captain/法务；二选一：收缩规格范围，或接受 B 档义务（改名 PCL、蓝色、同指南） |

若确认污染：①在 `clean-room-log` 标记模块+文件+接触人；②停止合并；③未接触者按规格重写（不是“改一改”）；④按 §2.3 三项检查复核；⑤无法重写则移除功能或整体转 B 档（captain 书面决策）。

### 2.6 用户数据与互操作（回应 01 文档 Q8 / 10 文档 Q8）

- 读取 `PCL\Setup.ini`、`config.json`、`versions\<id>\PCL\Setup.ini` 属于**互操作**：文件格式与字段名是实现互操作所必需的事实，一般不受著作权保护；PCL 的 LICENCE 规范的是「软件/存储库」，不是用户磁盘上的数据。
- 边界：**只读**、**不复制其默认配置模板/文案**、**不在我们 UI 中复刻其设置项命名体系**（例如不要把 `LaunchArgumentIndieV2` 这类内部键原样暴露给用户；读入后映射到我们自己的模型）。
- 不要做「导入 PCL 配置 → 写回 PCL 配置」的双向同步（既不礼貌，也会造成数据损坏风险）。

---

## 3. Mojang / Microsoft 边界

> 前提：Mojang **没有**公开的「第三方启动器许可」文本。社区实践（MultiMC/Prism/HMCL/PCL）长期存在，但合规依据只能落在三处：Minecraft EULA、Minecraft Usage Guidelines、以及「不复制/不再分发游戏文件」。因此本节结论按「最小暴露 + 可关闭」设计。

### 3.1 账号与认证（微软）

**事实（一手/社区权威文档）**：

- 需要**自建 Azure 应用**（OAuth 2.0 client id，public client，无 client secret）；scope 必须含 `XboxLive.signin`（可加 `offline_access` 拿 refresh token）。
- **必须使用 `consumers` 租户**；用 `common` 或租户 ID 会报错；这意味着**只能登录消费者 MSA，不能登录组织账号**。
- 新建 Azure 应用要调用 `api.minecraftservices.com`，**必须先申请 Minecraft API 权限**（`https://aka.ms/mce-reviewappid`）；未获批时接口返回 **403**（Minecraft Wiki 明确写了这一点）。
- 令牌链：MSA access → XBL（`user.auth.xboxlive.com`，`RpsTicket: "d=<msa_access>"`，NotAfter 约 14 天）→ XSTS（`xsts.auth.xboxlive.com`，`RelyingParty: rp://api.minecraftservices.com/`）→ Minecraft（`login_with_xbox`，返回 `expires_in: 86400`）→ 所有权校验（`/entitlements/mcstore`）→ profile（`/minecraft/profile`）。
- 所有权校验返回的 JWT **应用 Mojang 公钥验签**（Wiki 给了公钥），不要只看 `items` 非空。

**工程约束**：

| ID | 约束 | 验证 |
|---|---|---|
| **MC-01** | 使用自建 Azure 应用；`client_id` 可配置（构建期注入 + 运行期覆盖仅限开发）；**禁止**使用 Mojang/其它启动器的 client id；**禁止**内置 client secret（public client 不存在 secret） | 代码审查 + 打包产物字符串检查 |
| **MC-02** | 登录只走**官方登录页**：authorization code + PKCE(S256) + `state`，回调用 `http://127.0.0.1:<临时端口>/callback`；或 device code（需在应用注册里允许 public client flow）。绝不在自有 UI 收集 Microsoft 密码 | 手工 E2E + 抓包确认密码字段不存在 |
| **MC-03** | 上线前必须完成 `mce-reviewappid` 申请；未获批时 UI 明确提示「正版登录不可用」而不是反复 403；申请材料准备列为**发布前置项**（lead time 以周计） | 申请回执 + 预发环境验证 |
| **MC-04** | **禁止**「导入其它启动器 token」「共享账号 cookie」「代登录」；切换账号必须重新走 OAuth。用户要换号就重新登录——这是合规也是安全 | 代码中不存在 token 导入路径；review |
| **MC-05** | 每次启动前对 MSA 账户做 `/entitlements/mcstore` 检查；无所有权 → 拒绝启动并给购买链接（与 PCL 的 `McLaunchPrecheck` 精神一致，但文案独立）。离线账户不适用此检查 | E2E：无所有权账号 → 拒绝 + 链接 |
| **MC-06** | profile 的 JWT 用内置公钥验签；验签失败视为不可信响应，降级为「读取失败」而不是「放行」 | 单测：篡改 JWT → 拒绝 |
| **MC-21** | **P0 不依赖审批**：未配置 `client_id` 时，MSA 登录入口显示「未配置 / 待审批」并禁用（不报错弹窗）；已配置但接口 403 时，错误文案明确「应用未获 Minecraft API 授权（待审批）」；**不得**重试风暴、**不得**静默降级成离线 | E2E（未配置/403 两种）+ 单测 |
| **MC-22** | 按 §3.1.1 的 Azure 配置与 8 步端点链接线，错误按 §3.1.1 的表映射；所有端点/错误码集中在 `src/main/modules/auth/msa/endpoints.ts`，审批通过后逐条核对；请求 `User-Agent` 标识产品名+版本 | 单测（错误映射）+ 端点清单核对 |
| **MC-23** | Azure 配置全部来自 `auth.msa.*`（`clientId`、`tenant=consumers`、`redirect=loopback`）；**不存在** `clientSecret` 字段；构建产物与仓库不含任何 secret | 打包产物字符串检查 + secret 扫描 |

#### 3.1.1 获批后需要接线的权限与端点清单（照此实现）

**权限与 Azure 应用配置（申请时一次配好）**

| 项 | 配置 |
|---|---|
| 账户类型 | 「仅个人 Microsoft 账户」（`consumers` 租户）；组织账号不支持 |
| 平台/重定向 | 平台选「移动和桌面应用」；重定向 URI 用 `http://localhost`（loopback，允许任意端口）或 `http://127.0.0.1:<固定端口>`；若门户不接受动态端口，则固定端口 + 冲突时回退 device code |
| 客户端类型 | **public client**；不创建 client secret；只有用 device code 回退时才勾选「允许公共客户端流」 |
| scope | `XboxLive.signin offline_access`（如需 id_token 再加 `openid profile`） |
| Minecraft API 权限 | 提交 `https://aka.ms/mce-reviewappid`（说明启动器用途、隐私政策 URL、联系邮箱、预计调用量）；获批后 `api.minecraftservices.com` 才不再 403 |
| 可配置项 | `auth.msa.clientId` / `auth.msa.tenant=consumers` / `auth.msa.redirect`（默认 loopback）/ `auth.msa.enabled`（feature flag） |

**端点链（按顺序实现，任何一步失败即中止并给出可读错误）**

| # | 端点/操作 | 关键参数 | 说明 |
|---|---|---|---|
| 1 | GET `https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize` | `client_id`、`response_type=code`、`redirect_uri`、`scope`、`code_challenge`(S256)、`state` | 系统浏览器；禁止内嵌 WebView 收集密码 |
| 2 | POST `https://login.microsoftonline.com/consumers/oauth2/v2.0/token` | `grant_type=authorization_code`、`code`、`code_verifier`、`redirect_uri` | 得 MSA access/refresh |
| 3 | POST `.../consumers/oauth2/v2.0/devicecode` → 轮询 `.../token` | `grant_type=urn:ietf:params:oauth:grant-type:device_code` | 回退路径；需允许 public client flow |
| 4 | POST `https://user.auth.xboxlive.com/user/authenticate` | `Properties.AuthMethod=RPS`、`SiteName=user.auth.xboxlive.com`、`RpsTicket="d=<msa_access>"`、`RelyingParty=http://auth.xboxlive.com`、`TokenType=JWT` | 取 `Token` + `DisplayClaims.xui[0].uhs` |
| 5 | POST `https://xsts.auth.xboxlive.com/xsts/authorize` | `Properties.SandboxId=RETAIL`、`UserTokens=[xbl]`、`RelyingParty=rp://api.minecraftservices.com/`、`TokenType=JWT` | 失败按 XErr 映射 |
| 6 | POST `https://api.minecraftservices.com/authentication/login_with_xbox` | `{"identityToken":"XBL3.0 x=<uhs>;<xsts>"}` | 返回 `access_token`、`expires_in=86400` |
| 7 | GET `https://api.minecraftservices.com/entitlements/mcstore` | `Authorization: Bearer <mc_access>` | `items` 为空 = 无所有权 → 拒绝启动（MC-05） |
| 8 | GET `https://api.minecraftservices.com/minecraft/profile` | 同上 | 取 `id`/`name`/`skins`；JWT 验签（MC-06） |

**错误映射（必须可读，不许直接弹原始 JSON）**

| 现象 | 判定 | 处置 |
|---|---|---|
| 403（第 6 步起） | 应用未获 Minecraft API 权限 / 无权限 | 提示「待审批或未授权」，不重试；引导离线账户 |
| XSTS 401 `XErr=2148916227` | Xbox 账号被封禁 | 终止，提示联系 Xbox 支持 |
| `2148916233` | 无 Xbox 账户 | 提示先登录 minecraft.net 创建 |
| `2148916235` | 所在国家/地区不支持 Xbox Live | 终止并说明 |
| `2148916236` / `2148916237` | 需成年验证（韩国） | 提示前往 Xbox 页面验证 |
| `2148916238` | 未成年，需加入 Microsoft 家庭 | 提示家长在 Microsoft 家庭中授权 |
| `invalid_grant` / `interaction_required` | refresh token 失效 | 标记会话失效，引导重新登录（SEC-AUTH-09） |
| `AADSTS50020` / `AADSTS7000218` | 账号类型或租户不匹配 | 提示必须用个人 Microsoft 账户（consumers） |

### 3.2 离线账户（必须做，但必须诚实）

**事实与风险**：EULA 要求玩家持有正版；离线模式本质是**不做验证**。第三方启动器普遍提供（PCL/HMCL 都有），Mojang 未执法，但这不等于合法授权。**我们不能提供任何「伪造正版凭证」的能力**（不伪造 session、不伪造签名、不提供服务端白名单绕过）。

| ID | 约束 | 验证 |
|---|---|---|
| **MC-07** | 离线账户是**独立账户类型**（`kind: "offline"`），UI 标注「本地/局域网；需自备正版」；首次创建弹一次说明，可不再提示但不删除标识 | 截图 + 配置 schema |
| **MC-08** | 离线启动参数固定为 `--username <name> --uuid <32hex> --accessToken 0 --userType legacy`（与 01 文档 P0-2 一致）；**不得**用任何真实 token 冒充离线；**不得**为离线账户生成看似正版的 JWT | 单测：argv 断言 |
| **MC-09** | 首次启动（任意账户类型）显示一次正版购买劝导（可「不再提示」）；联机房间创建/加入时，若房间含离线成员，必须明示「离线成员无法加入正版验证服务器」；不提供「离线进正版服」的任何提示或工具 | E2E + UI 文案评审 |

### 3.3 游戏文件与版本 JSON

**事实**：

- Mojang 的 `version_manifest_v2.json` → 版本 JSON → `libraries`/`assets`/`client.jar`；实测 1.20.1 的 **88/88 个库都有 `sha1` + `size`**，`downloads.client.sha1`、`assetIndex.sha1` 也齐全（附录 A.3）。这给了我们**全量校验的可行性**，没有理由不校验。
- 版本 JSON 与资源索引是 Mojang 的数据；EULA 禁止再分发「游戏或其任何部分」。把 JSON 打进安装包属于不必要的风险暴露，且会过期。

| ID | 约束 | 验证 |
|---|---|---|
| **MC-10** | 游戏文件（client.jar、libraries、assets、server.jar、java runtime）**一律运行期从官方/镜像下载**，不进安装包、不进仓库、不做「离线完整包」分发 | 打包产物清单审查；仓库体积门禁（< 20 MB，不含 node_modules） |
| **MC-11** | 版本 JSON **不随包**；首次安装时下载并缓存到实例目录；缓存带 `etag/last-modified` 与哈希；离线导入只接受**用户自备**的 JSON/文件（UI 明示「由你提供，本程序不附带」） | 代码路径 + 断网测试 |
| **MC-12** | 写 `launcher_profiles.json` 只做**最小必要合并**（Forge 等 installer 需要），写入前备份原文件；**绝不写入 token/refreshToken**；不删除用户已有的 profile | 单测：合并后原 profile 保留；grep 无 token 字段 |
| **MC-13** | 不代理/不中转 Mojang 的认证与游戏流量（不做「登录代理」）；不做「加速器」式的游戏流量劫持 | 代码中无相关代理；网络清单审查 |

### 3.4 品牌与免责声明

**事实（Usage Guidelines 原文，经条款库逐字引文）**：

> 「Prominently include the disclaimer similar to the following: "NOT AN OFFICIAL MINECRAFT [PRODUCT/SERVICE/EVENT/etc.]. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT"」
>
> 「Do not do anything or include anything that makes people think that what you are sharing could be interpreted as official or approved by, endorsed by, associated with, supported by, or connected to us」

| ID | 约束 | 验证 |
|---|---|---|
| **MC-14** | 关于页/安装包「应用信息」/官网首屏**显著**展示（中英双语）：「NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.」中文：「非 Minecraft 官方产品，未获 Mojang 或 Microsoft 批准或关联。」 | 发布检查清单（截图） |
| **MC-15** | 产品名不含 `Minecraft`；描述可用「for Minecraft Java Edition」「Minecraft 启动器」这类**描述性**用法，但不得作为商标使用、不得用官方 Logo/字体/图标 | 商标检索 + 资源审查 |
| **MC-16** | 不得暗示「官方」「合作」「推荐」；不得使用 Mojang/Microsoft 的商标做应用图标、域名、社交媒体头像 | 发布检查清单 |

### 3.5 商业化边界

| ID | 约束 | 理由 |
|---|---|---|
| **MC-17** | 不售卖游戏本体、账号、激活码；不提供「代充/代购」；赞助/捐赠不得与「解锁游戏内优势」绑定；不售卖「绕过正版验证」的任何服务 | EULA + Usage Guidelines（entitlements 不得给竞争性优势） |
| **MC-18** | 若未来接广告/赞助：广告不得出现在启动/崩溃关键路径遮挡操作；不得上传用户行为数据（默认零遥测） | 产品原则（01 §1.3）+ 隐私最小化 |

### 3.6 原版下载口径（2026-10-21 用户已裁定）

**裁定（默认口径，生效）**：**只做下载器**——官方源（`launchermeta.mojang.com` / `libraries.minecraft.net` / `resources.download.minecraft.net`）+ BMCLAPI 镜像；**不在产品内分发游戏文件或 Mojang 资源**；**无需额外法务动作**。

- 这意味着：安装器/安装包/仓库里永远没有 `client.jar`、`libraries`、`assets`、版本 JSON、`server.jar`、JRE；它们只在用户机器上由下载器落盘（MC-10/11）。
- 仍保留**结构性可关闭**（SRC-06）：不是合规前置，而是工程弹性——上游口径变化（PCL 公告 230 是前例）时可一键切「仅官方源」或「用户自备文件」；企业/离线场景也可用。
- 若未来要改为「随包分发」，必须回到法务重新评估（当前明确不做）。

| ID | 约束 | 验证 |
|---|---|---|
| **MC-19** | 下载功能可通过配置/策略**整体关闭**（企业/离线模式），关闭后仍可用「导入本地文件」完成安装；该开关默认开启下载 | 配置项 + E2E：关闭后走导入路径 |
| **MC-20** | 口径变化时可在**不发版**的情况下通过远程配置关闭下载或切换源策略（远程配置只允许布尔/枚举，不允许下发可执行内容）；变更记入发布说明 | 发布清单 + 远程配置 schema 审查 |

---

## 4. 镜像源（BMCLAPI 等）

### 4.1 BMCLAPI 条款（官方 apiDoc「关于/协议」原文要点）

> - 「BMCLAPI 是对外开放的，所有需要 Minecraft 资源的启动器均可调用。」
> - 「BMCLAPI 下的所有文件，除 BMCLAPI 本身的源码之外，**归源站点所有**」
> - 「BMCLAPI 会尽量保证文件的完整性、有效性和实时性，对于使用 BMCLAPI 带来的一切纠纷，**与 BMCLAPI 无关**」
> - 「BMCLAPI 和 BMCL 不同，**属于非开源项目**」
> - 「**所有使用 BMCLAPI 的程序必需在下载界面或其他可视部分标明来源**」
> - 「**禁止在 BMCLAPI 上二次封装其他协议**」

映射关系（实测可用）：`launchermeta.mojang.com` → `bmclapi2.bangbang93.com`；`libraries.minecraft.net` → `/maven`；`resources.download.minecraft.net` → `/assets`；`meta.fabricmc.net` → `/fabric-meta`；`maven.neoforged.net` → `/maven`；`authlib-injector.yushi.moe` → `/mirrors/authlib-injector`。

### 4.2 工程约束

| ID | 约束 | 验证 |
|---|---|---|
| **SRC-01** | **UI 必须标明来源**：下载页/任务卡片显示「下载源：BMCLAPI（bangbang93）」并可点击到 `https://bmclapi.bangbang93.com/`；使用官方源时显示「Mojang 官方」。日志同时记录源 ID | UI 快照 + 日志断言 |
| **SRC-02** | 不做「二次封装」：不把 BMCLAPI 包装成我们自己的公开 API/镜像站对外提供服务；不在其上加自定义协议/重写路径对外暴露；客户端直连，不设中转 | 架构审查（无对外服务） |
| **SRC-03** | 镜像文件的权利归源站点：我们**不缓存再分发**、不把镜像文件打进安装包；本地缓存仅限本机使用（且按 MC-10/11 处理） | 打包清单 |
| **SRC-04** | 默认策略：**官方源优先**，镜像为**可关闭的回退**（用户可强制「只用官方」）；镜像失败自动回退官方，连续失败按指数退避并标记该源「本次会话不可用」 | 单测：故障注入；E2E：断镜像仍可装 |
| **SRC-05** | 自限流：对单一镜像主机并发 ≤ 8、总并发 ≤ 16、失败重试 ≤ 3（指数退避 + 抖动）；不提供「无限并发」开关；尊重 `Retry-After` | 代码常量 + 压测记录 |
| **SRC-06** | 源适配层必须支持「禁用全部第三方镜像」（合规模式），且该开关可由远程配置下发（只允许布尔/枚举，不允许可执行内容） | 配置 schema + E2E |
| **SRC-07** | 镜像只用于**文件下载与元数据**；**不把镜像的哈希当唯一真相**：哈希必须来自上游元数据（Mojang JSON / Maven `.sha1` / Modrinth / CF）；镜像元数据缺哈希时按「不可校验」处理（SEC-DL-04） | 单测：伪造镜像返回错误哈希 → 拒绝 |
| **SRC-08** | BMCLAPI 的 `java/list` 只返回文件名、**没有哈希** → **不得**用于自动下载 JRE；JRE 只走 Mojang java-runtime 清单（有 sha1）或 Adoptium（有 sha256），见 SEC-DL-05 | 代码路径审查 |

### 4.3 其它镜像与「自定义源」

- 01 文档实测里出现过 `mod.mcimirror.top` 等第三方镜像。它们**没有公开条款、没有 SLA、没有哈希承诺**。
- 处置：归入「**不可信源**」类别——只有用户显式添加/选择时才用，且必须满足 SEC-DL-04（有上游哈希才能装；无哈希则只能「下载到本地由用户自行确认」，UI 明确风险）。

| ID | 约束 | 验证 |
|---|---|---|
| **SRC-09** | 自定义源只接受 `https://`；**禁止**为任何源关闭证书校验（`rejectUnauthorized:false` 一律禁止）；自签证书源不支持 | 代码扫描（grep `rejectUnauthorized`/`NODE_TLS_REJECT_UNAUTHORIZED`） |
| **SRC-10** | 自定义源首次使用弹风险确认（「该源由你添加，本程序不为其内容背书」）；源列表可导出/导入但**不含任何密钥** | UI + 配置 schema |
| **SRC-11** | 源健康检查只用 HEAD/小文件，不拉全量；健康检查失败不影响已缓存文件的可用性 | 单测 |
| **SRC-12** | 任何源返回的 URL 必须做**主机白名单/同源**校验（防镜像把 `libraries` 指向钓鱼站）；跨主机跳转最多 3 跳且每跳都记录 | 单测：恶意 302 → 拒绝 |

---

## 5. Modrinth / CurseForge

### 5.1 Modrinth（P0/P1 主力源）

**事实（官方文档原文 + 实测）**：

- 速率限制：**300 请求/分钟/IP**；响应头 `X-Ratelimit-Limit/Remaining/Reset`；超限要读头退避。
- **必须**提供唯一 `User-Agent`；只写 `okhttp/4.9.3` 这类会被封；推荐 `github_username/project_name/1.56.0 (contact)`。我们应写成：`<org>/<product>/<version> (+https://<site>; <contact>)`。
- 文件对象含 `hashes.sha1` 与 `hashes.sha512`（实测 `sodium` 版本文件两者都有）；下载直连 `cdn.modrinth.com`。
- ToS「API Usage」：授予的是**有限、非独占、不可再授权、可撤销**的许可，用于「download, display, query, create, edit, delete」平台内容；须遵守 ToS/社区准则/法律。
- ToS 同时禁止「用 robot/spider 或自动手段访问」「用内容训练 AI」等——**API 的授权是例外通道**，但不得超出「下载/展示/查询」的目的做转存/再分发。

| ID | 约束 | 验证 |
|---|---|---|
| **API-01** | 所有 Modrinth 请求带唯一 UA（含产品名/版本/站点/联系邮箱），集中在一个 HTTP 客户端里注入，禁止散落硬编码 | 单测：拦截器断言 UA 格式 |
| **API-02** | 客户端级令牌桶：≤ 300 req/min（留 20% 余量，实际 ≤ 240/min）；读 `X-Ratelimit-*` 动态调整；429/503 指数退避 + 抖动，禁止并发风暴 | 单测 + 抓包 |
| **API-03** | 下载直连 `cdn.modrinth.com`（或 API 给的 `url`），**必须**校验 `sha512`（优先）或 `sha1`；不匹配即删文件并报错 | 单测：篡改字节 → 失败 |
| **API-04** | 不转存/不自建 Modrinth 镜像/CDN；本地只缓存元数据（带 TTL，≤ 24h）与用户主动安装的文件；**不把文件打进安装包** | 架构审查 + 打包清单 |
| **API-05** | 只在需要用户身份（发布/收藏等）时接 OAuth；P0 只读公开 API，不申请写权限 | 代码范围审查 |
| **API-06** | 整合包（`.mrpack`）只保存 `downloads[].url + hashes`，安装时逐个下载校验；**不把 pack 内的 jar 重新打包分发** | 单测：mrpack 解析器不落 jar |

### 5.2 CurseForge（P1 接入、自备官方 key；P0 不接）

**用户裁定（2026-10-21）**：P0 不接入；**P1 接入，且必须自备官方 key**（走 Overwolf 官方申请，不使用任何来源不明的 key）。

**事实（3rd Party API Terms 原文要点 + Freshdesk 说明）**

- API key 需通过表单申请、Overwolf 审核；审核关注「对作者收益的影响」「对 CF 服务器/CDN 的影响」「是否取得作者对第三方分发的同意」。
- 条款：「API Key … is non-transferable and **may not be shared with any third party**. Developer may not disclose the API Key to any third party」。
- 条款：Developer shall not … 「**save or cache any data obtained through the API or SDK**」；「**conceal your identity or geographic location when accessing the API, including accessing the API through a proxy server or VPN**」；「use the API … to build any product or service that **competes**, directly or indirectly, with CF」。
- 配额：超过某个由 Overwolf 单方决定的阈值后，可能要求签**付费**书面许可。
- 「Project Distribution Toggle」：作者可关闭第三方分发；关闭后第三方 API 拿不到该项目/文件；即使开启，第三方下载**不计入**作者收益。

**条款 → 工程要求映射（P1 设计时必须逐条对照）**

| 条款原文要点 | 对我们的硬要求 |
|---|---|
| key 不可转让、不得向任何第三方披露 | key 只存在于**后端 secrets**（或 CI secret）；客户端、仓库、日志、崩溃报告、房间协议一律零 key（API-08） |
| 「不得保存或缓存通过 API/SDK 获得的数据」 | 不落盘、不建本地库、不做离线元数据包；图标/描述实时透传（API-12/19） |
| 「不得通过代理服务器/VPN 隐匿身份或地理位置」 | 后端必须如实标识产品 `User-Agent` 与联系方式；**法务书面确认**「后端代用户请求」不构成隐匿（API-18） |
| 「不得用 API 构建与 CF 直接或间接竞争的产品」 | 接入前法务书面意见；不通过则退回「只跳转」（API-20） |
| 「超配额可要求签付费书面许可」 | 自建调用计数与告警，接近阈值前联系 CF（API-22） |
| Distribution Toggle：作者可关闭第三方分发；第三方下载不计收益 | `downloadUrl==null` → 不下载只跳转；UI 显示「不计入作者收益」（API-10/11/21） |

| ID | 约束 | 验证 |
|---|---|---|
| **API-07** | **P0 不调用任何 CF API**：只做「浏览器打开项目页」+「本地 zip 导入」+ 读取 pack 自带 `manifest.json`。P1 通过 `ModSourceProvider` 抽象接入（t8 已要求预留），**不重写下载层** | P0 代码无 `api.curseforge.com`；P1 仅实现 provider |
| **API-08** | CF key **永不**出现在客户端、仓库、日志、崩溃报告、遥测；仅后端 secrets（最小权限、按环境隔离）；仓库开启 secret 扫描（gitleaks） | CI secret scan + 打包产物字符串检查 |
| **API-09** | P1 开工前必须满足「前置条件清单」（本节表末）全部条目；**未满足不写代码**（可先写 provider 接口与 mock） | 前置清单签字 + PR 链接 |
| **API-10** | 接入后必须尊重 distribution toggle：`downloadUrl == null` → 不下载，改为「打开项目页」；不得从 forgecdn 猜测直链 | 单测（toggle off 样本） |
| **API-11** | 第三方下载不计作者收益 → UI 必须显示「该下载不计入作者收益，建议支持作者」并提供项目页链接 | UI 快照 |
| **API-12** | 不缓存 CF API 响应（含图标/描述/搜索页）；如必须展示，实时透传或只用本地用户数据 | 代码审查（无 disk/memory cache） |
| **API-16** | 申请主体与材料：以项目主体提交官方表单，说明启动器用途、隐私政策 URL、联系邮箱、预计 QPS/日活；保留申请回执与审核往来 | 回执归档 |
| **API-17** | key 生命周期：后端 secrets manager 存储；定期轮换；访问审计；泄露应急预案（立即联系 CF 更换 + 失效旧 key + 事件记录） | 运维演练记录 |
| **API-18** | 代理与身份：后端请求带真实产品 UA（含版本与联系邮箱），不伪造来源、不隐藏调用方身份；**法务书面意见**确认合规；若否 → 只做「跳转 + 本地导入」（客户端直连因 key 必然暴露，不可行） | 法务意见书 + 抓包 |
| **API-19** | 缓存禁令落地：无磁盘缓存、无持久化索引、无「离线 CF 元数据包」；会话内存中只保留当前渲染所需副本并随页面销毁（需法务确认不构成 cache） | 架构评审 |
| **API-20** | 竞品条款：法务书面意见确认「启动器接入 CF API」不构成与 CF/CurseForge for Studios 直接或间接竞争；若否 → 只保留「打开项目页」 | 法务意见书 |
| **API-21** | 下载只走 API 返回的 URL；不转存、不重打包、不做自有镜像；失效链接回退项目页 | 单测 + 打包清单 |
| **API-22** | 配额与运营合规：自建计数 + 告警阈值（如日调用 80% 配额）；接近阈值前联系 CF；不使用 API 数据训练模型；建立侵权投诉处理流程 | 监控面板 + 流程文档 |

**P1 前置条件清单（全部满足才开工；任一不满足 → 降级为「浏览器跳转 + 本地导入」）**

- [ ] API-16 申请回执（项目主体、用途、隐私政策、联系人齐全）
- [ ] API-18 法务意见：「后端代请求不构成隐匿身份」
- [ ] API-20 法务意见：「不构成与 CF 竞争」
- [ ] API-17 secrets/轮换/应急方案落地（客户端零 key）
- [ ] API-19 无缓存设计通过评审
- [ ] API-22 配额监控与告警上线
- [ ] 降级开关：远程配置可一键关闭 CF 源（只影响 provider，不影响 Modrinth）

### 5.3 整合包的一般规则

| ID | 约束 | 验证 |
|---|---|---|
| **API-13** | 安装整合包时，每个文件都必须来自 pack 声明的 URL + hash；**不携带**任何 jar 进我们的安装包；overrides 里的 jar 属于 pack 作者分发物，按原样落盘并在 UI 标注来源 | 单测 + 打包清单 |
| **API-14** | 导出整合包（P1）只导出「引用清单」（URL+hash），**不打包第三方 jar**（除非其许可证明确允许再分发，且记录在案） | 导出产物审查 |
| **API-15** | pack 内的 `modrinth.index.json` / `manifest.json` 视为**不可信输入**：限制字段、限制 URL 主机（见 SRC-12）、限制文件数/大小（SEC-DL-08/09） | fuzz/单测 |

---

## 6. 联机组件许可证

> 技术选型由 t4 决定；本节只给**许可证与分发**的硬边界。

### 6.1 一览（GitHub API 实测）

| 组件 | 许可证 | 能否随包分发 | 关键义务/风险 |
|---|---|---|---|
| **EasyTier** | **LGPL-3.0** | 可以（独立进程、不修改） | 附 LGPL 文本与源码地址；不得静态链接进我们的二进制；修改则须开源修改部分 |
| **frp** | **Apache-2.0** | 可以 | 保留 `NOTICE`/版权；需用户自备 `frps` 服务端 |
| **nps** | **GPL-3.0** | 许可上可（与本项目同为 GPL-3.0），但**不打包** | 许可无冲突；README 明示默认 `admin/123` + 8080 管理口 → 安全负债，故不采用 |
| **ZeroTier** | **源码可见（非商业）+ MPL-2.0（Agent）** | **禁止随产品分发** | `nonfree/LICENSE.md` 把「Incorporation of the Software into any paid or unpaid product, platform, distribution or service」列入 Commercial Use → 即使免费产品也需商业许可 |

### 6.2 EasyTier（推荐候选）

`LICENSE` = LGPL-3.0。我们采用 **sidecar 子进程**模型（与 40-architecture §6.9 一致）：`easytier-core` 作为独立可执行文件，通过 CLI/本地 RPC 交互，不链接、不修改。

| ID | 约束 | 验证 |
|---|---|---|
| **NET-01** | 只以**独立进程**方式使用；不把 EasyTier 作为 Rust/C 库链接进 Node/Electron；不修改其源码（若要改，修改部分必须开源，且需重新评估） | 依赖审查 + 进程模型 |
| **NET-02** | 分发（无论是随包还是运行期下载）都必须：①附 LGPL-3.0 全文；②提供对应源码获取方式（版本 tag + 仓库 URL）；③不限制用户替换该组件（不修改其二进制、不锁定路径）。**兼容性**：本项目为 GPL-3.0，LGPL-3.0 与之兼容；即使按「组合作品」处理，LGPLv3 §4 也允许整体以 GPLv3 分发（详见 §6.6） | `THIRD-PARTY-LICENSES` + 安装目录 |
| **NET-03** | 固定版本 + SHA-256 校验 + 官方 release 来源；**不**从 BMCLAPI/第三方镜像取 EasyTier 二进制 | 单测 + 代码路径 |
| **NET-04** | 采用「**运行期下载 + 用户可见**」优先（PCL 也是这个模式）：首次联机时提示「将下载 EasyTier 组件（LGPL-3.0）」并展示来源/哈希；失败可回退「手动指定已安装路径」 | E2E + UI 文案 |
| **NET-05** | 若随包：安装包内单独目录 + 独立 LICENSE 文件 + 版本清单；卸载时一并清理；`NOTICE` 中列明 | 安装包检查 |

### 6.3 frp（备选，需服务端）

| ID | 约束 | 验证 |
|---|---|---|
| **NET-06** | 可以随包（Apache-2.0），但必须保留版权/NOTICE；`frpc` 与我们的代码之间只通过配置文件/进程交互 | 打包清单 |
| **NET-07** | 需要公网 `frps`：优先「用户自备服务器」；若我们自建，必须按 NET-15~17 做鉴权/限流/滥用防护，并评估备案与成本 | 架构评审 |
| **NET-08** | `frpc` 的 admin UI 默认 `127.0.0.1:7400`：**默认关闭**；如开启必须随机端口 + 强口令 + 仅 loopback | 配置生成器单测 |

### 6.4 nps / ZeroTier（不采用）

| ID | 约束 | 理由 |
|---|---|---|
| **NET-09** | **不打包 nps**；文档中也不推荐用户使用默认配置（`admin/123`、8080 暴露公网是常见入侵入口） | 许可兼容（同为 GPL-3.0），但**默认弱口令 + 公网管理面** → 不采用 |
| **NET-10** | **不打包 ZeroTier**；不代用户创建 ZeroTier 网络；不把 ZeroTier 作为「默认联机方案」 | 非商业许可 + 需要 ZeroTier 账号/网络 |
| **NET-11** | 若用户已自行安装 ZeroTier，最多做「检测到已安装，提示可手动组网」，不自动调用、不配置其网络 | 代码审查 |

### 6.5 服务侧与中继

| ID | 约束 | 验证 |
|---|---|---|
| **NET-12** | 运行时下载的联机组件必须：官方 release + 固定版本 + SHA-256（有签名则验签）+ 失败即失败；不得「下载失败就换镜像重试到成功」而跳过校验 | 单测：坏哈希 → 拒绝 |
| **NET-13** | 房间邀请码 = 能力凭证：高熵（≥ 128 bit）、可撤销、有有效期；日志脱敏（SEC-LOG-01）；不写入可分享的崩溃报告 | 生成器单测 |
| **NET-14** | 房间内**不传输**任何账号 token/refresh token/密码；客户端与服务端只交换房间元数据与网络参数 | 协议审查 |
| **NET-15** | 若自建中继：TLS + 每房间令牌 + 连接数/带宽配额 + 滥用告警 + 不记录用户流量内容（只记元数据） | 运维评审 |
| **NET-16** | 中继可见流量：UI 必须提示「经中继时，网络流量对中继运营方可见；敏感场景请用直连或自建节点」；离线模式 LAN 世界**没有加密**，提示更明确 | UI 文案 |
| **NET-17** | 联机功能默认关闭；开启需显式同意（会开放本机端口/暴露 LAN 世界）；退出游戏即停 sidecar，不留后台常驻 | E2E + 进程清理测试 |
| **NET-18** | 若法务要求「零分发风险」：降级为「只提供官方下载页链接 + 用户手动放置 + 我们校验 SHA-256 后使用」，不自动下载、不随包、不代执行安装 | 代码路径 + 法务确认 |

### 6.6 GPL-3.0 项目下的兼容性复核（回应 Q6）

**结论：成立。**「EasyTier（LGPL-3.0）+ 独立进程 + 运行时下载 + 未修改」在 GPL-3.0 项目下没有许可障碍；即使最保守地按「组合作品」处理也成立。

| 场景 | 法律定性（工程口径） | 结论 |
|---|---|---|
| 我们的代码 GPL-3.0；EasyTier 作为**独立进程**，通过 CLI/本地 RPC/HTTP 交互 | 通过进程边界与通用协议通信的两个程序，通常视为**独立作品**（非衍生、非组合作品）；GPL 不传染到 EasyTier，LGPL 也不传染到我们 | ✅ 成立（默认方案） |
| 同一安装包/同一目录分发两者 | GPLv3 §5 的「聚合（aggregate）」：把独立程序放在同一介质不使它们成为一个作品 | ✅ 成立（随包也不改变定性） |
| 保守假设被认定为「组合作品」 | LGPL-3.0 与 GPL-3.0 **明确兼容**；LGPLv3 §4 允许把组合作品整体按 GPLv3 分发（并保留 LGPL 组件的源码/替换义务） | ✅ 成立（最保守情形也合规） |
| 运行期从官方 release 下载，我们不随包 | 我们不「convey」该组件，LGPL 的分发义务不落在我们头上；仍自愿展示许可证/源码（NET-02/04） | ✅ 成立（推荐默认） |
| 把 EasyTier 静态链接进我们的二进制 | 形成组合作品，触发 LGPL 的替换/重链接义务；GPL-3.0 下还需整体开源 | ❌ 不做（NET-01） |
| 修改 EasyTier 源码 | 修改部分须以 LGPL-3.0 开源，且要重新评估 | ❌ 不做（NET-01） |

**我们自己的 GPL-3.0 义务（必须同时满足）**

1. 分发二进制（安装包/更新包）时提供 **Corresponding Source**：公开仓库对应 tag + 构建脚本 + 依赖安装说明（LIC-09）。
2. 不附加与 GPL-3.0 冲突的限制：用户协议不得禁止复制/修改/再分发 GPL 代码（LIC-12）。
3. About 页放 Appropriate Legal Notices（版权声明 + 许可证 + 源码地址）；安装包附 `COPYING`/`NOTICE`/`THIRD-PARTY-LICENSES`（LIC-10、SEC-SUP-09）。
4. 依赖必须 GPL-3.0 兼容：MIT/BSD/Apache-2.0/ISC/MPL-2.0 可以；GPL-2.0-only、CDDL、专有、SSPL、BSL 不可以；AGPL 仅 authlib-injector 例外（LIC-11）。
5. 若未来在「锁定设备/应用商店」上分发，需评估 GPLv3 §6 的 Installation Information（一般 Windows 桌面分发不触发）。

**替代方案（仅在法务要求零分发时启用）**：NET-18——只给下载指引、用户手动放置、我们只做哈希校验与执行；此时我们完全不分发 EasyTier，LGPL 义务不适用。

---

## 7. 安全基线

### 7.1 威胁模型（先定对手，再定措施）

| 资产 | 对手 | 攻击面 | 主要后果 |
|---|---|---|---|
| MSA refresh token / MC access token | 同机恶意软件、日志/报告泄露、导出的 bat | `sessions.bin`、日志、`LatestLaunch.bat`、崩溃报告 | 账号被接管、封号 |
| 第三方 authlib 密码 | 钓鱼服务器、日志 | 用户输入、HTTPS 降级 | 第三方账号泄露 |
| 实例文件/存档 | 恶意整合包（zip-slip/覆盖） | 解压路径、overrides | 任意文件写、存档损毁 |
| 用户机器 | 恶意镜像/篡改下载、未校验二进制 | 下载链、Java/authlib/EasyTier/installer | RCE |
| 本地服务 | 同机/局域网攻击者 | OAuth 回调、sidecar 管理面、LAN 发现 | 令牌窃取、隧道被控 |
| 联机房间 | 恶意房主/成员、中继运营方 | 邀请码、房间协议、中继 | 隐私泄露、 griefing |

### 7.2 令牌存储（Windows 为主）

**事实（Electron safeStorage 文档）**：Windows 下用 **DPAPI** 生成/保护密钥；语义是「同一登录凭据的用户通常才能解密」——**保护其他用户与离线磁盘窃取，不保护同一用户空间内的其它程序**；Linux 若 `getSelectedStorageBackend() === 'basic_text'`，内容是**硬编码明文口令加密 = 无保护**；异步 API 支持 key rotation（`shouldReEncrypt`）。

| ID | 约束 | 验证 |
|---|---|---|
| **SEC-AUTH-01** | 持久化内容仅限：MSA **refresh token**、账户元数据（uuid/name/kind）、可选「记住我」。**不持久化** access token / XSTS / XBL / 密码 | 二进制/JSON 检查：无 access token 字段 |
| **SEC-AUTH-02** | 使用 `safeStorage.encryptStringAsync` 写入 `userData/auth/sessions.bin`（原子写 + 备份 + `0o600` 等价的 Windows ACL：仅当前用户）；启动时 `decryptStringAsync`，`shouldReEncrypt` 为真则重写 | 单测（mock safeStorage）+ 文件 ACL 检查 |
| **SEC-AUTH-03** | `safeStorage.isEncryptionAvailable()===false` 或（Linux）后端为 `basic_text` → **拒绝持久化**，只保留内存会话，并提示「本机无安全存储，登录状态不会保存」 | 单测：模拟不可用 → 不落盘 |
| **SEC-AUTH-04** | 「退出登录」必须：删除 `sessions.bin`、清内存、清 account 缓存、清 `LatestLaunch.bat` 中的令牌（本就脱敏）；切换账户时先清旧会话再写新会话 | E2E |
| **SEC-AUTH-05** | 令牌**永不**进入：日志、崩溃报告、导出配置、房间协议、HTTP(s) 遥测、剪贴板、窗口标题、错误码 message | 全局脱敏测试 + 代码扫描 |
| **SEC-AUTH-06** | 明确接受残余风险并**写进隐私说明**：DPAPI 不能防同用户恶意程序；因此提供「每次启动重新登录」选项（默认关），并保持 access token 短生命周期 | 文档 + UI |
| **SEC-AUTH-07** | 不实现「令牌云同步/多设备共享」；不实现「导出登录状态」；不读取其它启动器的凭据库 | 代码审查 |
| **SEC-AUTH-08** | 第三方 authlib 账户：密码**只在内存**用于一次登录，**不落盘**；只保存该服务器签发的 token（同样加密）；UI 必须标明「凭据将发送给 <服务器域名>（第三方），非 Microsoft」 | 单测 + UI 文案 |

### 7.3 令牌生命周期（按官方文档实测口径）

| 令牌 | 生命周期 | 处理 |
|---|---|---|
| MSA access token | ~1 小时（默认） | 内存；提前 5 分钟刷新 |
| MSA refresh token | **90 天**（SPA/邮件 OTP 为 24h；我们是桌面 public client，按 90 天） | 加密持久化；**每次使用后替换**（旧的本地立即删除；服务端不会立刻吊销旧的，但不能留） |
| XBL token | ~14 天（示例 `NotAfter` 2020-12-07 → 2020-12-21） | 内存/短缓存；401 时重取 |
| XSTS token | ~12–16 小时（示例 12-07 19:52 → 12-08 11:52） | 每次启动前重取 |
| Minecraft access token | **86400 s（24h）**，`expires_in` 字段 | 内存；每次启动重新走链；401 时刷新链 |

| ID | 约束 | 验证 |
|---|---|---|
| **SEC-AUTH-09** | 刷新失败（`invalid_grant`/`interaction_required`）→ 标记会话失效 + 引导重新登录；**不得**静默降级为离线（会造成「进服被踢」的迷惑体验，40 文档 §6.3 已定） | 单测：模拟 invalid_grant |
| **SEC-AUTH-10** | 刷新令牌**单飞**（single-flight）：并发启动/多窗口只允许一个刷新请求，其余等待同一结果，避免 rotation 竞态把 token 弄失效 | 并发单测 |
| **SEC-AUTH-11** | 时钟偏差容忍：用 `expires_in` 计算到期，不使用本地绝对时间做唯一判据；系统时间明显异常（差 > 24h）时提示校准 | 单测 |
| **SEC-AUTH-12** | 在启动前校验链时**顺带**做 entitlements 检查（MC-05）；profile 拉取失败分「网络失败（可重试）」与「无所有权（拒绝）」两类错误码 | E2E |

### 7.4 下载完整性

**哈希来源矩阵（必须按此实现，不允许「没有哈希就跳过」）**：

| 来源 | 哈希 | 实测/依据 |
|---|---|---|
| Mojang 版本 JSON：`libraries[].downloads.artifact` | `sha1` + `size` | 1.20.1：88/88 都有（附录 A.3） |
| Mojang `downloads.client` / `assetIndex` | `sha1` + `size` | 实测均有 |
| Mojang assets index 内每个 object | `hash`(sha1) + `size` | 格式标准 |
| Mojang java-runtime 清单 | 每文件 `sha1` + `size` | `launchermeta/v1/products/java-runtime/.../all.json` |
| Fabric / Quilt meta | 库条目本身常无哈希 → 用 Maven `.sha1` sidecar | Maven 仓库惯例 |
| Forge / NeoForge maven | `.sha1` sidecar | 同上 |
| Modrinth | `sha1` **与** `sha512` | 实测 sodium 两者都有 |
| CurseForge（若接入） | `sha1`/`md5`（API 返回） | 待接入核实 |
| Adoptium（若自选 JRE） | `sha256` + `.sha256.txt` + `.sig` | Adoptium API 惯例 |
| 自更新包 | Authenticode 签名 + 发布清单 SHA-256（清单本身签名/Ed25519） | 本文件 SEC-APP-08 |

| ID | 约束 | 验证 |
|---|---|---|
| **SEC-DL-01** | 所有下载必须校验：有 sha512 用 sha512，有 sha256 用 sha256，否则 sha1；**哈希不匹配 = 删除 + 报错 + 记录源**，不得「重试到成功」（除非换源后仍校验） | 单测：坏哈希；E2E |
| **SEC-DL-02** | 原子落盘：下载到 `<name>.part` → 校验 → 同目录 `rename`；中断/崩溃不留下半成品被误用；启动时清理超过 24h 的 `.part` | 单测：中断恢复 |
| **SEC-DL-03** | 断点续传（Range）只用于大文件；续传完成后**必须整体校验**；服务器返回 200（不支持 Range）时回退单线程（40 文档已列） | 单测：416/200 分支 |
| **SEC-DL-04** | 没有可信哈希的文件：①若来自官方源，记录「未校验」并在 UI 标注；②若来自第三方/自定义源，**默认拒绝自动安装**，只允许「下载后由用户确认路径」 | 单测：无哈希 + 自定义源 → 拒绝 |
| **SEC-DL-05** | JRE 只从 Mojang java-runtime（sha1）或 Adoptium（sha256）获取；**禁止**使用 BMCLAPI 的 java 列表（无哈希）；下载后执行 `java -version` 校验主版本 | 单测 + E2E |
| **SEC-DL-06** | 重定向：最多 3 跳；每跳必须 https；最终主机必须在允许清单（官方域名 + 已启用源 + Modrinth/CF CDN）；跨域重定向记录日志 | 单测：恶意 302 |
| **SEC-DL-07** | 并发与限速：全局并发 ≤ 16、单主机 ≤ 8；下载限速可配（默认不限，但提供 1/2/4/8 MB/s 档）；大文件（> 512 MB）串行 | 代码常量 + 压测 |
| **SEC-DL-08** | 解压防护：拒绝绝对路径、`..`、盘符、UNC、ADS（`:`）、保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）、结尾点/空格；拒绝软/硬链接；条目数 ≤ 20k；单条目 ≤ 512 MiB；总解压 ≤ 8 GiB；用 `yauzl` 的 size 校验模式 + 自己的 `assertInside` | zip-slip/zip-bomb 测试集 |
| **SEC-DL-09** | 路径安全：任何来自 renderer/pack 的路径先 `resolve` 再 `assertInside(root)`，用 `path.relative` 判定前缀（不靠字符串 `startsWith`）；Windows 长路径统一处理 | 单测：`D:\x` vs `D:\xy` |
| **SEC-DL-10** | 下载目录/实例目录的 ACL：用户级可写、不继承宽权限；不把缓存放 `%TEMP%` 长期保存 | 安装脚本检查 |
| **SEC-DL-11** | 文件大小先验校验：`Content-Length` 与元数据 `size` 不符 → 拒绝（40 文档已有「文件大小不一致」文案）；缺失 `size` 时以哈希为准 | 单测 |
| **SEC-DL-12** | 所有外部 URL 记录到「网络访问日志」（不含 query 中的敏感参数），便于排障与审计；日志滚动 ≤ 10 MB × 5 | 日志测试 |
| **SEC-DL-13** | 禁止把 `file://`、`http://`、`data:` 作为下载源；禁止 `NODE_TLS_REJECT_UNAUTHORIZED=0`；代理只接受用户显式配置 | 代码扫描 |
| **SEC-DL-14** | 自更新/组件下载与游戏下载**分队列**，避免更新被大文件饿死；更新失败可回滚（SEC-APP-09） | E2E |

### 7.5 第三方代码执行

| 组件 | 是否执行 | 风险 | 约束 |
|---|---|---|---|
| authlib-injector | 是（`-javaagent`） | 完整用户权限；供应链 | SEC-EXE-01~03 |
| JavaWrapper / libjlw | 否（不引入） | 原生 DLL、无公开源码、AV 误报 | SEC-EXE-04 |
| Forge/NeoForge installer | 是（`java -jar`） | 任意代码、写盘 | SEC-EXE-05~06 |
| 模组/资源包/光影 | 否（启动器只放文件） | 游戏内代码（用户自担） | SEC-EXE-07 |
| EasyTier sidecar | 是 | 网络面、提权（TUN） | SEC-EXE-08 + SEC-NET |

| ID | 约束 | 验证 |
|---|---|---|
| **SEC-EXE-01** | authlib-injector：固定版本 + SHA-256 白名单（官方 release 或本地已有且哈希匹配）；**不**从 BMCLAPI 镜像自动更新；启动命令中 `-javaagent:<abs path>=<api root>`；记录版本与哈希到日志（不含凭据） | 单测 + 日志断言 |
| **SEC-EXE-02** | 启用 authlib 前必须显式确认「将把登录信息发送给第三方服务器 <host>」；只允许 `https://` API root；证书错误直接失败，不提供「忽略」 | E2E + 代码扫描 |
| **SEC-EXE-03** | authlib 的 `LICENSE`（AGPL-3.0 + 例外）随分发物提供；例外条款允许「未修改二进制打包 / 进程间接口 / Java Agent」三种用法——我们只用第 1+3 种，**不修改其代码** | 打包清单 |
| **SEC-EXE-04** | **不引入** `JavaWrapper.jar` / `libjlw-*.dll`：无公开源码仓库（`Meloong-Git/JavaWrapper` 404，本机仅有二进制）、原生代码、会扩大 AV 误报面。我们直接 `spawn(java, args)` 并管道采集 stdout/stderr | 依赖清单无该文件 |
| **SEC-EXE-05** | 加载器 installer：来源限官方 maven，`.sha1` 校验；执行前弹确认（显示版本/来源/哈希）；在**临时目录**执行，`cwd` 不指向实例目录；执行后校验产物 JSON 存在且可解析 | E2E：Forge 安装 |
| **SEC-EXE-06** | 传给 installer 的参数只允许白名单（`--installClient` 等固定值）；**禁止**把 pack/用户输入拼进 installer 命令行；`spawn` 一律 `shell:false` | 单测 |
| **SEC-EXE-07** | 模组/资源包/光影：启动器**不加载**、不反射、不执行；只做文件操作与元数据解析（解析器要防御 zip 炸弹） | 代码审查 |
| **SEC-EXE-08** | EasyTier：只允许 `127.0.0.1` 上的控制接口；需要 TUN/管理员权限时**必须由用户显式确认**并说明原因；不静默提权；失败回退到「无联机」 | E2E + 权限检测 |

### 7.6 本地监听面（默认关闭，最小暴露）

| 服务 | 绑定 | 端口 | 鉴权 | 生命周期 | 约束 |
|---|---|---|---|---|---|
| OAuth 回调 | `127.0.0.1` | 临时（`listen(0)`） | `state` + PKCE；单次 | 登录期间 ≤ 120 s | SEC-NET-01 |
| 联机 sidecar 控制面（EasyTier RPC/Web） | `127.0.0.1` | 随机 | 随机 token（文件 ACL 0600） | 房间期间 | SEC-NET-02 |
| frpc admin（若用 frp） | `127.0.0.1` | 随机 | 强口令 | 默认**关闭** | SEC-NET-03 |
| LAN 世界发现（可选） | UDP 组播 `224.0.2.60:4445` | 只读监听 | 无 | 页面打开期间 | SEC-NET-04 |
| nps 管理端 | — | — | — | — | 不使用（NET-09） |
| 更新检查/下载 | 出站 | — | TLS | 按需 | SEC-DL-13 |

| ID | 约束 | 验证 |
|---|---|---|
| **SEC-NET-01** | 回调服务器：`server.listen(0,'127.0.0.1')`；只接受 `GET /callback`；校验 `state`（恒定时间比较）与 PKCE；**只处理第一个有效请求**后立即 `close()`；超时 120 s 关闭；HTML 响应不含 token；拒绝 `Host` 非 `127.0.0.1` 的请求 | 集成测试（本地桩） |
| **SEC-NET-02** | sidecar 控制面：端口由 OS 分配并写入 ACL=0600 的临时文件；token ≥ 128 bit；请求必须带 `Authorization: Bearer`；不提供 CORS 通配；进程退出即销毁 token | E2E + 单测 |
| **SEC-NET-03** | 禁止任何服务监听 `0.0.0.0`/`::`；代码层加断言（启动时检查 `server.address()`），CI 扫描 `listen(port)` 无 host 参数的写法 | 代码扫描 + 运行时断言 |
| **SEC-NET-04** | LAN 发现：只解析、不响应、不转发；单包 ≤ 4 KB；字段长度限制；异常包丢弃并计数（防放大/崩溃） | fuzz 单测 |
| **SEC-NET-05** | 联机功能开启需用户显式同意（会开放端口/暴露 LAN 世界）；UI 显示「当前监听端口/连接的对端」；一键停止 | E2E |
| **SEC-NET-06** | 不实现「启动器内 HTTP API」给外部调用；渲染进程只走 IPC，不允许 `http://127.0.0.1` 访问主进程能力 | 架构审查 |
| **SEC-NET-07** | 代理设置只影响出站；不把本地服务暴露到代理；`NO_PROXY` 至少包含 `127.0.0.1,localhost` | 单测 |
| **SEC-NET-08** | Windows 防火墙：首次监听若触发弹窗，说明用途；不自动添加放行规则；不请求管理员权限来改防火墙 | 手工验证 |
| **SEC-NET-09** | 联机房间 token/邀请码：高熵、可撤销、限时；日志脱敏；不放入 URL query（放 header/body） | 单测 |
| **SEC-NET-10** | 任何「房间服务」若由我们托管：TLS + 鉴权 + 速率限制 + 滥用告警 + 隐私政策；不记录用户 IP 之外的流量内容 | 运维评审 |

### 7.7 Electron 应用加固（在 40 §3.1 之上补齐）

40 文档已定：`contextIsolation/sandbox/nodeIntegration:false/webviewTag:false`、IPC 发送方校验、导航/开窗拦截、CSP、路径穿越、解压防护、`spawn shell:false`。本节只补**未覆盖**的项。

| ID | 约束 | 验证 |
|---|---|---|
| **SEC-APP-01** | CSP：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.modrinth.com https://*.mojang.com https://*.minecraftservices.com; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`。生产禁 `unsafe-eval`；若必须放宽（如 Vite dev），只在 dev 分支 | 打包产物 CSP 检查 |
| **SEC-APP-02** | 自定义协议 `app://` 加载渲染层（不用 `file://`）；协议处理器做路径规范化 + 只读根目录 | 单测 |
| **SEC-APP-03** | `session.setPermissionRequestHandler` 默认全拒（通知/摄像头/麦克风/地理位置/剪贴板读），只按需开「剪贴板写」 | 单测 |
| **SEC-APP-04** | `setWindowOpenHandler` 一律 `deny`；外链 `shell.openExternal` 前校验 `https:` + 主机白名单（项目页/帮助/购买页）；**不**对用户输入直接 openExternal | 单测 |
| **SEC-APP-05** | 禁止 `remote` 模块、禁止 `enableBlinkFeatures`/`experimentalFeatures`、禁止 `webSecurity:false`、禁止 `allowRunningInsecureContent` | 代码扫描 |
| **SEC-APP-06** | preload 只暴露**契约白名单**通道（40 §5.5）；IPC 入参 zod 校验；未知通道返回 `IPC.UNKNOWN_CHANNEL`；不暴露 `ipcRenderer` 本体 | 单测 + 类型 |
| **SEC-APP-07** | 单实例锁；便携模式判定不写系统目录；**不请求管理员权限**（若检测到以管理员运行，提示风险） | 手工 + 代码 |
| **SEC-APP-08** | 自动更新：只从 https + 固定域名；下载后校验 **Authenticode 签名**（Windows）与发布清单 SHA-256；签名不符拒绝安装；更新前后保留可回滚旧版本 | 发布流程演练 |
| **SEC-APP-09** | 更新失败回滚：替换前备份 `app.asar`/exe；启动失败 3 次自动回滚并提示 | 故障注入 |
| **SEC-APP-10** | Electron 版本策略：只用仍受支持的版本，随 Chromium 安全更新升级；升级走「依赖申请 + 回归」流程（40 §4.6） | 发布检查 |
| **SEC-APP-11** | 禁用 `webview`、禁用 `<iframe src="http...">`（CSP `frame-src 'none'`）；如需内嵌网页（帮助/公告），用 `WebContentsView` + 独立 session + 无 preload | 架构审查 |
| **SEC-APP-12** | 崩溃上报默认**本地生成**、用户确认后才可导出；不接第三方崩溃 SDK（避免隐式上传路径/令牌） | 代码审查 |

### 7.8 日志与隐私

| ID | 约束 | 验证 |
|---|---|---|
| **SEC-LOG-01** | 脱敏在 sink 之前做：键名匹配 `token` / `secret` / `password` / `cookie` / `authorization` / `refresh` / `session` / `accessToken` → `***`；JWT 形态（`eyJ...`）整体替换；argv 中 `--accessToken` 的下一个值 → `***`；URL query 中的 `code/token` 移除 | 回归测试（假 token 样本）常绿 |
| **SEC-LOG-02** | 日志文件 ACL 仅当前用户；滚动 ≤ 10 MB × 5；不写系统临时目录共享位置 | 安装后检查 |
| **SEC-LOG-03** | 崩溃报告/错误报告导出前再脱敏一次（双保险），并去除用户名/路径中的账户名（可选） | E2E：导出后 grep 无 token |
| **SEC-LOG-04** | 默认零遥测；任何网络诊断/统计必须显式 opt-in，且请求体不含账号标识/令牌/实例内容 | 代码审查 |
| **SEC-LOG-05** | 第三方 authlib 服务器域名可记录（排障需要），但**不记录**用户名/密码；失败原因分类记录 | 单测 |
| **SEC-LOG-06** | 「复制错误报告」按钮复制的是**已脱敏**文本；按钮旁注明「已移除登录凭据」 | UI 快照 |

### 7.9 供应链与依赖

| ID | 约束 | 验证 |
|---|---|---|
| **SEC-SUP-01** | 依赖白名单（**GPL-3.0 兼容**）：允许 MIT/BSD-2/3/Apache-2.0/ISC/0BSD/MPL-2.0/LGPL-3.0（仅独立进程）；**禁止** GPL-2.0-only、CDDL、EPL-1.0、专有、SSPL、BSL、Commons Clause；AGPL-3.0 **仅** authlib-injector（其例外条款）；CI 用 `license-checker`/`pnpm licenses` 出清单并卡门禁 | CI |
| **SEC-SUP-02** | 锁文件提交 + `npm ci`；禁止 `postinstall` 未审脚本（40 §4.6 依赖申请）；新增依赖必须写用途/体积/许可证 | PR 模板 |
| **SEC-SUP-03** | 供应链扫描：`npm audit`（或 osv-scanner）高危阻断；Electron/Chromium 高危及时升级 | CI |
| **SEC-SUP-04** | 构建可复现：固定 Node/pnpm 版本（`.nvmrc`/`packageManager`）；构建产物带 SBOM（CycloneDX） | 发布脚本 |
| **SEC-SUP-05** | 发布签名：Windows 代码签名证书（EV 优先）；安装包与更新包都签名；公钥/指纹写进文档 | 发布流程 |
| **SEC-SUP-06** | secret 扫描（gitleaks）+ 禁止在仓库出现 `client_secret`、CF key、私钥；CI 阻断 | CI |
| **SEC-SUP-07** | 第三方二进制（若有）单独目录 + `SHA256SUMS` 文件；发布时校验并在 `THIRD-PARTY-LICENSES` 标注版本/来源 | 发布检查 |
| **SEC-SUP-08** | 禁止从 CDN/镜像「顺手」拉可执行文件到构建机；构建期只从官方源拉依赖（npm registry 固定） | CI 网络策略 |
| **SEC-SUP-09** | GPL-3.0 分发合规：安装包/更新包内含 `COPYING`、`NOTICE`、`THIRD-PARTY-LICENSES.txt`；About/下载页可见 Corresponding Source 获取方式（仓库 tag + 构建说明）；不得附加与 GPL-3.0 冲突的条款；随包的 LGPL/AGPL 组件单独列出许可证与源码 | 发布包解包检查 + 发布清单签字 |

### 7.10 联机房间的信任边界

| ID | 约束 | 验证 |
|---|---|---|
| **SEC-LINK-01** | 房间服务端视为**不可信**：客户端校验服务端下发的网络参数（IP/端口/协议）合法性，拒绝指向非预期主机的参数 | 单测：恶意房间参数 |
| **SEC-LINK-02** | 邀请码是能力凭证：泄露=可加入；UI 提示「仅分享给信任的人」，支持「重置邀请码」踢出所有人 | E2E |
| **SEC-LINK-03** | 进房前做**实例一致性校验**（版本/加载器/关键 mod 哈希），不一致给出可读差异并阻止（01 P0-6 差异化点） | E2E |
| **SEC-LINK-04** | 房主端显示当前成员与流量路径（直连/中继）；可一键断开单个/全部 | E2E |
| **SEC-LINK-05** | 不把「游戏内 LAN 世界」自动暴露到公网：必须房主在游戏内主动「对局域网开放」+ 启动器侧确认 | 手工 + E2E |
| **SEC-LINK-06** | 联机组件崩溃/被杀不影响游戏进程；sidecar 退出码与日志单独采集（脱敏） | 故障注入 |

---

## 8. 工程约束总表（按模块）

> 用法：PR 描述里写「本 PR 满足 SEC-DL-01/02、SRC-01」，reviewer 按表核对。凡属于本轮 P0 交付范围的模块，其下的约束**本轮即为必须**；P1 模块的约束在实现该模块时生效，但不得先违反；发布门禁见 §9。

| 模块 | 任务 | 必守约束 | 备注 |
|---|---|---|---|
| **kernel / IPC**（40 §3.1/§5） | t5；t13 审 | SEC-APP-01~07、SEC-NET-03/06、SEC-LOG-01/02 | CSP、发送方校验、路径断言、无 HTTP 能力面 |
| **download** | t8；t13 审 | SEC-DL-01~14、SRC-01~12、API-01~04/07/13/15 | 哈希矩阵（§7.4）是验收核心；CF 只留 provider 接口（API-07） |
| **version / loader** | t8 + t6 | MC-10~12、SRC-07、SEC-EXE-05/06、SEC-DL-08/09 | 版本 JSON 不进包；installer 校验+临时目录 |
| **java** | t6 | SEC-DL-05、SEC-EXE-04、SRC-08 | 不用 BMCLAPI java 列表；不用 JavaWrapper |
| **auth** | t11；t13 审 | MC-01~06、MC-21~23、SEC-AUTH-01~12、SEC-LOG-01/03/05 | 令牌链、DPAPI、单飞刷新、entitlements、待审批降级 |
| **launch** | t6 | MC-08、MC-12、SEC-LOG-01、SEC-EXE-04 | argv 断言；bat 脱敏；环境变量清洗（见下） |
| **mods / resourcepacks** | t15（内核）+ t16（界面） | SEC-DL-08/09、SEC-EXE-07、API-01~05、LIC-13/15（如用 PCL 规格）、LIC-17（如移植 HMCL） | 只放文件不执行；zip 防护；规格/移植留痕 |
| **instance / store** | t6 | LIC-05、MC-11、SEC-DL-09/10 | 只读 PCL 目录；路径安全 |
| **link（联机）** | t9；t13 审 | NET-01~18、SEC-NET-01~10、SEC-LINK-01~06 | sidecar 生命周期、邀请码、房间信任、LGPL 声明 |
| **updater / 发布包** | t5；t13 审 | SEC-APP-08/09、SEC-SUP-05/07/09、SEC-DL-14 | 若本轮无更新器，则至少做到「发布包签名 + 手动更新说明」 |
| **crash / log** | t6 | SEC-LOG-01~06、SEC-APP-12 | 双脱敏；本地生成 |
| **release / CI / 文案** | t5 + t10（About/免责声明）+ t14（手册） | LIC-09/10/11/12、LIC-17/19/20、SEC-SUP-01~09、MC-14/15、NET-02 | 许可证清单、SBOM、源码可得性、HMCL NOTICE/版权声明（如有移植）、免责声明 |
| **端到端验收** | t12（QA）+ t13（审查） | §9 全部闸门 | 逐条留证（落盘文件 + 命令行 + 日志三件套） |

**额外一条（launch 模块，容易漏）**：spawn Java 前清除会注入 agent/classpath 的环境变量：`JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`、`JDK_JAVA_OPTIONS`、`CLASSPATH`、`JAVA_HOME`（除非用户显式指定 Java 时由我们设置）。验证：单测断言子进程 env 不含这些键。

---

## 9. 发布闸门与负责人归属

### 9.1 闸门清单（G-01 ~ G-20）

**阻断项（任一不满足不得对外发布）**

- [ ] **G-01 许可证与源码可得性**：仓库根有 `COPYING`(GPL-3.0)/`NOTICE`/`THIRD-PARTY-LICENSES.txt`；发布页/About 可见 Corresponding Source（仓库 tag + 构建说明）；CI 许可证门禁通过（LIC-09/10/11、SEC-SUP-01/09）
- [ ] **G-02 源码使用合规**：`docs/clean-room-log.md` 的 PCL 阅读记录（时间/作者/文件/目的/规格路径）完整；实现者未读 PCL 源码；`docs/specs/pcl-*.md` 可追溯；无表达复制/taint（LIC-13/14/15/20）
- [ ] **G-03 包内无 Mojang 资产**：安装包/仓库无 client.jar、libraries、assets、版本 JSON、server.jar、JRE（MC-10/11、API-13）
- [ ] **G-04 免责声明**：About + 安装包元数据含「NOT AN OFFICIAL MINECRAFT PRODUCT…」中英双语（MC-14）
- [ ] **G-05 下载源可见可控**：下载 UI 标注 BMCLAPI/官方来源；镜像可一键关闭（SRC-01/06）
- [ ] **G-06 令牌不落明文**：配置/日志/bat/崩溃报告 grep 不到 `eyJ` 与 `refresh_token`（SEC-AUTH-05、SEC-LOG-01/03）
- [ ] **G-07 本地监听面**：无 `0.0.0.0`；OAuth 回调 PKCE+state+单次；sidecar 仅 loopback + token（SEC-NET-01~03）
- [ ] **G-08 下载完整性**：所有下载路径强制哈希校验；坏哈希/中断续传/zip-slip 用例通过（SEC-DL-01/02/03/08/09）
- [ ] **G-09 第三方二进制**：authlib-injector / EasyTier（/ 若用 frp）版本固定 + SHA-256 + 许可证随附（SEC-EXE-01/03、NET-02/03）
- [ ] **G-10 发布包签名**：安装包/更新包签名校验生效；回滚演练通过（SEC-APP-08/09、SEC-SUP-05/09）
- [ ] **G-11 依赖许可与 SBOM**：依赖与 GPL-3.0 兼容，无 GPL-2.0-only/CDDL/专有/SSPL/BSL；SBOM 生成（SEC-SUP-01/04）
- [ ] **G-12 Mojang 条款口径**：EULA / Usage Guidelines 原文由法务复核一次（Q1）；原版下载口径已定（只做下载器），无需额外动作（§3.6）
- [ ] **G-13 CurseForge 前置**（仅当启用 P1 CF）：API-16~22 全满足，否则保持「跳转 + 本地导入」（§5.2）
- [ ] **G-14 微软登录待审批降级**：未配置 client_id / 403 两条路径均诚实报错，不重试风暴、不静默转离线（MC-21~23）
- [ ] **G-15 随包/移植组件许可**：AGPL authlib / LGPL EasyTier 的许可证与源码链接随附；若移植 HMCL，`NOTICE` + 文件版权头 + 改名/版本区分 + 软件内版权声明保留（LIC-17/19）；GPL 组合作品声明（LIC-11、NET-02、SEC-SUP-09）
- [ ] **G-16 隐私与导出**：崩溃报告/错误报告导出前二次脱敏；默认零遥测（SEC-LOG-03/04/06）

**建议项（本轮尽量）**

- [ ] **G-17** 遥测默认关闭且可审计（SEC-LOG-04）
- [ ] **G-18** 联机中继隐私提示（NET-16）
- [ ] **G-19** 首次启动正版劝导（MC-09）
- [ ] **G-20** Windows 代码签名证书就绪（SEC-SUP-05）

### 9.2 闸门负责人归属（逐条对到任务号）

> 规则：**t5/t8/t9/t11/t13 是五个交付责任任务**（脚手架/安装链/联机/账户/审查）；t6、t10、t15 等按模块承担对应闸门的实现。**主责**负责实现/提供证据；**协同**提供依赖或复核；**t12（QA）**逐条跑并留证「落盘文件 + 命令行 + 日志」三件套；**t13（reviewer）**是唯一签字口，任一阻断项无证据即判 `needs_revision`。

| 闸门 | 主责 | 协同 | 证据落点 | 备注 |
|---|---|---|---|---|
| **G-01** 许可证/源码可得 | **t5**（脚手架/CI/打包） | t13、t14 | 仓库根文件 + 发布页 URL + CI 日志 | 新增依赖先过 t13 |
| **G-02** 源码使用合规 | **t13**（审查） | t5 建模板；全员填 | `docs/clean-room-log.md` + `docs/specs/pcl-*.md` | t13 抽查规格/命名/文案相似度 |
| **G-03** 包内无 Mojang 资产 | **t5**（打包产物） | t8（下载落盘路径）、t13 | 解包清单 + 仓库体积门禁 | 安装器不带 JSON/jar |
| **G-04** 免责声明 | **t5**（安装包元数据）+ **t10**（About UI） | t13 | 截图 + 安装包属性 | 中英双语 |
| **G-05** 下载源可见可控 | **t8**（源适配层/开关） | t10（UI 展示）、t13 | UI 快照 + 配置项 | BMCLAPI 来源必须可见 |
| **G-06** 令牌不落明文 | **t11**（auth） | t6（launch 写 bat）、t13 | grep 脚本 + 脱敏单测 | 含崩溃报告 |
| **G-07** 本地监听面 | **t11**（OAuth 回调） | **t9**（sidecar）、t13 | 端口清单 + 单测 | 两条线都要查 |
| **G-08** 下载完整性 | **t8** | t13 | 坏哈希/续传/zip-slip 测试报告 | 见 §7.4 哈希矩阵 |
| **G-09** 第三方二进制 | **t9**（EasyTier）+ **t11**（authlib） | t5（打包）、t13 | 版本表 + SHA-256 清单 | frp 若启用归 t9 |
| **G-10** 发布包签名 | **t5** | t13 | 签名验证日志 + 回滚演练 | 无更新器也要签安装包 |
| **G-11** 依赖许可/SBOM | **t5** | t13 | `pnpm licenses` + SBOM 文件 | GPL-3.0 兼容白名单 |
| **G-12** Mojang 条款口径 | **captain + 法务**（非任务） | t14 记录 | 法务结论归档 | Q1；Q2 已定 |
| **G-13** CurseForge 前置 | **t8**（provider） | captain + 法务（API-18/20）、t13 | 前置条件清单签字 | 不满足则降级 |
| **G-14** 微软待审批降级 | **t11** | t13 | 两条 E2E 录屏/日志 | 未配置 + 403 |
| **G-15** 随包组件许可 | **t5** + **t9** + **t11** | t13 | `THIRD-PARTY-LICENSES` + 源码链接 | LGPL/AGPL 单列 |
| **G-16** 隐私与导出 | **t6**（日志采集） | **t11**（令牌）、t13 | 脱敏回归测试 + 导出样本 | 双脱敏 |
| G-17 遥测 | t5 | t11、t13 | 配置默认值 | 建议项 |
| G-18 中继提示 | t9 | t10、t13 | UI 文案 | 建议项 |
| G-19 正版劝导 | t11 | t10、t13 | 首启截图 | 建议项 |
| G-20 代码签名 | t5 | t13 | 证书指纹 | 建议项 |

**签字规则**：G-01~G-16 任一未通过 → 不发版；G-13 未启用 CF 时标记「N/A」而非「pass」；G-17~G-20 由 captain 决定是否放行。

---

## 10. 裁定与待办

### 10.1 已决（用户 2026-10-21，已写回正文）

| # | 事项 | 裁定 | 写回位置 |
|---|---|---|---|
| **Q2** | 原版下载合规口径 | **只做下载器**：官方源 + BMCLAPI 镜像；**不在产品内分发游戏文件或 Mojang 资源**；**无需额外法务动作** | §3.6、MC-19/20、G-12 |
| **Q4** | CurseForge 是否接入 | **P1 接入，必须自备官方 key**；P0 不接；受 key 不披露、禁缓存、禁代理隐匿、竞品条款约束 | §5.2、API-07~12/16~22、G-13 |
| **Q6** | 我们自己的许可证 | **GPL-3.0**（非 Apache-2.0）；分发须提供 Corresponding Source，不得附加冲突限制；依赖须 GPL-3.0 兼容 | LIC-09/11/12、§6.6、SEC-SUP-01/09、G-01/G-11 |
| **Q7** | 微软 Azure 应用与 MCE 审批 | **立即自建并提交审核**；**P0 不依赖审批**：client_id 可配置，未获批时诚实报错；获批后按 §3.1.1 接线 | §3.1.1、MC-21~23、G-14 |
| **Q9** | PCL 源码能不能读 | **可以读**（用户 2026-10-21 授权）：仅规格作者、产出行为规格、实现者不读、阅读留痕；**代码仍不可复制/移植/分发衍生**；大范围参考有重度使用风险 | §10.3、LIC-13~16/20 |
| **Q10** | HMCL 能不能移植 | **可以**：GPL-3.0 + §7 附加条款；保留版权头、NOTICE、衍生仍 GPL-3.0、源码、标注修改、改名/版本区分、保留版权声明 | §10.3.3、LIC-17~19 |

### 10.2 仍待定（不阻塞 P0，但影响发布/P1）

| # | 事项 | 现状 | 处理 | 谁定 |
|---|---|---|---|---|
| **Q1** | Mojang EULA / Usage Guidelines 原文复核（本机网络不可达） | 已按条款库逐字引文与公开摘要归纳 | 发布前由法务拉官方原文核对一次（G-12）；不阻塞开发 | captain + 法务 |
| **Q3** | 离线账户的产品表述 | 默认方案已生效：独立类型 + 警告 + 正版劝导，不出现「免正版」「破解」字样 | 营销文案上线前由产品确认；技术侧不变（MC-07~09） | 产品 |
| **Q5** | 联机方案（EasyTier vs frp）与是否自建中继 | t4 决策中；许可证已全部放行（§6），成本与滥用防护是主要风险 | t4 出结论后更新 §6.5/NET-15~17 | captain + t4 |
| **Q8** | CurseForge 的两份法务意见（API-18 代理身份、API-20 竞品条款）与官方 key 申请 | 未启动；仅 P1 启用 CF 时需要 | 先拿意见再写代码；不通过则保持「跳转 + 本地导入」（G-13 标 N/A） | captain + 法务 |

> 收敛结果：v0.3 后**没有阻塞 P0 的待决项**；Q1 只影响对外发布签字，Q8 只在启用 P1 CurseForge 时阻塞；PCL 阅读范围超限时才需要法务介入（§10.3.6）。

### 10.3 第三方源码使用政策（2026-10-21 改判：PCL 可读、HMCL 可移植）

> 用户 2026-10-21 明确：**PCL 源码可以读，不只是 HMCL**；但产出只能是**行为规格**，实现者不得读源码。本节是执行细则；§2 已同步，冲突时以本节为准。

#### 10.3.1 法律三分（分别给结论）

| 行为 | PCL2 | HMCL | 说明 |
|---|---|---|---|
| **阅读**源码以理解行为 | ✅ **可以**（仅规格作者；必须记录） | ✅ 可以 | 阅读通常不构成复制/分发；PCL 指南对“大量参考”另有约束，见 10.3.6 |
| **复制表达**（代码结构、变量命名、注释文本、资源） | ❌ **禁止** | ✅ 允许（GPL-3.0） | PCL 分发许可只授权「原样副本」；HMCL 允许复制，但衍生仍 GPL |
| **分发衍生代码** | ❌ **未授权** | ✅ 允许（GPL-3.0 + §7） | PCL 无修改/衍生授权；HMCL 须改名/版本区分、保留版权声明、提供源码 |

#### 10.3.2 PCL 原文与结论

《PCL 分发有限许可》（`https://shimo.im/docs/rGrd8pY8xWkt6ryW`，2026-06-18 修订版）原文：

> 「“软件” 是指 Plain Craft Launcher（以下简称 “PCL”）及许可方有权许可的相关源代码、二进制文件、资源文件、文档和随附内容。」
>
> 「除本许可明确授予的权利外，许可方保留软件及其相关知识产权中的全部权利。」
>
> 「在不以软件为收费主体的前提下，许可方授予您一项全球范围内、非排他、免版税、不得再许可的有限许可：您可以存储、镜像、备份、上传、下载、向公众提供、传播和再分发**原样副本**。」

仓库 `LICENCE`（2026-10-21，sha `ae3dd050…`）原文：

> 「本指南仅作为说明，不是法律文件或协议。」
>
> 「参考存储库中较大量的内容，以制作或重新实现 PCL 的部分实质功能（例如启动或下载 Java 版 Minecraft，下载或管理 Mod 等）」→ **重度使用**；义务包括：名称以 `Plain Craft Launcher (PCL)` 开头、关于页首位署名+赞助链接、**公开源代码**、继续使用本指南、实现 `McLaunchPrecheck` 正版劝导、Windows 主色为蓝色。

**四问四答（PCL）**

| 问题 | 结论 | 原文依据 |
|---|---|---|
| 允许复制代码吗？ | ❌ 不允许。只授权「原样副本」，不含源码复用 | 《分发有限许可》二、权利 |
| 允许修改吗？ | ❌ 未授权修改/衍生 | 「除本许可明确授予的权利外…保留全部权利」 |
| 允许再分发吗？ | ⚠️ **仅原样副本**，且不得「以软件为收费主体」（付费下载/会员门槛/强制赞助等） | 同上 |
| 允许商用吗？ | ❌ 代码复用/衍生商用无授权；原样副本仅在非「以软件为收费主体」时允许 | 同上 |
| 是否要求同名/同色/开源？ | **仅重度使用**要求：名称以 `PCL` 开头、Windows 主色蓝色、公开源代码并继续使用该指南、正版劝导；轻度使用只要求署名+不混淆 | 仓库 `LICENCE` 一/二 |

> **source-available ≠ open source**：GitHub 可读、可 fork 不等于 OSI 开源；PCL 没有授予修改/衍生/再许可权，不能按 MIT/Apache/GPL 的方式“借用代码”。

**结论**：

- **读可以，抄不行**：阅读源码理解行为不被许可证禁止（用户已授权）；但「原样副本」授权不包含修改、衍生、把源码并入我们的项目。
- **PCL 代码不得移植**：包括逐行翻译 VB.NET→TS、复制类/函数/变量/注释/结构、复制 `.xaml`/`.resx`/资源。
- **PCL 衍生代码不得分发**：没有修改/衍生授权；原样副本再分发虽被允许（非收费主体），但本项目不需要，也不应做。
- **重度使用风险**：如果规格作者大范围通读并逐段转述，即使没有复制代码，也可能被认定为「参考较大量的内容」→ 触发 B 档义务。按 §10.3.6 控制范围并升级。

#### 10.3.3 HMCL 原文与结论

- 仓库：`HMCL-dev/HMCL`（`huanghongxun/HMCL` 同源；README 指向上者），GitHub license = **GPL-3.0**；`LICENSE` 为标准 GPLv3（35,149 B）。
- 源码头示例（`HMCL/src/main/java/org/jackhuang/hmcl/Launcher.java`）：「Copyright (C) 2020 huangyuhui … GNU General Public License … either version 3 of the License, or (at your option) any later version.」
- **兼容性**：HMCL 文件头为 `GPL-3.0-or-later`，可按 GPLv3 使用；本项目为 GPL-3.0（only），衍生整体按 GPL-3.0 分发即可。若未来要改 `or-later`，需 captain 决策（LIC-09）。
- README「Additional terms under GPLv3 Section 7」：
  1. 「When you distribute a modified version of the software, you must change the software name or the version number in a reasonable way in order to distinguish it from the original version.」
  2. 「You must not remove the copyright declaration displayed in the software.」
- 注：附加条款写在 README 的「Additional terms」段（`LICENSE` 文件本身是标准 GPLv3 全文），两者共同构成项目的许可声明；移植时按两者执行。

**移植（Java→TS）义务**：

| # | 义务 | 落地 |
|---|---|---|
| 1 | 保留每个被移植文件的版权头与许可声明 | 文件头原样保留；新增「Portions derived from HMCL, GPL-3.0」 |
| 2 | 加 `NOTICE`/`THIRD-PARTY-LICENSES` 条目 | 项目根与发布物 |
| 3 | 衍生整体仍 GPL-3.0 | 本项目已是 GPL-3.0；不得改成更宽松许可 |
| 4 | 分发二进制时提供 Corresponding Source | 公开仓库 tag + 构建脚本（LIC-09） |
| 5 | 标注修改（日期/作者/变更） | 文件头或 `NOTICE` |
| 6 | 改软件名或版本号以区分原版（§7(c)） | 产品名 `mc-launcher` 已区分；版本号独立 |
| 7 | 不得移除软件内版权声明（§7(b)） | About/许可证页保留 HMCL 版权声明 |
| 8 | 商标/Logo/图标/字体/资源不在 GPL 范围 | 不使用 HMCL 名称/Logo/图标；资源按各自许可 |

#### 10.3.4 两角色流程（强制，防表达污染）

| 角色 | 可以做什么 | 不可以做什么 |
|---|---|---|
| **规格作者**（1 人） | 读 PCL 源码；把行为提炼成 `docs/specs/pcl-<module>.md`；登记阅读记录 | 不实现该模块；不复制代码/结构/命名/注释；不写逐行伪代码 |
| **实现者**（另 1 人） | 只读规格 + 公开规范 + 黑盒行为；写 TS 实现 | **不得打开 PCL 源码**；不得向规格作者索要源码片段 |

**规格内容白名单**：接口形状、参数含义、文件格式、状态机、错误分类、进度阶段、边界条件。
**规格内容黑名单**：逐行伪代码、变量/函数/类命名、注释原文、目录/类结构映射、UI 文案、资源路径清单、任何可直接还原源码的细节。

**阅读记录**（写入 `docs/clean-room-log.md`）：`日期 | 作者 | 仓库/分支/commit | 文件或目录 | 目的（要回答的行为问题） | 产出规格路径 | 是否复制内容（必须为否） | 复核人`。

#### 10.3.5 可借用清单（文件级，照做即可）

> 路径口径：PCL 相对 `Plain Craft Launcher 2/`；HMCL 相对仓库根 `HMCL-dev/HMCL`。只给路径，不代表已读内容。

**✅ 可直接移植/复用**（许可允许）

| 来源 | 路径 | 许可 | 义务 |
|---|---|---|---|
| HMCL | `HMCLCore/src/main/java/org/jackhuang/hmcl/{auth,download,game,java,launch,modpack,task,util}/**` | GPL-3.0 | §10.3.3 八条；保留版权头/NOTICE |
| HMCL | `HMCL/src/main/java/org/jackhuang/hmcl/**`（控制器/业务逻辑） | GPL-3.0 | 同上；UI 结构/文案不要照搬，按 design 自建 |
| MeloongCore | `Meloong-Git/MeloongCore`（PCL 的 .NET 子模块） | Apache-2.0 | 保留 NOTICE/版权；与 PCL 主仓库**分开判定**；我们不用 .NET，除非移植算法 |
| PCL2Help | `LTCatt/PCL2Help` | CC0-1.0（clean-room log CR-001 记录） | 可复用文档内容；仍建议注明来源 |

**⚠️ 只读源码写行为规格，不拷贝代码**（PCL）

| PCL 路径（仅文件名） | 可提炼什么 | 约束 |
|---|---|---|
| `Modules/Minecraft/ModLaunch.vb` | 启动阶段、参数顺序、预检、退出分类 | 只写行为；不得映射类/函数结构 |
| `Modules/Minecraft/ModDownload.vb` | 下载队列、源切换、校验、断点、进度阶段 | 同上 |
| `Modules/Minecraft/ModJava.vb` | Java 探测顺序、选择规则、错误分类 | 同上 |
| `Modules/Minecraft/ModMinecraft.vb` | 版本/资源/目录行为 | 同上 |
| `Modules/Minecraft/ModModpack.vb` | 整合包识别/导入流程 | 同上 |
| `Modules/Minecraft/ModCrash.vb` | 崩溃规则分类、报告字段 | 同上 |
| `Modules/Base/ModNet.vb`、`ModLoader.vb` | 网络重试/加载器识别行为 | 同上 |
| `Modules/Base/ModBase.vb`、`ModEvent.vb`、`PclLogger.vb` | 日志/事件/生命周期行为 | 同上 |
| `Modules/Resource/ResourceProject.vb`、`ResourceSearcher.vb`、`ResourceVersion.vb` | 资源搜索/版本匹配行为 | 同上 |
| `Modules/ThirdParty/DragHelper.vb` | 拖拽行为、文件类型判断 | 只写行为；Dropzone 自建 |
| `Pages/*.xaml`（UI） | **不看源码**；只用运行中的 UI 黑盒观察 | 复制 XAML/文案/布局禁止 |

**❌ 绝对别碰**

| 来源 | 路径 | 原因 |
|---|---|---|
| PCL | `Modules/ModSecret.vb` | 加解密/许可/赞助解锁敏感区；读了也不能用，直接禁止（captain 指定） |
| PCL | `Modules/Base/ModValidate.vb` | 校验/反篡改逻辑；安全敏感，禁止 |
| PCL | `Modules/ModDevelop.vb` | 开发者/调试入口；与本产品无关，禁止 |
| PCL | `Modules/ModMusic.vb`、`Musics/`、`Pictures/`、`*.png/*.ico/*.wav` | 资源/音乐/图标不在授权内 |
| PCL | `*.resx`、`*.xaml` 内容、`最新正式版.zip`、任何 PCL 二进制 | 字符串表/UI 表达/二进制；禁止复制/分发 |
| PCL | 任何 `.vb` 代码片段、类/函数/变量/注释 | 无复制/衍生授权 |
| HMCL | `HMCL/src/main/resources/assets/**`（Logo/图标/主题/字体） | GPL 不自动覆盖商标/品牌资源；不使用 |
| HMCL | `HMCLBoot/**`（原生启动器）、`lib/**`（第三方 jar） | 原生/第三方许可需逐个审；默认不碰 |
| HMCL | `countly` 遥测相关代码 | 隐私政策冲突（我们零遥测） |
| 任意 | 无 LICENSE / 自定义限制 / 来源不明的代码 | 默认禁止；先过 §10.3.7 |

#### 10.3.6 范围升级（重度使用风险闸门）

- **单次阅读范围**：一个行为问题 ≤ 2 个文件；**超过 3 个文件或整文件通读，先报 captain + 法务**，并说明是否会让规格变成“整模块转述”。
- **触发信号**：规格里出现“按源码顺序列出每个分支/每个函数”、或实现者能据此还原类结构 → 视为重度使用风险，停止并升级。
- **二选一**：收缩规格范围（只保留行为结论），或接受 B 档义务（PCL 前缀/蓝色/同指南/正版劝导）——后者改变产品定位，必须 captain 书面决策。
- **记录**：升级与决策写入 `clean-room-log` 与本节变更记录。

#### 10.3.7 约束与验证

| ID | 约束 | 验证 | 责任 |
|---|---|---|---|
| **LIC-13** | 角色隔离：只有规格作者读 PCL 源码；实现者不得读；规格作者不得实现对应模块 | PR 声明 + clean-room log + reviewer 抽查 | architect / reviewer |
| **LIC-14** | 每次 PCL 源码阅读必须登记（时间/作者/文件/目的/规格路径/是否复制） | clean-room log 完整；缺记录即拒收 | 规格作者 / reviewer |
| **LIC-15** | 规格只含行为白名单内容；禁止逐行伪代码/命名/注释/结构映射 | 规格评审 + 代码相似度抽查 | reviewer |
| **LIC-16** | PCL 代码不得复制/移植/分发衍生；不得分发 PCL 二进制/资源 | 仓库/安装包扫描；`grep` 黑名单 | architect / qa |
| **LIC-17** | HMCL 移植必须履行 §10.3.3 八条（版权头/NOTICE/衍生 GPL/源码/标注修改/改名/版权声明/资源例外） | PR 检查表 + `THIRD-PARTY-LICENSES` | 实现者 / reviewer |
| **LIC-18** | HMCL/PCL 的商标、Logo、图标、字体、音乐、`.resx`/`.xaml` 资源不随代码许可 | 发布物资源审查 | client-dev / architect |
| **LIC-19** | 发布门禁：`NOTICE`/`THIRD-PARTY-LICENSES` 列 HMCL（如有移植）；源码可得；改名/版本区分；版权声明保留 | G-01/G-15 + 解包检查 | architect / qa |
| **LIC-20** | 违规处置：实现者读 PCL 源码 → taint 重写；复制表达 → 删除/重写；HMCL 缺声明 → 阻断发布 | 事件记录 + 复核 | reviewer / captain |

#### 10.3.8 PR / 发布检查（复制到模板）

- [ ] 本 PR 是否使用 PCL 源码？→ 若是，附 `docs/specs/pcl-*.md` 路径 + 阅读记录；实现者声明“未读源码”。
- [ ] 是否复制 PCL 代码/结构/命名/注释/资源？→ 必须为否；reviewer 抽查。
- [ ] 是否移植 HMCL？→ 附文件清单 + 版权头 + NOTICE + 修改标注；确认衍生仍 GPL-3.0。
- [ ] 是否使用 HMCL/PCL 的 Logo/图标/字体/音乐/`.resx`/`.xaml`？→ 必须为否。
- [ ] 发布物是否含 HMCL 版权声明与源码链接？→ 是（如有移植）。

---

## 11. 附录

### 11.1 A. 证据摘录

**A.1 PCL `LICENCE`（GitHub API，sha `ae3dd05…`，2026-10-21 抓取）关键句**

> 「本指南仅作为说明，不是法律文件或协议。」
> 「除《PCL 分发有限许可》明确授予的权利外，开发者保留软件及其相关知识产权中的全部权利。」
> 「参考存储库中较大量的内容，以制作或重新实现 PCL 的部分实质功能（例如启动或下载 Java 版 Minecraft，下载或管理 Mod 等）」→ 重度使用。
> 重度使用义务：「名称必须以 Plain Craft Launcher (PCL) 开头」「公开源代码，且继续使用本文件作为指南」「实现与 McLaunchPrecheck 函数一致（或更激进）的 Minecraft 正版购买劝导与赞助劝导」「界面的主要色相必须为蓝色」。

**A.2 社区镜像**

`tangge233/PCL2`：`"fork": true`，`parent.full_name = "Meloong-Git/PCL"`，`license.spdx_id = "NOASSERTION"`（GitHub API，2026-10-21）。

**A.3 Mojang 元数据实测（2026-10-21）**

- `https://launchermeta.mojang.com/mc/game/version_manifest_v2.json` 可达；`latest.release = 26.3`，`versions = 920`。
- 1.20.1 版本 JSON：`downloads.client.sha1 = 0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838`，`size = 23028853`；`assetIndex.sha1 = 8a45c6be38ac9486b04944bffcb96f8aae1b0649`，`size = 413067`；`javaVersion.majorVersion = 17`；**88/88 个 libraries 带 `sha1`**（样例 `ca.weblite:java-objc-bridge:1.1`）。
- `https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json` 同样可达，版本数一致。

**A.4 本机二进制指纹（`E:\MC\PCL`，只读）**

| 文件 | 大小 | SHA-256 |
|---|---|---|
| `authlib-injector.jar` | 344,477 | `EAF14BC5ACFFC7D885BD5BD5942B99F36D6299302BEAE356B2FC5807FE42652B` |
| `JavaWrapper.jar` | 16,345 | `88EB3EE58854E916437831697EF6A2FD493DA9BC4FFB018F620CD88F090952AA` |

**A.5 Modrinth 实测（2026-10-21）**

`GET https://api.modrinth.com/v2/project/sodium/version?limit=1`：文件 `sodium-fabric-0.9.3-beta.1+mc26.3.jar`，`size=1912496`，`sha1=1e6aec…187e`，`sha512=884a1e…2419`，下载主机 `cdn.modrinth.com`。

**A.6 BMCLAPI 条款原文**：见 §4.1（apiDoc「关于/协议」）。

**A.7 CurseForge 条款原文**：见 §5.2（3rd Party API Terms §2.2/§3.1；Project Distribution Toggle）。

**A.8 Minecraft Usage Guidelines 免责声明**（ConductAtlas 抓取 2026-09-11，原文 SHA-256 `a8b646…809f`；官方 URL `https://www.minecraft.net/en-us/usage-guidelines` 本机不可达）。

**A.9 微软令牌生命周期**（Microsoft Learn「Refresh tokens in the Microsoft identity platform」，更新于 2025-11-05）：SPA/邮件 OTP 24h，其它 90 天；每次使用会换新，服务端不立即吊销旧的，**必须安全删除旧 token**。

**A.10 Electron safeStorage**（官方文档）：Windows = DPAPI，保护其他用户/离线磁盘，**不防同用户其它程序**；Linux 无 secret store 时退化为 `basic_text`（等同无保护）。

**A.11 用户裁定记录（2026-10-21，captain 转达）**：①Q6 自身许可证 = GPL-3.0；②Q7 立即自建 Azure 应用并提交 `aka.ms/mce-reviewappid`，P0 不依赖审批，按「client id 可配置 + 未获批诚实报错」实现；③CurseForge = P1 接入、自备官方 key；④Q2 原版下载 = 只做下载器（官方 + BMCLAPI），不分发游戏文件/Mojang 资源，无需额外法务动作。以上已写回 §0/§2.3/§3.1/§3.6/§5.2/§6.6/§7.9/§9/§10。

**A.12 《PCL 分发有限许可》原文（shimo.im/docs/rGrd8pY8xWkt6ryW，2026-06-18 修订版，2026-10-21 抓取）**

> 「“软件” 是指 Plain Craft Launcher（以下简称 “PCL”）及许可方有权许可的相关源代码、二进制文件、资源文件、文档和随附内容。」
> 「除本许可明确授予的权利外，许可方保留软件及其相关知识产权中的全部权利。」
> 「在不以软件为收费主体的前提下，许可方授予您一项全球范围内、非排他、免版税、不得再许可的有限许可：您可以存储、镜像、备份、上传、下载、向公众提供、传播和再分发**原样副本**。」

**A.13 HMCL 许可（GitHub API + README，2026-10-21）**

- `HMCL-dev/HMCL`（与 `huanghongxun/HMCL` 同源）`license.spdx_id = GPL-3.0`；`LICENSE` 35,149 B，标准 GPLv3。
- `HMCL/src/main/java/org/jackhuang/hmcl/Launcher.java` 文件头：`Copyright (C) 2020 huangyuhui … GNU General Public License … either version 3 of the License, or (at your option) any later version.`
- README「Additional terms under GPLv3 Section 7」：①修改后分发须以合理方式改软件名或版本号以区分原版（§7(c)）；②不得移除软件中显示的版权声明（§7(b)）。

### 11.2 B. 术语

- **clean-room（本项目改判后）**：规格作者可读源码，但只产出行为规格；实现者不读源码、不复制表达。称为「source-read spec / 规格隔离」。
- **重度使用**：PCL 自定义许可证中的档位，触发一套与产品定位冲突的义务（见 §2.1/§10.3.2）。
- **DPAPI**：Windows 用户级数据保护 API，Electron `safeStorage` 在 Windows 的实现基础。
- **能力凭证**：邀请码/房间 token 这类「持有即可用」的凭据，不等同于身份凭证。

### 11.3 C. 与 01/40 的对齐与需要修正的三处

1. **`01-requirements.md` §2.1/§3.1 把「公开源码目录」列为证据来源**：按 2026-10-21 改判，PCL 源码**可以读**，但只有规格作者读、产出行为规格；01 的表述应改为「行为规格（`docs/specs/pcl-*.md`）/目录树/二进制实测」，不要写“源码显示”；实现者仍只读规格。
2. **`01-requirements.md` §3.2/§4.3 的「PCL2 实测」表述**：建议统一改成「PCL 2.14.0.0 二进制/日志实测」，不要写「源码显示」。这不是文字洁癖——它是将来被质疑时唯一能自证的证据链。
3. **`40-architecture.md` 需同步两处**：①§15 的 R-13「EasyTier 许可证未审」已由本文 §6.6 关闭（结论：成立，见 NET-01~05/18）；②§4.6 的依赖白名单需按 GPL-3.0 兼容性重写（LIC-11、SEC-SUP-01），不要再用「禁 GPL」的旧口径。

其余：01 的「永久不做：盗版与绕过正版验证」与本文 MC-07~09 一致；40 §3.1/§6.3/§6.9 的安全基线与本文件 SEC-APP/SEC-AUTH/SEC-NET 一致，无需改动。

### 11.4 D. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 0.1 | 2026-10-21 | 首版：PCL 许可证裁定、clean-room 规程、Mojang/MS 边界、BMCLAPI/Modrinth/CurseForge 条款、联机组件许可、安全基线与约束总表 |
| 0.2 | 2026-10-21 | 写回用户裁定：Q6 改 GPL-3.0（+§6.6 兼容性复核、LIC-11/12、SEC-SUP-09）；Q7 微软登录立即申请、P0 不依赖审批（+§3.1.1 端点/权限清单、MC-21~23）；CurseForge 改 P1 接入自备 key（§5.2 重写、API-16~22 前置条件）；Q2 原版下载定为只做下载器（§3.6、MC-19/20）；新增 §9 闸门 ID（G-01~G-20）与 §9.2 任务归属（t5/t8/t9/t11/t13 等）；§10 收敛为已决/待定（无阻塞 P0 项） |
| 0.3 | 2026-10-21 | 按用户补充裁定重核：PCL **源码可读**（仅规格作者；产出行为规格；实现者不得读；阅读留痕；大范围参考仍可能触发重度使用，设范围升级闸门），PCL **代码仍禁止复制/移植/分发衍生**；HMCL 确认为 **GPL-3.0 + GPLv3 §7 附加条款**（改名/版本区分、保留版权声明），**允许移植**，列出八条义务；新增 **§10.3 第三方源码使用政策**（法律三分、原文引用、角色隔离、文件级可借用清单、范围升级、LIC-13~20、PR/发布检查）；§0 增至 18 条裁定；§2.2/2.3/2.4/2.5 重写；G-02/G-15 更新。影响任务：t15/t16（mods 移植/规格）、t5/t13（评审与门禁）、t37（本次重核） |
