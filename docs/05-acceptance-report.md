# 05 · 端到端验收报告（P0 逐条证据）

| 项 | 值 |
|---|---|
| 文档编号 | `05-acceptance-report` |
| 版本 | **1.0** |
| 日期 | 2026-10-21 |
| 验收人 | qa（🧐 验收测试工程师 / 🎭 测试自动化工程师） |
| 依据 | `docs/01-requirements.md` v1.5（P0-0 ~ P0-8、§5.10 冒烟、A0.* ~ A8.*） |
| 被测构建 | `release/win-unpacked/mc-launcher.exe`，2026-10-21 19:59:42，247,155,712 B，app 0.1.0 / Electron 44.9.3 |
| 构建来源 | t33 + t43（资源库/模组更新）+ t44（崩溃面板/存档/截图/回收站）完成后的打包产物 |
| 结论 | **P0 不可对外称“可用”**：9 张 P0 卡中 2 张通过（P0-0、P0-2），3 张部分/失败（P0-1、P0-5、P0-6、P0-7、P0-8），P0-3/P0-4 后端通过但 UI 未接线。阻断项见 §11。 |

> 判定口径：只写有证据的结论；证据全部落在 `docs/evidence/p0/`。命令行中的 `npm` 一律为 `npm.cmd`（本机 `npm.ps1` 被执行策略拦截）。验收期间 `src/` 仍被并发任务 t43/t44 修改：19:40–19:50 的早期探针使用 t33 构建，20:08 之后的关键 UI 证据使用 19:59:42 最终构建；报告在每处标明构建时间，未把旧构建的结论冒充最终构建。

---

## 0. 结论摘要

| P0 | 能力 | 结论 | 一句话证据 |
|---|---|---|---|
| P0-0 | 骨架/UI/主题/实例识别 | **PASS（A0.8 部分）** | 15 实例、3 缺 JSON；只读前后 SHA1/mtime 完全一致；主题重启保持；8 页可达 |
| P0-1 | 版本解析 + 安装 1.20.1 + 启动 | **FAIL（当前构建无法完成全新安装）** | 19:03 首次安装 425 s/3641 文件成功且哈希全对、启动到主菜单；本次连续 3 次全新安装失败（镜像 CDN 超时 + 源熔断，见 B1） |
| P0-2 | 离线账户 | **PASS** | UUID `097d…466c`/`a06c…23a6` 与规范一致；四件套正确；非法名 4/4 拦截；重启选中保持 |
| P0-3 | Java 自动检测 | **FAIL（UI/错误码）** | 4 个真实候选、1.20.1 自动选 17、强制 21 生效；但 Java 选择 UI 禁用，缺失/非法 Java 返回 `IPC.HANDLER_FAILED` |
| P0-4 | 内存/JVM/窗口参数 | **FAIL（UI）** | 后端 argv 全部正确（4096、1280×720、全屏、G1、4 个 natives、A/B 隔离）；设置页控件全部 disabled |
| P0-5 | 日志与崩溃提示 | **FAIL** | 日志/`launch-last.*` 齐全；坏 JVM 参数 293 ms 生成 `jvm-args` 结论；但无自动弹窗、崩溃报告路径/格式不符、日志无轮转 |
| P0-6 | 联机 L0 | **FAIL（L0 未闭环）** | 双进程开房/加入/关闭 3.1 s 通知、版本不匹配拦截均真实通过；成员列表不含房主、ping 为 null、LAN 世界发现与实际进世界未闭环 |
| P0-7 | 微软/Authlib/多账户 | **FAIL（UI 与实机）** | `MS_CLIENT_ID_MISSING` 诚实失败、Authlib 1.2.8 SHA-256/`-javaagent` 正确；无微软/Authlib UI 入口，Authlib 登录未验证到主菜单 |
| P0-8 | 模组/资源包/光影 + 整合包 | **PASS（A8.3/8.4/8.7 证据不足）** | 三目录扫描、启停、冲突、删除；拖拽与选择文件两入口都落盘 256 B 同源文件；资源/光影可用；mrpack 导出/导入成功 |

**发布门禁**：`01` §5.10 的 16 步冒烟未达到 16/16；第 3、4、8、13、15 步或失败或证据不足（§10）。**不得对外宣称 P0 可用。**

---

## 1. 验收环境、构建与命令

### 1.1 环境（基线机）

| 项 | 值 |
|---|---|
| OS | Windows 11 家庭中文版 10.0.26100 x64，24 核 / 31.4 GiB |
| Node / npm | v24.20.0 / 11.19.0（`where java` 为空） |
| Electron / Chrome / Node(内置) | 44.9.3 / 152.0.7977.167 / 24.22.0（来自 `launcher.log` boot 行） |
| Java | 4 个真实候选：25.0.1、21.0.12.1（JDK21）、21.0.7、17.0.15；1.20.1 自动选 17.0.15 |
| 测试世界 | `E:\MC\.minecraft`（只读）、`.e2e/e2e-install-H2EdGy`（隔离安装）、`%TEMP%`/`.e2e/*`（异常夹具） |
| 证据根 | `docs/evidence/p0/`（工具在 `docs/evidence/p0/tools/`，仅验收脚本，未改产品代码） |

### 1.2 构建与代码漂移

- 最终打包：`release/win-unpacked/mc-launcher.exe` 时间 19:59:42；`.e2e/runtime` 于 20:08 从该产物重新 staging。
- 验收期间 t43/t44 并发完成（`src/renderer/app/pages/SavesPage.tsx` 19:59:13、`LogsPage.tsx` 19:57:33、`CrashPanel.tsx` 19:56:45、`CatalogSearch.tsx` 19:51:19）。19:40–19:50 的 UI 截图来自 t33 构建；20:08 的 `settings-*`、`logs-page.png` 来自最终构建。
- 20:08 之后未再改产品代码；最终门禁见 §1.3。

### 1.3 命令与结果

