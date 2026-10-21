# Cubit Launcher（仓库名 `mc-launcher`）

> **当前发布状态（2026-10-21）**：**P0 未通过，不得对外称“可用”**。
> 依据 [`docs/05-acceptance-report.md`](docs/05-acceptance-report.md)：9 张 P0 卡中 **P0-0、P0-2 通过**；**P0-1、P0-3、P0-4、P0-5、P0-6、P0-7 存在阻断**；**P0-8 通过但 A8.3/8.4/8.5/8.7 证据不足**；16 步冒烟未达 16/16。
> 本 README 只写有证据的能力；**P1/P2 与未通过验收的项不会写成“已可用”**。

Cubit Launcher 是一个 **Windows x64、中文优先、clean-room** 的 Minecraft 启动器：Electron + TypeScript + React，目标覆盖实例/版本、安装下载、Java、账户、启动参数、模组/资源包/光影、整合包、日志/崩溃、联机。它**没有复制或移植 PCL2 源码**，只参考 PCL2 的黑盒行为、落盘格式与公开规范；许可证为 **GPL-3.0**（见 [`LICENSE`](LICENSE)、[`NOTICE`](NOTICE)）。

---

## 1. 快速开始

### 1.1 运行已打包版本

```bat
:: 仓库根目录双击，或命令行
start.cmd

:: 带独立数据目录 / MC 目录
start.cmd --data-dir D:\mcl-data --mc-dir E:\MC\.minecraft
```

`start.cmd` 会清掉 Agent/DSH 终端注入的 `ELECTRON_RUN_AS_NODE`（不清会让 Electron 以 Node 模式启动、直接退出），并在 `DSH_SHELL=1` 时附加 `--no-sandbox --disable-gpu --disable-software-rasterizer`（仅测试环境需要；普通桌面双击不需要这些参数）。

绕过 SmartScreen 的启动方式：

```powershell
powershell -ExecutionPolicy Bypass -File .\launch.ps1 --data-dir D:\mcl-data --mc-dir E:\MC\.minecraft
```

> 应用**未签名**。Windows 首次运行可能出现“Windows 已保护你的电脑”；可选“更多信息 → 仍要运行”，或使用 `launch.ps1`（它用 `CreateProcessW` + `DETACHED_PROCESS` 启动，不触发 SmartScreen）。

### 1.2 开发模式

在 `D:\DSH-工作文件` 下（PowerShell 的 `npm.ps1` 被执行策略拦截，统一用 `npm.cmd`）：

```powershell
npm.cmd --prefix mc-launcher install
npm.cmd --prefix mc-launcher run typecheck
npm.cmd --prefix mc-launcher run test
npm.cmd --prefix mc-launcher run build
npm.cmd --prefix mc-launcher run pack
npm.cmd --prefix mc-launcher run e2e:install-launch
```

开发模式：

```powershell
cd mc-launcher
npm.cmd run dev
```

> 在本机 DSH Agent 沙箱里，Chromium OS 级 sandbox 可能无法初始化；如需跑 `dev`，先清 `ELECTRON_RUN_AS_NODE`，再用 `npm.cmd run dev -- --noSandbox`（仅开发环境；普通桌面不需要）。

### 1.3 目录参数

| 参数 | 环境变量 | 作用 |
|---|---|---|
| `--data-dir <abs>` | `MCL_DATA_DIR` | 配置、日志、账户、缓存、回收站 |
| `--mc-dir <abs>` | `MCL_MC_DIR` | `.minecraft` 根（versions/libraries/assets） |
| `MCL_PORTABLE=1` | — | 强制便携：`<exeDir>/data` |
| `MCL_PORTABLE=0` | — | 强制 `%APPDATA%\mc-launcher` |

未指定时：打包版默认 `<exeDir>/data`，开发模式默认 `<cwd>/data`；便携目录不可写时回退 `%APPDATA%\mc-launcher` 并记录警告。**dataRoot 与 mcRoot 分离**：换 MC 目录不会丢账户/日志，卸载应用不会碰游戏目录。

```text
dataRoot/
├── config.json                 # 设置
├── accounts.json               # 账户（离线 name/uuid；微软 refresh token 走 safeStorage）
├── logs/launcher.log           # 人类可读
├── logs/app-YYYYMMDD.jsonl     # 机器可读
├── logs/game/<实例>/<时间>.log  # 启动器捕获的游戏输出
├── logs/launch-last.json/.bat  # 最近一次命令行（脱敏）
├── backups/                    # 存档/崩溃诊断包等
├── modules/                    # 各模块私有数据
└── trash/                      # 删除入回收站（可恢复，无永久删除入口）
```

---

## 2. 当前能力（对照 `docs/01-requirements.md` v1.6；范围与 v1.5 相同，1.6 仅修 B8 数值）

