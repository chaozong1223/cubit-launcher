# 07 · 交接文档（Cubit Launcher / mc-launcher）

> 交接对象：后续维护者 / 新一轮 agent。
> **先读**：[`docs/05-acceptance-report.md`](05-acceptance-report.md)（发布判定以此为准）、[`README.md`](../README.md)（真实状态）、[`docs/01-requirements.md`](01-requirements.md) v1.6（范围/验收）、[`docs/03-architecture.md`](03-architecture.md)（模块/IPC/数据目录）。
> **当前结论**：**P0 未通过，不得对外称“可用”**；代码审查第 3 轮 t54 已 pass（0 high/0 medium），但这是**代码审查放行**，不是 P0 验收通过。05 的 B1–B8 仍未全部关闭。

---

## 1. 仓库结构（2026-10-21 实际工作树）

```text
mc-launcher/
├── package.json / package-lock.json     # 冻结；scripts/依赖/electron-builder
├── electron.vite.config.ts              # 冻结；main/preload/renderer 三段构建
├── tsconfig*.json                       # 冻结
├── start.cmd / launch.ps1               # 包装启动（清 ELECTRON_RUN_AS_NODE / 绕 SmartScreen）
├── arch/frozen.manifest.json            # 冻结文件 SHA-256
├── scripts/
│   ├── ensure-electron.mjs              # postinstall 补 Electron runtime
│   ├── check-frozen.mjs                 # guard
│   ├── clean.mjs
│   └── e2e-install-launch.mjs           # 打包产物 E2E
├── src/
│   ├── main/
│   │   ├── index.ts                     # 冻结：启动序列/窗口/退出
│   │   ├── kernel/                      # 冻结：logger/config/paths/ipc/security/error-shape/system
│   │   └── modules/
│   │       ├── _registry.ts             # 冻结：glob 发现 modules/*/index.ts
│   │       ├── _services.ts             # publishService/getService（跨模块服务定位）
│   │       ├── _context.ts              # resolveModuleRoots(dataRoot)
│   │       ├── assets/                  # 存档/截图/日志/回收站（t39）
│   │       ├── auth/                    # 离线/微软/Authlib（t11）
│   │       ├── catalog/                 # Modrinth 搜索/详情/安装/更新（t41/t43）
│   │       ├── crash/                   # 崩溃分析/修复/诊断包（t40）
│   │       ├── download/                # 下载队列/源/校验/断点（t8/t46）
│   │       ├── hello/                   # 演示模块
│   │       ├── instance/                # 实例扫描/详情/设置（t6/t32）
│   │       ├── java/                    # Java 探测/选择/下载（t18）
│   │       ├── launch/                  # 参数/进程/日志（t6）
│   │       ├── loader/                  # Forge/NeoForge/Fabric/Quilt（t17）
│   │       ├── mods/                    # 模组/资源包/光影/整合包（t15）
│   │       ├── net/                     # HTTP 源策略 + 联机房间/隧道（t8/t9）
│   │       ├── repair/                  # 文件校验/修复（t19）
│   │       └── version/                 # 版本清单/JSON/安装计划（t8）
│   ├── preload/                         # 冻结：contextBridge 白名单
│   ├── shared/                          # 契约：assets/auth/catalog/crash/... + kernel/errors/system
│   └── renderer/
│       ├── app/                         # 冻结：App/router/theme/design.css/pages/data adapter
│       │   ├── pages/                   # 主页、实例、下载、资源库、联机、日志、设置、关于…
│       │   └── data/backend.ts          # window.mc 的 renderer adapter（无 mock）
│       ├── lib/ipc.ts                   # 冻结：类型化客户端
│       └── ui/                          # 组件
├── design/                              # 高保真原型 + README
├── docs/                                # 01–09、证据、clean-room
├── poc/link/                            # 联机 PoC 证据
└── release/win-unpacked/                # pack 产物（gitignore）
```

> 实际 UI 在 `src/renderer/app/pages/`（不是 docs/03 早期设想的 `renderer/features/<name>/` 自动注册）；`app/**` 是冻结文件，新增页面必须走冻结文件合并窗口 + 更新 `arch/frozen.manifest.json`。

---

## 2. 模块自注册机制（以实际代码为准）

### 2.1 发现与注册

`src/main/modules/_registry.ts`：

