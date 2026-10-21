# 06 · 代码与安全审查（t35）— 启动 / 安装 / 账户 / 模组 / 加载器 / 联机

- 审查人：reviewer（👁️ 代码审查 + 🔐 应用安全）
- 日期：2026-10-21
- 审查对象：当前工作树 `src/main/**`（t48/t43/t44/t47 之后的实现），被审任务 t28
- 结论：**needs_revision**（阻断性发现 2 条、高危 1 条、中危 6 条、低危 5 条）
- 未改动任何产品代码；本文件是唯一新增产物。

---

## 0. 结论摘要

| 级别 | 数量 | 代表问题 |
| --- | --- | --- |
| high | 3 | 退出启动器不处理游戏子进程与 stdio 管道（H1）；EasyTier 网络密钥进 argv（H2）；联机 LinkError 在 IPC 层退化为 `IPC.HANDLER_FAILED` + 英文 message（H3） |
| medium | 6 | sidecar 退出不清（H4）、作业锁无心跳（H5）、loader 库下载绕过安装锁（H6）、未认证控制连接无上限（H7）、游戏进程继承启动器全部环境变量（H8）、生产环境 IPC 信任 `http://localhost`（H9） |
| low | 5 | plan 回传完整 env（H10）、重入覆盖 launch-last 证据（H11）、长路径支持只在下载模块（H12）、安装器输出 UTF-8 解码（H13）、Authlib 注入 wiring 静默放弃（H14） |

已确认**做得好**、不需要返工的部分见 §4（避免下游重复审查）。

---

## 1. 六个模块逐文件结论

图例：**OK** = 已逐行读完，无必修项；**OK\*** = 已逐行读完，有本文件里登记的发现；**抽查** = 读关键路径（列出的行段），未逐行；**薄** = 薄封装（≤60 行），已整读。

### 1.1 启动链（launch）

