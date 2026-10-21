# 06-R2 · 代码与安全审查（第 2 轮，t52）— 复核 t51 修复

- 审查人：reviewer（👁️ 代码审查 + 🔐 应用安全）
- 日期：2026-10-21 20:5x
- 被审任务：t51（repair-round-2）；上一轮：t35（docs/06-code-review-t35.md）
- 审查基线：当前工作树（无 git），文件时间戳 20:30–20:46；**t46 仍在并发编辑 `src/main/modules/download/`**（其 per-source 断路器已落地但任务未完成），安装链的结论以"当前工作树"为准，行号可能随 t46 收口而移动。
- 独立验证：`npm.cmd run typecheck` exit 0；`vitest run src/main/modules/net/__tests__ src/main/kernel/error-shape.test.ts src/main/core/__tests__/args.test.ts src/main/modules/download/__tests__/ipc.test.ts` → 9 files / 61 tests passed。E2E 未由本轮复跑（t51 自述已 PASS）。

## 0. 结论

**needs_revision**。

- t51 声称的 7 项（H1/H2/H3/H4/H8/H10，含 H3b/H5/H6/H7 顺带修复）**代码层面全部落地**，其中 H1/H2/H3/H3b/H4/H5/H6/H7/H8/H10 **可关闭**。
- 但 H1 的新退出对话框引入一个**确定性**的新缺陷（N1，high）：点"取消"（或 Esc / 关对话框）会留下**无窗口、无托盘的常驻进程 + 仍在运行的游戏**，用户只能任务管理器强杀 —— 强杀就回到 BROKEN_PIPE，正好抵消 H1 的收益。
- 另有 3 条 medium（退出无超时可挂死、游戏 env 白名单过窄、EasyTier secret 换 env 后无任何验证）与 5 条低危（含上一轮遗留 H9/H11/H12/H13/H14 中的 4 条）。

| 轮次 | high | medium | low |
| --- | --- | --- | --- |
| 第 1 轮（t35） | 3 | 6 | 5 |
| 第 2 轮（本轮，未关闭项） | 1（新增 N1） | 4 | 7 |

---

## 1. t51 修复复核（逐项）

| 编号 | t51 自述 | 复核结论 | 证据 |
| --- | --- | --- | --- |
| H1 退出语义 | before-quit 对话框 + await net.dispose/stopAll + will-quit taskkill 兜底 | **基本成立，但见 N1/N2** | `index.ts:360-468`；`orchestrator.ts:647-668`（`hasRunningSessions`/`stopAllSync`） |
| H2 secret 进 argv | 改 `ET_NETWORK_SECRET` 环境变量 | **代码成立；验证缺失（N4）** | `net/args.ts:101-160` 已无 secret；`easytier.ts:269-275`；`net/__tests__/args.test.ts:31,60` 断言 argv 无 secret |
| H3 LinkError 错误码 | toShape + kernel 放行 LINK_ERROR_CODES | **关闭** | `net/ticket.ts:79-92`；`kernel/error-shape.ts:12-18`（闭集白名单，安全）；`error-shape.test.ts` 6 例通过 |
| H3b download 错误码 | 改用 kernel toHandlerErrorShape | **关闭** | `download/ipc.ts:2,59`；`download/__tests__/ipc.test.ts` 9 例通过 |
| H4 sidecar 退出 | disposeSync + will-quit | **关闭（实现依赖未声明字段，见 N7）** | `net/index.ts:55-59`；`net/room.ts:380-400`；`net/easytier.ts:444-456` |
| H5 作业锁心跳 | staleMs/3 心跳 | **关闭** | `download/core/fs-atomic.ts:232-300`（`setInterval` touch + `unref` + release 清理） |
| H6 batch 绕过锁 | batch 也取锁 + 去重 | **关闭** | `download/service.ts:139-150`（`dedupeDownloadTasks`）、`:803-810`（batch 持锁） |
| H7 未认证连接 | 握手超时 + 并发上限 | **关闭** | `net/control.ts:39-62,115-155`（10 s / 32 条，`clearHandshake` 在认证/失败/关闭三处调用，无泄漏）；`control.test.ts` 已覆盖 |
| H8 env 泄漏 | 白名单 | **关闭（白名单过窄，见 N3）** | `core/launch/args.ts:159-171,200-210`；`core/__tests__/args.test.ts:170-184` |
| H10 plan.env | 同 H8 | **关闭** | `plan.env` 即白名单输出（`args.ts:586`） |