| 命令 | 退出码 | 结果 | 证据 |
|---|---|---|---|
| `npm.cmd --prefix mc-launcher run typecheck` | 0 | 通过 | `evidence/p0/env/final-gates.log` |
| `npm.cmd --prefix mc-launcher run test` | 0 | **48 passed / 5 skipped 文件；414 passed / 18 skipped 用例** | `evidence/p0/env/final-gates.log` |
| `npm.cmd --prefix mc-launcher run build` | 0 | 通过 | `evidence/p0/env/final-gates.log` |
| `npm.cmd --prefix mc-launcher run e2e:install-launch`（全新目录） | **1** | 连续 3 次失败：第 1/2 次镜像 CDN 超时/源熔断，第 3 次被并发任务关闭应用 | `evidence/p0/smoke/e2e-install-launch-attempt1.log`、`...attempt2.log`、`evidence/p0/smoke/e2e-fresh-t34.log`、`evidence/p0/P0-1/install-failure-9wTshh-launcher.log` |
| `MCL_E2E_WORKSPACE=.e2e/e2e-install-H2EdGy npm.cmd ... run e2e:install-launch`（已完成工作区） | 0 | **PASS**：安装校验 3641/3641、离线 `TestUser`、Authlib `-javaagent`、到达主菜单 | `evidence/p0/smoke/e2e-final-resume.log`、`evidence/p0/P0-1/e2e-final-result.json` |
| `npm.cmd run pack`（由 e2e 自动触发） | 0 | 打包成功 | e2e 日志 |

> **必须区分**：`e2e:install-launch` 在“已完成安装的工作区”里通过，证明的是**启动链 + 已安装产物**；它**不能**证明当前网络下“全新目录安装”可复现。后者本次失败，是 P0-1 的阻断项 B1。

### 1.4 历史全新安装证据（19:03–19:10，t33 构建）

| 事实 | 值 | 证据 |
|---|---|---|
| 安装开始/结束 | 11:03:32.937Z → 11:10:38.433Z，**425,492 ms（7.1 min ≤ 15 min）** | `evidence/p0/P0-1/install-fresh-1903.log` |
| 任务统计 | 3641 文件 / 735,402,462 B；本次下载 2387、跳过 1254、失败 0 | 同上 |
| 启动到主菜单 | 进程 11:10:39.604Z → `Setting user` 19:12:39、`Sound engine started` 19:12:41（约 8 s） | `evidence/p0/P0-1/game-latest-fresh-1912.log` |
| 主菜单截图（本次验收） | 1.20.1 主菜单，窗口标题 `Minecraft 1.20.1` | `evidence/p0/P0-1/main-menu.png` |

---

## 2. P0-0 骨架、UI 页面/主题、数据目录与实例识别

**结论：PASS（仅 A0.8 的部分子项未达标）**

| 断言 | 结论 | 证据 |
|---|---|---|
| A0.1 首次 ≤2 s / 二次 ≤1.5 s | PASS（boot→window shown **341 ms**，renderer ready 450 ms） | `evidence/p0/P0-1/launcher-full.log`（11:49:17.567→17.877→17.994） |
| A0.2 `$DATA` 有 `config.json`、`logs/` | PASS | `.e2e/e2e-install-H2EdGy/data/config.json`、`data/logs/{launcher.log,app-*.jsonl,launch-last.*}` |
| A0.3 15 实例、3 缺 JSON、名称一致 | PASS（15；`1.21.1-Forge_52.1.1`、`1.21.1-Forge_52.1.10`、`The Last Voyage of the Harpy Express`） | `evidence/p0/P0-0/result.json`、`page-instances.png` |
| A0.4 只读扫描零改动 | PASS（4 个代表文件 mtime/SHA1 前后完全一致） | `evidence/p0/P0-0/readonly-hashes.txt` |
| A0.5 异常实例无进程 | PASS（javaw 0 → 0） | `evidence/p0/P0-0/probe-fixtures.log` |
| A0.6 全角冒号/中文路径 | PASS（`Hunt：History 1949 - Blood Testament` 完整显示） | `evidence/p0/P0-0/result.json`、`page-instances.png` |
| A0.7 broken-json → JSON 损坏、no-jar → 缺 jar，均不可启动 | PASS（`corrupt-json` / `missing-jar`，`launch:start` 拒绝，javaw 0） | `evidence/p0/P0-0/result.json`、`fixtures-instances.png` |
| A0.8 7 页可达；每页空/加载/错误三态；启动 6 态 | **FAIL（部分）**：8 个路由均可达并截图；空态/错误态有多处 `DataStateNotice`，但未对每页逐一演示加载态；启动 6 态只在 `/components` 规范页展示，真实只观察到 idle/启动中 | `evidence/p0/P0-0/page-*.png`、`P0-1/launcher-running.png` |
| A0.9 主题持久 + 无 mock | PASS（dark→light→reload 仍 light；`grep` 无 mock/fixture/sampleData/fakeData 常量） | `evidence/p0/P0-0/theme-after-reload.png`、`result.json` |

说明：实例行中部分 Forge 实例 `mcVersion` 为 `null`（`result.json`），列表显示加载器与 Java，但“游戏版本”列为 `-`；不违反 A0.3 的计数/名称断言，记录为显示精度缺口。

---

## 3. P0-1 版本解析 + 全新目录安装 1.20.1 + 启动

**结论：FAIL（阻断 B1：当前网络下全新安装不可复现）；安装产物与启动链本身通过**

### 3.1 产物断言（历史安装，逐项复核）