| 文件 | 深度 | 结论 |
| --- | --- | --- |
| `src/main/core/launch/process.ts` | OK\* | 行分割/解码/退出分类/`stop()` 分级 kill 都对；H1（管道句柄随进程消失）、H1b（listener 不清理，仅内存） |
| `src/main/core/launch/orchestrator.ts` | OK\* | 单实例锁（同 instance 已运行）在 prepare 之后但整段同步，无并发窗口；H1（`stopAll()` 无生产调用者）、H10（plan 回传全量 env）、H11（重入覆盖证据） |
| `src/main/core/launch/args.ts` | OK\* | 占位符替换/受管参数拒绝/`${}` 残留硬失败/quickPlay 判定都对；H8（`cleanEnvironment` 只清 4 个 Java 变量，`MCL_*` 全部留给游戏） |
| `src/main/core/launch/natives.ts` | OK\* | marker 指纹缓存、变更即整目录重建，行为正确；H12（无 `\\?\` 长路径） |
| `src/main/core/launch/artifacts.ts` | OK | 写 `launch-last.json/.bat`、token 置 `<redacted>`、env 走 `SAFE_ENV_KEYS` 白名单——这一处是全仓最好的做法，建议 H10 复用它 |
| `src/main/core/launch/settings.ts` | 薄 | `autoMaxMemoryMb` clamp(25%,2048,8192)；`chcp`/注册表回退 936 —— OK |
| `src/main/core/launch/hints.ts` | 抽查 | 崩溃特征匹配，纯函数，无 I/O —— OK |
| `src/main/core/ports.ts` | OK | `execFile`/`spawn` 均 `shell:false`；`writeTextAtomic` 有 Windows rename 回退 —— OK |
| `src/main/core/zip/reader.ts` | OK | 全仓最强的一处防御：拒绝 `..`/绝对路径/UNC/ADS/保留名/尾部点空格/symlink/加密/zip64/重复条目，CRC+尺寸校验，条目数与总解压量上限 —— OK |
| `src/main/modules/launch/service.ts` | OK\* | 懒建 orchestrator、`setAccountResolver` 公开 API 正确；H1（`stopAll` 无调用者） |
| `src/main/modules/launch/index.ts` / `handlers.ts` | 薄 | 纯转发 —— OK |

### 1.2 安装链（download + repair 调用面）

| 文件 | 深度 | 结论 |
| --- | --- | --- |
| `src/main/modules/download/core/queue.ts` | OK\* | `.part` + `Range`/`If-Range` + 206 `Content-Range` 校验 + 校验器变更重下 + 全文件 size/hash 后才 rename + 每主机限流，设计扎实；H6（`enqueue` 入口不去重、不取锁）、worker hook 抛错会整体中断（已由 runQueue catch 兜住，仅提示质量为 low） |
| `src/main/modules/download/core/fs-atomic.ts` | OK\* | `assertSafeRelPath`/`resolveInside` 覆盖 traversal/ADS/保留名/尾点空格；H5（作业锁无心跳，10 min 即 stale） |
| `src/main/modules/download/core/http.ts` | 抽查 | 超时/中止/重定向白名单/`agent:false`、`totalTimeoutMs` —— OK |
| `src/main/modules/download/core/plan.ts` | 抽查 | `dedupe` by `destRel`（无 hash 的变体让位有 hash 的），无 hash 且非可信 host 直接 `DOWNLOAD.HASH_REQUIRED` —— OK |
| `src/main/modules/download/service.ts` | 抽查 | `startInstall` 先校验 `versionId` 正则 `^[A-Za-z0-9._+-]{1,128}$` 再查 manifest（不留空目录），install/repair 持锁、batch 不持锁；H6 |
| `src/main/modules/download/ipc-core.ts` | OK | 自带 envelope：sender 校验 → zod 输入 → handler → (dev) 输出校验，与 kernel 同构 —— OK |
| `src/main/modules/download/ipc.ts` | OK\* | **H3b：这里注入的是 `@shared/errors` 的 `toErrorShape`（只认 `AppError`），DownloadError 的 `DOWNLOAD.*` 仍会被压成 `IPC.HANDLER_FAILED`** |
| `src/main/modules/download/module.ts` / `index.ts` / `handlers.ts` | 薄 | 纯装配，契约漂移在启动期失败 —— OK |
| `src/main/modules/download/core/{sources,retry,hash,manifest,settings,errors,job}.ts` | 抽查 | 只读了被调用面（`availability`/`recordFailure`/`resolveExpectedHash`/`DownloadError.toShape`）。**B1（连续 3 次失败整会话熔断）确认仍在 `sources.ts` 的 breaker 里，已由 t46 承担**，本审查不重复登记 |

### 1.3 账户（auth）

| 文件 | 深度 | 结论 |
| --- | --- | --- |
| `src/main/modules/auth/store.ts` | OK | 账户文件只有公开字段；`SessionStore.set` 先 `requireCipher()`，`basic_text` 直接拒绝（**令牌不落明文**达标） |
| `src/main/modules/auth/cipher.ts` | OK | `isEncryptionAvailable() && backend !== 'basic_text'` —— OK |
| `src/main/modules/auth/authlib.ts` | OK | 固定版本 + 固定 SHA-256、下载后先验后写、原子 rename —— OK |
| `src/main/modules/auth/service.ts` | 抽查 | 设备码流程、`REFRESH_MAX_AGE_MS`、`refreshToken` 只在加密后落盘；Authlib 服务器强制 `https:`（`AUTH.AUTHLIB_INSECURE`）—— OK |
| `src/main/modules/auth/microsoft.ts` | 抽查 | 只走 MS 公开端点，错误归一为 `AADSTS` 可读文案 —— OK |
| `src/main/modules/auth/http.ts` / `errors.ts` / `uuid.ts` | 薄/抽查 | 20 s 超时 + AbortController；离线 UUID = MD5(`OfflinePlayer:`+name) v3 —— OK |
| `src/main/modules/auth/index.ts` | OK\* | **H14：`wireLaunchBridge` 用私有字段探针 + 50 ms×60 次重试，失败后静默返回；Authlib 注入可能永远不生效且无日志** |

### 1.4 模组（mods）

| 文件 | 深度 | 结论 |
| --- | --- | --- |
| `src/main/modules/mods/service.ts` | 抽查（1–353、353–556、556–735） | `installLocalFile` 用 `safeBaseName` 落盘、重名 `(n)` 递增、512 MB 上限、`.mrpack` 引导走 import；`setEnabled/remove` 只按 basename 解析且拒绝目录；`importModpack` 失败时删掉半成品实例目录 —— OK |
| `src/main/modules/mods/modpack.ts` | 抽查 | `packTarget` 拒绝 `..`/绝对/NUL 且 `BLOCKED_ROOTS`（`instance.json`、`versions`、`logs`、`saves`…）**堵住了"整合包改写实例配置注入 JVM 参数"这条提权链**，是本轮最值得保留的设计 |
| `src/main/modules/mods/downloader.ts` | OK | 强制 HTTPS、`content-length` 与实体双重大小上限、sha1/sha512 不匹配即硬失败 |
| `src/main/modules/mods/archive.ts` | 抽查 | 出包走 `assertSafeEntryName`；`extractOverrides` 跳过目录/symlink —— OK |
| `src/main/modules/mods/metadata.ts` | 抽查 | `openZipFile` 默认限额内读 `fabric.mod.json`/`mods.toml` —— OK（zip 炸弹被 512 MB 单条目上限挡住，属可接受残留） |
| `src/main/modules/mods/index.ts` / `handlers.ts` | 薄 | 自注册契约 + `changed` 事件 —— OK |

### 1.5 加载器（loader）

| 文件 | 深度 | 结论 |
| --- | --- | --- |
| `src/main/modules/loader/core/installer.ts` | OK\* | 固定 argv `-Djava.awt.headless=true -jar <jar> --installClient <mcRoot>`、固定 cwd=临时目录、`shell:false`、env 白名单、15 min 超时/取消 kill、输出行解析有界（400 行/40 错误行）—— 优秀；H13（每 chunk 新建 TextDecoder，UTF-8 解码中文输出会花屏） |
| `src/main/modules/loader/core/meta.ts` | OK | 所有进入 URL/文件名的版本号都过 `SAFE_VERSION=/^[A-Za-z0-9._+\-]{1,64}$/`（**metadata → 路径 的穿越面已封**）；sha1 分级 mirror/list/official/none |
| `src/main/modules/loader/core/plan.ts` | OK | `assertVersionIdSafe(^[A-Za-z0-9._+\-]{1,80}$)`；父版本缺失 `LOADER.PARENT_MISSING`；plan 阶段就把 `sha1`/`hashSource` 暴露给 UI 确认 |
| `src/main/modules/loader/service.ts` | OK\* | `install` 重算 plan 再比对 `confirmSha1`（防 TOCTOU 换包）、`hashSource=none` 必须 `allowUnverifiedInstaller`、`activeRoots` 同 root+type+mc 互斥、失败走 snapshot+rollback 并删临时目录 —— H6（库下载经 `download.enqueue`，不持安装锁） |
| `src/main/modules/loader/core/verify.ts` | 抽查 | `dryRun` 无进程、合成账户明示 `syntheticAccount` —— OK |
| `src/main/modules/loader/core/{job,rollback,errors,http}.ts` | 抽查 | 回滚删新增版本目录/还原 `launcher_profiles.json`/清 workDir —— OK |
| `src/main/modules/loader/{index,handlers,module}.ts` | 薄 | 自注册 + `moduleIpc.emit`，契约漂移在启动期失败 —— OK |

### 1.6 联机（net）

| 文件 | 深度 | 结论 |
| --- | --- | --- |
| `src/main/modules/net/ticket.ts` | OK | 邀请码 = `MCL1.<code>.<payload>.<Ed25519 sig>`；code 由 roomId 派生、签名覆盖 code+payload、`exp/iat` 带 300 s 时钟容差、LAN endpoint 必须是私有/回环字面量；控制通道 `HELLO/WELCOME` 用 HMAC + `timingSafeEqual` —— **邀请码校验达标**（唯一缺口：无 `jti` 重放缓存，10 min TTL 内可重放，可接受） |
| `src/main/modules/net/control.ts` | OK\* | 鉴权前只允许 `HELLO`，行 64 KB 上限，心跳 sweep 清成员，`snapshot()` 永远含房主且 `pingKnown/pingLabel` 显式（B5 的一半已修）；H7（鉴权前连接无上限、无 HELLO 超时） |
| `src/main/modules/net/room.ts` | 抽查（150–570、890–1130） | `create` 拒绝通配/非私网绑定；`join` 对 6 位短码直接 `INVITE_INCOMPLETE`；`enterWorld/joinLanWorld` 只允许私有/回环目标；`diagnose`/`snapshot` 不含 `net.secret` —— OK；H2（secret 进 argv）、H3 |
| `src/main/modules/net/args.ts` | OK\* | 别名/监听/peer 约束齐；**H2：`--network-secret <hex>` 走 argv** |
| `src/main/modules/net/easytier.ts` | 抽查 | zip 与三个可执行文件都钉 SHA-256、每次启动复验；`taskkill /T /F` 杀进程树 —— OK；H4（`exit` 钩子里等不到异步 kill）、H8b（`env: {...process.env}` 全量继承） |
| `src/main/modules/net/index.ts` | 薄 | **H4：`process.once('exit', () => void service.dispose())` —— `exit` 里无法跑异步清理** |
| `src/main/modules/net/handlers.ts` | 薄 | 纯转发，`LinkError` 直接抛出 → H3 |
| `src/main/modules/net/{config,constants,discovery}.ts` | 薄/抽查 | relay peer 正则白名单、relay ≤4、maxMembers 2–8；LAN 发现只读文本日志尾部（128 KB）+ UDP 广播解析，`joinLanWorld` 再校验私网 —— OK |

---

## 2. 发现清单（含 file:line 与必修项）

### H1 · high · 关闭启动器时既不结束游戏，也不处理子进程管道

- `src/main/index.ts:343-345`（`window-all-closed` → `app.quit()`）、`src/main/index.ts:351-356`（`before-quit` 只写日志）
- `src/main/core/launch/orchestrator.ts:639-641`（`stopAll()` 无任何生产调用者）
- `src/main/core/ports.ts:228-236`（`stdio: ['pipe','pipe','pipe']`）、`src/main/core/launch/process.ts:236-240`

问题：点窗口右上角关闭 → Electron 主进程退出，但 `javaw.exe` 仍在跑，而它 stdout/stderr 的**读端随主进程一起消失**。Windows 上子进程后续写 stdout 会拿到 `ERROR_BROKEN_PIPE`，Java 侧打印 `IOException: The pipe is being closed`，同时启动器侧的游戏日志（`$DATA/logs/game/**`）在退出瞬间截断，崩溃分析拿不到尾部。当前既没有"是否结束游戏"的提示，也没有 detach/重定向，属于"句柄清理"这一验收项的直接不达标。

必修：
1. `before-quit` 里若存在运行中的 session：`event.preventDefault()` → 弹窗（结束游戏 / 仅退出启动器）→ 结束分支 `await service.stopAll()` 后再 `app.quit()`（二次进入用标志位）；或
2. spawn 时把 stdout/stderr 直接绑到日志文件 fd（`fs.openSync(logFile,'a')`）而不是 pipe，让子进程在父进程死后仍能写；两种方案二选一，并在 03 §6.7 写清语义（"退出启动器 = 游戏继续"还是"= 游戏结束"）。

### H2 · high · EasyTier 网络密钥出现在子进程命令行

- `src/main/modules/net/args.ts:112-113`（host）、`src/main/modules/net/args.ts:139-140`（member）：`--network-secret <secret>`
- `src/main/modules/net/room.ts:555`：`networkSecret: this.identity.netSecret.toString('hex')`

问题：房间密钥是**唯二的准入凭证**之一（另一个是签名邀请码），却以明文 argv 暴露：本机任意进程/用户在任务管理器、`Win32_Process.CommandLine`、部分 EDR 日志里都能直接读到；EasyTier 自身崩溃转储也会带命令行。ticket.ts 里"secret 永不落日志"的承诺被 argv 绕过。

必修：改用 EasyTier 支持的 secret 文件/环境变量（`--network-secret-file` 或 env），或生成临时配置文件并在 sidecar 退出后立即删除；同时把 `net` 侧的 `redact()` 扩展到 `CommandLine` 级别日志，并在 04 文档标注"secret 不得进 argv"。

### H3 · high · 联机 `LinkError` 在 IPC 层被压成 `IPC.HANDLER_FAILED` + 英文 message

- `src/main/modules/net/ticket.ts:61-77`（`LinkError`：只有 `code`/`retryable`/`details`，**没有 `toShape()`**）
- `src/main/kernel/error-shape.ts:11-23`（`DOMAIN_CODE` 只认 `NET.`/`LAUNCH.` 这类带前缀的码）、`:74-81`（兜底 `IPC.HANDLER_FAILED` + `error.message`）
- `src/main/modules/net/handlers.ts:26-37`（`copyInvite`/`setWorldPort`/`enterWorld`/`joinLanWorld` 直接抛 `LinkError`）

问题：`LinkError.code` 是裸码（`INVITE_EXPIRED`、`TICKET_MALFORMED`、`VERSION_MISMATCH`、`WORLD_NOT_FOUND`、`LAUNCH_FAILED`…），不匹配 `DOMAIN_CODE`，于是走兜底分支：前端拿到 `IPC.HANDLER_FAILED` + `"ticket prefix/parts"` / `"room is not connected"` 这种英文技术串。t48 修的是 kernel 内置契约（java/launch/loader/repair/mods/instance/version），**net 是自注册契约，从这条修复里漏掉了**；`error-shape.test.ts` 也没有 LinkError 用例。这正好顶到 t35 验收里"邀请码过期/篡改/版本不匹配分别返回可区分的错误码与中文提示"和 B5 的进世界链路。

必修：给 `LinkError` 增加 `toShape(): { code, message: LINK_ERROR_MESSAGES[code] ?? message, retryable, details }`；`kernel/error-shape.ts` 的 `asShape` 增补`(value as {linkCode?: boolean})` 或直接放行 `LINK_ERROR_CODES` 里的码（`@shared/net` 导出）；补 `error-shape.test.ts` 的 LinkError 用例。

### H3b · medium · 下载模块仍用 `toErrorShape`，安装链的 `DOWNLOAD.*` 码被吞

- `src/main/modules/download/ipc.ts:59`（`toErrorShape` 来自 `@shared/errors`，import 在 `:2`）
- `src/shared/errors.ts:45-50`（**只认 `AppError`**，其它一律 `fallbackCode`）
- `src/main/modules/download/core/errors.ts:184`（`DownloadError.toShape()` 存在，但这条路径没被使用）

问题：`mc:download:plan/install/enqueue` 抛出的 `DOWNLOAD.VERSION_NOT_FOUND`、`DOWNLOAD.LOCKED`、`DOWNLOAD.INVALID_TASK`、`DOWNLOAD.PATH_UNSAFE` 全部变成 `IPC.HANDLER_FAILED`，前端按码给中文指引的能力在**安装链**这一 P0 主链上失效（作业级失败仍带码，只有 IPC 级校验失败被吞）。

必修：`download/ipc.ts` 改注入 kernel 的 `toHandlerErrorShape`（`asShape` 会走 `DownloadError.toShape()`，`DOWNLOAD.*` 匹配 `DOMAIN_CODE`）；`shared/errors.toErrorShape` 增加"若 `error.toShape` 存在则优先"的分支，避免同类漏网。

### H4 · medium · 退出时 sidecar 不会被可靠终止

- `src/main/modules/net/index.ts:55-57`：`process.once('exit', () => { void service.dispose() })`
- `src/main/modules/net/easytier.ts:440-458`：`killChild` 用 `await execFileAsync('taskkill.exe', …)`

问题：`exit` 事件里不能等待异步；`dispose → leave → cleanupHost → stopTunnel → handle.stop → taskkill` 至少两跳 `await`，实际只跑到 `hostControl.close()` 的同步部分。结果：**关掉启动器后 EasyTier sidecar 常驻**（虚拟网卡、监听端口、与房间网络都还在），下次开房 `peerPort` 冲突或直接复用旧网络。

必修：改用 `app.on('will-quit')`（Electron 允许此处 `event.preventDefault()` 后异步清理再 quit），或在 kernel 暴露一个同步的 shutdown 钩子（`spawnSync('taskkill', ['/PID', pid, '/T', '/F'])`）。

### H5 · medium · 作业锁无心跳，10 分钟即被判定为"废弃锁"

- `src/main/modules/download/core/fs-atomic.ts:245-285`（`staleMs = 10 * 60 * 1000`，锁文件只在 `acquireJobLock` 写一次，mtime 不再更新）
- 参照数据：t34 实测全新安装 1.20.1 用了 **425 s**，慢镜像/限速下超过 600 s 完全可能

问题：两个启动器实例（portable 同一 data 目录）或"安装卡住后用户重开一个"，第二个进程会 **删掉仍在使用的锁** 并开始并发写同一批 `libraries/**`、`assets/**`。

必修：加心跳（每 60 s `utimes` 刷 mtime，或后台 timer），或写入 pid 并用 `process.kill(pid, 0)` 判定存活 —— 仅当"mtime 过期 **且** pid 不存在"才允许接管。

### H6 · medium · 加载器库下载绕过安装锁，且 `enqueue` 不去重

- `src/main/modules/download/service.ts:623-643`（`enqueue` → `createJob('batch', …)`）
- `src/main/modules/download/service.ts:784-789`（`if (handle.mode !== 'batch')` 才取锁）
- `src/main/modules/loader/service.ts:532-538`（`downloader.enqueue(libraryTasks.tasks)` 下载加载器库）

问题：用户"装原版 1.20.1"与"装 Fabric/Forge"并发时，两条链都会写 `libraries/**` 的同名目标；`batch` 既不持锁也不做 `dedupe`（`dedupe` 只在 `core/plan.ts` 的 `buildInstallPlan` 里），两个 worker 会同时写同一个 `<dest>.part`、互相 append/覆盖，最后靠 hash 失败重下（甚至循环）。

必修：`enqueue` 也按 `root` 取同一把作业锁（或对 `libraries/assets` 前缀做段锁），并在服务层对传入 tasks 复跑 `dedupe(by destRel + hash 优先)`。

### H7 · medium · 联机控制端口：未认证连接无上限、无 HELLO 超时

- `src/main/modules/net/control.ts:106-128`（`accept` 只把 socket 塞进 `this.sockets`，不设超时）
- `src/main/modules/net/control.ts:123-128`（每条连接最多缓冲 64 KB）

问题：房间控制端口绑在内网 IP（非通配，已正确），但同网段任何人可以对它开成百上千条 TCP 连接、一条 `HELLO` 都不发；`sockets` 集合与缓冲随连接线性增长，心跳 sweep 只清**已认证**成员。这是局域网内的低成本 DoS/句柄耗尽面。

必修：`accept` 里给 socket 设 `handshakeTimeoutMs`（例如 10 s，超时 `destroy()`）与全局未认证连接上限（例如 32），并在 `close()` 里清掉计时器。

### H8 · medium · 游戏进程继承启动器全部环境变量

- `src/main/core/launch/args.ts:151-156`（只清 `_JAVA_OPTIONS`/`JAVA_TOOL_OPTIONS`/`JDK_JAVA_OPTIONS`/`CLASSPATH`）
- `src/main/core/launch/args.ts:184-192`（`cleanEnvironment` 其余全部放行）
- `src/main/modules/mods/modpack.ts:332`（`process.env.MCL_CF_API_KEY` 会被这条链带进游戏）

问题：`MCL_CF_API_KEY`、`MCL_MS_CLIENT_ID` 等启动器自己的秘密会出现在游戏进程 env 里；游戏进程内跑的是**第三方模组代码**（不可信），`System.getenv()` 一行就能读走。同理 `src/main/modules/net/easytier.ts:267-271` 把全量 env 传给第三方 sidecar。

必修：`cleanEnvironment` 增加前缀黑名单（`MCL_`）并显式白名单化；sidecar 复用 loader 的 `installerEnvironment()` 白名单。

### H9 · medium · 生产环境 IPC 也信任 `http://localhost`

- `src/main/kernel/security.ts:43-54`（`isTrustedUrl`：`http(s)` + `localhost`/`127.0.0.1`/`[::1]` 一律信任）
- `src/main/kernel/ipc.ts:374-379`（所有 IPC 的 sender 校验都靠它）

问题：为 dev（`ELECTRON_RENDERER_URL`）放开的 localhost 白名单在打包后依然生效。任何**本机** HTTP 服务（端口无关）一旦被导航到同一窗口，就拿到完整 `window.mc` IPC 权限（写入任意 `destRel` 下载、启停游戏、读账户列表）。当前没有代码会导航到 localhost，所以是纵深防御缺口而非在野漏洞，但代价极低。

必修：`app.isPackaged` 时只接受 `app://mc-launcher`；dev 时把 `ELECTRON_RENDERER_URL` 的 origin 精确加入白名单（不放开整个 localhost）。

### H10 · low · `launch:plan` 把完整进程环境变量回传给 renderer

- `src/main/core/launch/orchestrator.ts:352`（`env: plan.env`）
- `src/shared/launch.ts:36`（`env: z.record(...)`）

问题：dry-run 面板的 `env` 就是 `process.env` 全量（含 `MCL_*`）。renderer 目前没展示，但这条通道把 H8 的秘密又送到了 UI 侧（复制/截图/渲染进程崩溃转储都会带出去）。

必修：只回传 `SAFE_ENV_KEYS` 白名单（直接复用 `core/launch/artifacts.ts:68-93`）或干脆不回传。

### H11 · low · 重入启动会先覆盖 `launch-last.json/.bat` 证据

- `src/main/core/launch/orchestrator.ts:359-376`（prepare 阶段就 `writeLaunchArtifacts`）
- `src/main/core/launch/orchestrator.ts:413-418`（`LAUNCH.ALREADY_RUNNING` 检查在其后）

问题：对已运行实例再点一次启动 → prepare 先写 artifacts，然后才抛 `ALREADY_RUNNING`，上一轮证据被覆盖；同时分配了一个不会再用的游戏日志文件。

必修：`start()` 里把"实例已运行"检查移到 `prepare()` 之前，或 artifacts 写到 `logs/sessions/<sessionId>/` 下。

### H12 · low · 长路径（>260）只覆盖下载模块

- `src/main/core/launch/natives.ts:151-152, 173`（`fs.remove`/`fs.mkdirp`/`extractZip` 用裸路径）
- 对照 `src/main/modules/download/core/fs-atomic.ts:22-29`（`winLongPath`）

问题：`C:\Users\…\Documents\…` 深目录 + 中文实例名时，natives 目录/游戏日志可能超 260 字符而失败（`ENAMETOOLONG`），报错只到 `ARCHIVE.INVALID`/原生错误。

必修：把 `winLongPath` 提到 `kernel/paths.ts`，在 launch/mods 的文件写入路径复用；至少对 `nativesDir`、游戏日志目录做一次长度检查并给可读错误。

### H13 · low · 安装器输出用 UTF-8 解码（每 chunk 新建 decoder）

- `src/main/modules/loader/core/installer.ts:176-178`

问题：中文 Windows 上 Forge/NeoForge 安装器输出是 GBK；按 UTF-8 解码会花屏（进度条/任务名变成 `�`），且每个 chunk 新建 `TextDecoder` 会把跨 chunk 的多字节字符切坏。

必修：复用 `core/launch/settings.ts` 的 `logEncodingForCodePage` + 单个 `TextDecoder(…, {stream:true})` 实例（与 `launch/process.ts:202-232` 同款写法）。

### H14 · low · Authlib 注入 wiring 可能静默不生效

- `src/main/modules/auth/index.ts:44-91`（50 ms × 60 次重试后直接 `return`，**没有失败日志**）
- `src/main/modules/auth/index.ts:74-87`（通过 `(launch as unknown as {orchestrator?}).orchestrator.options.resolveAuthlib = …` 探针私有字段）

问题：`mcRoot` 未配置时 `requireOrchestrator()` 抛错 → 重试 3 s → 放弃且无日志；用户之后配置目录并启动 Authlib 账户时，`-javaagent:authlib-injector` 不会注入，表现为"登录了却进不去验证服"的静默错误。此外探针依赖私有字段，属实现耦合。

必修：给 `LaunchModuleService` 增加与 `setAccountResolver` 对称的 `setAuthlibResolver()`（内部同步到 orchestrator），wiring 失败时 `log.warn` 并在 UI/诊断里可见。

---

## 3. 验收项覆盖矩阵

| 验收角度 | 覆盖位置 | 结论 |
| --- | --- | --- |
| 子进程与句柄清理 | `process.ts`、`orchestrator.ts`、`index.ts`、`ports.ts`、`loader/core/installer.ts`、`net/easytier.ts`、`control.ts` | **不达标**：H1、H4、H7 |
| 并发下载竞态 | `download/core/{queue,plan,fs-atomic}.ts`、`download/service.ts`、`loader/service.ts` | 队列内正确（dedupe/hash/lock）；**跨入口不达标**：H5、H6 |
| Windows 路径 / 空格 / 中文 | `download/core/fs-atomic.ts`、`core/zip/reader.ts`、`loader/core/meta.ts`、`launch/args.ts`、`loader/core/installer.ts` | 路径安全（traversal/ADS/保留名/尾空格）达标，中文与空格可达标；长路径仅下载链（H12）、安装器输出编码（H13） |
| 令牌不落明文 | `auth/{store,cipher}.ts`、`core/launch/artifacts.ts`、`kernel/logger.ts`、`net/ticket.ts` | 达标（DPAPI + 拒绝 `basic_text` + artifacts 白名单 + 日志 redact）；残留：H2（网络密钥走 argv）、H8（秘密进游戏 env） |
| 邀请码校验 | `net/ticket.ts`、`net/control.ts`、`net/room.ts:280-352` | **校验本身达标**（Ed25519 + 过期 + code 由 roomId 派生 + LAN 仅私网 + HMAC 时序安全比较 + 短码 `INVITE_INCOMPLETE`）；**呈现不达标**：H3 |
| 静默失败 | 全模块 `catch` 扫描（仅 `process.ts:321`、`download/service.ts:867` 为无害吞错） | 大体达标；具体：H14（Authlib wiring）、H4（sidecar）、H1（退出） |

---

## 4. 已确认良好、无需返工的点（避免下游重复审）

1. **ZIP 解包防御**（`core/zip/reader.ts`）：traversal / 绝对路径 / UNC / ADS(`:`) / 保留设备名 / 尾部点空格 / symlink / 加密 / zip64 / 重复条目 / CRC+尺寸 / 条目数与总量上限，一条不缺；`mods/modpack.ts` 的 `BLOCKED_ROOTS` 还额外堵住了"整合包改写 `instance.json` 注入 JVM 参数"。
2. **加载器安装器执行面**（`loader/core/installer.ts`）：固定 argv、cwd 隔离、`shell:false`、env 白名单、超时/取消 kill、失败回滚 + 删临时目录。
3. **加载器确认协议**（`loader/service.ts:225-238`）：`confirmSha1` 回显 + `allowUnverifiedInstaller` 双闸；`hashSource=none` 不会被静默执行。
4. **下载原子性**（`download/core/queue.ts`）：`.part` + `Range/If-Range` + `206 Content-Range` 校验 + 校验器变更重下 + 全文件 hash 后才 rename；无 hash 且非可信 host 直接拒绝（`DOWNLOAD.HASH_REQUIRED`）。
5. **令牌持久化**（`auth/store.ts` + `auth/cipher.ts`）：`basic_text` 硬拒绝、`accounts.json` 只有公开字段、`launch-last.json` env 白名单 + accessToken `<redacted>`。
6. **联机票据**（`net/ticket.ts`）：Ed25519 自验证 + 300 s 时钟容差 + LAN endpoint 私网约束 + `timingSafeEqual`；`snapshot()`/`diagnose()` 不泄漏 `net.secret`。
7. **IPC 统一信封**（`kernel/ipc.ts` + `download/ipc-core.ts`）：sender 校验 → zod 输入 → handler → dev 输出校验，异常不出进程（**只有 H3/H3b 的 error shape 映射需要补**）。
8. **Electron 加固**（`kernel/security.ts` + `index.ts:247-258`）：`contextIsolation`/`sandbox`/`nodeIntegration:false`/`webviewTag:false`；`app://` 自定义协议 + 响应头 CSP（`default-src 'none'`）；`setWindowOpenHandler` 拒绝、`will-navigate` 白名单、`will-attach-webview` 拒绝、权限默认拒绝。

---

## 5. 与既有阻断项（t34 B1–B8）的关系

| 现有编号 | 本审查结论 |
| --- | --- |
| B1 下载断路器 | 确认仍在 `download/core/sources.ts`，**由 t46 承担**，本文件不重复登记 |
| B2 设置页 disabled | 已在 t47 交付（renderer），不在本次六模块范围 |
| B3 错误码被包 | kernel 侧已由 t48 修好；**残留 H3（net 自注册契约）与 H3b（download 自注入 toErrorShape）** |
| B4 崩溃无弹窗/无落盘/无轮转 | t48 已交付，本轮未发现新问题 |
| B5 联机房主/ping/LAN 进世界 | `snapshot()` 已含房主与 `pingKnown/pingLabel`；**进世界链路的错误呈现仍是 H3** |
| B6 微软/Authlib 入口 | t47 已接；**Authlib 注入 wiring 见 H14** |
| B7 CF zip / Zip-Slip | 解包防御已达生产级（§4.1） |
| B8 01 文档数值 | 文档问题，不在代码审查范围 |

---

## 6. 建议的修复顺序（最小返工）

1. H1 + H4（退出语义与子进程清理，一次改动同时解决两个模块的"句柄清理"）。
2. H2（secret 不进 argv）+ H8（env 白名单化；顺手解决 H10）。
3. H3 + H3b（错误形态统一，改 2 个文件 + 补 2 个单测）。
4. H5 + H6（作业锁心跳与 batch 持锁，一套锁语义）。
5. H7、H9（各 10 行以内的防御补丁）。
6. H11–H14（低风险整理，可与上面合并）。

每项修完后的验证建议：H1 用"点关闭 → 检查 `javaw.exe` 与 `$DATA/logs/game` 尾部"；H3/H3b 用"直接 IPC 调 `mc:net:copyInvite`（无房间）与 `mc:download:install`（不存在版本）断言 code 不是 `IPC.HANDLER_FAILED`"；H5 用"伪造 11 分钟前的锁文件 + 活的 pid"断言不接管。
