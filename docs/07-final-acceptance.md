# 07 · 最终验收（发布决策依据）

| 项 | 值 |
|---|---|
| 文档编号 | `07-final-acceptance` |
| 版本 | **1.0** |
| 日期 | 2026-10-21 |
| 验收人 | qa（🧐 验收测试工程师 / 🎭 测试自动化工程师） |
| 依据 | `docs/01-requirements.md` v1.5（P0-0 ~ P0-8、A0.* ~ A8.*）、`docs/05-acceptance-report.md` §16、t61 合同 |
| 被测构建 | `release/win-unpacked/mc-launcher.exe`，2026-10-21 22:40:23，247,155,712 B；app 0.1.0 / Electron 44.9.3 |
| 源码状态 | 验收期间 auth `profile` 由并发修复在 22:36–22:38 落地；最终 `typecheck/build=0`、`test=458 passed/19 skipped`、e2e exit 0（22:43 干净日志重跑） |
| 证据根 | `docs/evidence/t61/`（脚本：`docs/evidence/p0/tools/probe-t61-*.mjs`） |
| **发布结论** | **P0 仍未全部通过**：P0-0/1/2/3/4/5/7/8 通过或通过（带条件）；**P0-6 的 L0 真实 LAN 世界/进世界仍未闭环**，是唯一剩余 P0 阻断。**README 不应改为“P0 通过”。** |

> 本轮只新增证据与文档，未修改产品代码。所有结论来自 2026-10-21 22:20–22:45 的实际运行；旧 t34/t45 结论未被复用为“新验证”。

---

## 1. 结论摘要

| P0 | 结论 | 关键证据 |
|---|---|---|
| P0-0 骨架/实例/主题 | **PASS**（沿用 t34 已验项；本轮未回退） | 15 实例、3 缺 JSON、只读零改动、主题持久（`docs/05` §2） |
| P0-1 全新安装 + 启动 | **PASS（带构建漂移说明）** | 空目录 3641 文件/735,402,462 B/0 失败，**616.6 s（10.3 min）**；jar SHA1 `0c3ec587…`、3575 assets、64 libs；主菜单 `Sound engine started`（`t61/e2e-launcher.log`、`game-latest-final.log`） |
| P0-2 离线账户 | **PASS** | 当前构建 e2e 创建 `TestUser`，离线 plan 四件套；T61User 一键启动成功 |
| P0-3 Java | **PASS** | 4 候选、1.20.1 自动 Java 17；B2 Java 选择 UI 已接线（`settings-launch.png`） |
| P0-4 内存/JVM/窗口 | **PASS** | 设置页保存 1024/4096、1280×720、`-Dmcl.t61=1`；dry-run 与 instance.json 一致（`probe-ui.log`） |
| P0-5 日志/崩溃 | **PASS** | 坏 JVM 参数 35 ms 崩溃；`data/crash-reports/*.txt` + 实例 crash-reports；首页自动 CrashPanel；日志轮转单测通过（`unit-breaker-rotation-verbose.log`） |
| P0-6 联机 | **FAIL（剩余阻断）** | 双进程开房/加入/2 成员 host-first/ping 0 ms/关房 3.1 s 全部通过；但 **真实 LAN 世界发现与一键进世界未实测**（无 LAN 世界）；局域网扫描真实空态 |
| P0-7 微软/Authlib | **PASS（条件项：真实登录 P1）** | 账户页有微软设备码与 Authlib 入口；`MS_CLIENT_ID_MISSING` 诚实失败；Authlib 注入沿用 t34/t45 证据 |
| P0-8 模组/整合包/删除 | **PASS** | 全局拖拽 jar/mrpack/CF zip 自动识别并导入；删除实例→回收站→恢复；CF 无 API 调用 |

**一句话**：除 P0-6 的 L0 真实 LAN 世界/进世界外，其余 P0 主链已在当前构建上通过；因此 **README 的“P0 未通过”暂不能改**（只差这一项，需补 LAN 世界实测）。

---

## 2. P0-1 全新空目录安装 + 启动（重跑）

### 2.1 安装事实

