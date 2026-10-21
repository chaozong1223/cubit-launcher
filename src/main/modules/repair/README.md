# `src/main/modules/repair` — 实例文件校验与一键修复（t31）

> 按版本 JSON（含 `inheritsFrom` 合并结果）校验 **client jar / libraries / assets index / assets objects**，输出「缺失 / 损坏 / 多余」三类清单；一键修复通过 t8 安装链下载器**只重下缺失/损坏文件**，随后再次校验。
> **严格不读写 `mods/`、`saves/`、`config/`、资源包、光影包**；多余文件只报告、不删除。
> 契约：`src/shared/repair.ts`；新模块通过 `moduleIpc` 自注册，不改 `main/index.ts` / `package.json` / 冻结内核契约表。

## 1. 结构

| 路径 | 内容 |
|---|---|
| `index.ts` | `moduleIpc.handle(repairContract, handlers)` + 事件转发（自注册） |
| `service.ts` | scan/repair job、进度、取消、报告、两阶段修复 |
| `handlers.ts` | 6 个契约方法 → service |
| `core/scan.ts` | 复用 t8 `buildClientTask`/`buildLibraryTasks`/`buildAssetIndexTask`/`buildAssetTasks` 生成期望文件，逐文件校验并收集多余文件 |
| `core/downloader.ts` | 适配 t8 `enqueue` / `onProgress` / `onFinished` / `cancel`；无事件时轮询 `status` |
| `core/job.ts` | 任务状态 + 100 ms 进度节流（stage/state 变化强制发） |
| `core/errors.ts` | `REPAIR.*` 可读错误码 |

## 2. 校验

输入：`versionId`（目录名或 JSON id）+ `verify: 'hash' | 'size'`。

1. t6 `resolveVersion` 合并父版本；失败 → `REPAIR.VERSION_NOT_FOUND`。
2. 期望文件来自 t8 的纯函数（与安装链同源）：
   - client：`versions/<dir>/<dir>.jar`（`downloads.client` 的 URL/sha1/size；loader profile 继承父版本）；
   - libraries：按 rules 过滤后的 artifact + 当前平台 natives classifier（`libraries/<maven 路径>`）；
   - asset index：`assets/indexes/<id>.json`（`assetIndex.sha1/size`）；
   - assets objects：`assets/objects/<hash[0:2]>/<hash>`（每个 object 的 hash/size）。
3. 每个文件：
   - 不存在 → `missing`；
   - 有 size 且不符 → `corrupt`（不读整文件）；
   - `verify=hash` 且任务带 sha512/sha256/sha1 → 计算并比较；不符 → `corrupt`；
   - 无上游哈希（旧 Forge 库）只校验存在/大小。
4. 资源索引不可用（缺失/大小不符/哈希不符/无法解析）→ 单独 `asset-index` issue，**不猜** assets 列表；修复先下载索引再枚举。
5. 多余文件（仅报告，不删除）：
   - 版本目录中不属于 `<dir>.json`、`<dir>.jar`、`instance.json`、`natives/` 的文件；
   - `libraries/**` 中不被当前版本引用的文件（`shared:true`，可能属于其它版本）；
   - `assets/objects/**` 中不被当前索引引用的对象（`shared:true`）。
   最多各 200 条，超过时 `warnings` 提示截断。

报告字段：`counts.{checked,bytesChecked,missing,corrupt,extra,missingBytes,corruptBytes}`、`missing[]/corrupt[]/extra[]`、`warnings[]`、`ok`（仅当缺失/损坏为 0；多余不影响 `ok`）、`verify`、`durationMs`。

## 3. 一键修复

`repair({versionId, verify})`：

1. 先 scan，保存报告；若 `ok` 直接完成（多余文件不处理）。
2. 需要下载的任务 = scan 的 missing + corrupt（**不含 extra / 用户文件**）。
3. 若 asset index 不可用：先下载 client/libraries/index → 重新 scan 得到 assets 清单（两阶段）。
4. 对 **corrupt** 目标：先删除该文件再 enqueue。原因：t8 的批量 `enqueue` 按“大小”判断已存在文件，尺寸相同的损坏文件会被跳过；删除的是已校验为坏的文件，missng 无需处理，extra/用户文件绝不删除。
5. 通过 t8 `downloadService.enqueue(tasks)` 提交；任务沿用 t8 的镜像优先、哈希校验、重试、`.part` 续传、原子 rename。
6. 下载完成后再 scan（`verify` 模式）→ 最终报告；`ok` 才标记成功，否则 `REPAIR.DOWNLOAD_FAILED` 并在 `details` 带剩余 missing/corrupt 数。
7. 下载器不可用 → `REPAIR.DOWNLOADER_UNAVAILABLE`；目标不在 `versions/<dir>/*.jar`、`libraries/`、`assets/indexes/`、`assets/objects/` → `REPAIR.UNSAFE_TARGET`（防御性）。

