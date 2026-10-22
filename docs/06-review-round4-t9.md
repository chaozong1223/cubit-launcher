# 06 · 二期实现审查（t1–t8）与 P3 修复（t9）

| 项 | 值 |
|---|---|
| 文档编号 | `06-review-round4-t9` |
| 日期 | 2026-10-22 |
| 审查人 | reviewer（审查、回归验证与文档口径） |
| 范围 | t1 作业内核 / t2 分享包 / t3 存档跨版本 / t4 投影 / t5 链接导入 / t6 渲染层接入 / t7 性能面板 / t8 皮肤与联机 SDK |
| 维度 | 子进程清理、并发竞态、路径兼容、令牌不落明文 |
| 本次代码改动 | `loader/core/installer.ts`（UTF-8 流式解码）、`auth/service.ts`（pollAuthCode 幂等）、`sdk/service.ts` + `sdk/index.ts`（sidecar 退出清理、并发启动守卫）、`download/__tests__/service.test.ts`（取消点 flake）及对应测试 |
| 不改动 | 上述子系统之外的实现、`src/main/index.ts` 等冻结文件、`package.json` |

> 本文是**实现审查**，不是 P0 验收。P0 状态仍以 [`docs/07-final-acceptance.md`](07-final-acceptance.md) 与 [`docs/05-acceptance-report.md`](05-acceptance-report.md) 为准；P0-6 口径已按 [`docs/08-p0-6-lan-e2e.md`](08-p0-6-lan-e2e.md) 对齐。

---

## 1. 结论

- 四个维度上**未发现阻断级（blocker/high）问题**；三个已确认的产品 P3 问题在本次一并修复并补了回归测试（另修一个与负载相关的测试 flake，见 F13）。
- 其余发现记录在第 §5 节（3 个 medium、6 个 low、2 个观察），均给出建议修复方向；其中 **皮肤链接 DNS 解析到内网（SSRF）**、**分享包脱敏未覆盖 `apiKey` 类键**、**分享包在内存中打包** 建议在发布前处理。
- 二期能力不改变 P0 结论：README 的 P0 表未升级任何一项状态。

## 2. 审查方法

1. 逐文件阅读 t1–t8 的实现与测试：`core/job/kernel.ts`、`modules/mods/*`、`core/instance/{copy,share}/*`、`modules/assets` 的存档/投影路径、`modules/catalog` 的链接导入、`modules/{perf,skin,sdk}/*`、`renderer/app/data/{backend,waitJob}.ts` 与各页面接线。
2. 针对四个维度做定向搜索：`spawn/kill/unref/detached`、`JobRegistry/cancel/pause/checkpoint`、`path.join/realpath/assertChild/sanitizePathName`、`token/apiKey/password/Cookie/Authorization`。
3. 对可疑点写最小复现（单测或临时脚本）后再决定是否修复；修复项均带回归测试。
4. 全量门禁：`typecheck`、`vitest run`、`build`、`guard`（结果见 §6）；未重跑 01/05 的 16 步验收与真机 e2e（t1–t8 各自已有真机证据）。

## 3. P3 修复（本次改动）

### 3.1 安装器日志跨块 UTF-8 花屏（R1/H13）

- **问题**：`core/installer.ts` 原为每个 `data` 块 `new TextDecoder('utf-8').decode(chunk)`。UTF-8 的 3 字节汉字被 `data` 边界切开时，两次解码各产生一个 U+FFFD，中文 Windows 上 Forge/NeoForge 安装日志即“花屏/截断”。
- **修复**：每条流只建一个 `TextDecoder`，`decode(chunk, { stream: true })` 保留跨块尾字节；进程退出后先 `decoder.decode()` flush（不完整序列才会变成替换符），再 flush 行缓冲。30 ms 的流收尾等待移到解码/行缓冲 flush 之前，避免“先 flush 解码器、迟到数据再按新流解码”。
- **位置**：`src/main/modules/loader/core/installer.ts`（`createChunkDecoder`、`stdoutDecoder/stderrDecoder`、退出后 flush 顺序）。
- **回归测试**：`installer.test.ts` 新增“把汉字切成两块”的用例，断言输出包含完整 `Installing client... 安装客户端` 且不含 `\uFFFD`。

### 3.2 `pollAuthCode` 成功后重复轮询返回 `FLOW_NOT_FOUND`