```ts
const discovered = import.meta.glob<ModuleDefinition>('./*/index.ts', { eager: true })
// Object.entries(discovered).sort(...) → definition.register({ log, dataRoot })
```

- 每个模块目录必须有 `index.ts`，导出 `moduleId` 与 `register(ctx)`。
- `register(ctx)` 返回 `void`/`Promise<void>`；单个模块抛错只记 `failed`，不阻塞其它模块。
- **实际 context 只有 `log` 与 `dataRoot`**；没有 docs/03 §4.4 设想的 `ctx.services`/`ctx.ipc`。
- **实际没有 `dependsOn` 拓扑排序**：模块按路径字母序注册。需要别的模块服务时，用 `getService<T>('id')` **在调用时**取，不要在 `register()` 顶层强依赖初始化顺序。
- 服务的发布/获取在 `src/main/modules/_services.ts`（`publishService`/`getService`）；这是 docs/03 §4.4 “不 import 其它模块实现”的临时替身。

### 2.2 IPC

- 契约在 `src/shared/<name>.ts`，用 zod schema + `defineContract`。
- 模块 `handlers.ts` 导出 `makeHandlers(service)`；`src/main/kernel/ipc.ts` 用 `import.meta.glob('../modules/*/handlers.ts')` 自动装配，并校验输入/输出。
- 需要自定义 envelope/发送方校验的模块可提供 `modules/<id>/ipc.ts`（`SELF_MANAGED_IPC`，内核不重复注册）。
- 也可在 `register()` 里直接 `import { moduleIpc } from '../../kernel/ipc'` 调 `moduleIpc.handle(contract, handlers)`。
- 事件：`moduleIpc.emit(moduleId, event, payload)`；renderer 通过 preload 白名单 `on` 订阅。

### 2.3 新增一个模块（最小步骤）

1. 在 `src/shared/` 新建 `<name>.ts`：定义 zod schema + `defineContract({ id: '<name>', methods, events })`。
2. 新建 `src/main/modules/<name>/`：
   - `index.ts`：`export const moduleId = '<name>'` + `register(ctx)`；
   - `service.ts`：业务（不要 import electron，纯 Node）；
   - `handlers.ts`：`makeHandlers(service)`；
   - `__tests__/`：单测（零网络/零真实用户目录）。
3. `register(ctx)` 内：
   ```ts
   const roots = resolveModuleRoots(ctx.dataRoot)
   const service = createXxxService({ roots, log: ctx.log })
   publishService(moduleId, service)
   moduleIpc.handle(xxxContract, makeHandlers(service) as unknown as ModuleHandlers)
   ```
4. 如需 UI：在 `src/renderer/app/pages/` 加页面 + `router.ts`/`App.tsx` 加路由/导航 + `data/backend.ts` 加 adapter；**这些是冻结文件，需与内核所有者合并并更新 frozen manifest**。
5. 跑：
   ```powershell
   npm.cmd --prefix mc-launcher run typecheck
   npm.cmd --prefix mc-launcher run test
   npm.cmd --prefix mc-launcher run guard
   ```
6. 写 `docs/clean-room-log.md` 新记录（如参考了外部行为/格式）。

> 不要假设 `dependsOn` 会被执行；不要修改 `src/main/index.ts`/`package.json`/`_registry.ts`/`preload/**`/`renderer/app/**` 而不更新 guard 清单。

---

## 3. 冻结文件与 guard

`arch/frozen.manifest.json` 记录以下文件的 SHA-256，`npm.cmd run guard` 会校验：

```text
package.json  package-lock.json  electron.vite.config.ts  tsconfig*.json
src/main/index.ts  src/main/kernel/**
src/main/modules/_registry.ts
src/preload/index.ts  src/preload/contracts.ts
src/renderer/app/**  src/renderer/lib/**
src/shared/kernel.ts  src/shared/errors.ts  src/shared/system.ts
src/shared/bridge.ts  src/shared/channels.ts
scripts/**  arch/**
```

规则：模块所有者只写自己的 `modules/<id>/**`、`shared/<id>.ts`；冻结文件改动必须由内核所有者合并窗口处理并更新 manifest。`t54` 验证 `guard` 19 files pass；`package.json` hash 未变。