状态图例：✅ 05 有证据通过；🟡 部分实现/证据不足；⛔ 05 判定阻断；❌ 未实现。
**“05 后已改”不等于通过**：05 之后 t46–t53 有修复，但没有按 01 v1.5 重跑全量 16 步，因此下表不把它们写成 ✅。

### 2.1 P0（交付门禁）

| P0 | 能力 | 状态 | 依据 / 说明 |
|---|---|---|---|
| P0-0 | 骨架、UI 页面/主题、数据目录、实例识别 | 🟡 **PASS，但 A0.8 部分** | 15 实例、3 缺 JSON、只读零改动、主题重启保持；A0.8 的“每页加载态/启动 6 态”未逐一演示 |
| P0-1 | 版本解析 + 全新安装 1.20.1 + 启动 | ⛔ **FAIL（B1）** | 历史安装 425 s/哈希全对/主菜单；本次连续 3 次全新安装因镜像 CDN 超时 + 源熔断失败（`DOWNLOAD.NO_SOURCE`） |
| P0-2 | 离线账户 | ✅ **PASS** | UUID/四件套/非法名/重启保持均通过 |
| P0-3 | Java 自动检测 | 🟡 **后端 PASS，UI/错误码 FAIL** | 4 候选、1.20.1 选 17；05 时 Java 选择 UI 禁用、错误码被 `IPC.HANDLER_FAILED` 包裹 |
| P0-4 | 内存/JVM/窗口参数 | 🟡 **后端 PASS，UI FAIL** | argv/4096/1280×720/全屏/G1/natives/A-B 隔离通过；05 时设置页控件 disabled |
| P0-5 | 日志与崩溃提示 | ⛔ **FAIL** | 日志/`launch-last.*` 齐全、坏 JVM 参数 293 ms 出 `jvm-args`；但 05 时无自动弹窗、报告路径/格式不符、无日志轮转 |
| P0-6 | 联机：房间 + LAN 世界 + 隧道降级 | ⛔ **FAIL（L0 未闭环）** | 开房/加入/关闭 3.1 s/版本不匹配通过；05 时房主不计入成员、ping null、LAN 世界与进世界未闭环；L2 未验 |
| P0-7 | 微软设备码 / Authlib / 多账户 | 🟡 **错误路径/Authlib 注入 PASS；UI/实机 FAIL** | `MS_CLIENT_ID_MISSING` 诚实失败、Authlib 1.2.8 SHA-256/`-javaagent` 正确；05 时无微软/Authlib UI 入口，Authlib 未到主菜单 |
| P0-8 | 模组/资源包/光影 + 整合包 | 🟡 **PASS，证据不足** | 三目录扫描/启停/冲突/删除、拖拽+选择文件两入口、mrpack 导入通过；A8.3/8.4/8.5/8.7 未做端到端 |

**16 步冒烟**：05 时第 3、8、15 步失败，第 4 步仅历史证据，第 13 步部分；**未达 16/16**。
**05 之后已有代码改动（未复验，不算通过）**：账户页已接微软/Authlib UI、设置页已接实例/下载、主页运行态已切到“运行中”、日志轮转已实现、net 已有 `lanWorlds/joinLanWorld`、crash 已写 `crash-reports/`。这些仍需按 01 v1.5 重跑 16 步后才能改状态。

### 2.2 P1（本轮不验收，仅记录实现状态）

| 项 | 状态 | 说明 |
|---|---|---|
| Forge/NeoForge/Fabric 安装 | 🟡 部分 | Fabric/Quilt 真实安装 PASS（05 §3.2）；Forge 仅 plan/hash（opt-in 未执行）；NeoForge `hashSource=none` 默认拒绝，属预期安全行为 |
| Java 自动下载 | 🟡 后端有、UI 未验 | `java.download` 后端与 Adoptium/Microsoft 包安装代码在树；05 未提供 UI/端到端证据 |
| 服务器列表/自动进服 | ❌ 未实现 | 无独立 server 模块；联机页只做房间 |
| 备份/还原 | 🟡 部分 | 存档备份 zip（t39/t44）可用；**实例级备份/还原未实现** |
| 完整设置 | 🟡 部分 | 全局设置页已接启动/Java/下载/账户；实例详情“设置”tab 仍是 `UnwiredTab` |
| 系统集成 | 🟡 脚本级 | `start.cmd`/`launch.ps1`；快捷方式/文件关联/单实例未做 |
| 下载增强 | 🟡 部分 | 镜像/源切换/并发/断点在树；05 的 B1 未复验 |
| PCL 目录只读兼容 | ❌ 未实现 | P0 只扫描 `versions/`，不读 PCL `Setup.ini` |
| 实例删除/多 MC 文件夹 | 🟡 部分 | 实例列表/详情/模组可用；删除与多文件夹未由 05 覆盖 |
| 联机重连/一致性指纹 | 🟡 部分 | 心跳/重连/票据代码与测试在树；L0 实机未闭环，mod 指纹未做 |