结论：t51 的 7 项主张属实，未发现"报告说修了、代码没修"的情况；但**新代码自身还有 1 个 high 与 3 个 medium**。

---

## 2. 本轮发现

### N1 · high · 退出对话框"取消/ Esc / 关窗"会把启动器留在无窗口的常驻状态

- `src/main/index.ts:397-415`（`event.preventDefault()` + `quitDialogOpen`；`response === 2` 直接 `return`）
- `src/main/index.ts:426-439`（只有"仅最小化"分支会 `existing.show()` / `createMainWindow()`）
- 全仓无 `Tray`（已 grep：`src/main/**` 无 Tray/skipTaskbar）

触发链是确定性的：用户点窗口 X → `window-all-closed` → `app.quit()` → `before-quit` 弹框（此时**窗口已销毁**）→ 用户选"取消"、按 Esc 或点对话框右上角 → `response === 2` → 直接 return。结果：
1. 进程活着（保住 stdout 管道），**但没有任何窗口，也没有托盘图标可恢复**；
2. 用户唯一的退出手段是任务管理器强杀 → 子进程管道断开 → 正好回到 H1 要修的 BROKEN_PIPE；
3. 同一分支里 `dialog.showMessageBox` 的 `.catch`（`:448-453`）也只重置 `quitDialogOpen`，不重建窗口、不重试退出 —— 同样落到无窗口僵尸态。

必修（任一，建议 1+3）：
1. 把 `response === 2` 与"仅最小化"合并：重建/显示窗口（`createMainWindow()`）并保持进程，语义改为"取消退出，回到启动器"；
2. 对话框增加 `noLink` 之外的处理：`cancelId` 指向"仅最小化"而不是"取消"，避免 Esc/X 落入僵尸分支；
3. `.catch` 分支同样重建窗口并 `log.warn`，绝不留在无窗口状态；
4. （可选，配合 2）加 `Tray`，让"最小化"名副其实；否则把文案改成"保持后台运行（无窗口）"并说明如何恢复。

### N2 · medium · `before-quit` 无超时地 await 网络清理，可导致"退不掉也看不见"

- `src/main/index.ts:378-394`（`event.preventDefault()` 后在 `net.dispose()` 的 `.finally` 里才 `app.quit()`）
- `src/main/modules/net/easytier.ts:444-456`（`execFileAsync('taskkill.exe', …)` **无 timeout**）

`RoomService.dispose()` → `leave()` → `stopTunnel()` → `killChild()`；`taskkill` 被安全软件拦截/卡住时 `execFileAsync` 不返回，`before-quit` 的 promise 永不 settle：窗口已关、退出被 preventDefault 挡住，进程既不退出也不显示任何 UI（比 N1 更糟：连对话框都没有）。

必修：给 `killChild` 的 `taskkill` 加 `timeout: 3000`；`before-quit` 里用 `Promise.race([net.dispose(), timeout(3000)])`，超时就 `log.warn` 并继续 quit（后面还有 `will-quit` 的 `disposeSync` 兜底）。

### N3 · medium · 游戏环境白名单过窄，模组/工具类场景会读到"缺变量"的异常环境

- `src/main/core/launch/args.ts:159-171`（`SAFE_GAME_ENV_KEYS` = PATH/Path/PATHEXT/SystemRoot/windir/APPDATA/LOCALAPPDATA/USERPROFILE/TEMP/TMP/PROCESSOR_ARCHITECTURE/OS）

原版 1.20.1 已由 t51 E2E 证明能进主菜单（Java 自身 `user.home`/`java.io.tmpdir` 走系统 API + TEMP，不依赖 env），但这份白名单缺 `USERNAME`、`USERDOMAIN`、`COMPUTERNAME`、`NUMBER_OF_PROCESSORS`、`PROCESSOR_IDENTIFIER`、`SystemDrive`、`ProgramFiles`、`ProgramFiles(x86)`、`ProgramData`、`PUBLIC`、`CommonProgramFiles`。这些在模组/整合包/外部工具的常见写法里会被读到（`System.getenv("APPDATA")` 有，但 `%USERNAME%`、`%COMPUTERNAME%` 没有），属于"原版能跑、部分模组静默异常"的典型来源，且排查成本高。

必修：补齐上述无害系统/身份变量（仍排除 `MCL_*`、`*_OPTIONS`、`CLASSPATH`）；在 03 文档写明"游戏进程 env 为白名单"以及白名单内容，方便后续按 issue 增补。