| 断言 | 结论 | 实测 | 证据 |
|---|---|---|---|
| A1.1 id/mainClass/libraries/assetIndex/java | PASS | `id=1.20.1`、`mainClass=net.minecraft.client.main.Main`、`libraries=88`、`assetIndex=5`、`javaMajor=17` | `artifact-facts.txt` |
| A1.2 client jar 大小/SHA1 | PASS | 23,028,853 B；SHA1 `0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838` | `artifact-facts.txt` |
| A1.3 `assets/indexes/5.json` 大小/SHA1 | **PASS（以版本 JSON 上游 sha1 为准）；01 的数值是笔误** | 413,067 B；SHA1 `8a45c6be38ac9486b04944bffcb96f8aae1b0649` 与版本 JSON `assetIndex.sha1` 一致；01 写的 `ad7d5442…` 不匹配任何本机上游值 | `artifact-facts.txt`、`hash-verification.txt` |
| A1.4 3575 objects；抽查 20 个 SHA1 | **PASS（计数与抽样）；01 的“总大小”数值过时** | 3575 个；40 个随机对象 40/40 SHA1+size 匹配；索引 `totalSize=651,728,646`，磁盘去重后 651,496,644；01 写 650,564,794 | `asset-sample-verification.txt`、`artifact-facts.txt` |
| A1.5 64 个 Windows library + 21 natives | PASS | 64 个 jar 全部 SHA1 匹配；natives 递归含 `lwjgl.dll`、`glfw.dll`、`jemalloc.dll`、`OpenAL.dll`、`lwjgl_stb.dll`、`lwjgl_tinyfd.dll` | `hash-verification.txt`、`artifact-facts.txt` |
| A1.6 安装 ≤15 min / 源可证明 | **FAIL（本次）/ PASS（历史）** | 历史 425 s；本次 3 次失败，日志证明镜像源把文件重定向到 `*.749333.xyz` 后连接超时，连续 3 次失败后源被熔断，剩余任务报 `DOWNLOAD.NO_SOURCE` | `install-fresh-1903.log`；`install-failure-9wTshh-launcher.log`；`e2e-install-launch-attempt1.log` |
| A1.7 `launch-last.json/.bat` 字段 | PASS | `--username TestUser`、`--uuid 097d…466c`、`--accessToken 0`、`--userType legacy`、`--version 1.20.1`、`--gameDir/--assetsDir/--assetIndex 5`、`-Xmx4096m` 恰 1 次、无 `${...}` | `log-artifacts.txt`、`launch-last.bat` |
| A1.8 natives ≥6 DLL | PASS（文件位于 `1.20.1-natives/windows/x64/...`，递归存在） | 见 A1.5 | `artifact-facts.txt` |
| A1.9 游戏日志四标记 + 窗口标题 | PASS | `Setting user: TestUser`、`Backend library: LWJGL`、`textures/atlas/blocks.png-atlas`、`Sound engine started`；窗口标题 `Minecraft 1.20.1` | `game-latest-fresh-1912.log`、`game-latest-resume.log`、`main-menu.png` |
| A1.10 点击→Sound engine ≤60 s；退出码 0 | PASS | 20:05:40 进程 → 20:05:49 `Sound engine started`（9 s）；20:04:15 一次正常退出 `exitCode=0 classification=normal` | `launcher-full.log`、`log-artifacts.txt` |
| A1.11 负向 1 取消 / 2 续传 / 3 坏文件 / 4 不存在版本 | **PARTIAL**：取消真实生效（job `cancelled`）；坏 client jar 10 B → repair 后 SHA1 精确恢复；缺 jar 预检拦截。续传仅观察到“跳过 1254 个已存在文件”（非真实中断测试）；不存在版本未测 | `probe-errors.log`、`install-fresh-1903.log` |
| A1.12 inheritsFrom 夹具 dry-run | PASS | `mainClass=cpw.mods.bootstraplauncher.BootstrapLauncher`、classpath 44 含父库、无 `${...}`、`logs/dry-run.json` 落盘、无 javaw | `probe-inherit.log`、`P0-1/result.json` |
| A1.13 父版本缺失 | PASS | 实例状态 `unsupported`，原因 `VERSION_PARENT_NOT_FOUND: parent version not found: no-such-parent`；plan 拒绝 | 同上 |

### 3.2 加载器（任务口径：Fabric/Quilt 真实安装；Forge opt-in；NeoForge 无哈希拒绝）

| 项 | 结论 | 证据 |
|---|---|---|
| Fabric 真实安装 | PASS：255 个版本、选 `0.19.5`，`fabric-loader-0.19.5-1.20.1` done；verify chain `[1.20.1, fabric…]`、mainClass `KnotClient`、96 库/52 classpath、Java 17 | `evidence/p0/P0-1-loaders/result.json` |
| Quilt 真实安装 | PASS：307 个版本、选 `0.30.1`，`quilt-loader-0.30.1-1.20.1` done；99 库/55 classpath | 同上 |
| Forge | PASS（按口径不执行）：137 版本、`47.4.28` recommended，installer sha1 `585dd607…`、`hashSource=official`；未执行原因已记录（官方 maven 约 75 KB/s、执行还需约 60 MB 依赖；执行路径由 fake-ProcessPort 单测覆盖，t17） | 同上 |
| NeoForge 无哈希拒绝 | PASS（行为）；错误码为 `IPC.HANDLER_FAILED`，message `installer has no upstream sha1; pass allowUnverifiedInstaller=true after user confirmation`；plan `hashSource=none` 并有警告 | 同上 |

### 3.3 本次全新安装失败复现步骤（B1）

1. 新建空目录 `%TEMP%\mcl-e2e-fresh`，`data` 与 `mc` 均空；`npm.cmd --prefix mc-launcher run e2e:install-launch`。
2. 观察 `assets` 阶段：镜像 URL 被 302 到 `https://<n>.749333.xyz/download/...`，连接 `172.64.229.x:443` 超时；每文件 10 s、3 次重试。
3. 约 2 min 后日志出现批量 `DOWNLOAD.NO_SOURCE "no enabled source for assets/objects/..."`——`SourceRegistry` 在源连续 3 次失败后将其**整会话禁用**，镜像与官方先后被禁用后无源可用，任务以 `failed` 结束（`3314 个文件下载失败`）。
4. 复现 2 次；第 3 次在下载中应用进程被并发任务关闭（exit 4294967295），未完成。
5. 证据：`e2e-install-launch-attempt1.log`、`install-failure-9wTshh-launcher.log`、`e2e-fresh-t34.log`。修复建议：熔断只禁用“当前策略下的首选源”，保留最后一个可用源；或支持显式 `sourcePreference=official` 且不因 3 次瞬时超时熔断；失败任务可重试而非终态。

---

## 4. P0-2 离线账户

**结论：PASS**

| 断言 | 结论 | 证据 |
|---|---|---|
| A2.1 `TestUser=097d3392-…-da1c3473466c`、`SecondUser=a06ca53b-…-1254960523a6` | PASS | `evidence/p0/P0-2/result.json` |
| A2.2 四件套 `--username/--uuid/--accessToken 0/--userType legacy` | PASS（两个账户各一次 plan） | 同上 |
| A2.3 `Setting user: TestUser`；SecondUser 新 plan 不含 TestUser | PASS（`leak=false`） | 同上、`game-latest-fresh-1912.log` |
| A2.4 `ab`、`a b`、17 位、`张三` 全部拦截且不建账户 | PASS（4/4 `IPC.INVALID_INPUT`，账户数保持 2） | 同上 |
| A2.5 重启后选中保持 | PASS（`selectedBeforeRestart=selectedAfterRestart=948b…`，名称 TestUser） | `probe-ui-final.log`、`result.json` |

UI：账户页可创建/选择离线账户，展示 offline/authlib 列表（`evidence/p0/P0-2/settings-account.png`）；页面顶部仍有“设置后端尚未接入”的旧提示，属文案/接线不一致（见 B3）。

---

## 5. P0-3 Java 自动检测

**结论：FAIL（UI + 错误码）；检测/匹配本身通过**

