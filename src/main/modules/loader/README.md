# `src/main/modules/loader` — 加载器安装（t17）

> Forge / NeoForge：下载官方 maven 安装器，用指定 Java 以 **固定白名单参数** 静默执行 `--installClient`，逐行解析输出为进度事件。
> Fabric / Quilt：官方 meta API 生成带 `inheritsFrom` 的完整版本 JSON，并用下载模块补齐加载器库。
> 契约：`src/shared/loader.ts`；模块通过 `register(ctx)` 自注册，不改 `main/index.ts` 与 `package.json`。

## 1. 结构

| 路径 | 内容 |
|---|---|
| `index.ts` | 模块入口：`moduleIpc.handle(contract, handlers)` + `moduleIpc.emit`（t20 内核桥） |
| `module.ts` | Electron-free 的 `createRegister`（测试可注入 service / binder / emitter） |
| `service.ts` | `LoaderService`：list / plan / install / cancel / status / listJobs / verify / dryRun |
| `handlers.ts` | 契约方法 → service |
| `core/meta.ts` | 四家 meta 端点、版本列表解析、版本选择、安装器 URL、10 min 缓存 |
| `core/plan.ts` | 安装计划：父版本检查、Java 要求、installer 哈希分级、预测版本 id |
| `core/http.ts` | 安装器下载：UA、https、≤3 跳重定向、`.part`→SHA1→rename、重试 |
| `core/installer.ts` | `java -jar … --installClient` 执行、逐行解析、超时/取消、产物检测 |
| `core/profile.ts` | Fabric/Quilt profile → 下载任务（maven 路径 + sha1 + 镜像 URL） |
| `core/rollback.ts` | 快照/回滚：只删本次新增的 `versions/<id>`，还原 `launcher_profiles.json` |
| `core/job.ts` | 任务账本、100 ms 进度节流、100 ms 日志批量 |
| `core/verify.ts` | t6 合并校验 + 完整 dry-run 命令行（无 `${...}`） |

## 2. 两条安装路径

### 2.1 Fabric / Quilt（meta JSON，无安装器）

1. `GET {meta}/v2|v3/versions/loader/<mc>` → 版本列表（Fabric 镜像优先、Quilt 仅官方）。
2. 选择显式版本 / 最新 stable。
3. `GET …/loader/<mc>/<loader>/profile/json` → 完整版本 JSON（`id`、`inheritsFrom`、`libraries`、`mainClass`）。
4. profile 的每个 library → `DownloadTask`（`libraries/<maven 路径>`，`sha1`，`size`，Fabric/Quilt maven → BMCLAPI `/maven` 镜像）交给 `download` 服务。
5. 库下载成功后原子写 `versions/<id>/<id>.json`；用 t6 `resolveVersion` 校验，失败删除新目录。

### 2.2 Forge / NeoForge（installer jar）

1. 版本列表：
   - Forge：BMCLAPI `/forge/minecraft/<mc>`（同时给出 installer 的 40 位 SHA1），官方 `maven-metadata.xml` 回退。
   - NeoForge 1.20.1：BMCLAPI `/neoforge/list/1.20.1`，工件是 **`net.neoforged:forge`**，版本形如 `1.20.1-47.1.106`。
   - NeoForge 1.20.2+：`net.neoforged:neoforge` 的 maven metadata，用 t6 的 `minecraftVersionFromNeoForge()` 过滤（`20.2.x→1.20.2`、`21.1.x→1.21.1`），**不硬编码映射**。
2. 安装器 URL：官方 maven 路径（Forge `net/minecraftforge/forge/<raw>/…-installer.jar`；NeoForge 1.20.1 `net/neoforged/forge/<raw>/forge-<raw>-installer.jar`；其余 `net/neoforged/neoforge/<v>/…`），镜像为 BMCLAPI `/maven` 同路径。
3. 哈希分级（`hashSource`）：
   - `official`：官方 `installer.jar.sha1`（Forge 常可达）；
   - `list`：BMCLAPI 列表自带的 Forge 上游 SHA1（官方 `.sha1` 超时的时候）；
   - `mirror`：镜像 `.sha1`（当前 NeoForge 未镜像）；
   - `none`：无上游哈希 → **默认拒绝执行**，必须 `allowUnverifiedInstaller:true` 用户显式确认。