> **许可证元数据残留（发布前必修）**：仓库根已有 `LICENSE` + `COPYING`（GPL-3.0 全文，二者内容相同）与 `NOTICE`，但 `package.json` 的 `license` 字段仍是 **`UNLICENSED`**（冻结文件，本轮不改）。正式发布前需由内核所有者在合并窗口改为 `GPL-3.0`，并补源文件 SPDX 头；否则包元数据与 LICENSE 不一致。
>
> **打包残留**：`package.json` 的 `build.files` 目前只含 `out/**/*` 与 `package.json`，**LICENSE/COPYING/NOTICE 未随 `release/win-unpacked` 打包**。发布前需把它们加入 `files`/`extraResources`（并生成 `THIRD-PARTY-LICENSES.txt`），否则分发物不满足 GPL-3.0/LGPL 的许可证随附义务。

---

## 4. 数据目录与运行参数

| 根 | 解析优先级 |
|---|---|
| `dataRoot` | `--data-dir` → `MCL_DATA_DIR` → `<exeDir>/data`（打包）/ `<cwd>/data`（开发）→ 不可写回退 `%APPDATA%\mc-launcher` |
| `mcRoot` | `--mc-dir` → `MCL_MC_DIR` → `config.json.paths.minecraftRoot` → 首启 UI 选择 |

关键路径：

```text
dataRoot/config.json
dataRoot/accounts.json
dataRoot/logs/launcher.log
dataRoot/logs/app-YYYYMMDD.jsonl
dataRoot/logs/game/<实例>/<时间>.log
dataRoot/logs/launch-last.json/.bat
dataRoot/backups/              # 存档/诊断包等
dataRoot/modules/<id>/
dataRoot/trash/
mcRoot/versions/<dir>/{<dir>.json,<dir>.jar,<dir>-natives/,instance.json,LatestLaunch.bat}
mcRoot/libraries/ assets/
```

---

## 5. 运行与验证

```powershell
# 在 D:\DSH-工作文件 下
npm.cmd --prefix mc-launcher install
npm.cmd --prefix mc-launcher run typecheck
npm.cmd --prefix mc-launcher run test
npm.cmd --prefix mc-launcher run build
npm.cmd --prefix mc-launcher run pack
npm.cmd --prefix mc-launcher run guard
npm.cmd --prefix mc-launcher run e2e:install-launch
```

最近基线（t54，2026-10-21 21:0x）：

- `typecheck` exit 0；
- `npx vitest run` → 50 files passed | 6 skipped，**448 passed | 19 skipped**，exit 0（首次曾“全绿但 exit 1”，见 R5）；
- `guard` → Frozen guard passed (19 files)；
- E2E 未由 t54 复跑；t53 自述 exit 0（主菜单、authlib 注入）。

**并行执行注意**：`.e2e/runtime` 是单实例目录；并发任务占用时会 `EPERM`（t45/t53 都遇到）。运行 e2e 前确认没有其它 `mc-launcher.exe` 占用 `.e2e/runtime`。

---

## 6. 当前阻断（05 B1–B8）状态

| ID | 05 判定 | 当前状态（2026-10-21 晚，未按 01 v1.5 复验） |
|---|---|---|
| B1 | 源熔断导致全新安装失败 | t46 已落 per-source 断路器+冷却测试；t52/t54 审查称安装链通过；**05 后未重跑空目录全新安装 → 待复验** |
| B2 | 设置页未接线 | 全局设置页已接启动/Java/下载/账户；**实例详情“设置”tab 仍 `UnwiredTab`**；未复验 |
| B3 | 错误码被 `IPC.HANDLER_FAILED` 包裹 | t53 加 `technicalMessage/causeCode` + UI 展示；未复验 |
| B4 | 崩溃无自动弹窗/报告路径/无日志轮转 | 日志轮转、`crash-reports/` 已实现；**自动弹窗仍未实现**；未复验 |
| B5 | 联机 L0 未闭环 | 代码已有 `lanWorlds/joinLanWorld`、房主成员、ping 字段；**未按 05 复验** |
| B6 | 微软/Authlib 无 UI | 账户页已接微软设备码/Authlib 表单；**Authlib 实机到主菜单未复验** |
| B7 | P0-8 的 CF zip/Zip-Slip/普通 zip/无加载器提示证据不足 | **未关闭**（仅单测） |
| B8 | 01 A1.3/A1.4 数值笔误 | **已修**：01 v1.6 改为 `8a45c6…` / `651,728,646`（磁盘去重 `651,496,644`） |