**不删除任何多余文件**；修复只覆盖缺失/损坏文件（下载器原子写）。

## 4. IPC 契约（`src/shared/repair.ts`）

方法：`scan / repair / status / report / cancel / listJobs`（`mc:repair:*`）。

事件：

- `scanProgress` / `repairProgress`：`{jobId,kind,versionId,state,stage,percent,done,total,currentFile,message,bytesDone,bytesTotal,updatedAt}`，100 ms 节流；
- `scanFinished` / `repairFinished`：`{jobId,kind,ok,report,error|null}`。

模块不在冻结的 `BUILTIN_CONTRACTS` 中，因此 `index.ts` 通过 `moduleIpc.handle` 自注册（与 loader 同模式）；内核 `autoRegisterModuleIpc` 看到 `has('repair')` 后跳过，不会重复接线。

## 5. 安全边界

| 要求 | 实现 |
|---|---|
| 不碰用户数据 | scan 只枚举 version 目录（顶层）、`libraries/`、`assets/`；repair 只 enqueue 允许前缀内的任务；无删除 API |
| 不静默改文件 | 修复只下载缺失/损坏；extra 仅展示 |
| 路径安全 | `safeAbsolute` 拒绝 `..`/绝对路径；任务前缀白名单 |
| 校验边界 | client/libs/assets 均按上游 sha1（t8 任务也带哈希）；hash 模式抓同尺寸损坏 |
| 下载链复用 | 不自己发 HTTP；t8 下载器负责镜像/重试/续传/哈希/原子写 |
| 资源索引信任 | 索引缺失/损坏不猜 assets，先下载再枚举 |

## 6. 验证（2026-10-21）

```
npm.cmd --prefix mc-launcher run typecheck
npm.cmd --prefix mc-launcher run test -- src/main/modules/repair   # 11 passed
```

- `scan.test.ts`（5）：缺失/损坏/多余三类、hash vs size（同尺寸损坏只在 hash 模式发现）、client 损坏、索引缺失不猜 assets、用户数据不出现且内容不变；
- `repair.test.ts`（5）：只 enqueue 坏文件（无 extra/用户文件）、修后 `ok=true`、scan/repair 进度（scan/download/verify stage + 事件 payload 过契约校验）、client 损坏修复、索引缺失两阶段修复、下载器不可用可读失败；
- `registration.test.ts`（2）：6 个 handler 与契约方法一一对应、4 个事件名齐全。

全仓回归：`npm.cmd --prefix mc-launcher run test`（349 passed / 17 skipped，2026-10-21）；`guard`、`build` 通过。

## 7. 已知边界

1. **多余文件不自动清理**：libraries/assets 是跨版本共享缓存，删除风险高；只报告（`shared:true`）。如 P1 需要清理，应另做“确认后删除 + 白名单”流程。
2. **版本 JSON 自身缺失/损坏**不属于本模块修复范围：`resolveVersion` 失败直接报 `REPAIR.VERSION_NOT_FOUND`；版本 JSON 修复由 t8 安装链负责。
3. **logging config**（`assets/log_configs`）不在验收范围内，未核对；client/libs/assets 之外的文件不会被修改。
4. **hash 模式成本**：1.20.1 全量约 700 MB，首次全量哈希需要数秒；UI 可先用 `size` 快速模式再按需 `hash`。
5. **索引缺失时首轮报告**不会列出 3,575 个 assets 为缺失（避免误导）；修复下载索引后会重新枚举并只重下真正缺失的对象。
6. 多余列表最多各 200 条（防报告爆炸），超过时给出 warning；总数仍以 `counts.extra` 为准（当前也为截断后的数量）。
7. 模块注册依赖 t20 `moduleIpc`；若内核未 bind，事件会丢弃，但 handlers 仍会注册（重启后由内核 bind 安装）。
