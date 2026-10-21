# 08 HMCL 对照分析：加载器 / 模组依赖 / 下载重试

> 任务：t38（只读对照分析）。**本任务不修改我们的任何实现**，只产出建议清单。
> 对照对象：HMCL（GPL-3.0），GitHub `HMCL-dev/HMCL` main 分支，快照 commit `acc9740fa9289ded38553b6a35045fd608c1ea99`（2026-10-20）。
> 我们的基线：`mc-launcher/src/main/modules/{loader,download}/`、`src/shared/{loader,download}.ts`；模组模块（t29）在本工作区**尚未落地**，第 2 节按 `docs/09-resume-plan.md` R2 的验收目标做“设计对照”，不把计划当已实现。
> 合规：HMCL 为 GPL-3.0-or-later，引用文件头部均有 GPL 声明与 `Copyright (C) ... huangyuhui ... and contributors`。本报告只描述行为、路径和取舍，**未复制 HMCL 代码**；未来若逐行借鉴，见 §5 的许可证头与 NOTICE 要求。

## 0. 结论先行

| 领域 | HMCL 明显更强 | 我们已经更强 | 最高优先动作 |
|---|---|---|---|
| Forge/NeoForge | **不执行安装器**：解析 `install_profile.json` 的 `processors`，自己跑 processor，逐个校验输出 SHA1；临时目录 + draft 提交 | 固定 argv/环境白名单、安装器 SHA1 确认、Java 主版本预检、失败回滚版本目录与 `launcher_profiles.json`、完整测试 | 先补“安装器类型/期望产物”预检（P0.5）；现代 Forge/NeoForge 增加 **processor 结构化路径**（P1，保留安装器回退） |
| 模组依赖 | 元数据解析非常宽容（Forge/Fabric/Quilt/LiteLoader、jar-in-jar、子目录、`.disabled`/`.old`、未知回退）；远程依赖类型模型完整 | 计划中的“解析依赖 + 缺失前置/版本不匹配提示”**领先 HMCL**（HMCL 本地 ModManager 不做依赖求解） | 抄“元数据读取器注册表/回退”模式；**依赖图与版本区间自研**，不要等 HMCL |
| 下载重试/镜像 | 区域感知的默认源、每个文件 candidate 列表（镜像+官方）、per-candidate 重试/超时、ETag/Last-Modified、Range 续传校验、镜像规则覆盖 Forge/Fabric/Modrinth 等 | 连续失败熔断、指数退避+抖动、`Retry-After`、每主机并发 4、全局限速、原子写、哈希优先级、暂停/恢复/取消、作业锁 | 分离“版本清单/元数据”和“文件”的源偏好（元数据官方优先）；每文件 candidate 列表 + per-candidate 策略（P1） |

一句话：**加载器这块，HMCL 的结构化 processor 路线比“跑安装器 + 解析 stdout”稳，值得抄行为；模组依赖这块 HMCL 没有本地求解器，我们必须自研；下载这块 HMCL 的多源不是“测速”，而是区域默认 + 有序 candidate 回退，我们应补 candidate/缓存，保留自己的熔断与并发优势。**

---

## 1. Forge/NeoForge 安装器的输出解析与进度

### 1.1 HMCL 的实际做法（不是解析 installer stdout）

关键结论：**现代 Forge/NeoForge 安装器在 HMCL 里根本不会被执行**；HMCL 把 installer jar 当作一个“带元数据的压缩包”读取，然后自己执行 `processors`。因此不存在“解析 installer stdout”这一层。

引用（均相对 HMCL 仓库根）：

- [`ForgeInstallTask.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeInstallTask.java)
- [`ForgeNewInstallTask.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeNewInstallTask.java)
- [`ForgeOldInstallTask.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeOldInstallTask.java)
- [`ForgeNewInstallProfile.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/forge/ForgeNewInstallProfile.java)
- [`NeoForgeInstallTask.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/neoforge/NeoForgeInstallTask.java)
- [`NeoForgeOldInstallTask.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/neoforge/NeoForgeOldInstallTask.java)
- [`DefaultGameBuilder.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/DefaultGameBuilder.java)
- [`SystemUtils.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/util/platform/SystemUtils.java)

#### (1) 先判定安装器格式，并校验目标 MC 版本

`ForgeInstallTask.detectForgeInstallerType` / `install` 打开 installer：

1. 读 `install_profile.json`；
2. 含 `spec` → 现代 processor 格式，解析 `ForgeNewInstallProfile`；
3. 含 `install` + `versionInfo` → 旧格式，解析 `ForgeInstallProfile`；
4. 校验 `profile.minecraft` 与目标 game version 一致，不一致抛 `VersionMismatchException`；
5. 识别失败抛 `ArtifactMalformedException`/`IOException`。

NeoForge 在 `NeoForgeInstallTask.install` 中做类似判定：1.20.1 旧工件 `net.neoforged:forge` 走 `ForgeNewInstallTask` 后改 patch id；新工件走 `NeoForgeOldInstallTask`（名字叫 old，实际也是 processor 路径）。

#### (2) 现代格式：复制 maven → 下载库 → 顺序执行 processors

`ForgeNewInstallTask.preExecute`：

- 从 installer 的 `maven/` 目录复制 `profile.libraries` 与主 jar 到共享库缓存；
- 派发 `GameLibrariesTask` 下载这些依赖（走统一 DownloadProvider）；
- 读 `install_profile.json` 的 `processors`（`ForgeNewInstallProfile.Processor`：`sides/jar/classpath/args/outputs`）；
- `getProcessors()` 只保留 `client` side。

`execute`：