| 断言 | 结论 | 证据 |
|---|---|---|
| A3.1 ≥4 条、四项齐全 | PASS：25.0.1、21.0.12.1（`jdk21`）、21.0.7、17.0.15，path/vendor/arch/source 与探测一致 | `evidence/p0/P0-0/result.json` |
| A3.2 1.20.1 自动选 17.0.15 | PASS（`java-runtime-beta`，plan/launch 一致） | 同上、`e2e-final-result.json` |
| A3.3 强制 21 后命令行切换 | PASS（plan `javaPath=…jdk-21.0.12.1+1…`、`javaMajor=21`） | `evidence/p0/P0-2/result.json` |
| A3.4 不存在 → `JAVA.NOT_FOUND`；非 Java → `JAVA.INVALID` | **FAIL**：均被包装成 `IPC.HANDLER_FAILED`；`C:\Windows\System32\cmd.exe` 走 8 s 探测超时，未给出 `JAVA.INVALID`；无 javaw 进程 | `evidence/p0/P0-4/result.json` |
| A3.5 缓存 ≤500 ms | **未验证**（未做二次打开计时；单测覆盖缓存） | — |
| UI 选择/下载 Java 出口（R3.5/R3.6） | **FAIL**：Java 路径输入框与“自动选择 Java”均为 disabled，只有只读候选列表 | `evidence/p0/P0-2/settings-java.png` |

---

## 6. P0-4 内存与 JVM 参数（含分辨率/全屏）

**结论：FAIL（UI）；后端 argv 全部通过**

| 断言 | 结论 | 实测/证据 |
|---|---|---|
| A4.1 自动内存 ∈[2048,8192]，`-Xmx` 恰 1 次且与 UI 一致 | PASS（`-Xmx8047m`；但 UI 无显示，故“与 UI 一致”不可验） | `evidence/p0/P0-4/result.json` |
| A4.2 自定义 4096 → `-Xmx4096m` 恰 1 次 | PASS | 同上 |
| A4.3 G1 + `UnlockExperimentalVMOptions` + 编码 | PASS（10 个 G1/log4j 参数；代码页 936 → `-Dstdout/stderr/file.encoding=GBK`） | 同上 |
| A4.4 4 个 natives 路径以 `1.20.1-natives` 结尾 | PASS（4/4） | 同上 |
| A4.5 1280×720 各 1 次、窗口化无 `--fullscreen`、全屏有 | PASS | 同上 |
| A4.6 `-Dmcl.acceptance=1` 存在；`-Xmx2G` 被拒绝且不启动 | PASS（拒绝 message 可读；错误码仍为 `IPC.HANDLER_FAILED`） | 同上 |
| A4.7 A/B 隔离、重启保留 | PASS（A `-Xmx4096m`、B `-Xmx2048m/854×480`；instance.json 持久） | 同上 |
| UI 显示最终值、可改内存/JVM/窗口（R4.1/R4.9） | **FAIL**：设置页“自动分配内存/全局上限/游戏窗口/JVM 参数”全部 disabled（“落盘通道尚未接入”“等待设置后端”） | `evidence/p0/P0-2/settings-launch.png` |

---

## 7. P0-5 日志与崩溃提示

**结论：FAIL**

| 断言 | 结论 | 证据 |
|---|---|---|
| A5.1 正常退出无弹窗；`launcher.log` 退出码 0；四类日志齐全 | **PARTIAL**：20:04:15 `exitCode=0 classification=normal`；`launcher.log`、`app-*.jsonl`、`launch-last.*`、`logs/game/...` 齐全；但**没有自动弹窗**（面板需手动打开） | `log-artifacts.txt` |
| A5.2 坏 JVM 参数 ≤10 s 弹窗，结论命中，剪贴板一致 | **PARTIAL/FAIL**：`-XX:+UseDefinitelyNotARealGC` 在 **293 ms** 内 crashed，report 有 `jvm-args` 高置信结论与证据；最终构建的崩溃面板可“分析最近一次崩溃/复制报告/导出诊断包”（`CrashPanel.tsx`），但**无自动弹出**；未验证剪贴板内容 | `evidence/p0/P0-5/result.json`、`logs-page.png` |
| A5.3 杀进程 ≤10 s 弹窗，结论“进程被终止” | **FAIL**：`taskkill` 后分类为 `crashed`、`hints=[]`，无“被终止”结论，无弹窗 | `log-artifacts.txt` |
| A5.4 OOM 规则单测命中 | PASS（全仓 414 passed，含 crash 规则单测） | `env/final-gates.log` |
| A5.5 缺 jar 预检、无进程、修复后 SHA1 正确 | PASS（预检拒绝；repair 后 23,028,853 B / `0c3ec587…`） | `P0-5/result.json` |
| A5.6 `launch-last.bat` 字段；日志轮转 ≤10 | **FAIL**：`.bat` 含 `chcp 936`、`cd /d`、Java、`-cp`、主类、`--username`（PASS）；但 `kernel/logger.ts` **没有轮转实现**，`logs/` 仅 `launcher.log` + 按日 `app-*.jsonl` | `log-artifacts.txt`、`src/main/kernel/logger.ts` |
| A5.7 报告无 accessToken/`eyJ` | PARTIAL：`launch-last.json/.bat` 扫描无 `eyJ`/refresh token；但崩溃报告不自动落盘，无法验证报告文件；诊断包路径为 `data/backups/crash/crash-<id>.zip`，**不是** R5.7 的 `data/crash-reports/<time>-<实例>.txt` | `log-artifacts.txt`、`crash/service.ts` |
| A5.8 日志面板 跟随/暂停/清空/搜索 | PARTIAL：控件均存在并接 `launch:evt:output`，历史日志来自真实文件；未做逐项交互计时 | `logs-page.png` |

---

## 8. P0-6 联机：一键房间 + 进入 LAN 世界 + 隧道降级

**结论：FAIL（L0 未闭环）；房间控制面与错误路径通过**