| 项 | 值 | 证据 |
|---|---|---|
| 起始目录 | `.e2e/t61-fresh/mc`（新建空目录；`missingFiles=3641`） | `t61/e2e-launcher.log` |
| 安装任务 | 3641 文件 / 735,402,462 B；**0 failed**；下载 3641、跳过 0 | 同上 |
| 耗时 | 14:23:46.817Z → 14:34:03.429Z，**616,609 ms（10.27 min ≤ 15 min）** | 同上 |
| client jar | 23,028,853 B；SHA1 `0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838` | 实测 |
| assets | 3575 objects | 实测 |
| libraries | 64 个 jar | 实测 |
| 启动到主菜单 | `Setting user: TestUser` 22:34:13、`Sound engine started` 22:34:16；窗口截图 `t61/main-menu.png` | `game-latest-final.log`、`main-menu.png` |
| 最终 e2e | 当前构建（22:40）清空游戏日志后重跑：**exit 0 / E2E PASS / mainMenu=true**，日志 `Setting user: TestUser` + `Sound engine started` 22:43:27/29 | `e2e-rerun3.log`、`e2e-result-final.json` |

**构建漂移**：首次全新安装发生在 22:23–22:34，使用的 22:07 构建；22:36–22:38 并发修复给 auth 增加 `profile` handler，22:40 重建。最终构建已用 e2e（跳过已安装文件）启动到主菜单；安装链文件（download/launch）在两次构建间无变化。若要求“同一次构建既完成全新安装又启动”，需在最终构建上再跑一次 10 分钟安装；本轮未重复下载 700 MB。

**源策略**：本轮全新安装显式使用 `sourcePreference=official`（因默认镜像 CDN `*.749333.xyz` 持续超时/低至 ~0.2 MB/s）；官方源 0 失败完成。B1 的熔断修复由单测与代码验证（§3 B1），但**默认 auto 路径的端到端安装未在最终构建上完成**——这是残余风险而非代码失败。

**一次异常（已隔离）**：安装期间 `config.json.paths.minecraftRoot` 被外部动作改成 `E:\MC\.minecraft`（日志 `minecraft root imported … instances 15`，14:24:03），导致 14:34:03 一次 launch 尝试写 `E:\MC\.minecraft\versions\1.20.1\1.20.1-natives` 报 EPERM；应用重启后 launch 使用 `.e2e/t61-fresh` 成功。该导入调用不是 e2e 脚本/本轮探针发出，属于并发 UI/外部动作；记录为环境异常，不据此判产品失败。复现命令与日志见 `t61/e2e-launcher.log` 同一时间段。

---

## 3. B1–B7 逐项复核

| ID | 结论 | 证据 |
|---|---|---|
| **B1** 下载源熔断 | **PASS（代码/单测）；默认 auto 端到端为残余风险** | `sources.ts`：3 次连续失败 → 60 s cooldown，另一源继续；`sources.test.ts` 3 个用例（冷却/恢复/全源不可用=网络不可达）通过；`unit-breaker-rotation-verbose.log`。全新安装官方源 0 失败；默认镜像 CDN 本轮实测仍超时（`e2e-fresh.log` 无默认成功记录），属网络不可达，不是代码缺陷。 |
| **B2** 设置项 | **PASS** | 设置·启动：内存 1024/4096、窗口 1280×720、JVM `-Dmcl.t61=1` 保存成功；dry-run `-Xmx4096m`/`1280`/`720`/`-Dmcl.t61=1`；`instance.json` `memoryMode=custom`；截图 `settings-launch.png`。Java 选择控件已接线（`settings-launch.png` 下方）。 |
| **B3** 错误码 | **PASS** | 运行时原始返回：`JAVA.INVALID`、`LOADER.PARENT_MISSING`、`ROOM_NOT_FOUND`、`INSTANCE.NOT_FOUND`（消息中文可读），不再是 `IPC.HANDLER_FAILED`；`probe-ui.log`。 |
| **B4** 崩溃报告/日志轮转 | **PASS** | 坏 JVM 参数：35 ms 崩溃、`jvm-args`；`data/crash-reports/20261021-224032-1.20.1.txt` + `mc/.../crash-reports/` 副本；首页自动 CrashPanel（`crash-panel-auto.png`）；`logger.test` 轮转用例通过（`unit-breaker-rotation-verbose.log`）。 |
| **B5** 联机 | **PASS（控制面/UI）；L0 真实 LAN 世界仍为条件项** | 双进程：房主+成员双方成员列表 **2 人**，房主行 `0 ms（房主）· 已连接`，成员 `0 ms`；LAN 扫描真实空态；短码 `INVITE_INCOMPLETE`、篡改 `TICKET_SIGNATURE_INVALID`、残缺 `TICKET_MALFORMED`；关房 **3.1 s ROOM_CLOSED**；旧邀请码返回 `NETWORK_UNREACHABLE`（可读，但非 `ROOM_CLOSED`，见剩余项）。截图 `net-host-room.png`/`net-member-room.png`；`probe-net.log`。 |
| **B6** 账户入口 | **PASS（真实登录 P1）** | 账户页有「微软登录（设备码）」「Authlib 皮肤站」入口；点击微软登录返回 `MS_CLIENT_ID_MISSING` 可读错误、不伪造成功；`account-entries.png`/`account-microsoft-error.png`、`probe-ui.log`。 |
| **B7** CF zip | **PASS** | 全局拖入 `qa-curse.zip`：自动识别 `CurseForge manifest.json`，无确认面板，导入 `CurseAutoTest`；反馈 `curseforge · MC 1.20.1 · vanilla`；启动器日志中 `api.curseforge.com` 命中 **0**；`global-drop-cf.png`、`probe-drag-delete.log`。 |