1. 要求 vanilla client jar（由 `GameDownloadTask` 先准备）；
2. 建临时目录，把 vanilla jar 复制成 `tempDir/minecraft.jar`（**隔离路径**，避免 processor 拿到共享缓存路径）；
3. 解析 `data` 变量（`{entry}`、`[artifact]`、`'literal'`、installer 内文件解压到临时目录），设置 `SIDE=client`、`MINECRAFT_JAR`、`MINECRAFT_VERSION`、`ROOT`、`INSTALLER`、`LIBRARY_DIR`；
4. `Task.runSequentially` 按顺序跑 processors；每个 `ProcessorTask`：
   - 先检查 `outputs`：文件存在且 SHA-1 匹配 → **整个 processor 跳过**（可恢复/幂等）；
   - 从 processor jar 的 `MANIFEST.MF` 取 `Main-Class`；
   - 拼 Java 命令：`java -cp <classpath...>;<processor.jar> <Main-Class> <args...>`；
   - `SystemUtils.callExternalProcess(...)` 执行，非 0 抛 `IOException`；
   - 执行后逐个校验 `outputs` 的 SHA-1；不符则删除输出并抛 `ChecksumMismatchException`；对原生 zlib 不兼容环境，若输出是 jar 且能通过 ZIP 完整性检查，则容忍 SHA-1 差异并记日志；
   - 特殊 processor：`task=DOWNLOAD_MOJMAPS && side=client` 不跑外部进程，改为从 version JSON 的 `client_mappings` 直接下载（避免该 processor 在部分环境失败）。
5. `updateProgress(processorDoneCount, processors.size)` 提供进度；processor 的 stdout/stderr 只经 `ManagedProcess.pump* → LOG.info` **写日志**，不解析、不用于进度；
6. `postExecute` 删除临时目录；`setResult(GameInstancePatch.fromManifest(...))`，最终由 builder 合并。

#### (3) 旧格式：解包，不执行

`ForgeOldInstallTask`：

- 读 `install_profile.json`；
- 从 installer zip 中把 `install.filePath` 的 universal jar 解到 maven 布局；
- 用 `install_profile.versionInfo` 构造 `GameInstancePatch`；
- 不运行 installer，也不解析输出。

#### (4) 失败与“回滚”

`DefaultGameBuilder` 的注释很明确：

- 安装/更新在独占的 `DefaultGameRepositoryDraft` 中构建；
- **实例 manifest 与主 JAR 只有在 draft commit 后才进入实例树**；
- 失败/取消 → abort draft；**共享 libraries/assets/download caches 可能保留**（这是缓存，不是“半成品实例”）；
- processor 的临时目录在 `postExecute` 删除；processor 已写出的输出若失败，下一次运行会因 SHA-1 不匹配删除/重跑（幂等），但没有全局“物理回滚所有 processor 输出”的动作。

#### (5) 安全模型（不要误抄）

HMCL 的 processor 命令来自安装器元数据，`SystemUtils.callExternalProcess` 直接 `ProcessBuilder` 执行；它依赖“官方 installer + 元数据可信”这一前提。HMCL 没有我们 `SEC-EXE-06` 那种固定 argv 白名单。**我们不应因此放弃自己的白名单**；如果引入 processor 路径，必须把 processor 的 `jar/classpath/args/outputs` 也纳入信任边界（见 §1.5）。

### 1.2 我们的做法（t17）

引用：[`installer.ts`](../src/main/modules/loader/core/installer.ts)、[`service.ts`](../src/main/modules/loader/service.ts)、[`README.md`](../src/main/modules/loader/README.md)。

- 下载官方 installer jar（`ensureInstaller`，mirror→official，`.part`+SHA1，缓存）；
- `installerArguments(jar, mcRoot)` = `['-Djava.awt.headless=true','-jar',jar,'--installClient',mcRoot]`；`cwd`=临时目录；env 白名单；`spawn(shell:false)`；
- `runInstaller` 逐行读 stdout/stderr：
  - `parseInstallerLine` 用英文动词表（Analyzing/Downloading/Extracting/Installing/Processing/Building/...）映射任务；
  - `%` 或 `(n/m)` 映射 percent；
  - `ERROR_PATTERN` 抓 `error/failed/exception/...`，`0 errors` 视为良性；
  - 15 min 超时；取消 kill；保留 400 行日志 + stderr tail；
- 成功判定（service）：非取消、非超时、`exitCode===0`、**发现新的 version JSON**、通过 t6 `verifyInstalledVersion`（`resolveVersion` + `inspectVersion`）；
- 失败：`snapshotMcRoot`（版本目录名 + `launcher_profiles.json` 字节）→ 删除新增版本目录、还原/删除 profiles、清临时 cwd；库缓存保留；
- 测试：`installer.test.ts` 覆盖任务/百分比/错误行/argv/env/退出码/超时/取消/spawn 失败；`service-installer.test.ts` 用 fake ProcessPort 覆盖 Forge/NeoForge 安装、哈希不符、无产物、Java 过低、非零退出回滚、取消；真实端点测试只下载并校验 installer jar（5.97 MB），**未在本机跑真实安装器**（README 已写明）。

### 1.3 差距（按影响排序）