- **问题**：loopback 登录成功时会 `authCodeFlows.delete(flowId)`。UI 轮询（或重叠的两次轮询）在成功之后再调 `pollAuthCode` 会得到 `AUTH.FLOW_NOT_FOUND`（“登录流程不存在或已结束”），把一次成功登录显示成失败。
- **修复**：成功时把**公开的账户快照**（绝不含 token）写入 `completedAuthCodeFlows`（10 分钟 TTL、最多 32 条、逐条过期清理）；`pollAuthCode` 先查回放表，命中即返回同一 `{ status:'ok', account }`。失败路径保持原语义（不缓存），避免把一次 token 交换失败长期钉住。
- **位置**：`src/main/modules/auth/service.ts`（`AUTH_CODE_REPLAY_MS`、`rememberAuthCodeResult`、`pollAuthCode` 开头的回放分支）。
- **回归测试**：`auth.test.ts` 的 loopback 成功用例追加两次重复轮询，均返回 `status=ok` 且账户一致。

### 3.3 联机 SDK sidecar 的退出清理与并发启动

- **问题 A（子进程清理）**：`SdkService` 只在 `stop` 时 `kill`；退出启动器（`before-quit`/`will-quit`）没有任何模块收尾，sidecar 会变成孤儿进程继续占用端口。`src/main/index.ts` 是冻结文件，且模块注册表没有 dispose 生命周期。
- **修复 A**：新增 `disposeSync()`（同步 kill 所有已跟踪 sidecar、清空启动中集合），在 `modules/sdk/index.ts` 用 `process.once('exit', ...)` 注册（与 `modules/net` 的 EasyTier 收尾同一模式，不触碰冻结文件）。
- **问题 B（并发竞态）**：`start()` 先 `await list()`（内部还有异步 hash 校验）再检查“已在运行”。两个并发 `start(id)` 都能通过检查并各 spawn 一个 sidecar，`running` 只留最后一个，前一个成为孤儿。
- **修复 B**：进入 `start()` 时同步占用 `starting` 集合（在第一个 `await` 之前），重复调用立即返回 `SDK.ALREADY_RUNNING`；`finally` 释放。
- **位置**：`src/main/modules/sdk/service.ts`、`src/main/modules/sdk/index.ts`。
- **回归测试**：新增“3 个并发 start 只 spawn 1 个、其余 2 个 `SDK.ALREADY_RUNNING`”与“disposeSync 杀掉全部 sidecar、`runningIds()` 清空”两个用例。

## 4. 四维审查矩阵

| 子系统 | 子进程清理 | 并发竞态 | 路径兼容 | 令牌/密钥 |
|---|---|---|---|---|
| t1 作业内核 + mods 导入 + 实例复制 | 无子进程；取消经 `AbortSignal`，cleanup 删 `.part`/tmp/半成品目录 ✅ | jobId 随机、终态由 kernel 收口；`dispose()` 未接退出（见 F5） | `.part` 同目录 rename；目录名 NFKD/保留名处理；长路径未预检（F8） | 下载 URL 会进错误文本，但不含用户凭据 ✅ |
| t2 分享包 | 无 ✅ | preview→extract 之间无保留名；冲突时 rename 失败而非覆盖 ✅ | `sanitizePathName`/`safeEntryPath`/拒绝 symlink 与保护路径 ✅ | 凭据库跳过 + 文本/JSON 脱敏；`apiKey` 类键未覆盖（F3） |
| t3 存档跨版本 | 无 ✅ | 同名三选一；运行中拒绝；RollbackStack 逆序恢复 ✅ | `assertChild`、隐藏 staging/backup 不进列表 ✅ | 不涉及 ✅ |
| t4 投影 | 无 ✅ | running 检查、staging→backup→rename、move 在提交后入回收站 ✅ | `assertChild`、文件名白名单、`uniqueFileName` 保留扩展名 ✅ | 不涉及 ✅ |
| t5 链接导入 | 无（fetch 不可取消，已知）⚠️ | plan 一次性 + 10 分钟 TTL + 同步删 plan，重复确认拿不到第二份 ✅ | 包文件名 sanitize；目标目录固定 ✅ | key 仅 `x-api-key`；safeStorage 加密；日志/错误无 key ✅ |
| t6 渲染层 | 无 ✅ | `waitForJob` 先订阅再查终态；监听在 finally 释放 ✅ | 文件操作全在主进程 ✅ | renderer 只拿账户公开字段，无 token ✅ |
| t7 性能面板 | `tasklist` 每次一个子进程，无 timeout（F6）⚠️ | 缓存清理与下载/导入无互斥（F4）⚠️ | 白名单目录 + 不跟随符号链接 ✅ | 不涉及 ✅ |
| t8 皮肤 + SDK | sidecar 已接入退出清理 ✅（本次修复） | 并发 start 已加守卫 ✅（本次修复） | 账户 id 白名单、可执行文件目录内 + 拒绝 symlink ✅ | sidecar 最小环境变量、无 token ✅；皮肤链接 DNS SSRF（F1）⚠️ |