---

## 4. 一键启动真实成功路径（当前构建）

- 真实完整实例：`.e2e/t61-fresh` 的 1.20.1（3641 文件）；数据目录全新 `.e2e/t61-oneclick-data`；离线账户 `T61User`。
- 主页只点击 **1 次** `aria-label="启动游戏"`（点击前 enabled）：
  - **9,953 ms** 到主菜单：`Setting user: T61User` → `Backend library: LWJGL` → `Sound engine started`（22:39:37→22:39:40）。
  - 真实游戏窗口截图 `t61/main-menu.png`（Minecraft 1.20.1）；启动器截图 `t61/oneclick-running.png` 显示「运行中 / 游戏运行中 / 结束游戏」。
- 点击「结束游戏」：真实 `launch.stop`，UI 显示「已结束 · 退出码 — · 耗时 22.2 秒 / 就绪」，报告 `classification=killed`；截图 `oneclick-stopped.png`。
- **残留小缺陷**：结束后 `mc:launch:status` 返回 `state=crashed`（`exitCode=null`，report=killed），UI 已回到就绪；状态枚举把用户主动结束映射为 crashed，建议后续改为 exited/killed 语义。

---

## 5. 全局拖拽 / 自动识别 / 删除实例

| 场景 | 结果 | 证据 |
|---|---|---|
| 全局拖入 `.jar` | 无页面限制，反馈「已安装到 mods · 目标实例 1.20.1 · 依据：扩展名 .jar」；`mods/t61-global.jar` 存在 | `global-drop-jar.png`、`probe-drag-delete.log` |
| 全局拖入 `.mrpack` | 自动读 `modrinth.index.json`，无类型确认；导入新实例 `1.20.1-2`；反馈 `modrinth · MC 1.20.1 · vanilla · 0 新/0 跳过` | `global-drop-mrpack.png` |
| 全局拖入 CF `.zip` | 自动读 `manifest.json`，无确认；导入 `CurseAutoTest`；`api.curseforge.com` 0 命中 | `global-drop-cf.png` |
| 删除实例 | 列表删除 `CurseAutoTest`：确认框显示实例名/回收站/libraries 不删；确认后列表剩 `1.20.1`、`1.20.1-2`，Banner「已移入回收站」；回收站条目 `kind=other/instanceId=CurseAutoTest` | `instance-deleted.png`、`trash-instance.png` |
| 恢复实例 | 回收站点「恢复实例」→ 实例列表重新出现 `CurseAutoTest` | `instance-restored.png` |

---