### 2.3 P2（暂缓/可选）

| 项 | 状态 |
|---|---|
| Quilt 安装 | ✅ 真实安装 PASS（05 §3.2；优先级 P2） |
| OptiFine / LiteLoader | ❌ 未实现 |
| 整合包导出 | 🟡 已实测导出+导入 341 B `.mrpack`；带 mods/overrides 未复跑（05 A8.3 PARTIAL） |
| Mod 在线搜索/安装/更新（Modrinth） | ✅ 资源库/模组更新页面已接真实 `mc:catalog:*`（t43/t45；更新检查为真实空结果） |
| 数据包/世界下载 | ❌ 未实现 |
| 自定义主页/音乐/皮肤/帮助/公告/遥测/更新器 | ❌ 未实现（About 页明确标注“尚未接入”） |

---

## 3. 已知阻断与残留（必须如实阅读）

### 3.1 `docs/05` 的 B1–B8（P0 不能称可用的原因）

| ID | 05 阻断 | 当前状态（2026-10-21 晚） |
|---|---|---|
| B1 | 下载源熔断导致全新安装 100% 失败 | t46 已落 per-source 断路器（t52/t54 称安装链通过）；**05 后未重跑空目录全新安装** → 待复验 |
| B2 | 设置页未接线（内存/窗口/JVM/Java/实例设置） | 全局设置页已接线；**实例详情设置 tab 仍占位**；未复验 |
| B3 | 领域错误码被 `IPC.HANDLER_FAILED` 包裹 | t53 加 `technicalMessage/causeCode` 透传；未复验 |
| B4 | 崩溃无自动弹窗、报告路径不符、无日志轮转 | 日志轮转/`crash-reports/` 已实现；**自动弹窗仍未实现**；未复验 |
| B5 | 联机 L0 未闭环（房主成员/ping/LAN 世界/进世界） | 代码已有 `lanWorlds/joinLanWorld` 与房主成员；**未按 05 复验** |
| B6 | 微软/Authlib 无 UI 入口 | 账户页已接微软设备码/Authlib 表单；**Authlib 实机到主菜单未复验** |
| B7 | P0-8 的 CF zip/Zip-Slip/普通 zip/无加载器提示证据不足 | 未关闭；仅单测 |
| B8 | 01 的 A1.3/A1.4 数值笔误 | **已修**：01 v1.6 改为 `8a45c6…` / `651,728,646`（磁盘去重 `651,496,644`） |

### 3.2 三轮审查透明账（代码审查 ≠ P0 验收）

| 轮次 | 结论 | 发现 | 处置 |
|---|---|---|---|
| t35（第 1 轮） | needs_revision | 3 high / 6 medium / 5 low，共 14 条 | H1–H3 高危、H4–H9 中危已修；H10–H12/H14 低危已修；**H13 未修**（安装器中文输出逐 chunk UTF-8 解码） |
| t52（第 2 轮） | needs_revision | 新增 **1 high + 3 medium + 4 low**（N1–N8）；另有上一轮未关闭项 | N1–N8 由 t51/t53 修复；H9/H11/H12/H14 已修；H13 仍开 |
| t54（第 3 轮） | **pass（放行代码审查）** | 0 high / 0 medium；4 low + 2 观察（R1–R6） | 见下；**不等于 P0 验收通过**，05 的 B1–B8 仍需复验 |

**t54 残留（P1，约半天）**：

- **R1 / H13（未修）**：`modules/loader/core/installer.ts:176-178` 仍是逐 chunk `new TextDecoder('utf-8')`；中文 Windows 下 Forge/NeoForge 安装器输出会花屏/截断多字节字符。**不影响机器可解析的英文进度与安装正确性**，但 t53 报告“logEncoding 单 decoder 已满足”**不实**，以此为准。
- **R2**：`helpSupportsSecretEnv` 的 `|| --network-secret` 臂让 fail-closed 判据几乎恒真；应只认 `ET_NETWORK_SECRET`，并补“只有 flag → false”断言。
- **R3**：`isTrustedUrl` 的 packaged/dev 分支无单测（建议 4 例）。
- **R4**：dev 态 origin 全等比较（`127.0.0.1` vs `localhost`）可能拒掉开发态 IPC；打包态不受影响。
- **R5**：全量 vitest 偶发“全绿但 exit 1”（socket 测试未回收）；复跑 exit 0，按 flake 记录。
- **R6**：`LAUNCH.PATH_TOO_LONG`（240 字符预检）已补进 [`docs/03-architecture.md`](docs/03-architecture.md) §9.2。

---