4. 安装前确认：计划返回 `installer.sha1`，`install` 必须回传 `confirmSha1`（SEC-EXE-05 的“先展示后执行”），不一致 → `LOADER.CONFIRMATION_MISMATCH`。
5. Java：`javaPath` 指定则 `probeJavaExecutable` + 与 `requiredJavaMajor` 比较（低 → `LOADER.JAVA_TOO_OLD`）；未指定则走 t6 的 `detectJava` + `chooseJava`。
6. 安装器执行：
   ```
   cwd = dataRoot/tmp/loader-<jobId>        # 临时目录，绝不指向实例根
   java -Djava.awt.headless=true -jar <cache>/…-installer.jar --installClient <mcRoot>
   ```
   `spawn(shell:false)`，环境变量白名单，stdout/stderr 逐行 → 任务/百分比/日志；15 min 超时；取消即 kill。
7. 安装后：按 `versions/` 目录差集找新版本 JSON，`resolveVersion` 校验；成功保留，失败/超时/非零退出 → 回滚。

## 3. 回滚语义（验收“不留下半成品目录”）

- 安装前快照 `versions/` 目录名与 `launcher_profiles.json` 原始字节；
- 失败时删除**本次新增**的版本目录，恢复（或删除）`launcher_profiles.json`，清理临时 cwd；
- `libraries/` 中安装器已下载的共享库**保留**（内容寻址缓存，删除可能影响其它实例；README 明确记录）；
- 回滚本身失败 → `LOADER.ROLLBACK_FAILED`，消息包含原始错误与清理错误。

## 4. IPC 契约（`src/shared/loader.ts`）

- 方法：`list / plan / install / cancel / status / listJobs / verify / dryRun`；通道 `mc:loader:<method>`。
- 事件：`mc:loader:evt:progress`（100 ms 节流）、`mc:loader:evt:log`（批量行，服务端 100 ms 合并）、`mc:loader:evt:finished`。
- 通过 t20 内核的 `moduleIpc.handle/emit` 注册：payload 由 zod 校验，sender 校验与 `Result` 信封由内核统一处理；模块自带契约，内核不会重复接线。
- `progress` 字段：`state / stage / percent / currentTask / message / versionId`。
- `verify` 返回合并链、mainClass、加载器识别、classpath 数；`dryRun` 用**验证用离线账户**生成完整 argv（`syntheticAccount:true`、`hasPlaceholders:false`），不创建进程。

## 5. 端点事实（2026-10-21 本机实测）

| 数据 | 端点 | 结果 |
|---|---|---|
| Fabric 列表/Profile | BMCLAPI `/fabric-meta/v2/...` | 200，254 个 loader 版本；stable `0.19.5`；profile 8 libraries |
| Quilt 列表/Profile | `meta.quiltmc.org/v3/...` | 200，307 个版本；stable `0.24.0`；profile 14 libraries |
| Quilt 镜像 | BMCLAPI `/quilt-meta/...` | **404**（官方仅此一路） |
| Forge 列表 | BMCLAPI `/forge/minecraft/1.20.1` | 200，137 个版本，含 installer SHA1；最新 build `47.4.28` |
| Forge 安装器 | `maven.minecraftforge.net/.../forge-1.20.1-47.2.0-installer.jar` | 200，5,973,950 B；`.sha1` 200 |
| NeoForge 1.20.1 列表 | BMCLAPI `/neoforge/list/1.20.1` | 200，60 条；**混合两种字段形状**（`47.1.5` 与 `1.20.1-47.1.105`/`1.20.1-forge-…`），已归一化 |
| NeoForge 安装器 | BMCLAPI `/maven/net/neoforged/forge/1.20.1-47.1.106/...` | 200，7,836,067 B；`.sha1` **404**；官方 `maven.neoforged.net` 本机不可达 |
| 镜像重定向 | BMCLAPI maven → `mirrors.cernet.edu.cn` → `mirrors.qlu.edu.cn` | 安装器下载需跟随 3 跳；有哈希时按哈希验收 |

## 6. 合规映射（docs/02）