| 断言 | 结论 | 证据 |
|---|---|---|
| A6.1 创建 ≤5 s；房间号/邀请码格式 | PASS（即时；6 位 Crockford `7B7WJ9`，邀请 `MCL-7B7WJ9`；完整 ticket `MCL1.`） | `evidence/p0/P0-6/net-errors-result.json` |
| A6.2 加入 ≤10 s；双方成员列表一致；延迟真实 | **FAIL**：加入即 `connected`；两进程 `members` 均只有 1 个 member，房主不计入（UI 显示“1 位成员”，与“双方各 2 人”不符）；`pingMs=null`，UI `ping —` | `link-host-room.png`、`net-errors-result.json` |
| A6.3 LAN 端口发现 ≤5 s | **未闭环（阻塞）**：需游戏内“对局域网开放”的人工操作，未自动化；无日志解析实测 | 见 §11 B5 |
| A6.4 一键进世界 ≤3 点击/≤60 s；1.20+ quickPlay | **PARTIAL**：B 真实启动游戏，argv 为 `--quickPlayMultiplayer 10.33.135.230:25566`，`Setting user: MemberUser`；但无实际 LAN 世界/服务器，未进入世界 | `P0-6/probe.log`、`qa-06-B` 游戏日志 |
| A6.5 版本不匹配拦截；错误邀请码报错不启动 | PASS（用真实 1.20.4 实例 → `VERSION_MISMATCH`；篡改 → `TICKET_SIGNATURE_INVALID`；残缺 → `TICKET_MALFORMED`；短码 → `INVITE_INCOMPLETE`）。**口径差异**：01 期望 `MCL-000000 → ROOM_NOT_FOUND`，实现按 t4/t9 设计返回“短码不完整”，更安全但需改文档 | `net-errors-result.json` |
| A6.6 房主关闭 ≤5 s；邀请码失效 | **PARTIAL**：成员 3.1 s 收到 `ROOM_CLOSED`（PASS）；旧邀请码重加入返回 `PORT_MAPPING_REQUIRED`，不是 `INVITE_INVALID/ROOM_CLOSED`（FAIL） | `probe-close.log` |
| A6.7 仅回环/私网监听，无外部中继 | PASS（`netstat` 仅 127.0.0.1 与私网连接；`transport=lan`、`relay=false`） | `P0-6/probe.log` |
| A6.8 双开不污染 | PASS（两个 data 目录、两个账户、各自实例；A/B 状态独立） | `net-errors-result.json` |
| A6.9 L2 隧道/中继/手动映射 | **未验证（条件项）**：本机单出口；t4 PoC 未闭环跨网 P2P/中继，按 01 §5.7 条件项记录 | `docs/04`、B5 |
| A6.10 sidecar 哈希/许可证/可关闭 | **未运行**（`transport=lan` 未启动 EasyTier）；代码/许可证来自 t9，未在本轮实测 | — |

---

## 9. P0-7 微软设备码 / Authlib / 多账户

**结论：FAIL（UI 与实机登录）；错误路径与 Authlib 注入通过**

| 断言 | 结论 | 证据 |
|---|---|---|
| A7.1 无 client id → `MS_CLIENT_ID_MISSING`，无 token、无假成功 | PASS（含 hint/docs 链接） | `P0-2/result.json`、`e2e-final-result.json` |
| A7.2 403 → `MS_AUTH_NOT_APPROVED` | **未验证（条件项）**：无可用 client id/审批，不能触发 403 | — |
| A7.3 token 不落明文（`eyJ`/`accessToken` 搜索为空） | PASS（data 目录扫描 0 命中；`accounts.json` 仅 name/uuid/kind） | `P0-2/result.json` |
| A7.4 Authlib `-javaagent`、jar SHA-256、进程不崩 | **PARTIAL**：Authlib 1.2.8 真实下载（`downloaded=true`，SHA-256 `9c7f4343e6c8…7b10`），plan 含 `-javaagent:<abs>=https://littleskin.cn/api/yggdrasil`；**Authlib 账户登录到主菜单未验证**（既有尝试 `menu=false`），无注入后崩溃证据 | `P0-2/result.json`、`data/authlib-launch.log` |
| A7.5 三态切换不串号 | PARTIAL：offline→offline 切换无串号；Authlib 仅 plan，未做三态启动切换 | `P0-2/result.json` |
| A7.6 Authlib 不可达 → 可读错误、不卡死 | **未验证**；UI 无 Authlib 配置入口 | — |
| UI 设备码流程/Authlib 入口 | **FAIL**：账户页只有离线账户创建与列表；无“微软登录/Authlib 服务器”入口（后端 IPC 已有） | `P0-2/settings-account.png` |

---

## 10. P0-8 模组/资源包/光影 + 整合包

**结论：PASS（t34 明确要求的两入口与加载器已满足）；A8.3/8.4/8.5/8.7 证据不足**

| 断言 | 结论 | 证据 |
|---|---|---|
| A8.1 扫描/启停/冲突/删除/打开目录 | PASS（扫描 3 目录；`.disabled` 启停；同名启用+禁用 → `conflicts=[qa-conflict.jar]`；批量删除；`openFolder` 未点） | `evidence/p0/P0-8/result.json` |
| A8.2 拖入与选择文件两入口都能装、结果一致、不串实例 | PASS（拖拽：CDP 真实 `drop` 事件 → `qa-entry-drag (1).jar`；选择文件：同一 `mods.installLocalFile(path)` → `qa-entry-picker.jar`；均 256 B、同源；未做第二实例对照与非法类型实测） | `result.json`、`mods-after-ui-drag.png` |
| A8.3 mrpack 文件/哈希/overrides | PARTIAL：真实导出 341 B `.mrpack` 并导入为 `QA-Import`（jar/json/instance.json 齐全）；无 mods/overrides 的哈希复核；t33 的 3,912 B 带 mods/overrides 导入未复跑 | `result.json`、`qa-export.mrpack` |
| A8.4 本地 CF zip 仅本地解析/缺失清单 | **未实测**（仅 t29 单测） | — |
| A8.5 Zip-Slip 拒绝 | **未实测端到端**（单测覆盖） | — |
| A8.6 无加载器提示 | **未验证**（导入结果 `needsBaseInstall=false`；UI 提示未查） | — |
| A8.7 普通 zip 识别/无法识别报错 | **未实测**；非法文件 `qa-not-a-pack.txt` 被拒（`file too small to be a zip`） | `result.json` |

---

## 11. §5.10 端到端冒烟剧本（16 步）