> 结论：**P0 仍不能称“可用”**；下一轮必须按 01 v1.5 的 16 步逐条复验，尤其第 3（全新安装）、8（崩溃自动提示）、15（联机进世界）步。

---

## 7. t54 残留（P1，约半天）

| 编号 | 严重级 | 问题 | 必修 |
|---|---|---|---|
| **R1 / H13** | low | `modules/loader/core/installer.ts:176-178` 仍逐 chunk `new TextDecoder('utf-8')`；中文 Windows 安装器输出花屏/截断多字节。**t53 报告“logEncoding 单 decoder 已满足”不实**。 | 复用 `core/launch/settings.ts` 的 `logEncodingForCodePage` + 单个 `TextDecoder(encoding, { stream: true })`，codePage 从服务层传入 |
| **R2** | low | `helpSupportsSecretEnv` 的 `/ET_NETWORK_SECRET|--network-secret/i` 让 fail-closed 几乎恒真（任何构建都有 flag） | 判据收紧为 `/ET_NETWORK_SECRET/`；补“只有 `--network-secret` → false”断言 |
| **R3** | low | `isTrustedUrl` 的 packaged/dev 分支无单测 | 新增 `kernel/security.test.ts` 4 例 |
| **R4** | low | dev 态 origin 全等比较（127.0.0.1 vs localhost）会拒 IPC | 按 protocol + hostname 白名单 + port 比较，或统一 dev URL |
| **R5** | 观察 | 全量 vitest 偶发“全绿但 exit 1”（socket 未回收） | CI 按 flake 复跑；socket 测试补 `afterEach` 关闭/端口回收 |
| **R6** | low | `LAUNCH.PATH_TOO_LONG` 未进 03 §9.2 | **已补**（docs/03 v1.4 变更记录）；240 字符预检见 `kernel/paths.ts:16-29` |

---

## 8. 三轮审查透明账

| 轮次 | 结论 | 发现 | 修复/遗留 |
|---|---|---|---|
| t35（第 1 轮） | needs_revision | **3 high / 6 medium / 5 low = 14**：H1 退出子进程/管道、H2 EasyTier secret 进 argv、H3 LinkError 退化；H4 sidecar 清理、H5 锁心跳、H6 加载器库下载绕过锁、H7 控制连接无上限、H8 env 全继承、H9 生产信任 localhost；H10 plan 回传 env、H11 重入覆盖证据、H12 长路径只在下载、H13 安装器 UTF-8、H14 Authlib wiring 静默 | H1–H3、H4–H9、H10–H12/H14 已修；**H13 未修**（R1） |
| t52（第 2 轮） | needs_revision | **新增 1 high + 3 medium + 4 low**：N1 退出取消留下无窗口常驻；N2 退出无超时；N3 env 白名单过窄；N4 secret env 无验证；N5 私有字段；N6 死代码；N7 pid 未声明；N8 丢真实原因；另有上一轮 H9/H11/H12/H13/H14 未关 | N1–N8 由 t51/t53 修复；H9/H11/H12/H14 已修；**H13 仍开** |
| t54（第 3 轮） | **pass（代码审查放行）** | **0 high / 0 medium；4 low + 2 观察**（R1–R6） | R1 未修（P1）；R2–R5 记录；R6 已补文档；**不等于 P0 验收通过** |

> 写作口径：不要写成“一次通过”。t35/t52 都是 needs_revision；t54 只是代码审查闸门放行，且明确保留 P1 残留。

---

## 9. 未完成项 / 路线图

### 9.1 先关闭 P0（发布前）

1. **B1**：重跑空目录全新安装（当前网络），确认 per-source 断路器不把最后可用源熔断；保留失败/成功日志。
2. **B2**：实例详情“设置”tab 接 `instance.update`/dry-run；确保内存/JVM/窗口/Java 选择全可操作。
3. **B4**：崩溃自动弹窗 + `crash-reports/<time>-<实例>.txt` 路径 + 日志轮转证据。
4. **B5**：L0 真实闭环（房主计入成员/ping、LAN 端口发现、`joinLanWorld` 进世界）；L1/L2 条件项记录。
5. **B7**：CF zip/Zip-Slip/普通 zip/无加载器提示的端到端证据。
6. 按 `docs/05` §5.10 重跑 16 步，产出新的 `docs/05`（或 05 v2）。