| # | 维度 | HMCL | 我们 | 影响 |
|---|---|---|---|---|
| L-1 | 是否执行安装器 | 不执行；解析 install_profile + processors | 执行 installer `--installClient` | 我们的进度/错误取决于安装器输出与行为；安装器自带下载不走 t8 源策略 |
| L-2 | 进度来源 | processor 计数（结构化） | stdout 英文动词 + `%`/`(n/m)` | 输出格式/语言/版本变化会让任务名/百分比失真（不致命，但 UI 不可靠） |
| L-3 | 输出校验 | 每个 processor 的 outputs SHA-1 + 重跑 | 只校验最终 version JSON 可解析；不校验 processor 产物 | 安装器“exit 0 但某个库/映射损坏”可能漏检 |
| L-4 | 幂等/断点 | 已有且 SHA-1 正确的 processor 输出跳过 | 无 processor 概念；重装靠 installer 自己 | 失败后重试可能重复下载/重复处理；慢网络成本高 |
| L-5 | 安装器类型预检 | 读 install_profile，校验 profile.minecraft；区分 spec/old | 不读 installer 内部；直接执行 | 目标版本不匹配时晚失败；旧/新格式行为不可控 |
| L-6 | 回滚/事务 | draft 未 commit 前实例不可见；共享缓存保留 | 快照 + 删除新版本目录/还原 profiles；安装期间目录可见 | 失败后清理逻辑可控，但安装中途用户可能看到半成品；对“修改已有版本”只按新增目录判断 |
| L-7 | 下载源 | installer/libraries 全部走 DownloadProvider（多源/缓存/重试） | installer 走 loader 自己的 HTTP；libraries 由 installer 自己下载 | 镜像/重试/断点策略不统一；两个下载栈 |
| L-8 | 旧 Forge | 解 universal + versionInfo patch，不跑 installer | 仍跑 installer | 老安装器兼容性/速度不确定 |
| L-9 | 安全 | processor 命令来自元数据，无 argv 白名单 | 固定 argv/环境/shell:false；安装器 SHA1 确认 | **我们更强**，不能为了“像 HMCL”而削弱 |

### 1.4 我们的具体脆弱点（可直接开修复项）

1. **stdout 格式耦合**：`TASK_PATTERNS` 是手写英文动词表；Forge/NeoForge 版本升级、日志本地化、ANSI 颜色、进度条 `\r`、行缓冲都可能让任务/百分比错位。行解析错不会导致安装失败（成功判定不依赖它），但 UI 会“看起来卡住/乱跳”。
2. **错误行启发式**：`ERROR_PATTERN` 可能把 “Failed to download X, retrying…” 这类可恢复日志当错误；目前只用于失败详情，不改变 exit code 成功判定，但报告噪音大。
3. **exit 0 不等于完整**：我们只验证 version JSON 可解析 + t6 能解析链；没有像 HMCL 那样验证 processor 输出 SHA-1。若 installer 跳过某个输出或写出坏 jar，可能到启动才暴露。
4. **安装期间写入真实 mcRoot**：安装器直接在 `versions/`/`libraries/` 写；失败后我们删除新增版本目录，但若安装器修改了已有文件（例如 profiles、父版本）只能依赖 snapshot 恢复；没有 draft/staging 隔离。
5. **installer 自下载不可控**：installer 会自己下载 Forge/NeoForge 库，不走 t8 的镜像/熔断/并发/断点；慢网络下 15 min 超时可能不够，且无法给用户“镜像源”体验。
6. **旧格式/版本判定晚**：不读 `install_profile.json`，无法提前发现 `profile.minecraft` 不匹配、`spec` 与 `install/versionInfo` 的差异；旧 Forge 仍靠 installer 自身兼容。
7. **进度语义**：`(n/m)` 在 Forge 输出中常是“下载第 n/m 个库”，不是整体百分比；`%` 可能来自解压/单任务；我们的 `percent` 会来回跳。
8. **末行丢失**：`exit` 后固定等 30 ms 再 flush；极端情况下最后一行/错误可能丢（有测试但仍是时间假设）。
9. **日志截断**：400 行环形截断，出错时最关键的早期行可能已丢；HMCL 用结构化 processor 计数，不依赖日志尾部。

### 1.5 建议动作（抄 / 不抄 / 自研）

| ID | 建议 | 类型 | 优先级 | 成本 | 理由 / 验收 |
|---|---|---|---|---|---|
| L1 | **成功判定继续以“进程 exit 0 + 新 version JSON + t6 verify”为主，不用 stdout 错误文本判失败**；把 parser 错误仅作日志/诊断 | 保持+加固 | P0.5 | S | 我们已经比“只看 stdout”稳；补测试：exit 0 + 有警告行仍成功；exit 0 + 无产物失败 |
| L2 | **安装器预检**：解压读 `install_profile.json` + `version.json`；校验 `minecraft`/目标版本；识别 `spec`/`install+versionInfo`；把“安装器类型/processor 数”放进 plan/日志 | 抄行为（自研解析） | P0.5 | S | 早失败、UI 可解释；不需要执行安装器 |
| L3 | **现代 Forge/NeoForge 增加 processor 路径**：解析 `processors`，校验 jar/classpath 哈希，Java 执行，输出 SHA-1 校验/跳过，`DOWNLOAD_MOJMAPS` 特殊处理；保留 installer 作为 legacy 回退 | 抄架构，自研实现 | P1 | L | HMCL 的核心优势；需要安全评审：processor args 不能直接当白名单 argv，必须按 `jar/classpath/args/outputs` 校验并限制路径 |
| L4 | **staging/draft 式提交**：安装到临时 root 或版本 draft，成功后原子发布 version JSON/JAR；失败丢弃 staging | 自研（参考 HMCL draft 思路） | P1 | M | 避免安装期间半成品可见；比“快照+删除”更接近事务；注意 Forge installer 对绝对路径/launcher_profiles 的依赖 |
| L5 | **parser 加固**：去 ANSI、兼容 `\r` 进度、识别 `(n/m)` 的“库计数”语义、增加 heartbeat（长时间无输出但进程活着）、保留最后 30 行+首个错误、Windows 进程树 kill | 自研 | P0.5 | S | 低风险高收益；不改变成功判定 |
| L6 | **installer/库下载统一走 t8**：至少把 installer jar 下载换成 t8 source registry；P1 再考虑把 processor 库预下载走 t8 | 自研/复用 | P1 | M | 统一镜像/熔断/重试/进度；需避免循环依赖（loader→download 服务） |
| L7 | **旧 Forge 解包路径**：检测 `install/versionInfo`，解 universal jar + patch，不跑 installer | 抄行为，自研 | P1 | M | 旧版本兼容/速度；与 L3 共用 profile 解析 |
| L8 | **不要抄**：无 argv 白名单的 `ProcessBuilder`、把 stdout 当日志唯一来源、失败只 abort draft 而不清理可复现输出 | 不抄 | — | — | 我们的 SEC-EXE-06/回滚是差异优势；processor 路径必须保留安全检查 |