## 5. 残余发现（未修，建议排期）

| ID | 严重度 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| F1 | **medium** | `modules/skin/service.ts:194` `validateUrl` | 只拦截字面量 IP / localhost；`https://rebind.example/skin.png` 的 DNS 可解析到 `127.0.0.1`/内网，仍会被 fetch（重定向的逐跳复验同样只看字面量） | 解析 DNS（`dns.lookup`）并拒绝私网/回环地址，或对解析结果做二次校验；给 `fetch` 注入自定义 `lookup` |
| F2 | medium | `core/instance/share/export.ts:402` | 分享包先在内存里 `createStoredZip` 再整块写盘；2 GB 上限下主进程可能 OOM（t6 实测 43.5 MB 无压力） | 改为流式 zip writer 写 `.part`（`core/zip/writer.ts` 已有 writer 基础），内存只保留单个 entry |
| F3 | medium | `core/instance/share/sanitize.ts:60` | `SENSITIVE_KEY` 只覆盖 token/cookie/password/secret/authorization；`apiKey`、`clientSecret`、`accessKey`、`sessionId` 等键不会被脱敏，第三方模组配置里的 API key 可能随包外发 | 扩充键名模式（`api[_-]?key`、`client[_-]?secret`、`access[_-]?key`、`session[_-]?id`），并把新增键加入导出证据 |
| F4 | low | `modules/perf/service.ts:412` `cleanCache` | 清理 `catalog-packs`/`download-cache` 与正在进行的链接导入/下载没有互斥：`rmSync` 可能删掉正在下载的包或刚交给 import job 的文件（表现为导入失败，不会损坏存档） | 清理前查询 job/下载服务状态，或跳过近 N 分钟内有写入的目录 |
| F5 | low | `core/job/kernel.ts:424` `dispose`；`modules/mods/service.ts:774` | JobRegistry 的 `dispose()` 没有接到应用退出；进程被杀/退出时 `dataRoot/tmp/jobs/mods-import-*` 与 `.part` 可能残留（正常取消/失败会清理） | 在模块注册时挂 `process.once('exit')` 或下次启动时按 24 h 清扫 `dataRoot/tmp/jobs` |
| F6 | low | `modules/perf/service.ts:361` | `execFile('tasklist')` 无 `timeout`，tasklist 卡住时子进程与 Promise 一起悬挂 | 加 `timeout: 10_000` 并 kill 子进程 |
| F7 | low | `core/instance/copy.ts:105`；`core/instance/share/export.ts:117` | 目录遍历用 `Dirent.isSymbolicLink()` 判链；Windows junction 在 `withFileTypes` 里是“目录”，会被递归（可能复制到实例目录外/循环）。t6 的 `libraries/assets` junction 位于 MC 根而非实例目录，故未触发 | 目录也做 `lstat` 并识别 reparse point（或用 `fs.realpath` 前缀校验后再递归） |
| F8 | low | `core/instance/copy.ts`、存档复制 | 未做 MAX_PATH 预检（只有启动链有 240 字符检查）；超长路径会在复制中途失败并回滚 | 复制前对目标根做长度预检，超限给 `PATH_TOO_LONG` 可读错误 |
| F9 | low | `modules/instance/service.ts:653` | 导出取消/失败时 cleanup 会删除 `artifactPath`；若用户 `outPath` 选了一个已存在文件，取消会删掉原文件（成功也会覆盖） | 仅当本次确实创建了文件（`.part` 存在或记录创建标记）才删除；覆盖前先备份 |
| F10 | low | `modules/catalog/service.ts:1052` | 链接导入的“下载”阶段没有取消通道（t6 已在 UI 说明）；取消只能覆盖随后的 mods import job，已下载的包留在 `catalog/packs` 等 7 天清理 | 给 catalog 下载加 AbortSignal/job，或取消时删除本次 `dest` |
| F11 | observation | `modules/auth/service.ts:789` | 重叠的两次 `pollAuthCode` 仍可能做两次 token 交换（授权码只能用一次），后到的一次会收到失败响应；成功回放只解决“成功后再轮询” | UI 侧串行轮询；或在 flow 上记录 `inFlight` 让第二次直接返回 `pending` |
| F12 | observation | `renderer/app/data/waitJob.ts:26` | 事件丢失且 job 已被 registry 裁掉（默认保留 20 条）时，`fetchResult()` 返回 null，只能等 30 分钟超时 | 超时改为可选/更短，或保留更久的 job 结果 |
| F13 | medium（已修） | `modules/download/__tests__/service.test.ts:336` | 全量跑 3 次失败 2 次：用例以 `status.done >= 4` 作为取消点，但下载计划里小文件先完成，4 个完成项可能全是元数据，三个被断言的大文件一个都没落盘 → `completed.size > 0` 失败。单跑 3/3 通过，属负载相关 flake（非产品缺陷） | 取消点改为“两个被断言的库 jar 已落盘”，完成集合也从磁盘重算；单跑与全量各复跑验证（见 §7） |
| F14 | observation | `core/__tests__/real-forge-launch.test.ts:11` | 只要本机存在 `E:\MC\.minecraft\versions\[神道传说]…` 就会真实启动一次 Forge 游戏（本次全量多花 29 s，并可能留下进程/日志句柄）；其他机器自动 skip | 与 `MCL_REAL_LAN`/`MCL_REAL_LAUNCH` 一样改成显式环境变量开关，保持 `npm test` 可预期 |