### 9.2 P1

- Forge/NeoForge 安装器实际执行（opt-in）；Fabric/Quilt 已通过。
- Java 自动下载 UI（后端已有）。
- 实例级备份/还原（存档备份已有，但实例级未做）。
- 服务器列表/自动进服。
- 完整设置、系统集成（快捷方式/文件关联/单实例）。
- PCL 目录只读兼容、实例删除/多 MC 文件夹。
- 联机一致性指纹/重连增强。
- R1–R5 清理。

### 9.3 P2

- OptiFine/LiteLoader、数据包/世界下载、自定义主页/音乐、皮肤、帮助/公告/反馈、遥测、更新器。
- 整合包导出已实测（05 A8.3 PARTIAL：341 B `.mrpack` 导出+导入通过；带 mods/overrides 未复跑），仍属 P2 范围。

---

## 10. 证据与关键文件

| 内容 | 路径 |
|---|---|
| P0 验收 | `docs/05-acceptance-report.md`；证据 `docs/evidence/p0/**`（含 `t45/`） |
| 需求 | `docs/01-requirements.md` v1.6 |
| 合规 | `docs/02-compliance-security.md`（v0.3） |
| 架构 | `docs/03-architecture.md`（§9.2 含 `LAUNCH.PATH_TOO_LONG`） |
| 联机 | `docs/04-multiplayer-design.md`；PoC `poc/link/evidence/**` |
| 代码审查 | `docs/06-code-review-t35.md`、`06-review-round2-t52.md`、`06-review-round3-t54.md` |
| clean-room | `docs/clean-room-log.md` |
| 用户手册 | `docs/06-user-guide.md` |
| 设计 | `design/index.html`、`design/README.md` |

---

## 11. 交接注意事项（踩过的坑）

1. **npm.ps1 被 ExecutionPolicy 拦截**：所有命令用 `npm.cmd`；不要写 `npm --prefix`。
2. **ELECTRON_RUN_AS_NODE**：Agent/DSH 终端会注入；`start.cmd` 已清；直接跑 exe 前手动清。
3. **SmartScreen**：未签名；`launch.ps1` 用 `CreateProcessW` + `DETACHED_PROCESS` 绕过；普通用户可用“仍要运行”。
4. **`.e2e/runtime` 单实例**：并发任务占用会 `EPERM`；e2e 前清理/确认没有其它 mc-launcher 进程。
5. **长路径**：`kernel/paths.ts` 240 字符预检会抛 `LAUNCH.PATH_TOO_LONG`；不要把 240 当魔法数字改坏。
6. **PCL 目录只读**：P0 不读不写 `PCL/Setup.ini`；不要为了“兼容”写回用户 PCL 配置。
7. **CF API**：P0 不调 `api.curseforge.com`；P1 需自备官方 key + 02 法务前置；客户端零 key。
8. **EasyTier**：LGPL-3.0 独立进程、运行时下载、固定 `v2.7.0` + SHA-256、不修改；`--network-secret` 不得进 argv（t51 H2），secret 只走 `ET_NETWORK_SECRET` env。
9. **不要伪造验收**：05 的 B1/B4/B5/B7 仍未关闭；README/手册/交接必须保持“P0 未通过”。
10. **H13 报告更正**：t53 声称“logEncoding 单 decoder 已满足”与代码不符；`modules/loader/core/installer.ts` 仍逐 chunk UTF-8，按 R1 处理。

---

## 12. 交接清单（下一位 owner 的第一小时）

- [ ] 读 `README.md` + `docs/05` 的 §0/§12/§15/§16，确认“P0 未通过”口径。
- [ ] `npm.cmd --prefix mc-launcher run check`（guard+typecheck+test）确认基线（t54: 448 passed/19 skipped，guard 19 files）。
- [ ] 检查 `git`/工作树是否有未提交改动（本仓库当前可能无 git；以冻结 manifest 为准）。
- [ ] 选一个 B 项（建议 B1 或 B5）建立复现脚本，先产出证据再改代码。
- [ ] 改代码只动自己模块目录；冻结文件改动更新 `arch/frozen.manifest.json` 并跑 guard。
- [ ] 任何新“通过”结论必须附 `docs/evidence/p0/**` 的文件/截图/日志路径，并在新 05 报告里注明构建时间。
