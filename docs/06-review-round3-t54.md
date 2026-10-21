# 06-R3 · 代码与安全审查（第 3 轮，t54）— 复核 t53 修复

- 审查人：reviewer（👁️ 代码审查 + 🔐 应用安全）
- 日期：2026-10-21 21:0x
- 被审任务：t53（repair-round-3）；前序：t35（第 1 轮）、t52（第 2 轮）
- 审查基线：当前工作树（无 git），t53 改动集中在 20:50–20:55；`src/main/index.ts`、`core/launch/{args,orchestrator,natives}.ts`、`kernel/{security,paths,error-shape}.ts`、`modules/launch/service.ts`、`modules/auth/index.ts`、`modules/net/{room,easytier}.ts` 与对应测试。
- 独立验证（本轮实跑）：
  - `npm.cmd run typecheck` → exit 0
  - `npx vitest run` → **50 files passed | 6 skipped，448 passed | 19 skipped**，exit 0（首次运行为全绿但进程 exit 1，见 R5）
  - `npm.cmd run guard` → **Frozen guard passed (19 files)**
  - E2E 未由本轮复跑（t53 自述 exit 0、到主菜单、authlib 注入）

## 0. 结论

**pass（放行）**。第 1/2 轮全部 high 与 medium 已关闭并在代码/测试中复核；t53 声称的 13 项里 **12 项为真**，唯一不实的是 H13（loader 安装器输出编码，见 R1，属低危外观问题，不阻断）。残留 4 条低危 + 2 条观察，均不影响发布，建议并入 P1 清理。

| 轮次 | high | medium | low | 结论 |
| --- | --- | --- | --- | --- |
| 第 1 轮（t35） | 3 | 6 | 5 | needs_revision |
| 第 2 轮（t52） | 1 | 4 | 7 | needs_revision |
| **第 3 轮（本轮）** | **0** | **0** | 4（+2 观察） | **pass** |

## 1. t53 修复复核（逐项）

| 编号 | t53 自述 | 复核 | 证据 |
| --- | --- | --- | --- |
| N1 退出取消不再留僵尸 | 合并为两按钮；cancelId=1；取消/Esc/X 与 catch 都 restoreLauncher | **✔ 属实** | `index.ts:362-370`（restoreLauncher）、`:433-441`（`response !== 0` → restore）、`:459-465`（catch → restore）；`quitAction` 仅剩 `'stop' \| null`，死分支已删 |
| N2 退出等待有超时 | taskkill 与两处同步 taskkill 加 3 s；before-quit 两条路径 Promise.race 3 s | **✔ 属实** | `easytier.ts:510-527`（taskkill `timeout: 3_000`）、`room.ts:391`、`orchestrator.ts:666-684`（stopAllSync timeout）、`index.ts:372-395`（disposeNetWithTimeout）+ `:413`/`:447` 两处使用 |
| N3 env 白名单扩充 | 34 键 + 文档 + 测试 | **✔ 属实** | `core/launch/args.ts:159-196`（新增 SystemDrive/ProgramData/ProgramFiles(x86)/USERNAME/USERDOMAIN/COMPUTERNAME/NUMBER_OF_PROCESSORS/PROCESSOR_* 等）、`:221-238`（白名单+黑名单双防并注释）；`core/__tests__/args.test.ts:170-193`（正反断言）；`docs/01` 附录 I（1556-1562）、`docs/03:224` |
| N4 secret env 有测试/取证/能力探测 | sidecarEnvironment + helpSupportsSecretEnv + 探测 + fixture + fail closed | **✔ 属实（探测判据偏松，见 R2）** | `easytier.ts:97-104`（导出两个纯函数）、`:258-289`（探测 + 缓存 `capabilityChecked` + 3 s 超时 + fail closed）、`:291-309`（startHost/startMember 前置探测）；`__tests__/easytier.test.ts:66-131`（env/argv/夹具/失败用例）；`__tests__/fixtures/easytier-core-help-2.7.0.txt`（真实摘录，含 `[env: ET_NETWORK_SECRET=]`） |
| H9 生产只信任 app:// | packaged 仅 app://，dev 精确 origin | **✔ 属实** | `kernel/security.ts:43-67`；`ipc.ts:376`、`download/ipc.ts:58` 均走默认（`app.isPackaged`） |
| H11 重入覆盖证据 | ALREADY_RUNNING 移到 prepare 前 | **✔ 属实** | `orchestrator.ts:421-427`（prepare 之前即查 sessions），`:429-434` 保留 prepare 后的二次校验 |
| H12 长路径 | winLongPath 提升 kernel + natives 使用 + 预检 | **✔ 属实（新增一条硬失败路径，见 R6）** | `kernel/paths.ts:6-29`（winLongPath/assertPathBudget）、`core/launch/natives.ts:2,152-174`（remove/mkdirp/extractZip）、`orchestrator.ts:307,315`（nativesDir、logFile 预检）、`kernel/paths.test.ts:99` |
| H13 安装器编码 | "logEncoding 单 decoder 已满足" | **✘ 不实** | `modules/loader/core/installer.ts` **未被改动**（mtime 14:18:38），`:176-178` 仍为 `new TextDecoder('utf-8')` 逐 chunk 解码 → 见 R1 |
| H14 Authlib 注入接线 | 公开 setAuthlibResolver + warn | **✔ 属实** | `modules/launch/service.ts:22-24,106-121`（公开 API，构造 orchestrator 时传入 `resolveAuthlib`）、`core/launch/orchestrator.ts:144-148`、`modules/auth/index.ts:29-70`（不再探针私有字段，缺 API/异常均 warn） |
| N5 外壳探针私有字段 | 公开 hasRunningSessions/stopAllSync | **✔ 属实** | `launch/service.ts:106-112`；`index.ts:28-32,410,474-475` 全部改走公开方法 |
| N6 死代码 | 删 'only' 分支；cleanEnvironment 双防+注释 | **✔ 属实** | `index.ts:360`；`args.ts:221-238` |
| N7 TunnelHandle pid | 显式声明 | **✔ 属实** | `easytier.ts:416-422`（`pid: number \| null`）；`room.ts:386` 直接 `this.tunnelHandle?.pid` |
| N8 丢真实原因 | technicalMessage/causeCode + UI | **✔ 属实（通用层实现）** | `kernel/error-shape.ts:46-71`（`attachTechnical`，`:104` 对 toShape 结果同样生效）、`renderer/app/data/backend.ts:189-230`、`renderer/app/ui.tsx:336-341`；`error-shape.test.ts:77,80` |