**建议的实施顺序**：L1/L2/L5（P0.5，低风险）→ L3+L4（P1，先做 Forge 1.20.1/NeoForge 1.20.1 的 processor 路径，保留 installer 回退）→ L6/L7。不要先重写整个 loader；先把“预检 + 日志/进度 + 失败产物校验”补上。

### 1.6 我们已经做得更好的地方（不要改回去）

- 固定 argv 白名单、`shell:false`、env 白名单（SEC-EXE-06）；
- 安装器 SHA1 展示 + `confirmSha1` 确认（SEC-EXE-05）；
- Java 主版本预检（Java 16 < required 17 直接拒绝，不 spawn）；
- 失败回滚版本目录 + 还原 `launcher_profiles.json` 字节 + 清临时 cwd；
- 成功判定不止 exit code（version JSON + t6 verify）；
- loader 的 45+ 个单测 + fake ProcessPort 覆盖取消/超时/非零退出；
- 我们已知“真实 installer 未在本机执行”并在 README 明示，没有把 fake 测试说成真实安装。

---

## 2. 模组依赖与冲突

### 2.1 HMCL 的实际做法

引用：

- [`ModManager.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/addon/mod/ModManager.java)
- [`LocalModFile.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/addon/mod/LocalModFile.java)
- [`FabricModMetadata.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/addon/meta/FabricModMetadata.java)
- [`ForgeNewModMetadata.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/addon/meta/ForgeNewModMetadata.java)
- [`QuiltModMetadata.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/addon/meta/QuiltModMetadata.java)
- [`RemoteAddon.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/addon/RemoteAddon.java)
- [`ModrinthRemoteAddonRepository.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/addon/repository/ModrinthRemoteAddonRepository.java)
- [`ModAdviser.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/modpack/ModAdviser.java)

#### (1) 本地 mod 元数据：读取器注册表 + 宽容回退

`ModManager`（HMCL 现在把 mod 放在 `addon` 包下）维护：

```
jar/zip -> [ForgeNewModMetadata, ForgeNewModMetadata(NeoForge), ForgeOldModMetadata,
            FabricModMetadata, QuiltModMetadata]
litemod -> [LiteModMetadata]
```

扫描流程：

- 只处理 `.jar/.zip/.litemod`；先按当前实例支持的 loader 排序（supported readers 优先，再 unsupported readers）；
- 依次尝试 reader，第一个成功即用；全部失败 → 用文件名作为 name、loader=`UNKNOWN` 的兜底 `LocalModFile`，并记 warning；
- 对 Forge/Quilt/Cleanroom/LiteLoader 支持 `mods/<subdir>/`（跳过 `.connector`），Fabric 不递归子目录；
- 识别 `.disabled`（禁用）与 `.old`（旧版本）；
- 同 `(modId, loaderType)` 的多个文件归入 `LocalMod`，但**不解决同 ID 多版本冲突**，只分组展示。

各 reader 实际解析的字段：

| 格式 | 解析内容 | 是否解析依赖 |
|---|---|---|
| `fabric.mod.json` | `id/name/version/description/icon/authors/contact.homepage` | **否**（`depends/breaks` 完全忽略） |
| `META-INF/mods.toml` / `neoforge.mods.toml` | `mods[]` 的 `modId/version/displayName/side/displayURL/authors/description/logoFile`；`dependencies` 只用于**判断 loader 是 Forge 还是 NeoForge**；`${file.jarVersion}` 替换；`META-INF/MANIFEST.MF` 版本 | **否**（不保留版本区间/不计算缺失） |
| `mcmod.info`（旧 Forge） | 旧元数据 | 否 |
| `quilt.mod.json` | `quilt_loader.id/version/metadata` | **否** |
| `litemod.json` | LiteLoader 元数据 | 否 |
| 嵌套 jar（Forge `META-INF/jarjar/metadata.json` / `Embedded-Dependencies-Mod`） | 递归取内嵌 mod 的元数据 | 否 |

#### (2) 远程依赖模型：有“类型”，但没有本地求解

`RemoteAddon` 定义：

- `DependencyType = REQUIRED / OPTIONAL / EMBEDDED / INCOMPATIBLE / BROKEN`；
- `RemoteAddon.Version.dependencies` 来自 Modrinth/CurseForge API；
- `ModrinthRemoteAddonRepository` 解析 `dependency_type`（required/optional/embedded/incompatible）和 `project_id`；
- `RemoteAddon.IAddon.loadDependencies` 把依赖项目加载为 `RemoteAddon`；
- 版本筛选由 `gameVersions`/`loaders` 在 API 结果上过滤（`DownloadProvider.fetchModrinthVersionsAsync`）。

这主要服务于**在线 addon 安装/更新**，不是本地 mods 目录的依赖求解：没有 `fabric.mod.json` 的 `depends` 版本区间求值，没有 `mods.toml` 的 `versionRange` 匹配，也没有“缺失前置”的本地提示。HMCL 让 mod loader 在运行时输出缺失依赖，或由用户自己看项目页。

#### (3) 冲突