| 步 | 结论 | 说明 |
|---|---|---|
| 1 全新 data+空 mc 首启 ≤2 s | PASS | boot→window 341 ms；可选目录 |
| 2 只读扫描 `E:\MC\.minecraft` | PASS | 15 实例/3 异常/零改动 |
| 3 空目录安装 1.20.1 | **FAIL（本次）** | 历史 19:03 通过；本次 3 次失败（B1） |
| 4 离线 TestUser 主按钮一次点击进主菜单 | **PASS（历史/重启路径）** | 19:12 与 20:05 两次到主菜单；主页“启动中”态与 pid 真实；但 20:05 使用的是 t33 构建 |
| 5 Java 自动选择 17.0.15 | PASS | plan/launch 一致 |
| 6 内存 4096 + 1280×720 再启动 | **PARTIAL（仅 argv）** | argv 正确，UI 无法设置 |
| 7 全屏再启动 | **PARTIAL（仅 argv）** | `--fullscreen` 正确，UI 无法设置 |
| 8 错误 GC → ≤10 s 报告 | **FAIL（无弹窗）** | 293 ms 生成结论，面板需手动打开 |
| 9 正常退出无崩溃弹窗、退出码 0 | **PARTIAL** | 退出码 0/classification normal；无弹窗实现 |
| 10 缺 jar 预检 + 修复 + 再启动 | **PARTIAL** | 预检/修复 SHA1 通过；“再启动到主菜单”未复跑 |
| 11 7 页 + 主题切换 + 重启保持 | PASS | 8 路由截图；主题持久 |
| 12 模组启停/冲突/拖入 + 选择文件 + 资源/光影 | PASS | 真实验证（见 P0-8） |
| 13 mrpack 导入 + 哈希 + overrides | **PARTIAL** | 空包导出/导入通过；带文件/overrides 未复跑 |
| 14 微软错误路径 + Authlib 注入 | **PARTIAL** | 错误路径与 plan 注入通过；Authlib 实机未到主菜单 |
| 15 双开建房/加入/开 LAN/一键进世界 | **FAIL** | 开房/加入/关闭通过；LAN 世界与进世界未闭环 |
| 16 关房 + 错码 + 版本不匹配 + 隧道降级 | **PARTIAL** | 关房/版本不匹配通过；旧邀请码错误码不符；隧道未测 |

**16/16 未达成**；第 3、8、15 步失败，第 4 步仅历史证据。

---

## 12. 阻断项（必须修复/补证后才能称 P0 可用）

| ID | 阻断项 | 证据/复现 | 影响 |
|---|---|---|---|
| **B1** | 下载源健康策略在瞬时超时后禁用最后的可用源，导致全新安装 100% 失败 | 空目录安装 → 镜像 302 到 `*.749333.xyz` 超时 → 3 次后 `DOWNLOAD.NO_SOURCE`（`install-failure-9wTshh-launcher.log`） | P0-1 阻断（第 3 步） |
| **B2** | 设置页未接线：内存/窗口/JVM/默认实例/Java 选择全部 disabled；实例设置 tab 仍是占位 | `settings-launch.png`、`settings-java.png`、`InstanceDetailPage.tsx` 的 `UnwiredTab('settings')` | P0-3/P0-4 阻断（第 6/7 步） |
| **B3** | 领域错误码被 `IPC.HANDLER_FAILED` 包裹（Java/启动/加载器/修复/模组） | `P0-4/result.json`、`P0-1-loaders/result.json`、`P0-5/result.json` | 失败不可解释，违反“失败路径有错误码” |
| **B4** | 崩溃无自动弹窗；报告不落 `crash-reports/<time>-<实例>.txt`；`launcher.log` 无轮转 | `log-artifacts.txt`、`kernel/logger.ts` | P0-5 阻断（第 8 步） |
| **B5** | 联机 L0 未闭环：房主不计入成员/无 ping、LAN 世界发现未验证、旧邀请码返回 `PORT_MAPPING_REQUIRED`、进世界无服务器 | `link-host-room.png`、`probe-close.log`、`P0-6/probe.log` | P0-6 阻断（第 15 步）；L1/L2 条件项未具备 |
| **B6** | 微软/Authlib 无 UI 入口；Authlib 登录未验证到主菜单 | `settings-account.png`；`data/authlib-launch.log` | P0-7 阻断（第 14 步） |
| **B7** | P0-8 的 CF zip/Zip-Slip/普通 zip/无加载器提示未做端到端实测 | 仅单测；`P0-8/result.json` | P0-8 证据不足（第 13 步） |
| **B8** | 01 文档断言数值与上游不符：A1.3 索引 SHA1、A1.4 objects 总大小 | `artifact-facts.txt`、`asset-sample-verification.txt` | 文档缺陷，非产品缺陷；建议修 01 §5.2 |

---

## 13. 未验证项与条件项（不得当作通过）

1. **L1 同 LAN 双设备**：本机只有一台设备，按 01 §5.7 “环境不具备”记录，不阻塞 L0。
2. **L2 跨网隧道/中继**：t4 PoC 未闭环（单出口、公共节点失效）；本轮 LAN 房间未启动 EasyTier，无 sidecar 运行时证据。
3. **Forge/NeoForge 真实安装器执行**：按 t34 口径 opt-in，本机官方 maven ~75 KB/s、执行还需 ~60 MB 依赖，未执行；执行路径由 t17 fake-ProcessPort 单测覆盖，计划/哈希证据见 `P0-1-loaders/result.json`。
4. **微软真实登录/403**：无 client id/审批（MCE 审批外部阻塞）；仅验证 `MS_CLIENT_ID_MISSING`。
5. **Authlib 账号登录到主菜单**：未闭环；旧尝试 `menu=false`（`data/authlib-launch.log`）。
6. **邀请码 10 分钟过期**：未真实等待；`net/__tests__/ticket.test.ts` 以注入时钟覆盖 `INVITE_EXPIRED`。
7. **真实“断网”**：未拔网线/禁用网卡；用“镜像 CDN 超时 + 官方/CDN 失败”的真实失败日志与 `DOWNLOAD.NO_SOURCE` 单测覆盖；未做物理断网。
8. **日志轮转 11 次启动**：未跑；代码层无轮转实现（B4）。

---

## 14. 证据索引（相对 `docs/`）