## 2. 残留项（不阻断发布）

### R1 · low · loader 安装器输出仍是逐 chunk UTF-8 解码（H13 未修，t53 报告误报）

- `src/main/modules/loader/core/installer.ts:176-178`（`new TextDecoder('utf-8', { fatal: false }).decode(chunk)`，文件 mtime 14:18:38 未被本轮触碰）

影响面仅限：中文 Windows 下 Forge/NeoForge 安装器的非 ASCII 输出在进度/日志里显示为 `�`，且跨 chunk 的多字节字符会被截断。**机器可解析的英文动词与百分比不受影响**（安装正确性、超时、回滚均不依赖该文本），故为低危。

必修（P1）：复用 `core/launch/settings.ts` 的 `logEncodingForCodePage(codePage)` + **单个** `TextDecoder(encoding, { stream: true })` 实例（与 `core/launch/process.ts:202-232` 同款），并把 `codePage` 从服务层传入 `runInstaller`。

### R2 · low · `helpSupportsSecretEnv` 的 `|| --network-secret` 臂让 "fail closed" 只在极端情况生效

- `src/main/modules/net/easytier.ts:101-103`（`/ET_NETWORK_SECRET|--network-secret/i`）
- 测试 `__tests__/easytier.test.ts:102` 只断言 "`--network-name only` → false"，未覆盖"只有 `--network-secret`、无 env 标注"的构建

任何 EasyTier 构建都带 `--network-secret` 这个 CLI flag，因此该正则几乎恒为真；若将来升级到一个"有 flag、无 env 支持"的版本，探测会放行 → 两侧空 secret、不报错（正是 N4 想堵的 fail-open）。

必修（P1）：判据收紧为 `/ET_NETWORK_SECRET/`，并补一条 `helpSupportsSecretEnv('--network-secret <X>') === false` 的断言（固定版本仍由 fixture 证明）。

### R3 · low · `isTrustedUrl` 的 packaged/dev 分支无单测

- `src/main/kernel/security.ts:43-67`（本轮新增 packaged/dev 判定，是全部 IPC sender 校验的唯一闸门）
- 全仓测试中无 `isTrustedUrl` 用例（已 grep）