## 6. 命令结果（最终代码）

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm.cmd --prefix mc-launcher run typecheck` | exit 0 | `t61/gates-current.log` |
| `npm.cmd --prefix mc-launcher run build` | exit 0 | 同上 |
| `npm.cmd --prefix mc-launcher run test` | **exit 0，458 passed / 19 skipped** | 同上 |
| `npx vitest run sources.test.ts logger.test.ts --reporter=verbose` | exit 0，28 passed（B1 熔断 3 例、B4 轮转 1 例） | `t61/unit-breaker-rotation-verbose.log` |
| `MCL_E2E_WORKSPACE=.e2e/t61-fresh npm.cmd ... run e2e:install-launch` | **exit 0，E2E PASS，mainMenu=true**（清空游戏日志后重跑） | `t61/e2e-rerun3.log`、`t61/e2e-result-final.json` |
| 同一命令全新目录 | 首次安装成功（10.3 min/0 failed）；早前默认镜像尝试因 CDN 慢/应用被外部动作打断，非代码失败 | `t61/e2e-launcher.log` |

> e2e 脚本本身不会自动轮换 `latest.log`；若旧日志已有 `Sound engine started`，可能误判“到主菜单”。本轮最终 e2e 前手工移走旧日志，确保 `Setting user: TestUser` + `Sound engine started` 是本次新写入（22:43:27/29）；建议后续给 e2e 增加日志轮换/时间戳断言。

---

## 7. 剩余阻断与复现步骤

### 阻断 P0-6-L0：真实 LAN 世界/一键进世界未闭环

- **缺失证据**：没有房主在单人游戏里「对局域网开放」的真实 `latest.log`（`Started serving on <port>` / `Local game hosted on port <port>`）；没有成员通过 `joinLanWorld` 进入该世界的服务端 `joined the game` 日志。
- **已通过**：房间创建/加入、成员 2 人、房主 ping 0 ms、LAN 扫描真实空态、关房 3.1 s、邀请码错误码。
- **复现步骤**：
  1. 两台/双进程启动器，A 建 LAN 房间，B 加入；
  2. A 启动 1.20.1 → 单人游戏 → 创建世界 → Esc → 对局域网开放；
  3. 观察 A 房间 ≤5 s 出现世界端口；B 点“进入世界”，断言游戏命令行含 `--quickPlayMultiplayer 127.0.0.1:<port>`，A 日志出现 B 用户名 joined。
- **当前结果**：环境无 LAN 世界/无第二设备；本轮只验证到 LAN 扫描空态与房间控制面。L1/L2 仍为条件项。

### 残余风险（不一定阻断，但发布前应处理）

1. **B1 默认 auto 未端到端完成**：本轮全新安装使用 explicit `official`；默认镜像 CDN 仍慢/超时。代码/单测证明 60 s 冷却不会永久禁用最后源；建议在最终构建上再用默认设置跑一次空目录安装，或把默认源策略改为“官方优先”。
2. **launch.status 结束后为 `crashed`**：用户主动结束游戏后状态枚举应与 `killed/exited` 对齐，避免崩溃面板误报。
3. **B5 旧邀请码** 返回 `NETWORK_UNREACHABLE`（可读）而非 `ROOM_CLOSED`；建议区分“房主已关房”与“网络不可达”。
4. **构建漂移**：本报告的全新安装发生在 22:07 构建；最终 22:40 构建只重跑了 e2e（跳过文件）与一键启动。若发布审计要求同一构建，应重跑 10 分钟全新安装。
5. **e2e 旧日志误判**：建议脚本启动前清空/轮换 `latest.log` 并断言日志 mtime。

---

## 8. README 更新建议

**本轮不满足“全部 P0 通过”**，因此 README 顶部不应改成“P0 通过/可用”。等 P0-6-L0 真实 LAN 世界/进世界补齐并重跑后，README 可改为：

> **当前发布状态（2026-10-21）**：**P0 通过，可对外称“可用”**（P0-6 的 L0 同机/LAN 世界已验证；L1/L2 仍为条件项；Forge/NeoForge 安装器为 opt-in）。

在此之前保留 README 现有“P0 未通过”表述，并可在其后追加一句：
> t61（2026-10-21 22:45）已复核 B1–B7：B1–B4、B6、B7 通过，B5 控制面通过；剩余 P0-6 L0 真实 LAN 世界/进世界未闭环，详见 `docs/07-final-acceptance.md`。

---

## 9. 证据索引

```
docs/evidence/t61/
  e2e-launcher.log            首次全新安装任务/耗时/0 failed
  e2e-result-final.json       当前构建 e2e（mainMenu=true）
  e2e-rerun3.log              清空游戏日志后的最终 e2e exit 0
  game-latest-final.log       TestUser + Sound engine started
  main-menu.png               真实 Minecraft 1.20.1 主菜单
  oneclick-running.png        启动器“运行中 / 结束游戏”
  oneclick-stopped.png        “已结束 · 退出码 — · 22.2 秒”
  settings-launch.png         B2 设置项与 dry-run
  account-entries.png         B6 微软/Authlib 入口
  account-microsoft-error.png MS_CLIENT_ID_MISSING
  crash-panel-auto.png        B4 自动崩溃分析
  net-host-room.png           2 位成员/房主 0 ms
  net-member-room.png         成员视图
  global-drop-jar.png         全局拖拽 .jar
  global-drop-mrpack.png      mrpack 自动识别
  global-drop-cf.png          CF zip 自动识别
  delete-dialog.png / instance-deleted.png / trash-instance.png / instance-restored.png
  probe-ui.log / probe-net.log / probe-drag-delete.log / probe-onelaunch.log
  gates-current.log / unit-breaker-rotation-verbose.log
docs/evidence/p0/t61/         截图同内容（probe 输出目录）
```

验收脚本：`docs/evidence/p0/tools/probe-t61-*.mjs`、`capture-h2edgy.ps1`；未改 `src/`、`tools/`、`plugins/`。