### N4 · medium · EasyTier secret 改走 `ET_NETWORK_SECRET` 后**无任何验证**，失败方向是 fail-open

- `src/main/modules/net/easytier.ts:269-275`（`env: { ...installerEnvironment(), ET_NETWORK_SECRET: networkSecret }`）
- `src/main/modules/net/args.ts:101-160`（已彻底移除 `--network-secret`）
- 全仓 `ET_NETWORK_SECRET` 只出现在这一行：**没有单测、没有文档、没有 `--help` 取证**

EasyTier 官方文档对每个 CLI 参数都标注了 `[env: ET_<FLAG>]`（`--network-secret` → `ET_NETWORK_SECRET`），命名自洽，因此"大概率可用"（凭证：<https://easytier.cn/en/guide/network/configurations.html>，页面逐项列出 `--disable-ipv6 [env: ET_DISABLE_IPV6=]` 等；本机未留 `easytier-core --help` 摘录）；但一旦该版本不读这个变量，两侧都会拿到空 secret 且**不会报错**——网络名 `mcl-<短码>` 是公开可推导的，等于房间失去第二道准入凭证（静默 fail-open，比直接启动失败更危险）。

必修（30 分钟内可完成）：
1. 单测断言 `spawn` 收到的 env 含 `ET_NETWORK_SECRET` 且 argv 不含 secret（`easytier.test.ts` 目前只测 hash 门）；
2. 在真机用固定版 `easytier-core.exe --help` 截取 `--network-secret [env: ET_NETWORK_SECRET=]` 作为证据（写入 docs/04 或 evidence）；
3. 加一条运行期保险：`ensureInstalled()` 后跑一次 `--version`/`--help` 解析，发现不支持该 env 时直接 `TUNNEL_START_FAILED`（宁可失败，不可静默降级）。

### N5 · low · 应用外壳直接读 launch 服务的私有 `orchestrator`

- `src/main/index.ts:28-34,372-377,460-464`（`getService<LaunchShutdown>('launch').orchestrator?.hasRunningSessions()`）
- `src/main/modules/launch/service.ts:98-100`（服务只公开了 `stopAll`，没有 `hasRunningSessions`/`stopAllSync`）

运行时可行（TS private 只在编译期），但两份代码靠"字段名恰好一致"耦合；一旦 orchestrator 改名/惰性化，`hasRunningSessions?.()` 变成 `undefined` → `running=false` → **静默跳过退出保护**（可选链把错误吞掉）。

必修：`LaunchModuleService` 增加 `hasRunningSessions(): boolean` 与 `stopAllSync(): void`（内部转发到 orchestrator），`index.ts` 改用这两个公开方法，去掉对私有字段的探针。

### N6 · low · 死代码 / 误导性条件

- `src/main/index.ts:459`（`if (quitAction === 'only') return` —— `quitAction` 只在 `:417` 被赋 `'stop'`，永远不等于 `'only'`）
- `src/main/core/launch/args.ts:200-210`（`key.startsWith('MCL_') || ENV_VARS_TO_SCRUB.includes(key)` 对白名单键永远为假）

必修：删掉或在"仅最小化"分支里真正赋 `'only'`；`cleanEnvironment` 里的两个条件要么删掉（白名单已排除），要么改成"白名单 ∪ 黑名单"的双重防御并保留注释说明。

### N7 · low · `disposeSync` 依赖 `TunnelHandle` 上未声明的 `pid`

- `src/main/modules/net/room.ts:385-400`（`(this.tunnelHandle as { pid?: number | null } | null)?.pid`）
- `src/main/modules/net/easytier.ts:351-356`（`TunnelHandle` 没有 `pid` 字段；实际对象是 `SidecarHandle` 直传，所以今天能拿到）

如今能用，但类型层面是"借用未声明字段"；若哪天 `EasyTierTunnel.startHost` 改成做字段投影，`pid` 就丢了，sidecar 会重新变成孤儿（H4 回归），而且不会报错。

必修：在 `TunnelHandle` 上显式声明 `pid: number | null`（并在 `EasyTierTunnel.startHost/startMember` 里显式传递），或在 `TunnelPort` 增加 `stopSync(handle)` 让 room 不需要知道 pid。

### N8 · low · `enterWorld`/`joinLanWorld` 的 `LAUNCH_FAILED` 丢掉真实原因

- `src/main/modules/net/room.ts:486,554`（`new LinkError('LAUNCH_FAILED', 'failed to start game: …')`，未带 `details`）