必修（P1）：新增 `kernel/security.test.ts` 4 例 —— packaged + `app://mc-launcher/...` → true；packaged + `http://localhost:5173` → false；dev(`devUrl=http://localhost:5173`) + 同 origin → true；dev + 其它端口/其它 host → false。

### R4 · low · 开发态 origin 精确比对存在 host 拼写坑

- `src/main/kernel/security.ts:55-63`（`new URL(devUrl).origin` 与 `url.origin` 全等比较）

`ELECTRON_RENDERER_URL=http://127.0.0.1:5173` 而页面实际在 `http://localhost:5173` 时 origin 不等 → 开发态 IPC 全被拒（打包不受影响）。建议 dev 分支按 `protocol + hostname∈{localhost,127.0.0.1,[::1]} + port` 比较，或在 README/dev 脚本里统一写法。

### R5 · 观察（基础设施）· 全量 `vitest run` 曾出现"全绿但进程 exit 1"

- 第一次运行：`Test Files 50 passed | 6 skipped`、`Tests 448 passed | 19 skipped`，但进程退出码 1，日志无 `Unhandled Errors` 段；第二次同样内容 exit 0。
- 疑为 worker teardown/端口竞争的偶发（与历史 t45 记录的 `.e2e/runtime` EPERM、并发任务争用同源）。

建议：CI 里把"全绿 + 非零退出"当作 flake 记录并复跑；必要时对 net/download 的 socket 测试加 `afterEach` 关闭与端口回收断言。

### R6 · low（文档）· 新增错误码 `LAUNCH.PATH_TOO_LONG` 未进 03 §9.2 错误码表

- `src/main/kernel/paths.ts:16-29`（`assertPathBudget` 抛 `LAUNCH.PATH_TOO_LONG`，maxLength=240）
- `docs/03-architecture.md:945-1000`（§9.2 表内无该码）

另需注意：这是一条**新增的硬失败路径**（natives 目录或游戏日志路径 > 240 字符时启动/ dry-run 直接失败，而不再尝试）。方向正确（可读错误 + hint 优于 `ENAMETOOLONG`），但应写进 §9.2 与 01 的验收口径，避免后续把 240 当魔法数字改坏。

## 3. 六模块结论（本轮）

| 模块 | 结论 |
| --- | --- |
| 启动链 | **通过**。退出语义（对话框/取消恢复/超时/同步兜底）、env 白名单、长路径、ALREADY_RUNNING 顺序、Authlib 接线均落实；余 R1（loader 侧编码，归加载器）、R6（文档）。 |
| 安装链 | **通过**。t46 的 per-source 断路器与 `real-cooldown-install.test.ts` 在树中（本轮未介入其结论），batch 持锁 + 去重 + 锁心跳齐全；未发现新问题。 |
| 账户 | **通过**。DPAPI-only 持久化、拒 `basic_text`、Authlib 固定哈希、公开接线 + 失败 warn；无回归。 |
| 模组 | **通过**。`packTarget`/`BLOCKED_ROOTS`/哈希校验未改动；无回归。 |
| 加载器 | **通过（带 R1）**。安装器 argv/cwd/env 白名单、超时/取消 kill、回滚、`confirmSha1` 双闸均未回归；仅日志编码外观问题。 |
| 联机 | **通过（带 R2）**。票据 Ed25519/私网约束/心跳与握手上限、secret 仅走 env、探测 fail-closed、sidecar 同步兜底、TunnelHandle.pid 显式；无回归。 |

**关键关注点复核**：子进程与句柄清理（达标）、并发下载竞态（达标）、Windows 路径/空格/中文（达标，长路径新增预检）、令牌不落明文（达标：DPAPI + secret 不进 argv + env 白名单）、邀请码校验（达标：签名/过期/私网/中文错误码）、静默失败（达标：Authlib 接线、探测 fail-closed、technicalMessage 透出；余 R2 判据偏松）。

## 4. 放行说明与后续

- 本轮**无 high / medium**，放行六个模块的代码审查闸门。
- 建议把 R1–R6 作为 P1 清理项（合计约半天），其中 **R1 需要更正 t53 报告中"已满足"的表述**，避免后续验收误判。
- 发布前请保留本轮验证命令的原始输出（typecheck 0 / 448 passed / guard 19 files）以便复现。