| 约束 | 实现 |
|---|---|
| SEC-EXE-05 | 来源限官方 maven；支持 `.sha1` 校验；计划展示版本/URL/哈希；`cwd`=临时目录；执行后校验 JSON 存在且可解析 |
| SEC-EXE-06 | 参数固定白名单（headless/jar/`--installClient`/mcRoot），无用户或整合包字符串；`spawn(shell:false)` |
| MC-10/11 | 版本 JSON/安装器不随包；运行时下载到 `dataRoot/modules/loader/cache` |
| MC-12 | 只创建最小 `launcher_profiles.json`（不存在时），失败还原原始字节，不写 token |
| SRC-07 | Forge 哈希来自官方 `.sha1` 或 Forge 官方列表；不一致时采用官方并告警 |
| SEC-DL-14 | 安装器/组件独立于游戏下载队列（模块自己的缓存与重试） |
| SEC-DL-01/02 | 安装器 `.part` → SHA1 → rename；失败删除半成品 |
| LIC-01 | 仅使用公开 meta/maven 协议与本机黑盒行为，无 PCL 源码/资源 |

## 7. 验证（2026-10-21）

```
npm.cmd --prefix mc-launcher run typecheck          # exit 0
npm.cmd --prefix mc-launcher run test -- src/main/modules/loader   # 45 passed / 5 skipped
npm.cmd --prefix mc-launcher run guard              # Frozen guard (main/index.ts、package.json 未改)
```

测试覆盖：

- `meta.test.ts`（9）：四家解析、版本选择、maven mapping、缓存 TTL、installer URL、`.sha1`；
- `plan.test.ts`（8）：Fabric/Forge/NeoForge 计划、父版本缺失、哈希分级、NeoForge 1.20.1/1.20.2 工件切换、非法输入；
- `installer.test.ts`（11）：输出→任务/百分比、错误行、argv/env 白名单、退出码、超时、取消、spawn 失败、产物检测；
- `service-meta.test.ts`（5）：Fabric/Quilt 安装、库任务（sha1/镜像）、t6 合并、dry-run（无 `${...}`）、父版本缺失、库失败不落 JSON；
- `service-installer.test.ts`（9）：Forge 真实流程（fake ProcessPort：精确 argv/cwd/输出）、确认哈希、Java 过低、非零回滚、无产物、哈希不符、NeoForge 无哈希需确认、取消、超时；
- `ipc.test.ts`（3）：契约方法齐全、服务发布、调用透传；
- `real-meta.test.ts`（opt-in，`MCL_REAL_LOADER=1`，5/5 通过）：Fabric 列表+profile、Quilt 列表+profile、Forge 列表+官方 `.sha1`、NeoForge 1.20.1 列表+计划、**真实下载 5.97 MB Forge 安装器并 SHA1 校验**。

## 8. 已知边界

1. **真实安装器未在本机执行**：本机到官方 maven 的安装器下载约 75 KB/s，Forge 安装器执行还要再下载约 60 MB 依赖，超出一次验收窗口；执行路径由 fake `ProcessPort` 精确验证（argv/cwd/退出码/输出/回滚）。opt-in 真实安装可后续补跑。
2. **NeoForge 哈希**：官方 maven 不可达、BMCLAPI 不镜像 `.sha1`，因此 `hashSource:none` + 显式 `allowUnverifiedInstaller`。UI 必须显示风险确认；官方网络恢复后自动回到 `official`。
3. **父版本**：安装加载器前必须已有对应原版（`versions/<mc>/<mc>.json`），否则 `LOADER.PARENT_MISSING`；这与 P0 的“先装原版”流程一致。
4. **Forge recommended**：BMCLAPI 列表没有“推荐版”标记，取最新 build；P1 可接 `promotions_slim.json`。
5. **版本 id 预测**：安装器实际生成目录以差集检测为准，预测值仅用于 UI/计划（NeoForge 1.20.1 实测目录名可能为 `1.20.1-neoforge-…` 或 `1.20.1-forge-…`，检测后以实际为准）。
6. **回滚保留 libraries**：只回滚实例可见的版本目录与 `launcher_profiles.json`；共享库保留（见 §3）。
7. **IPC 依赖 t20 内核**：事件经 `moduleIpc.emit` 推送；未 bind 前的事件会被内核丢弃（安装只会在 IPC 就绪后由用户触发）。
