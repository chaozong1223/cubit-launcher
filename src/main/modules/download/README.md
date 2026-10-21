# `src/main/modules/download` — 安装链（t8 + t42 信任锚加固）

> 范围：`version_manifest_v2` → 版本 JSON → libraries / logging / 客户端 jar / assets 索引 / assets 对象；
> 并发下载、SHA1 校验、重试、断点续传、**元数据官方优先 / 文件镜像优先**、ETag/Last-Modified、Range 续传校验、进度事件。
> 契约：`src/shared/download.ts`；模块通过 `register(ctx)` 自注册，**不改** `main/index.ts` 与 `package.json`。

## 1. 结构（Electron 无关的 core + 薄适配层）

| 路径 | 内容 |
|---|---|
| `index.ts` | 模块入口：`moduleId` + `register`（Electron 只在这里和 `ipc.ts` 出现） |
| `module.ts` | Electron-free 的 `createRegister`（测试可注入 fake IPC / fake service） |
| `service.ts` | `DownloadService`：manifest / plan / install / repair / enqueue / pause / resume / status / providers |
| `handlers.ts` | 契约方法 → service（启动时构造一次，契约漂移在 boot 就炸） |
| `ipc-core.ts` | 通道注册、发送方校验、`Result` 信封、事件转发（纯 Node，可单测） |
| `ipc.ts` | Electron 适配：全局 `ipcMain` + 向所有 `BrowserWindow.webContents.send` |
| `core/http.ts` | 唯一 HTTP 出口：UA、超时、重定向策略、Range/断点、`file://`/`http://` 拒绝 |
| `core/sources.ts` | 官方 / BMCLAPI 映射、源顺序、熔断、重定向白名单、UA 格式 |
| `core/manifest.ts` | manifest 10 分钟磁盘缓存 + 版本 JSON / assets 索引（SHA1/大小校验） |
| `core/plan.ts` | rules/os 过滤、classic/modern natives、libraries/assets/client/logging → `DownloadTask[]` |
| `core/queue.ts` | 并发池、单主机限流、重试退避、`.part` 续传、原子 rename、整体哈希校验、取消 |
| `core/job.ts` | 任务账本、100 ms 节流、`setImmediate` 事件总线（不阻塞主进程） |
| `core/fs-atomic.ts` | 路径安全、`\\?\` 长路径、临时文件 → rename、24 h `.part` 清理、作业锁、磁盘空间 |
| `core/settings.ts` | `dataRoot/modules/download/settings.json`（并发 1–16、源偏好、镜像开关、下载总开关、限速） |
| `providers/*` | mod 源抽象：Modrinth（P0 唯一在线源）、CurseForge（P1 占位）、限流器 |

## 2. 契约（`src/shared/download.ts`）

- 方法：`listSources / getSettings / updateSettings / fetchManifest / plan / install / repair / enqueue / cancel / pause / resume / list / status / listProviders / projectPage`
- 事件：`mc:download:evt:progress`（100 ms 节流）、`mc:download:evt:finished`
- 通道：`mc:download:<method>`；`ipc.ts` 自带注册，t20 内核检测到模块有 `ipc.ts` 即跳过自动接线（不会重复 `ipcMain.handle`）。
- `DownloadProgress` 含：`state / stage / done / failed / total / bytesDone / bytesTotal / currentFile / bytesPerSec / source / versionId / message`（01 R1.16）。
- `stage` 顺序：`manifest → version-json → client / libraries / logging → assets-index → assets`（01 §5.2 步骤 3）。
- t42 新增：`DownloadTask.sourcePolicy`（`metadata|file`，缺省 file）、`ManifestResult.warnings`、`InstallPlanSummary.warnings`。元数据无哈希且来自镜像时，warning 随契约返回并写日志。

## 3. 安装流程（`service.install`）

1. 读 manifest（官方优先、镜像回退；磁盘缓存 10 min，过期缓存作为离线回退；`force` 可强制刷新）。刷新时带 ETag/If-None-Match 或 Last-Modified/If-Modified-Since，304 直接复用并刷新缓存时间。
2. 目标版本不在清单 → `DOWNLOAD.VERSION_NOT_FOUND`，**不创建** `versions/<id>/`（01 负向用例 4）。
3. 版本 JSON：已存在则直接读；否则经 HTTP 下载（元数据官方优先；有 SHA1 则校验）后原子写盘（MC-11：不进安装包）。
4. assets 索引：已存在则读；否则校验 `assetIndex.sha1/size` 后原子写盘（文件源策略，镜像优先）。
5. `buildInstallPlan`：libraries（rules/os 过滤）→ logging → 客户端 jar → assets objects；按 `destRel` 去重。
6. 磁盘预检：`max(1.5 GiB, missingBytes × 1.1)`（01 R1.6）。
7. 后台队列下载：优先级客户端 9 > 日志 8 > 库 5 > 资源 3；完成后写 `finished` 事件。
8. 返回 `{ jobId, plan }` 立即给 UI；进度通过事件推送，不阻塞调用方。

## 4. 下载语义（与约束 ID 对应）

| 行为 | 实现 | 约束 |
|---|---|---|
| 哈希矩阵 | `sha512 > sha256 > sha1`（文档 §7.4）；有哈希即整体校验 | SEC-DL-01、API-03 |
| 原子写 | `<dest>.part` → 校验 → 同目录 `rename`；Windows 占用回退 | SEC-DL-02 |
| 断点续传 | `.part` + `Range: bytes=n-`；`206` 校验 `Content-Range` 起点、`If-Range`/ETag/Last-Modified；`200` 从 0 重来；`416` 删除后重下；续传完成后整体校验 | SEC-DL-03、01 R1.4 |
| 续传校验 | 首次响应把 ETag/Last-Modified 写入 `<dest>.part.meta.json`；续传发 `If-Range`，206 再比对；不一致抛 `DOWNLOAD.RANGE_VALIDATOR_CHANGED` 并从头下 | t42 |
| 条件请求 | manifest 缓存保存 ETag/Last-Modified；过期/force 刷新发 `If-None-Match`/`If-Modified-Since`；304 复用缓存，200 更新缓存 | t42 |
| 大小先验 | `Content-Length + resumeFrom` 必须等于元数据 `size` | SEC-DL-11 |
| 无哈希 | 官方 host + `unverified` 警告；第三方源直接 `DOWNLOAD.HASH_REQUIRED`；Forge/Fabric 官方 loader maven 视作可信来源（P1 改为抓 `.sha1`） | SEC-DL-04、SRC-07 |
| 重试 | 每源初始 + 3 次重试（可配 0–10）；指数退避 + 抖动；429/5xx/408 可重试；`Retry-After` 解析已实现 | 01 R1.3、SRC-05 |
| 源切换 | **元数据（manifest/version JSON）官方优先、镜像回退；文件（libraries/assets）镜像优先、官方回退**；`sourceHint` 可前置；**按源熔断**：单源连续 3 次失败只冷却该源 60s，另一源继续服务；冷却到期自动恢复；仅所有适用源都在冷却时抛 `DOWNLOAD.NETWORK_UNREACHABLE`（网络不可达，含冷却剩余时间），配置问题才是 `DOWNLOAD.NO_SOURCE` | SRC-04、docs/03 §6.5、t42、t46 |
| 元数据告警 | 无哈希 manifest/version JSON 来自镜像时记录 `source=mirror` 并返回 warnings（`ManifestResult`/`InstallPlanSummary`）；用户显式 mirror 也保留告警 | t42、SRC-07 |
| 镜像开关 | `settings.mirrorEnabled=false` 即合规模式（只走官方）；`downloadEnabled=false` 整体禁用（MC-19） | SRC-06、MC-19 |
| 源标注 | `listSources` 返回显示名 + 主页 + 冷却剩余/原因；每个文件日志记录 source | SRC-01、SEC-DL-12 |
| 并发 | 全局 1–16（默认 8），单主机 1–8（默认 4）；大文件不特殊串行（P1 再按 SEC-DL-07 细分） | SRC-05、SEC-DL-07 |
| 取消/暂停 | 取消：停止新任务 + 中止在途 + 删除 `.part`，保留已校验文件；暂停：保留 `.part` 与已完成文件；用户取消**不计入**源熔断 | 01 R1.5、docs/03 §6.3 |
| 路径安全 | `destRel` 拒绝绝对路径/盘符/UNC/`..`/ADS/保留名/尾点空格；`resolveInside` 用 `path.relative` 判定 | SEC-DL-08/09 |
| 路径穿越 | 下载目标与 zip 解压共用同一套规则（zip 解析在 `core/zip`） | SEC-DL-08 |
| 作业锁 | `dataRoot/tmp/download-<hash(mcRoot)>.lock`，10 min 过期；同目录双开不互相写坏 | docs/03 §6.3 |
| 网络日志 | 每个 URL/源/字节/耗时/校验结果写 `launcher.log`；不带 query 机密 | SEC-DL-12 |

### 4.1 镜像重定向的特殊处理（实测发现）

BMCLAPI 的文件下载会 302 到**轮换 CDN 域名**：`bmclapiN.sakura.sld.tw`、`2.749333.xyz`（2026-10-21 实测）。
固定白名单会让镜像随机失效（本次真实测试第一次就因此回退官方）。策略：

- **manifest（信任锚，无上游哈希）**：默认 **官方优先**；官方不可用时回退镜像并返回 warning。旧策略“镜像优先”已弃用（t42）。有上游哈希的文件仍允许镜像/轮换 CDN，但最多 3 跳、逐跳记录、响应体必须匹配上游 SHA1（SRC-07）。
- **有上游哈希的文件**（版本 JSON / assets 索引 / libraries / assets / 客户端 jar）：镜像重定向允许任意 **https** 主机，但最多 3 跳、逐跳记录日志、响应体必须匹配 **Mojang 上游 SHA1**（SRC-07）。哈希才是完整性边界。
- 官方源永不放开；无哈希 + 镜像仍拒绝（SEC-DL-04）。

## 5. Mod 源抽象（P0 只接 Modrinth）

- `ModSourceProvider { search, listVersions, toDownloadTasks, projectPage }`；下载层只消费 `DownloadTask`。
- Modrinth：唯一 UA（`mc-launcher/<version> (+site; contact)`）、自限 240 req/min（API 允许 300）、只认 `cdn.modrinth.com`、优先 sha512、不落盘元数据/不转存（API-01~04）。
- CurseForge：`available=false, requiresKey=true`；所有 API 方法抛 `SOURCE.PROVIDER_UNAVAILABLE`；`projectPage()` 只拼官网链接（API-07/08）。P1 只需替换 provider 实现。
- UA 的 site/contact 目前是占位值（`github.com/mc-launcher` / `users.noreply`），**发布前必须由 captain 确认真实联系方式**（API-01 门禁）。

## 6. 数据目录

```
dataRoot/modules/download/settings.json   # 模块设置（唯一写者：本模块）
dataRoot/modules/download/cache/version_manifest_v2.json
dataRoot/tmp/download-<hash>.lock         # 安装作业锁（10 min 过期）
mcRoot/versions/<id>/<id>.json|.jar
mcRoot/libraries/**                        # maven 布局
mcRoot/assets/indexes/<id>.json
mcRoot/assets/objects/<hh>/<hash>
mcRoot/assets/log_configs/<file>
```

## 7. 已验证（2026-10-21，本机）

```
npm.cmd --prefix mc-launcher run typecheck      # exit 0
npm.cmd --prefix mc-launcher run test           # 443 passed / 19 skipped（全仓，2026-10-21 t46 后）
npm.cmd --prefix mc-launcher run test -- src/main/modules/download   # 127 passed / 4 skipped
npm.cmd --prefix mc-launcher run guard          # Frozen guard passed (19 files)
npm.cmd --prefix mc-launcher run pack && npm.cmd --prefix mc-launcher run e2e:install-launch  # E2E PASS（t46 后全新工作区）
```

t42 新增覆盖：manifest 官方优先、镜像回退（source=mirror + warnings）、ETag/304 命中、ETag 变化重下、Last-Modified/304、续传 ETag 变化重启、重定向上限 3。

t46 新增覆盖：单源 3 次失败只冷却该源、另一源完成下载；全部适用源冷却 → `DOWNLOAD.NETWORK_UNREACHABLE`（含中文 userMessage/冷却剩余）；冷却到期后重新使用该源；manifest 全源冷却同样分类并恢复。

t46 审查补充：
- **H3b**：`ipc.ts` 改用 `kernel/error-shape.ts` 的统一 shaper，`mc:download:install` 的 `DOWNLOAD.VERSION_NOT_FOUND` 不再被压成 `IPC.HANDLER_FAILED`（ipc.test）。
- **H5**：作业锁每 `staleMs/3` 刷新 mtime（`heartbeatMs` 可配），长安装不会在 10 分钟被误判抢锁（fs-atomic.test 用 120ms/20ms 心跳验证）。
- **H6**：loader 库的 `enqueue` 批次现在复用同一 per-root 作业锁，并按 `destRel` 去重；安装与加载器下载不会并发写同一 maven 文件（service.test）。
- **B1 真实安装证据**：`real-cooldown-install.test.ts`（opt-in）在全新 mcRoot 用 dead mirror + 官方源完成 1.20.1 的 3,641 文件；`e2e:install-launch` 在全新工作区 **E2E PASS**（installState done 3641/3641，main menu reached）。

打包产物证据（模块在真实 exe 中自注册，t22 CDP 测试触发；日志 `data/t22-cdp5/logs/launcher.log`）：

- `modules":["system","download","hello","instance","java","launch","net","version"]`，`failedModules=[]`。
- `download IPC registered`：15 个 `mc:download:*` 通道全部注册。
- 渲染层经 CDP 调 `mc:download:fetchManifest` 得到 920 个版本（镜像优先失败后自动回退官方，符合设计）。
- 渲染层调 `mc:download:plan`（真实 `E:\MC\.minecraft`）：`files=3641 missing=1` —— 只缺 1 个文件，正是“只补缺失项”的真实用例。

真实端点证据（`MCL_REAL_DOWNLOAD=1` 才跑，`__tests__/real-network.test.ts`）：

- manifest 920 个版本；版本 JSON SHA1 `38d412af…` 通过；t42 后默认官方优先，官方不可用时回退镜像（source 记录在结果中）。
- 1.20.1：libraries 88 / Windows 允许 64 / 下载 64 个 jar / 21 个 natives / 库 60,876,077 B（58.0 MiB）。
- assets 索引 3,598 条 → 去重后 **3,575** 个对象文件，651,496,644 B。
- 客户端 jar 23,028,853 B；总计 **3,641 个文件 / 735,402,462 B ≈ 701.3 MiB**（01 文档口径 ≈700 MiB）。
- 真实下载：1 个资源对象（镜像，含轮换 CDN 重定向）+ `client-1.12.xml`（官方，SHA1 `bd65e7d2…`）全部校验通过。

本地 HTTP 桩覆盖（`__tests__/queue.test.ts`）：200/206/416/500/429 形态、服务器忽略 Range、坏哈希、大小不符、断点续传、取消清理、单主机并发、事件循环不阻塞。

## 8. 已知边界 / 后续接线

1. **版本模块的安装 API**：03 §6.2 把 `installVanilla` 写在 `version` 模块；t8 的独占目录只有 `modules/download/`，因此安装能力通过 `download.install({versionId})` 暴露。t10/t11 可直接调用；若架构要求挪到 `version`，只需转发一层。
2. **启动前自动补缺**（01 R1.12）：`service.repair({versionId})` 已实现（只补缺失/大小不符项），但 `launch` 模块（t6）尚未调用；建议 t11 在启动预检里调用一次（≤5 条目要求见 01）。
3. **事件通道**：依赖 t20 的 preload 形状白名单（`mc:<id>:evt:<event>`）；未解冻前渲染层拿不到事件，main 侧推送与测试已就绪。
4. **限速**：`speedLimitBytesPerSec` 已实现令牌桶，P0 未做 1/2/4/8 档 UI（SEC-DL-07 的“大文件串行”留 P1）。
5. **assets 字节口径**：`assetIndex.totalSize`=650,564,794，而按对象实际大小求和=651,496,644；本模块以后者做进度/磁盘预检（更保守），文档口径差异已在此记录。
6. **镜像 manifest 信任锚**：见 §4.1；若要强制“清单也必须走镜像”，需要 captain 接受无哈希元数据来自任意 CDN 的风险，或引入镜像签名/双源比对（P1）。
7. **Windows 长路径**：`winLongPath()` 已用于 fs 调用；尚未在 >260 字符的真实整合包目录做端到端验证。
8. **内核 logger 的 EPIPE（跨模块，非本模块可修）**：打包产物在 stdout 被关闭后（t22 的 CDP 测试管道）任何 `console.log` 都会抛 `EPIPE`，`kernel/logger.ts` 的 `process.on('uncaughtException')` 又记录 fatal → 再次 console → 循环。证据：`data/t22-cdp4/logs/launcher.log`。`kernel/logger.ts` 属冻结文件，需 captain 决定解冻并在 `Logger.log` 里 try/catch 包裹 console 输出（或检测 `process.stdout.destroyed`）。