HMCL 有 `.disabled`/`.old` 命名、同 ID 分组、`ModAdviser` 的整合包文件建议（黑名单/白名单），但没有“两个同 ID 不同版本冲突”的自动判定/提示模型；也没有 Forge `breaks`/Fabric `breaks` 的本地冲突分析。

### 2.2 我们的做法（t29 尚未实现）

截至本快照，`src/main/modules/` 没有 `mods/`；`src/shared/mods.ts` 也不存在。因此第 2 节只能对照 **docs/09 R2 的验收目标**：

- 扫描 `mods/`、`resourcepacks/`、`shaderpacks/` 并分类；
- 用 `.disabled` 启停；
- **解析 `fabric.mod.json` / `mods.toml` 依赖，提示缺失前置**；
- `installLocalFile(path)` 统一拖拽/选择器入口；
- .mrpack 与常见 zip 整合包导入。

“提示缺失前置”这一点已经**明确超出 HMCL 本地 ModManager 的能力**；HMCL 没有现成的本地依赖求解可抄。

### 2.3 差距

| # | 维度 | HMCL | 我们（计划） | 结论 |
|---|---|---|---|---|
| M-1 | 本地元数据宽容度 | 多 reader、supported/unsupported 回退、未知兜底、jar-in-jar、子目录、`.disabled/.old` | 尚未实现 | **HMCL 领先，抄模式** |
| M-2 | 依赖解析 | 只把 Forge dependencies 用于 loader 判定；Fabric/Quilt 的 depends 忽略 | 计划解析 depends/breaks | **我们计划领先，自研** |
| M-3 | 版本区间 | 无本地区间求值；远程 API 只按 gameVersion/loader 过滤 | 计划 Fabric semver predicates + Forge Maven ranges + Quilt | **自研，HMCL 无可抄** |
| M-4 | 缺失前置提示 | 无本地提示；依赖 mod loader 运行时日志 | 计划在启动前/模组页提示 | **我们领先，注意误报** |
| M-5 | 冲突/重复 | 同 ID 分组但不判定；无 breaks 分析 | 计划重复 ID/loader 不匹配/版本冲突 | **自研** |
| M-6 | 远程依赖 | 有 REQUIRED/OPTIONAL/EMBEDDED/INCOMPATIBLE/BROKEN 模型 | P0 不做在线依赖下载 | P1 可借模型，不接 API 也可复用类型 |
| M-7 | 整合包文件建议 | `ModAdviser` 黑名单/建议列表 | t29/t35 计划 | 可参考“文件分类”思路，不必抄列表 |

### 2.4 建议动作

| ID | 建议 | 类型 | 优先级 | 成本 | 说明 |
|---|---|---|---|---|---|
| M1 | **元数据读取器注册表**：per-loader 优先级、supported→unsupported 回退、未知兜底、`.disabled/.old`、Forge/Quilt 子目录、jar-in-jar | 抄行为（自研） | P0/t29 | M | 直接提升“能读出多少 mod”的覆盖率；不要抄 HMCL 的 Java 类 |
| M2 | **自研依赖模型**：`Dep {modId, kind:required/optional/embedded/incompatible, range, side, source}`；Fabric semver predicates（`>=`/`<`/`~`/`^`/`*`/`x`）、Forge Maven ranges（`[1.0,2.0)` 等）、Quilt 语法；MC/loader 约束 | 自研 | P0/t29 | L | HMCL 没有；这是差异点。先支持 required + 简单 ranges，optional/embedded 只展示不报缺失 |
| M3 | **缺失/不匹配判定**：按 `(modId, loader)` 建索引；区分“缺失”“已安装但版本不满足”“被禁用”“仅客户端/仅服务端”“内嵌提供”；给出可操作的提示（缺哪个、需要什么范围、当前是什么） | 自研 | P0/t29 | M | 需要 UI 契约字段；避免把 optional/embedded 当缺失 |
| M4 | **冲突判定**：重复 ID 多版本、loader 不匹配（Forge mod 放进 Fabric 实例）、`breaks`/`incompatible`；不自动删文件，只提示 | 自研 | P0/t29 | M | HMCL 只分组；我们可做得更好，但先保证不误报 |
| M5 | **P1 远程依赖**：采用 HMCL 的 `REQUIRED/OPTIONAL/EMBEDDED/INCOMPATIBLE/BROKEN` 类型模型；Modrinth API 的 `project_id/version_id`；不在 P0 做在线解析/下载 | 抄模型（自研实现） | P1 | M | 与 t29 本地依赖共用数据结构 |
| M6 | **不要抄**：HMCL 忽略本地 depends、把依赖判断留给运行时、无版本区间求值 | 不抄 | — | — | 我们的验收要求“提示缺失前置”，必须自己实现 |

### 2.5 我们已做得/可做得更好的地方

- HMCL 的元数据解析很宽容，但**没有本地依赖求解**；我们按 docs/09 R2 做“缺失前置提示”是明确的产品差异点，值得投入。
- 我们的 t29 可复用 t6 的实例/loader 信息、t8 的下载任务（未来 P1 在线依赖）和 t31 的 repair 分离，不需要把依赖求解塞进启动链。
- 但要注意：**依赖声明常有 optional/embedded/条件依赖/服务端专用**；先做 required + 明确缺失，避免“一打开模组页满屏红字”的误报。
- HMCL 的 `ModAdviser` 黑名单是其整合包导出策略，不是依赖逻辑；不要为了“像 HMCL”复制一份黑名单到 t29。

---

## 3. 下载重试与镜像降级

### 3.1 HMCL 的实际做法

引用：