## 6. 验证

| 命令 | 结果 |
|---|---|
| `npm.cmd run typecheck` | **exit 0**（node + web 两套 tsconfig） |
| `npm.cmd run test`（全量） | **exit 0，77 passed / 7 skipped（84 文件），635 passed / 21 skipped（656 用例）**，30.1 s |
| `npm.cmd run build` | **exit 0**（electron-vite build） |
| `npm.cmd run guard` | **exit 0**，`Frozen guard passed (19 files)` |
| 定向回归 | `installer.test.ts`（12）、`auth.test.ts`（30）、`sdk.test.ts`（8）全过；`download/service.test.ts` 单跑 3/3 通过 |
| 全量 flake 排查 | 修复前全量 3 次失败 2 次（均为 `download/service.test.ts:365`）；修复后全量 exit 0 |

日志（本地、gitignored）：`.e2e/t9-test.log`、`.e2e/t9-test2.log`、`.e2e/t9-test3.log`、`.e2e/t9-test4.log`、`.e2e/t9-typecheck.log`、`.e2e/t9-build.log`、`.e2e/t9-guard.log`。

## 7. 收尾记录

本次改动（全部在工作区，未提交；提交/打包/推送留给收尾关卡）：

```text
src/main/modules/loader/core/installer.ts        UTF-8 流式解码 + 退出 flush 顺序
src/main/modules/loader/__tests__/installer.test.ts   跨块中文回归用例
src/main/modules/auth/service.ts                  pollAuthCode 成功回放
src/main/modules/auth/__tests__/auth.test.ts      重复轮询断言
src/main/modules/sdk/service.ts                   starting 守卫 + disposeSync
src/main/modules/sdk/index.ts                     process.once('exit') 清理
src/main/modules/sdk/__tests__/sdk.test.ts        并发启动/dispose 用例
src/main/modules/download/__tests__/service.test.ts   取消点改为落盘驱动（flake）
README.md                                         P0-6 口径、H13/R1 关闭、二期能力表
docs/07-final-acceptance.md                       P0-6 结论/§7/§8 + §10 口径更新
docs/06-review-round4-t9.md                       本文（新增）
```

未改动：`src/main/index.ts`、`package.json`、`package-lock.json`、preload、`src/shared/*` 契约（因此 `guard` 的冻结清单不变）。并发任务正在修改的 `catalog` 链接导入文件未触碰（`git status` 中它们属于另一 task）。

## 8. 不在本次范围

- 不重跑 P0 16 步验收、不重跑 t1–t8 的真机 e2e（各自证据已在任务记录与 `docs/05`/`docs/07`）。
- 不处理并发任务正在修改的 `catalog` 链接导入增强（另一 task 负责）。
- 不新增二期能力，不升级 README 的 P0 状态。