## 4. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 双击 exe 没反应/闪退，终端里是 `ELECTRON_RUN_AS_NODE` | Agent/DSH 终端会把 Electron 当 Node。用 `start.cmd`（会清变量）或手动 `set ELECTRON_RUN_AS_NODE=` / `Remove-Item Env:\ELECTRON_RUN_AS_NODE` |
| Windows SmartScreen 拦截 | 应用未签名。`launch.ps1` 可直接绕过；或“更多信息 → 仍要运行” |
| `npm` 报“无法加载 npm.ps1，因为在此系统上禁止运行脚本” | PowerShell ExecutionPolicy。统一用 `npm.cmd`（或 `cmd /c npm`） |
| 全新安装卡在 assets，最后 `DOWNLOAD.NO_SOURCE` | 05 的 B1：镜像 CDN 超时后源被熔断。可到 设置 → 下载 切换源/开关镜像后重试；**不要据此认为安装已通过验收** |
| 找不到 Java | 设置 → Java 选择已有候选；`java.download` 后端存在但当前 UI 未暴露自动下载入口。本机可用 `%APPDATA%\.minecraft\runtime\*` 或 `tools\jdk21`（若存在） |
| 微软登录提示 `MS_CLIENT_ID_MISSING` / `MS_AUTH_NOT_APPROVED` | 这是**诚实的未配置/待审批**状态；不会伪造登录。请先用离线或 Authlib 账户。MCE 审批结果到货后再配置 client id |
| Authlib 登录失败 | 只支持 HTTPS 皮肤站；启动器会注入 `-javaagent`，不改原版 jar。若皮肤站不可达，会明确报错而不是卡死 |
| 联机进不去 LAN 世界 | 05 时 L0 未闭环；当前代码已有 `lanWorlds/joinLanWorld`，但未复验。跨网 P2P/中继为条件项，失败时按 UI 的手动端口映射指引处理 |
| 崩溃没有自动弹窗 | 05 的 B4 未关闭；当前请在 日志 → 分析最近一次崩溃 手动分析，或导出诊断包 |
| 日志/诊断包在哪 | 设置 → 日志与诊断 打开数据目录；日志页可导出 `logs.zip` / `diagnostics.zip`；游戏输出在 `dataRoot/logs/game/<实例>/` |

---

## 5. 目录与文档

```text
mc-launcher/
├── src/main/                 # Electron 主进程（kernel + modules/<name>）
├── src/preload/              # contextBridge 白名单
├── src/renderer/             # React UI（app/pages + data adapter）
├── src/shared/               # 共享契约（zod schema + 类型）
├── scripts/                  # e2e / frozen guard / clean / ensure-electron
├── docs/                     # 01 需求、02 合规、03 架构、04 联机、05 验收、06 手册、07 交接、08/09 研究
├── design/                   # 高保真原型与设计规范
├── release/win-unpacked/     # pack 产物（gitignore）
├── package.json / lock       # 冻结依赖与脚本
└── start.cmd / launch.ps1    # 包装启动器
```

关键文档：

- [`docs/01-requirements.md`](docs/01-requirements.md) — P0/P1/P2 范围与逐条验收（v1.6）
- [`docs/02-compliance-security.md`](docs/02-compliance-security.md) — 许可证/条款/安全基线
- [`docs/03-architecture.md`](docs/03-architecture.md) — 模块、IPC、数据目录、错误码
- [`docs/04-multiplayer-design.md`](docs/04-multiplayer-design.md) — 联机选型、房间协议、降级链
- [`docs/05-acceptance-report.md`](docs/05-acceptance-report.md) — **发布判定以此为准**
- [`docs/06-user-guide.md`](docs/06-user-guide.md) — 用户手册
- [`docs/07-handoff.md`](docs/07-handoff.md) — 交接、模块扩展、残留与路线图
- [`docs/clean-room-log.md`](docs/clean-room-log.md) — clean-room 记录

---

## 6. 许可证与免责声明

本项目代码为 **GPL-3.0**（GPLv3）：见 [`LICENSE`](LICENSE) / [`COPYING`](COPYING) 与 [`NOTICE`](NOTICE)。对外分发二进制时必须同时提供 Corresponding Source（公开仓库 tag + 构建说明）。第三方组件（Electron/React 等）按各自许可证；EasyTier 为 LGPL-3.0 **独立进程、运行时下载、不修改**；Modrinth 仅按 API 条款使用；CurseForge 在 P0 不接入 API（P1 若接入需自备官方 key，并满足 02 的 API-16~22 前置）。

> 元数据残留：`package.json` 的 `license` 字段当前仍是 `UNLICENSED`（冻结文件，未在本轮改）；正式发布前需由内核所有者更新为 `GPL-3.0`。

本项目是**非官方**启动器，与 Mojang/Microsoft、PCL2 作者无关联；不使用 PCL2 源码/图标/音乐/皮肤资源。Minecraft 是 Mojang 的商标。