- [`DownloadCandidates.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/DownloadCandidates.java)
- [`DownloadCandidate.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/DownloadCandidate.java)
- [`DownloadProvider.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/download/DownloadProvider.java)
- [`HMCLDownloadProvider.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCL/src/main/java/org/jackhuang/hmcl/download/HMCLDownloadProvider.java)
- [`FetchTask.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/task/FetchTask.java)
- [`FileDownloadTask.java`](https://raw.githubusercontent.com/HMCL-dev/HMCL/acc9740fa9289ded38553b6a35045fd608c1ea99/HMCLCore/src/main/java/org/jackhuang/hmcl/task/FileDownloadTask.java)

#### (1) 没有“多源测速”，是区域默认 + 有序 candidate

HMCL 的下载选择不是先测速再选最快源，而是：

- `HMCLDownloadProvider` 用 `RegionUtils.isIsChinaMainlandMachine()` 判断区域；
- `DownloadSource = DEFAULT / OFFICIAL / MIRROR`；分别设置 `versionListSource` 和 `fileSource`；
- 中国区：
  - 文件 `DEFAULT/MIRROR` → **镜像优先**；`OFFICIAL` → 官方优先；
  - 版本清单 `DEFAULT/OFFICIAL` → **官方优先**（`getGameVersionListCandidates` 的 DEFAULT 是 `defaultUrl, bmclapiUrl`）；
- 非中国区：
  - 文件 `DEFAULT/OFFICIAL` → 只官方；`MIRROR` → 镜像→官方；
- 每个文件：`mirrorUrlFor` 用 `MirrorRule` 表把官方 URL 重写到 BMCLAPI/其它镜像；`fallback` 标记为 true 的镜像（Modrinth/CurseForge CDN）即使在镜像模式下也**官方优先**；
- `DownloadCandidates` 可以包含多个 `DownloadCandidate`（url、retry、connectTimeout、readTimeout）；`FetchTask` **顺序尝试**：
  - 每个 candidate 默认 `DEFAULT_RETRY=5`（即 1+5 次）；
  - 失败等待 200 ms 固定 sleep 后重试；
  - candidate 失败换下一个；全部失败抛最后一个（suppressed 前置异常）；
  - 支持最多 20 次重定向；
- 版本清单还有 `FallbackTask`：先官方，失败再 BMCL（或按 source 反过来）。

#### (2) 缓存、续传与校验

`FetchTask`/`FileDownloadTask`：

- HTTP 缓存：ETag/Last-Modified 条件请求、304 使用缓存；`FileDownloadTask` 对带 integrity check 的文件用缓存候选；
- Range 续传：记录总长度、strong ETag/Last-Modified，续传校验 `Content-Range`、ETag/Last-Modified、编码；416/不可续传时从头重来；
- 下载到临时文件 → 校验整个文件 hash（或 BMCLAPI 的 `x-bmclapi-hash`）→ 原子 move；失败删除临时文件；
- zip/jar 下载附加 ZIP 完整性检查；
- 进度按字节更新，速度按秒计算。

### 3.2 我们的做法（t8）

引用：[`sources.ts`](../src/main/modules/download/core/sources.ts)、[`queue.ts`](../src/main/modules/download/core/queue.ts)、[`retry.ts`](../src/main/modules/download/core/retry.ts)、[`service.ts`](../src/main/modules/download/service.ts)、[`README.md`](../src/main/modules/download/README.md)。

- 源：`official` / `mirror`（BMCLAPI），`sourcePreference = auto | official | mirror`；`auto` 无条件 **mirror first**，`mirrorEnabled=false` 时只官方；
- `sourceHint` 可把某源提前，但另一源仍作为 fallback；
- 连续失败 3 次 → **会话级熔断**（源被禁用，`DOWNLOAD.NO_SOURCE` 列出所有尝试 URL）；
- 每源 `maxRetries=3`（1+3 次），退避 `backoffDelay`：300 ms 起、指数、±20% 抖动、上限 5 s；429/5xx/408/网络错误可重试，`Retry-After` 解析；
- 并发：全局 8（1–16）、每主机 4（1–8）；可限速；暂停/恢复/取消；作业锁防双开；磁盘预检；
- `.part` + `Range` 续传（206 校验 `Content-Range`；200 回退从头；416 删除重下）；原子 rename；24 h 陈旧 `.part` 清理；
- 哈希优先级 `sha512 > sha256 > sha1`；有哈希即整文件校验；无哈希仅官方 host + `unverified`；
- 进度事件 100 ms 节流，包含文件数/字节/速度/当前文件/源；
- **没有**：区域感知、每文件 candidate 列表（只有 `url` + `mirrorUrl`）、per-candidate retry/timeout、ETag/304、Last-Modified、Range 的 If-Range/ETag 校验；镜像规则只覆盖 Mojang 主机（不含 Forge/NeoForge/Fabric/Modrinth/CurseForge/Maven Central）。

### 3.3 差距

| # | 维度 | HMCL | 我们 t8 | 结论 |
|---|---|---|---|---|
| D-1 | 默认源 | 区域感知；版本清单官方优先、文件镜像优先 | auto 无条件 mirror first | **HMCL 更合理**；我们的 manifest 走镜像，信任锚较弱 |
| D-2 | candidate 数 | 每文件可多 URL（官方+镜像+规则） | 1 official + 1 mirrorUrl | HMCL 更灵活；多镜像/多 CDN 需要扩展 task schema |
| D-3 | 重试策略 | 每个 candidate 默认 5 次、固定 200 ms、可配 timeout | 每源 3 次、指数退避+抖动+Retry-After、熔断 | **我们更好**（除 candidate 级配置） |
| D-4 | 熔断 | 无显式会话熔断；失败换 candidate | 连续 3 次失败熔断 | **我们更好** |
| D-5 | 缓存/条件请求 | ETag/Last-Modified/304 | 无 | HMCL 更好（元数据尤其有用） |
| D-6 | 续传校验 | Content-Range + ETag/Last-Modified + 编码 | `.part` + Content-Range；200/416 回退 | HMCL 更严；我们基本够用 |
| D-7 | 镜像覆盖 | Forge/NeoForge/Fabric/Modrinth/CurseForge/Tencent Maven 规则 | Mojang 主机 + client 专用路由 | HMCL 更广；我们 loader 另有一套 HTTP |
| D-8 | 并发/限速/暂停 | 有全局 semaphore，未看到每主机/限速/暂停同级能力 | 每主机 4、限速、暂停/恢复、作业锁 | **我们更好** |
| D-9 | 测速 | **没有测速**；有序 candidate | **也没有测速** | 不要把“测速”当成 HMCL 优点；不必为每个文件测速 |

### 3.4 建议动作

| ID | 建议 | 类型 | 优先级 | 成本 | 说明 |
|---|---|---|---|---|---|
| D1 | **拆分源偏好**：`versionListSource`（版本清单/版本 JSON）默认官方优先、镜像回退；`fileSource`（libraries/assets/client）默认镜像优先（中国区）/官方（非中国区）；保留 explicit official/mirror | 抄行为，自研 | P0.5 | S | 先修信任锚：无哈希的 manifest 不应默认镜像；HMCL 的做法正确 |
| D2 | **每文件 candidate 列表**：把 `DownloadTask` 的 `url+mirrorUrl` 扩展为 `candidates[]`（source/url/fallback/retry/timeout）；保持哈希/原子写不变 | 自研扩展 | P1 | M | 支持多镜像/多 CDN/per-candidate 重试；UI/日志仍显示实际源 |
| D3 | **条件请求缓存**：manifest/version JSON/asset index 等小文件加 ETag/Last-Modified；304 用本地缓存；大文件可先不做 | 抄行为，自研 | P1 | M | 降低重复安装/刷新流量；注意离线回退与缓存过期 |
| D4 | **补镜像规则**：Forge/NeoForge/Fabric/Quilt maven、Modrinth CDN、Maven Central 镜像；每条规则有 fallback 标记和白名单 | 抄思想，自研 | P1 | M | 我们 loader 现在自己写 HTTP；统一后才能享受 |
| D5 | **per-attempt 超时/心跳**：连接/读取超时、无字节心跳、失败换 candidate；不要只靠总超时 | 抄行为 | P0.5 | S | 解决“卡住但进程未退出” |
| D6 | **不要为每个文件做测速**；如未来要测，只对元数据/候选源做低频探测，并允许关闭 | 不抄/自研 | P2 | M | HMCL 也没测速；确定性区域/回退更可解释 |
| D7 | **保留**：熔断、指数退避+抖动、Retry-After、每主机并发、限速、暂停/恢复、哈希优先级、原子写、作业锁 | 保持 | — | — | 这些是我们比 HMCL 强的地方 |

### 3.5 我们的优势（不要为了“像 HMCL”而丢）

- 失败熔断 + 抖动退避 + `Retry-After`；HMCL 固定 200 ms、无熔断。
- 每主机并发/全局限速/暂停恢复/取消清理；大文件对 UI 更友好。
- 哈希矩阵与整文件校验、原子 rename、作业锁、磁盘预检。
- 进度契约包含 bytes/速度/当前文件/源，t8 测试有 109 例（含真实端点 opt-in）。
- t31 复用 t8 只补坏文件；HMCL 的修复/安装也统一走 DownloadProvider，各有取舍，但我们的 repair 明确不删 extra。

---

## 4. 汇总：抄什么、不抄什么、自研什么

| 决策 | 内容 | 优先级 | 备注 |
|---|---|---|---|
| **抄行为（自研代码）** | 安装器预检/期望版本；现代 Forge/NeoForge processor 路径；输出 SHA-1 校验/跳过；draft/staging 提交；mod 元数据读取器注册表/回退/jar-in-jar；区域感知源默认；每文件 candidate；ETag/Last-Modified；镜像规则表 | P0.5–P1 | 只借鉴行为/结构，不复制 Java 代码；保留我们的安全控制 |
| **自研** | 本地 mods 依赖图 + 版本区间求值 + 缺失/冲突提示；t29 的 `fabric.mod.json`/`mods.toml`/Quilt 解析；UI 理由；整合包依赖清单 | P0/t29 | HMCL 没有本地求解器，不能等它 |
| **不抄** | 用 stdout 当安装唯一进度/成功依据；无 argv 白名单的 processor 执行；HMCL 的固定 200 ms 退避；为每个文件做测速；HMCL 忽略本地依赖的做法；复制 ModAdviser 黑名单 | — | 我们已有更好或不需要 |
| **保持** | 固定 argv/env 白名单、installer SHA1 确认、Java 预检、回滚、哈希矩阵、熔断、每主机并发、限速、暂停/恢复、原子写、作业锁、repair 的 extra 不删除 | — | 差异优势 |

**建议下一张任务卡（不在本任务实施）**：
1. `loader` P0.5：安装器预检（L2）+ parser 加固（L5）+ 成功判定测试（L1）；
2. `loader` P1：Forge/NeoForge processor 路径（L3）+ staging/draft（L4），保留 installer fallback；
3. `mods`（t29）：M1/M2/M3/M4；
4. `download` P0.5/P1：D1、D5；D2/D3/D4 分阶段。

---

## 5. 许可证、引用与 clean-room 说明

1. **HMCL 许可证**：GPL-3.0-or-later。本报告引用的每个 `.java` 文件头部都有：
   `This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.`，并带 `Copyright (C) 20xx huangyuhui <huanghongxun2008@126.com> and contributors`。
2. **本报告未复制代码**：只记录行为、类/方法名与路径；没有把 HMCL 源码粘贴进我们的仓库。若未来要“抄代码”而不是“抄行为”：
   - 我们的项目已是 GPL-3.0（见 [02-compliance-security.md](./02-compliance-security.md) Q6 裁定），GPL-3.0-or-later 兼容；
   - 必须保留原版权头、许可证头、文件级来源注释（URL + commit），并在 `NOTICE`/`THIRD-PARTY` 中列 HMCL 与版权人；
   - 修改过的文件要标注修改；分发二进制时提供完整对应源码（GPL 义务）；
   - 不建议跨语言逐行翻译（Java→TS），版权上仍可能构成衍生作品；clean-room 记录见 [clean-room-log.md](./clean-room-log.md)。
3. **引用快照**：HMCL main commit `acc9740fa9289ded38553b6a35045fd608c1ea99`（2026-10-20）；raw 链接已固定到该 commit，避免 main 漂移。
4. **我们自己的引用**（相对路径）：loader `src/main/modules/loader/core/installer.ts`、`service.ts`、`__tests__/installer.test.ts`；download `src/main/modules/download/core/{sources,queue,retry}.ts`、`README.md`；t29 需求 `docs/09-resume-plan.md` R2；许可证 `docs/02-compliance-security.md`。
5. **分析边界**：
   - 只做了源码阅读，没有运行 HMCL 与我们的 loader 做同机对比；
   - HMCL 是活跃仓库，actor/模型可能变化；本报告锁定 commit；
   - 没有审计 HMCL 的 UI 层完整交互（只看了 core/下载/模组元数据），UI 文案/提示位置可能另有实现；
   - 我们的 t29 未实现，第 2 节“我们的做法”是**计划**，不是现状；
   - 真实 Forge installer 执行仍未在本机跑通（t17 README 已记录），所以 L1–L8 的建议优先级基于代码与测试，不是实测对比。

---

## 6. 附：关键对照速查

### 6.1 Forge/NeoForge 安装流程对照

| 步骤 | HMCL | 我们 t17 |
|---|---|---|
| 识别 installer 格式 | 读 `install_profile.json`：`spec` / `install+versionInfo`；校验 `minecraft` | 不解包；直接执行 `--installClient` |
| 安装器执行 | 不执行 installer；执行 processors（Java `-cp` + main class） | 执行 installer `java -jar ... --installClient mcRoot` |
| 进度 | processor 完成数 / 总数；输出仅日志 | stdout 英文动词 + `%`/`(n/m)` |
| 产物校验 | processor outputs SHA-1；失败删除输出/重跑 | 最终 version JSON 可解析 + t6 verify |
| 临时目录 | `tempDir` 隔离 vanilla jar；postExecute 删除 | `dataRoot/tmp/loader-<jobId>` 作为 cwd；失败/成功都删 |
| 失败可见性 | draft 未 commit → 实例不可见；共享缓存保留 | 快照回滚新版本目录/profiles；安装期间目录可见 |
| 库下载 | GameLibrariesTask / DownloadProvider（多源/缓存） | installer 自己下载；installer jar 走 loader HTTP |
| 安全 | 元数据命令直接 ProcessBuilder | 固定 argv/env、shell:false、SHA1 确认 |

### 6.2 模组元数据对照

| 能力 | HMCL | 我们 t29（计划） |
|---|---|---|
| Fabric `fabric.mod.json` | id/name/version/authors/contact；**忽略 depends** | 解析 depends/breaks + 版本区间 |
| Forge `mods.toml` | 元数据；dependencies 仅用于 loader 判定 | 解析 `[[dependencies]]` 的 modId/mandatory/versionRange/side |
| Quilt `quilt.mod.json` | 元数据；**忽略 depends** | 解析 depends + 版本区间 |
| 旧 Forge `mcmod.info` | 支持 | 视 P0 范围支持 |
| 嵌套 jar/jar-in-jar | 支持递归读取 | 建议 P0 支持（避免把内嵌依赖判缺失） |
| 子目录 | Forge/Quilt/Cleanroom/LiteLoader 支持 | 按 loader 支持 |
| `.disabled`/`.old` | 支持 | 支持 |
| 缺失前置提示 | **无（本地）** | **目标能力** |
| 版本不匹配 | 远程 API 过滤 gameVersion/loader；本地不算 | 本地依赖区间判定 + 提示 |
| 冲突/重复 | 分组但不判定 | 计划判定 |

### 6.3 下载策略对照

| 能力 | HMCL | 我们 t8 |
|---|---|---|
| 区域默认 | 中国区：文件镜像优先、版本清单官方优先；非中国区官方 | auto 无条件镜像优先 |
| 源偏好 | DEFAULT/OFFICIAL/MIRROR；versionList/file 分开 | auto/official/mirror；未分 metadata/file |
| 每文件 candidate | 多 URL，fallback 标记 | 1 official + 1 mirror |
| 重试 | 每 candidate 默认 5 次、固定 200 ms、可配 timeout | 每源 3 次、指数+抖动、Retry-After、熔断 |
| 缓存 | ETag/Last-Modified/304 | 无 |
| 续传 | Content-Range + ETag/Last-Modified | `.part` + Content-Range；200/416 回退 |
| 镜像规则 | Forge/Fabric/NeoForge/Modrinth/CurseForge/Tencent Maven | Mojang 主机 + client 专用 |
| 限速/每主机/暂停 | 并发 semaphore；未见完整同级能力 | 每主机 4、限速、暂停/恢复、作业锁 |
| 测速 | **无** | **无** |

---

**最终建议一句话**：优先把 HMCL 的“**结构化安装（install_profile/processors + 输出校验 + draft）**”和“**区域感知的每文件 candidate 下载**”学过来；但不要为了对齐 HMCL 放弃我们的安全白名单、熔断、并发与修复边界。模组依赖则是我们**超过 HMCL** 的机会，必须自研，不能等现成实现。