```
evidence/p0/
  env/final-gates.log                  typecheck/test/build（414 passed / 18 skipped）
  env/build-gates.log                  早期 typecheck/guard/build
  smoke/e2e-final-resume.log           最终构建 e2e（已完成工作区）PASS
  smoke/e2e-install-launch-attempt1.log  全新安装失败（源熔断）
  smoke/e2e-fresh-t34.log              第三次全新安装被并发任务中断
  P0-0/result.json                     15 实例/3 缺 JSON/Java 4 候选/主题/页面
  P0-0/readonly-hashes.txt             只读前后 mtime/SHA1
  P0-0/page-*.png                      8 个路由截图
  P0-0/theme-after-reload.png          主题重启保持
  P0-0/fixtures-instances.png          broken-json/no-jar 夹具
  P0-1/main-menu.png                   1.20.1 主菜单（真实窗口）
  P0-1/launcher-running.png            主页“启动中”+ pid
  P0-1/e2e-final-result.json           离线启动/Authlib 注入/主菜单
  P0-1/install-fresh-1903.log          19:03 全新安装时间线
  P0-1/game-latest-fresh-1912.log      19:12 到主菜单日志
  P0-1/artifact-facts.txt              jar/索引/库/对象/natives 断言
  P0-1/hash-verification.txt           64 库 SHA1 全对 + 6 DLL
  P0-1/asset-sample-verification.txt   40 个 assets SHA1 全对
  P0-1/install-failure-9wTshh-launcher.log  B1 原始日志（6616 行）
  P0-1/probe-inherit.log               inheritsFrom/父缺失
  P0-1-loaders/result.json             Fabric/Quilt 真实安装 + Forge/NeoForge plan
  P0-2/result.json                     UUID/非法名/切换/持久化/Java21/Authlib
  P0-2/settings-account.png            账户页（无微软入口）
  P0-2/settings-java.png               4 候选 + 禁用选择
  P0-2/settings-launch.png             内存/窗口/JVM 全部 disabled
  P0-2/logs-page.png                   最终构建日志页 + 崩溃面板
  P0-4/result.json                     argv 全量断言 + A/B 隔离
  P0-5/result.json                     修复/缺 jar/坏 JVM/错误码
  P0-5/log-artifacts.txt               launch-last.bat/game 日志/退出分类
  P0-6/net-errors-result.json          开房/加入/短码/篡改/版本不匹配
  P0-6/probe-close.log                 关房 3.1 s + 旧邀请码
  P0-6/probe.log                       two-process create/join/enter argv
  P0-6/link-host-room.png              房主房间 UI（1 位成员/ping —）
  P0-8/result.json                     扫描/两入口/启停/冲突/资源/光影
  P0-8/probe-modpack.log               mrpack 导出/导入
  P0-8/mods-after-ui-drag.png          拖拽后列表
```

验收脚本（只读/仅写临时目录，未改产品代码）：`evidence/p0/tools/*.mjs`、`*.ps1`。

---

## 15. 验收判定

- **P0-0、P0-2**：通过。
- **P0-1**：安装产物与启动链通过，但“当前构建 + 当前网络下的全新安装”失败，**阻断**。
- **P0-3、P0-4、P0-7**：后端能力通过，UI 未接线/错误码不符，**阻断**。
- **P0-5、P0-6**：关键用户路径（自动崩溃提示、LAN 进世界）未闭环，**阻断**。
- **P0-8**：t34 要求的两入口与加载器通过；完整卡仍有未实测子项。
- 结论：**P0 不可对外称“可用”**；建议按 §12 B1–B8 修复后重跑 §5.10 全 16 步。本文档不含无证据的通过结论；历史安装/启动证据已与“本次全新安装失败”分开标注。

---

## 16. t45 补充验收（t43/t44 新页面 + 一键启动真实成功路径 + 双入口）

> 追加章节，不覆盖 §1–§15。验收时间 2026-10-21 20:10–20:25。
> **构建说明**：t43/t44 的稳定打包产物为 `release/win-unpacked/mc-launcher.exe`（19:59:42，247,155,712 B）。验收期间 t46 在 20:15、20:22 又重建了 `release`（新增 net `lanWorlds` 契约但 handler 未注册，见 §16.5），其应用在 20:16 出现 renderer 崩溃。为保证页面/启动证据来自同一稳定包，本节页面与一键启动证据使用 **19:59:42 构建**（已复制到 `.e2e/t45-runtime`，sha 与 t34 最终构建一致：`main-menu.png` 哈希与 t34 截图相同），并在每项注明。

### 16.1 验收结果总览

| 项 | 结论 | 证据 |
|---|---|---|
| 资源库（Modrinth 搜索/详情/安装 UI） | **PASS** | 真实 UI 搜索 `sodium` → **107 个结果 / 第 1/6 页**；`catalog-search-sodium.png`；后端同查 107 |
| 模组更新（SHA-1 反查/风险/回收站确认） | **PASS**（真实空结果） | 目标实例检查 0 个可更新（checked 0/matched 0/skipped 0/errors 0）；`updates-check.png` |
| 存档页 | **PASS** | 真实 `QA World`（1 个世界）；`saves-list.png`；`backupSave` 可点（zip 生成） |
| 截图页 | **PASS** | 真实 `qa-shot.png`（1 张），主进程 data URL 缩略图；`screenshots-grid.png` |
| 回收站页 | **PASS** | 删除 QA World → trash 条目 `25be6a31…` → 恢复 1 项/失败 0 → `listSaves` 再次出现 `QA World`；`trash-after-delete.png` |
| 日志页 + 崩溃分析面板 | **PASS** | 真实坏 JVM 参数崩溃（`jvm-args`），面板显示“JVM 启动参数错误 / 中置信度 / Unrecognized VM option”并导出诊断包 `diagnostics-1792584748271.zip`（3 文件/3.0 MB）；`logs-history-crash.png`、`crash-analysis.png`、`crash-exported.png` |
| **一键启动真实成功路径** | **PASS（主链）** | 主页只点 1 次「启动游戏」→ 1.20.1 主菜单，**10.3 s**；`Setting user: OneClickUser`、`Sound engine started`；`status.state=running`；`main-menu.png` + `oneclick-running.png` + `probe-onelaunch.log` |
| 一键启动 UI 状态机 | **FAIL（细节）** | 游戏已到主菜单、`launch.status=running` 时，主页仍显示“启动中… / 等待游戏进程…”；未切到“运行中/结束游戏”（`oneclick-running.png`） |
| 拖拽安装 | **PASS** | CDP 真实 `drop` → `t45-drag.jar`（256 B） |
| 文件选择器安装 | **PASS** | 真实弹出“选择模组”原生对话框，Alt+N + 路径 + Enter → `t45-picker.jar`（256 B） |
| 两入口落盘一致 | **PASS** | 两个文件均 256 B，SHA-256 均为 `40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880`；`consistent=true`；测试后清理为空 |

### 16.2 t43/t44 页面逐项

**资源库**：`#/catalog` 载入真实 Modrinth；关键词输入 `sodium` 后点击「搜索」，结果区显示 `107 个结果 · 第 1/6 页`，卡片含 Sodium / Sodium Extra / Reeses’s Sodium Options 等真实项目、下载量与加载器标签；截图 `evidence/p0/t45/catalog-search-sodium.png`。事件记录：`evidence/p0/t45/probe-catalog-final.log`（`clickSearch=clicked`、header=107 个结果）；后端 `mc:catalog:search` 返回 total=107。

**模组更新**：`#/updates`（资源库内“模组更新”页）选择实例后点「检查更新」；真实返回 `0 个可更新 / 检查 0 · 匹配 0 / 跳过 0 · 错误 0`，空态文案“当前已装模组均为最新，或 Modrinth 未收录文件哈希”；截图 `updates-check.png`，事件 `probe-catalog-final.log`。说明：该实例为 `fabric-loader-0.19.5-1.20.1`（1.20.1/Fabric，mods 为空）；页面共享的实例选择器在自动化键盘 Home 后 UI 仍显示原实例，属 UI/自动化选择问题，不影响“真实 IPC + 空结果”结论；未伪造可更新项。