现在 `LinkError.toShape()` 把 message 换成中文固定文案（"启动游戏失败"），原始原因只存在于被丢弃的 `message` 里 → 用户看不到"实例已在运行/缺 jar/Java 不可用"这类真正可操作的信息（H3 修复带来的副作用）。

必修：`new LinkError('LAUNCH_FAILED', msg, { retryable: false, details: { technicalMessage: msg, causeCode } })`，并让 UI 在中文上文案下显示 `technicalMessage`。

---

## 3. 上一轮未关闭项（复核后仍然存在）

| 编号 | 级别 | 位置 | 现状 |
| --- | --- | --- | --- |
| H9 | medium | `kernel/security.ts:43-54` | `isTrustedUrl` 仍无条件信任 `http(s)://localhost`；`security.ts` 本轮被改过但仍未加 `app.isPackaged` 分支 |
| H11 | low | `core/launch/orchestrator.ts:368` vs `:418-422` | artifacts 仍在 `ALREADY_RUNNING` 检查之前写入 |
| H12 | low | `core/launch/natives.ts:151-173` | 仍无 `winLongPath`（`kernel/paths.ts` 里也没有该函数） |
| H13 | low | `modules/loader/core/installer.ts:176-178` | 仍是每 chunk 新建 UTF-8 `TextDecoder`（无 GBK 支持） |
| H14 | low | `modules/auth/index.ts:41-73` | 仍是 50 ms×60 次后静默 return，无 warn；仍探针 `orchestrator.options.resolveAuthlib` |

---

## 4. 六模块结论（第 2 轮）

| 模块 | 结论 |
| --- | --- |
| 启动链 | H1/H8/H10 修复已落地且生效；新增 N1（high）、N2/N3（medium）、N5/N6/N8（low）；H11/H12 仍开 |
| 安装链 | H3b/H5/H6 修复已落地；t46 并发中（per-source 断路器与 `real-cooldown-install` 测试已在工作树），**B1 的最终结论归 t46**；本轮未新开发现 |
| 账户 | 无回归；H14（Authlib wiring 静默放弃）仍开 |
| 模组 | 无回归；上一轮"已确认良好"项（`packTarget`/`BLOCKED_ROOTS`）未被改动 |
| 加载器 | 无回归；H13（安装器输出编码）仍开；安装器 argv/env 白名单契约未变 |
| 联机 | H2/H3/H4/H7 修复已落地；新增 N4（medium）、N7/N8（low）；`control.ts` 的握手超时+并发上限实现正确（认证/失败/关闭三处都清 pending，无泄漏） |

覆盖矩阵（子进程与句柄清理 / 并发下载竞态 / Windows 路径·空格·中文 / 令牌不落明文 / 邀请码校验 / 静默失败）与第 1 轮一致，本轮变化：
- 子进程与句柄清理：从"不达标"提升到"主路径达标"，余 N1/N2/N7；
- 令牌不落明文：仍达标（H2 后 secret 不再进 argv；env 仍不是硬边界，属可接受残留——同用户进程可用 PEB 读取，但代价远高于 `CommandLine`）；
- 并发下载竞态：从"跨入口不达标"提升到"达标"（batch 持锁 + 去重 + 锁心跳）；
- 邀请码校验：维持达标（Ed25519 + 私网约束 + 中文错误码已透传）；
- 静默失败：新增 N4（secret 通道 fail-open 风险）、N5（可选链吞错）、N8（原因丢失）。

---

## 5. 修复顺序建议

1. **N1**（一行判别 + 复用"仅最小化"分支）→ 立刻消除退出死胡同；
2. **N2**（taskkill timeout + before-quit race 3 s）；
3. **N3**（补 11 个无害变量）与 **N4**（补 2 个断言 + 1 条真机取证）；
4. N5/N6/N7/N8 一次清（都是 ≤10 行）；
5. H9 与 H11–H14 可与上面合并，均为低风险整理。

回归验证建议：
- N1：真实启动游戏 → 关窗口 → 分别点"取消"/按 Esc/点 X → 断言仍有可见窗口（`BrowserWindow.getAllWindows().length === 1`）且游戏未断流（日志继续增长）；
- N2：在 `net.dispose` 里注入永不 resolve 的 fake，断言 3 s 后仍能退出；
- N4：`easytier.test.ts` 断言 spawn env 含 `ET_NETWORK_SECRET`、argv 不含 secret；真机 `easytier-core --help | Select-String network-secret` 留证。