**存档**：`#/saves` 选择 `1.20.1` 后显示 `saves/` 真实世界 `QA World`（含 `level.dat` 与 `icon.png`）共 1 个；「备份 zip」按钮可点；截图 `saves-list.png`，事件 `probe-pages-fix.log`（`1 个世界`、`QA World`）。

**截图**：`#/screenshots` 显示 `screenshots/qa-shot.png` 1 张，页面通过主进程 `previewScreenshot` 渲染 1 个 data URL；截图 `screenshots-grid.png`，事件 `probe-pages-fix.log`（`1 张`、`qa-shot.png`）。

**回收站**：`mc:assets:deleteSaves` 删除 `QA World` → `mc:assets:listTrash` 返回条目 `25be6a31-f7ec-49fe-a683-ba28cd16e90a`（kind=save）→ 页面截图 `trash-after-delete.png` → `mc:assets:restoreTrash` 恢复 1 项、failed=0 → `listSaves` 再次返回 `QA World`；事件 `probe-pages.log`。

**日志 + 崩溃面板**：对 `qa-broken` 注入 `-XX:+UseDefinitelyNotARealGC` 启动 → `state=crashed`、report hint=`jvm-args`；日志页选中该实例点「分析最近一次崩溃」→ 面板显示“T40 崩溃分析 · QA-BROKEN / JVM 启动参数错误 / 中置信度 / 日志证据 Unrecognized VM option”；点「导出诊断包」→ `data/backups/diagnostics/diagnostics-1792584748271.zip`（3 个文件，3.0 MB）。截图 `logs-history-crash.png`、`crash-analysis.png`、`crash-exported.png`；事件 `probe-pages.log`。限制：分析结论为“中置信度”（上下文不足），不是“高”；面板没有自动弹出，仍属 t34 B4。

### 16.3 一键启动真实成功路径（P0 主链补充证据）

- 构建：19:59:42 t44 稳定包；数据目录 `.e2e/t45-onelaunch-data`（全新），MC 目录使用完整安装 `.e2e/e2e-install-H2EdGy/mc`（1.20.1 全量文件，t34 已哈希验证）。
- 账户：离线 `OneClickUser`（UUID 标准离线生成）；实例：`1.20.1`（vanilla，Java 17，1280×720 窗口化，4096 MiB）。
- 操作：主页只点击一次 `button[aria-label="启动游戏"]`（`clicks=1`，点击前 disabled=false）。
- 结果：
  - 点击 → `Setting user: OneClickUser` / `Backend library: LWJGL` / `Sound engine started` 共 **10,297 ms**（≤60 s）。
  - `mc:launch:status` 返回 `state=running`、sessionId `d9f96ac4-…`。
  - 真实游戏窗口截图 `main-menu.png`（标题 `Minecraft 1.20.1`，与 t34 的主菜单截图哈希一致），启动器截图 `oneclick-running.png`。
  - 事件/日志：`probe-onelaunch.log`、`data/logs/launcher.log` 的 `game process started`、游戏日志四标记。
- **未通过子项**：同一时刻启动器主页仍显示“启动中… / 等待游戏进程…”，未显示“游戏运行中/结束游戏”。这是 UI 状态机缺陷（`HomePage` 只更新 flow 的部分分支），不影响“一键启动成功到主菜单”的主链结论，但 P0-0 的 6 状态演示仍不完整。

### 16.4 拖拽安装 vs 文件选择器（各实测一次）

| 入口 | 操作 | 结果 |
|---|---|---|
| 拖拽 | CDP `Input.dispatchDragEvent` dragEnter/dragOver/drop，files=[`C:\Users\Supreme\AppData\Local\Temp\t45-drag.jar`] | 列表出现 `t45-drag.jar`，256 B |
| 选择文件 | 点击「选择文件」→ 原生 `#32770` 对话框标题“选择模组” → UIA/Alt+N 输入 `…\t45-picker.jar` + Enter | 列表出现 `t45-picker.jar`，256 B |

- 源文件与落盘文件 SHA-256 均为 `40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880`；`consistent=true`；两入口均走 `mods.installLocalFile(path)`。
- 截图：`mods-after-drag.png`、`mods-after-picker.png`；事件：`probe-mods.log`（pickerHelper status=0，`DIALOG_FILLED`）。
- 测试后 `mods:remove` 清理，`afterClean=[]`，未污染其它实例。

### 16.5 命令与构建漂移

| 命令 | 结果 | 证据 |
|---|---|---|
| `npm.cmd --prefix mc-launcher run test` | **exit 0，437 passed / 18 skipped** | `evidence/p0/t45/gates.log` |
| `npm.cmd --prefix mc-launcher run e2e:install-launch` | **exit 1（环境/并发阻塞）**：打包成功后 `ensureRuntime` 删除 `.e2e/runtime` 报 `EPERM`——并发任务 t46 的应用（pid 38432，data `.e2e/t46-fresh2`）正占用该目录；同时 20:15 构建日志出现 `contract net method lanWorlds has no handler`，该构建 renderer 在 20:16 崩溃 | `evidence/p0/t45/e2e.log`、t46 进程命令行 |

> 说明：t45 的“一键启动真实成功路径”已用 19:59 稳定包 + 真实 UI 点击独立完成，不依赖 e2e。e2e 的失败不是本任务引入，而是并发任务对 `.e2e/runtime` 的独占与 20:15 构建的 net 契约漂移；需要在 t46 结束后重跑。

### 16.6 t45 结论与遗留

1. t43/t44 新增页面全部可打开并接真实 IPC；资源库真实搜索、存档/截图/回收站真实闭环、崩溃分析面板真实分析与导出均 PASS。
2. 一键启动**真实成功到主菜单**已补证（10.3 s、真实游戏窗口、状态 running），满足 P0 主链“不是只走失败分支”的要求；遗留主页状态机不切换（B4-ui）。
3. 拖拽与文件选择器两入口各实测一次，落盘 SHA-256 完全一致，PASS。
4. 未改产品代码；新增证据均在 `docs/evidence/p0/t45/`，验收脚本为 `docs/evidence/p0/tools/*.mjs`、`picker-dialog.ps1`。
5. e2e 未能在并发任务占用 `.e2e/runtime` 时通过；建议 t46 完成后按 §1.3 重跑，并把 20:15 构建的 `net.lanWorlds` handler 缺失/渲染崩溃作为独立阻断项修复。
