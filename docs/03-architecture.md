# 03 · 架构与技术选型 ADR（Electron + TypeScript + React）

**Status**: v1.3 · 可交付实现（t5–t16 的契约基线；1.3 按用户 2026-10-21 要求恢复拖拽安装 P0，并补一键启动口径）
**Author**: architect（🏛️ 软件架构师 / 🛡️ 安全架构师）  **Date**: 2026-10-21
**输入（必须消费）**: [`01-requirements.md`](01-requirements.md) v1.5、[`02-compliance-security.md`](02-compliance-security.md) v0.2、[`design/README.md`](../design/README.md) v0.1、[`docs/research/40-architecture.md`](research/40-architecture.md)（研究底稿）。
**权威顺序**: 合规红线以 02 为准 > 范围/验收以 01 为准 > 本文定义实现契约 > 40 为研究底稿（与本文冲突处，以本文为准；§13.4 列出全部差异）。
**免责**: 本文只定义工程架构，不构成法律意见；许可证结论见 02 §6.6。

> **一分钟版本**：Electron 44 + TypeScript 7 + React 19 + Vite 8（electron-vite 6）三段式；main 是唯一可信边界；模块**自注册**（扫 `src/main/modules/*/index.ts`，导出 `register(ctx)`），新增模块只加目录，**冻结 `src/main/index.ts` 与 `package.json`**；IPC 用 `src/shared/<name>.ts` 单源契约 + zod + `Result` 信封；数据目录 `dataRoot`（应用私有）与 `mcRoot`（.minecraft）分离；版本 JSON 安装时扁平化；启动参数纯函数 + dry-run；联机是可选模块（P0 局域网房间，隧道 P1）；测试 vitest + Playwright，所有命令用 `npm.cmd`。

---

## 0. 决策摘要

### 0.1 ADR 一览

| ADR | 决策 | 一句话理由 | 详见 |
|---|---|---|---|
| **ADR-001** | **Electron 44 + TypeScript 7 + React 19 + Vite 8（electron-vite 6）**，打包 electron-builder 26 | 本机 Node 24/npm 可用、无 .NET SDK；Electron 提供唯一成熟的三进程 + 原生窗口 + 系统集成路径；团队并行成本最低 | §2 |
| **ADR-002** | 三进程（main/preload/renderer）+ 冻结安全基线 | 渲染层零文件/进程能力；即使 XSS 也只能调白名单通道 | §3 |
| **ADR-003** | 模块**自注册**：`src/main/modules/<name>/index.ts` 导出 `register(ctx)`；`src/main/index.ts`、`_registry.ts`、`package.json` 冻结 | 12 个模块并行开发时，唯一必然相交的文件被消除；新增模块只增目录 | §4 |
| **ADR-004** | 类型化 IPC：`src/shared/<name>.ts` 单源（类型 + zod + 通道 + 客户端签名），`Result` 信封，永不跨 IPC 抛异常 | 错误可分类、可诊断；preload/renderer/main 三层同一契约 | §5 |
| **ADR-005** | **`dataRoot`（应用私有）与 `mcRoot`（.minecraft）分离**；默认 `dataRoot=<exeDir>/data`，`mcRoot` 首次选择后持久化 | 01 v1.2 R0.2/R0.3 的 `--data-dir`/`--mc-dir` 要求；应用数据可随包便携，MC 目录可与 PCL/HMCL 共用 | §7 |
| **ADR-006** | 配置 **JSON + `schemaVersion` + 分片 + 原子写**；内核 `config.json`，模块 `modules/<id>/config.json` | 机器可写、可迁移；单文件单写者，避免 lost update | §8 |
| **ADR-007** | 版本 JSON **安装/导入时扁平化**（展开 `inheritsFrom`），运行期不再合并 | 启动期无合并逻辑，排障简单；与 PCL 的实际落盘一致（12 个有效实例全部扁平） | §6.3 |
| **ADR-008** | 实例目录 = **`mcRoot/versions/<目录名>/`**；`id` 与 `dirName` 解耦 | 与 PCL/HMCL/官方启动器互见，零迁移；改名不断引用 | §6.2/§8.3 |
| **ADR-009** | `libraries/`、`assets/` 放 `mcRoot` **全局共享**；`gameDir` 按实例隔离 | 10 个实例省 5–9 GB；用 `isolation=isolated` 兜底 | §7.3 |
| **ADR-010** | refresh token **只**进 `safeStorage`（Windows=DPAPI）加密文件；access token 只在内存 | 02 SEC-AUTH-01~12；日志/配置/bat 零令牌 | §6.6 |
| **ADR-011** | 下载源策略 **BMCLAPI → 官方**（可切仅官方/仅镜像），**全量哈希 + 原子写 + 源熔断** | 本机实测 `piston-meta` 超时、BMCLAPI 路径镜像可用；源必须可关可换 | §6.4/§6.9 |
| **ADR-012** | `launch` 的 argv 构造是**纯函数** `buildLaunchPlan()`，提供 **dry-run** 落盘 | 可用 golden test 锁死参数；P0-1/2/3/4/7 的验收依赖 dry-run | §6.7 |
| **ADR-013** | `link` 是**可选模块**：默认 `LocalRoomProvider`（局域网/同机回环），隧道 sidecar 为可选 provider | P0-6 只要求 LAN；隧道失败不得拖垮主链路；EasyTier 许可与运行时下载按 02 §6.6 | §6.12 |
| **ADR-014** | `crash` 是独立扩展模块（订阅 launch 输出），规则库可独立迭代 | 规则会频繁变，不能塞进 log/launch 发版 | §6.13 |
| **ADR-015** | 测试分层 L1–L6 + conformance kit；**所有命令用 `npm.cmd`**，脚本冻结且通用 | 本机 `npm.ps1` 被 ExecutionPolicy 拦截；模块测试零网络零真实磁盘 | §11 |
| **ADR-016** | 依赖预算（非 npm workspace）：`package.json` 单点维护，模块不得自行 `npm install` | 单产物、单 lockfile、低构建复杂度；新依赖走合并窗口 | §4.9 |

### 0.2 模块地图（10 主线 + 2 扩展 + 内核内建 system）

| 模块 | 任务 owner | 独占写目录 | 依赖 | 对外服务 | P0 范围 |
|---|---|---|---|---|---|
| `log` | t6 | `dataRoot/modules/log/` | — | `LogService` | 查询/订阅/导出诊断包 |
| `store` | t5 | `dataRoot/modules/store/` | — | `StoreService` | 设置分区聚合、读写、打开数据目录 |
| `net` | t8 | `dataRoot/modules/net/` | — | `NetService` | HTTP 出口/源策略/UA/重试/熔断 |
| `download` | t8 | `dataRoot/modules/download/`、`dataRoot/tmp/` | net | `DownloadService` | 队列、并发、SHA1、断点、原子写 |
| `java` | t6 | `dataRoot/modules/java/`、`dataRoot/java/`（P1） | net, store | `JavaService` | 探测/选择（P0 不自动下载） |
| `auth` | t11 | `dataRoot/accounts.json`、`dataRoot/modules/auth/` | net, store | `AuthService` | 离线账户（P0-2）、设备码错误路径、Authlib 配置与注入信息、多账户 |
| `version` | t8 | `mcRoot/versions/<dir>/<dir>.json/.jar/-natives/`、`dataRoot/modules/version/` | net, download, store | `VersionService` | 清单/JSON/扁平化/原版 1.20.1 安装计划；不装加载器 |
| `instance` | t6 | `mcRoot/versions/<dir>/instance.json`、`dataRoot/trash/` | store, version, java | `InstanceService` | 扫描/识别 4 态/详情/设置/创建（安装时） |
| `mods` | t15 | 实例内 `mods/ resourcepacks/ shaderpacks/`（经 instance 授权） | instance, version, download | `ModsService` | 扫描/启停/冲突/拖入安装/选择文件安装/整合包导入/`modsetHash` |
| `launch` | t6 | `dataRoot/logs/game/<dirName>/`、`dataRoot/logs/launch-last.*`、实例 `LatestLaunch.bat` | java, version, auth, download, instance, store | `LaunchService` | plan/dry-run/start/stop/status/输出 |
| **扩展** `link` | t9 | `dataRoot/modules/link/`（房间状态必须按 dataRoot 隔离，双开不串） | instance, launch, net | `LinkService` | LAN 房间/邀请码/端口发现/一键进服；隧道可选 |
| **扩展** `crash` | t6 | `dataRoot/modules/crash/` | log, launch, mods | `CrashService` | 5 类高频规则 + 可复制报告 |
| **内建** `system` | t5（内核） | — | — | —（内核直接注册） | 版本/根路径/模块状态/许可证信息 |

> `system` 不是模块，是内核注册的只读契约（`src/shared/system.ts` + `src/main/kernel/system.ts`），让 UI 能展示"哪个模块不可用"与法务信息（GPL 源码链接、免责声明），而不必新增模块目录。

### 0.3 关键数字（实现/验收共同口径）

- 冷启动到可交互 ≤ 2 s（01 R0.1）；模块 `register` 单次 ≤ 100 ms，重活延迟到首次调用。
- 安装 1.20.1：client 23,028,853 B / 88 libs（64 Win 适用）/ 3,575 assets ≈ 700 MiB（01 A1.2–A1.5）。
- 下载并发默认 8（1–16），单主机 ≤ 4，单请求超时 10 s，每源重试 3 次。
- IPC 高频事件节流 100 ms；日志环形缓冲 2,000 条。
- `pack` 产物：`release/win-unpacked/mc-launcher.exe`（01 Q6）。

---

## 1. 背景、约束与选型输入

### 1.1 本机实测事实（决定选型，不是偏好）

| 事实 | 值 | 影响 |
|---|---|---|
| Node / npm | v24.20.0 / 11.19.0 | Electron 之外的工具链可用；但**运行期是 Electron 内置 Node**，不是主机 Node |
| .NET SDK | **不存在**（仅 6.0/7.0 runtime） | WPF/C# 需要先装 SDK（管理员/网络/时间），且 .NET 8 已进入 EOL 窗口（2026-11） |
| 便携 JDK | `tools\jdk21\jdk-21.0.12.1+1` | 仅用于**探测/启动游戏**，不用于构建启动器 |
| `npm.ps1` | 被 ExecutionPolicy `Restricted` 拦截 | 所有脚本/验收命令必须 `npm.cmd run ...` |
| 网络 | `piston-meta` 超时；`launchermeta`/`piston-data`/`libraries`/`resources`/BMCLAPI 可用 | 下载源必须可切换/回退；默认 BMCLAPI → 官方 |
| 实例现实 | 15 个实例、12 个有效 JSON 全部扁平、3 个缺 JSON；单实例最大 10.8 GB/311 mods | 扫描性能、异常态、扁平化、中文路径是 P0 设计输入 |
| 参考产品 | PCL 2.14.0.0 快照（`E:\MC\PCL`），非开源 | clean-room：只做黑盒行为与目录级观察（02 LIC-01~10） |

### 1.2 需求/合规/设计输入如何进入架构

- **01**：P0-0~P0-8 的验收断言 → §12.1 traceability；`--data-dir/--mc-dir`、无单实例锁、dry-run、LAN 房间、设备码错误路径、不装加载器、CF 不接 API，均落到模块边界。
- **02**：SEC-APP/AUTH/DL/EXE/NET/LOG/SUP、SRC、API、MC、NET、LIC → §3/§6/§7/§9/§10/§11 的硬约束（文中以 `02 SEC-*` 标注）。
- **design**：色板/字阶/组件/页面/启动与下载状态机/错误文案 → renderer 目录、`tokens.css`、`features` 自注册、事件契约（`mc:launch:evt:*` 等）、错误码表（§9.3）。
- **40 研究稿**：模块接口、IPC、错误/日志/测试的初稿；本文修正其与 01 v1.2 冲突的部分（§13.4）。

---

## 2. ADR-001：技术选型

### 2.1 候选与硬约束

| 候选 | 构建前提 | 本机可行性 | 交付形态 | 主要代价 |
|---|---|---|---|---|
| **A. Electron 44 + TS + React 19 + Vite 8** | Node/npm（已有） | ✅ 立即可开工 | 单 exe/目录，~100–150 MB | 内存/体积大；Electron 安全面需要纪律 |
| B. 自装 .NET 8 SDK + WPF | 需下载安装 SDK（~200 MB+），管理员权限；.NET 8 于 2026-11 EOL | ❌ 当前不可构建，需先改环境 | 原生 Windows，体积小 | SDK 获取/EOL/跨团队 UI 效率；与现有 01/02/design 的 Web 设计资产不匹配 |
| C. Tauri 2 + WebView2 | 需 Rust toolchain + MSVC Build Tools + WebView2 运行时 | ❌ 需先装 Rust/MSVC | 体积最小 | 新增 Rust 学习/构建/签名链；插件生态与 MC 进程管理需自写；CI 复杂 |
| D. 纯 Web + 本地服务 | 浏览器 + 后台进程 | ⚠️ 可行但体验差 | 需另装服务 | 无原生窗口/文件对话框/单机体验；不符合桌面启动器定位 |

### 2.2 加权决策（权重和为 100）

| 维度 | 权重 | A Electron | B .NET/WPF | C Tauri |
|---|---|---|---|---|
| 本机可立即构建 | 25 | 10 | 2 | 2 |
| 并行开发/模块化 | 20 | 9 | 7 | 6 |
| UI 交付速度（design 已给 Web 规范） | 15 | 10 | 6 | 9 |
| 进程/文件/Java 集成 | 15 | 9 | 9 | 8 |
| 体积/内存 | 10 | 4 | 9 | 9 |
| 安全可控性（沙箱/权限模型） | 10 | 7 | 6 | 7 |
| 长期维护/生态 | 5 | 8 | 6 | 6 |
| **加权总分** | 100 | **8.35** | **5.85** | **5.75** |

### 2.3 决策与后果

**采用 A。** 理由不是"Electron 更好"，而是**在本机与当前团队结构下，只有 A 能当天开工且与 design/01/02 的资产直接对齐**。

**接受的代价**：

1. 安装包 ~100–150 MB、空闲内存 ~200–300 MB（01 §7.7 目标 ≤300 MiB，不作硬门禁）。
2. 必须严格执行 02 SEC-APP 的 Electron 加固；任何 `webPreferences` 改动都要 ADR。
3. 运行期 Node ≠ 主机 Node 24：首行日志打 `process.versions`；禁止依赖主机新 API（40 R-4）。

**回退触发条件（写死，避免以后争论）**：

- 若 Electron 在目标 Windows 版本上无法启动/被杀软系统性拦截，且两周内无法通过签名/白名单解决 → 复评 B（但 .NET 8 EOL 需先选 .NET 9/10）。
- 若安装包体积成为硬性渠道限制（<30 MB）→ 复评 C，但需先补齐 Rust 构建链与 2 周学习成本。
- 除上述两种情况外，不在本轮讨论换栈。

### 2.4 版本锁定（2026-10-21 `npm view` 实测）

| 包 | 版本 | 说明 |
|---|---|---|
| electron | **44.9.3** | 锁定 minor；随 Chromium 安全更新升级（02 SEC-APP-10） |
| electron-vite | **6.0.0** | 三段式构建（main/preload/renderer） |
| vite | **8.3.4** | 若 electron-vite 6 的 peer 范围不兼容 Vite 8，回退 Vite 7 并在 PR 记录（不改架构） |
| react / react-dom | **19.3.1** | 只用函数组件 + hooks；不引入状态库（React Query 可选，见 §4.9 依赖预算） |
| typescript | **7.0.2** | 若 `tsc -b` 与 Electron 44 typings 不兼容，回退 5.9.x 并在 PR 记录 |
| vitest | **5.0.5** | 单测/契约/集成 |
| @playwright/test | **1.64.1** | `_electron` E2E |
| electron-builder | **26.15.3** | `--dir` + NSIS（P1） |
| zod | **4.6.7** | 契约/配置校验 |
| p-queue / fast-glob / semver / yauzl | 10.0.0 / 3.3.3 / 7.8.5 / 3.4.0 | 队列/扫描/版本比较/zip 读取 |

> 版本以 `package.json` 冻结为准；升级走"依赖申请 + 回归"（§4.9）。

---

## 3. 进程模型与安全边界

### 3.1 三层与信任边界

```
┌──────────────────────────────────────────────────────────────────────┐
│ main（Node，唯一可信边界）                                            │
│  src/main/index.ts 🔒   启动序列（§附录 B）                            │
│  src/main/kernel/ 🔒    日志/配置/路径/端口/服务/生命周期/安全/系统契约  │
│  src/main/modules/<name>/  每个模块独占，自注册（§4）                  │
│  持有：fs、child_process、net、safeStorage、dialog、shell             │
└───────────────▲──────────────────────────────────────────────────────┘
                │ ipcMain.handle('mc:<module>:<method>')   │ webContents.send
                │ zod 校验 → handler → Result 信封         │ 事件（可节流）
┌───────────────┴──────────────────────────────────────────────────────┐
│ preload（sandbox，无 Node 直接暴露）                                   │
│  src/preload/index.ts 🔒  contextBridge.exposeInMainWorld('mc', {...}) │
│  src/preload/contracts.ts 🔒  从 src/shared/*.ts glob + 品牌过滤        │
└───────────────▲──────────────────────────────────────────────────────┘
                │ window.mc.invoke(channel, payload)
┌───────────────┴──────────────────────────────────────────────────────┐
│ renderer（React 19，无 Node、无 remote、CSP 收紧）                     │
│  src/renderer/app/** 🔒  壳/路由/主题/错误边界                         │
│  src/renderer/features/<name>/**  模块 UI，自注册（§4.8）              │
│  src/renderer/lib/ipc.ts 🔒  类型化客户端 api.instance.list()          │
└──────────────────────────────────────────────────────────────────────┘
```

**硬边界**：

- renderer **不得** `import 'fs' | 'child_process' | 'electron'`；所有文件/进程/网络操作走 IPC（01 R0.8）。
- preload **不得** import `@main/*`（02 SEC-APP-06）；只暴露白名单通道 + 只读 `meta`。
- main 之外的进程**不得**读取令牌文件、不得创建子进程。
- 模块 `service.ts` **不得** import `electron`（架构规则 R3），只能通过 `ctx.ports`。

### 3.2 BrowserWindow 安全配置（冻结，改动需 ADR）

```ts
new BrowserWindow({
  width: 1280, height: 800, minWidth: 1024, minHeight: 700,
  frame: false,                       // 自绘 40px 标题栏（design §1.1）
  backgroundColor: nativeTheme.shouldUseDarkColors ? '#0F1316' : '#F4F6F8',
  show: false,
  webPreferences: {
    preload: path.join(__dirname, '../preload/index.js'),
    contextIsolation: true,      // 默认值，但显式写明
    sandbox: true,               // preload 只能用受限 API；必须打包成 CJS 单文件
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    allowRunningInsecureContent: false,
    webSecurity: true,
    spellcheck: false,
  },
})
```

> 窗口默认 1280×800，最小 1024×700（design §2.4）。在 800×600 屏幕上仍必须能启动（01 §7.1 的下限），布局退化为单列滚动，不得崩溃或白屏。

配套（02 SEC-APP-01~12）：

| 项 | 实现 |
|---|---|
| 生产加载 | 自定义协议 `app://mc-launcher/`；`protocol.handle` 只读应用目录 + 路径规范化；开发用 `http://localhost:5173` 且仅 dev |
| CSP | `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://cdn.modrinth.com https://*.mojang.com https://*.minecraft.net https://textures.minecraft.net; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'` |
| 导航/开窗 | `will-navigate` 只放行应用来源；`setWindowOpenHandler` 一律 deny；外链 `shell.openExternal` 仅 `https:` + 主机白名单 |
| 权限 | `setPermissionRequestHandler` 默认全拒；只按需开剪贴板写 |
| 单实例 | **P0 不启用全局单实例锁**（01 §5.0：P0-6 需要双开）；P1 再加 `--single-instance` 可选锁 |
| 调试 | 生产禁用 devtools 自动打开；不暴露 `--remote-debugging-port` |
| 更新 | P0 不做自动更新；P1 必须签名 + 回滚（02 SEC-APP-08/09） |

### 3.3 路径与子进程

- 所有 renderer 传入的路径：`ctx.paths.assertInside(root, p)`（`path.resolve` + `path.relative` 前缀判断，不用字符串 `startsWith`）。
- 子进程：`spawn(exe, argsArray, { shell: false, cwd, env, windowsHide: true })`；禁止命令行字符串拼接。
- 启动 Java 前清洗会注入 agent/classpath 的环境变量：`JAVA_TOOL_OPTIONS`、`_JAVA_OPTIONS`、`JDK_JAVA_OPTIONS`、`CLASSPATH`（02 §8 末条）。
- **游戏进程 env 是发送给 Java 的显式白名单**（白名单+黑名单双防）：仅传递 `PATH`/`Path`/`PATHEXT`、`SystemDrive`/`SystemRoot`/`windir`、`ProgramData`/`ProgramFiles`/`ProgramFiles(x86)`/`CommonProgramFiles`/`CommonProgramFiles(x86)`/`PUBLIC`、`APPDATA`/`LOCALAPPDATA`/`USERPROFILE`/`HOMEDRIVE`/`HOMEPATH`、`USERNAME`/`USERDOMAIN`/`COMPUTERNAME`/`LOGONSERVER`/`SESSIONNAME`、`NUMBER_OF_PROCESSORS`/`PROCESSOR_ARCHITECTURE`/`PROCESSOR_IDENTIFIER`/`PROCESSOR_LEVEL`/`PROCESSOR_REVISION`、`TEMP`/`TMP`、`OS`、`LANG`/`LC_ALL`/`TZ`。任何 `MCL_*`、`*_OPTIONS`、`CLASSPATH` 永不传递；`LaunchPlan.env` 也只含该白名单。
- 解压：条目数 ≤ 20k、单条目 ≤ 512 MiB、总解压 ≤ 8 GiB，拒绝 `..`/绝对路径/盘符/ADS/保留名/软链接（02 SEC-DL-08）。

---

## 4. 模块系统：并行开发契约（ADR-003）

### 4.1 目录约定（写死）

```
src/
├── main/
│   ├── index.ts                    🔒 启动序列（≤120 行）
│   ├── kernel/                     🔒 内核服务（日志/配置/路径/IPC/端口/系统契约）
│   └── modules/
│       ├── _registry.ts            🔒 glob 注册表（≤30 行）
│       └── <name>/
│           ├── index.ts            # 只装配：导出 moduleId/dependsOn/register
│           ├── service.ts          # 业务；禁止 import electron
│           ├── handlers.ts         # 契约方法 → service（可并入 index）
│           └── __tests__/
├── preload/
│   ├── index.ts                    🔒 contextBridge 桥
│   └── contracts.ts                🔒 契约 glob + 品牌过滤
├── renderer/
│   ├── app/                        🔒 壳/路由/主题/错误边界/features 聚合
│   ├── lib/ipc.ts                  🔒 类型化客户端
│   ├── ui/                         无业务组件（t10）
│   └── features/<name>/            # 模块 UI（index.tsx 默认导出 RendererFeature）
└── shared/
    ├── kernel.ts                   🔒 ModuleContext/defineContract/Result
    ├── errors.ts                   🔒 ERROR_CODES/AppError
    ├── system.ts                   🔒 内核内建契约
    └── <name>.ts                   # 模块契约（只允许该模块所有者改）
```

**所有权**：

- 模块所有者**只能写**：`src/main/modules/<name>/**`、`src/shared/<name>.ts`、`src/renderer/features/<name>/**`、`src/main/modules/<name>/__tests__/**`。
- **不许写**：`package.json`、锁文件、`src/main/index.ts`、`kernel/**`、`_registry.ts`、`preload/**`、`renderer/app/**`、`renderer/lib/**`、`shared/kernel.ts`、`shared/errors.ts`、其它模块目录。
- `src/shared/<name>.ts` 里**只能**定义本模块的契约/类型/服务接口；跨模块只能用 `import type` 读服务接口（运行时 import 由 arch 规则拒绝）。

### 4.2 模块入口（必须长这样）

```ts
// src/main/modules/instance/index.ts
import type { ModuleContext, ModuleRegistration } from '@shared/kernel'
import { contract } from '@shared/instance'
import { createInstanceService } from './service'
import { makeHandlers } from './handlers'

export const moduleId = 'instance'
export const dependsOn = ['store', 'version', 'java'] as const

/** 只做装配；≤100ms；重活延迟到首次调用 */
export async function register(ctx: ModuleContext): Promise<ModuleRegistration> {
  const service = createInstanceService(ctx)
  ctx.ipc.handle(contract, makeHandlers(service))
  ctx.log.info('module registered', { deps: dependsOn })
  return { service, dispose: () => service.close() }
}
```

**规则**：

1. 必须导出 `moduleId: string`、`register(ctx)`；可选 `dependsOn: readonly string[]`、`dispose`。
2. `moduleId` 必须等于目录名、等于 `contract.id`（conformance 断言）。
3. `register` 内只允许：建 service、`ctx.ipc.handle`、轻量读取；**不得**下载/启动进程/扫描大目录。
4. 模块顶层只允许 `const` 声明与 `export`（无副作用；arch 规则 R7）。
5. 模块**不得** import 其它模块的实现文件；跨模块只通过 `ctx.services.get<T>('id')`。
6. 模块删除后应用必须仍能启动（UI 显示该功能不可用）——这是并行开发的回归项。

### 4.3 注册表（冻结）

```ts
// src/main/modules/_registry.ts                    🔒
import type { ModuleNamespace } from '@shared/kernel'

// 必需模块：eager，构建期固定；排除可选模块（link/crash）
const REQUIRED = import.meta.glob<ModuleNamespace>(
  ['./*/index.ts', '!./link/index.ts', '!./crash/index.ts'],
  { eager: true },
)

// 可选模块：lazy，导入失败可在运行期捕获（联机/崩溃分析不得拖垮主链路）
const OPTIONAL = import.meta.glob<ModuleNamespace>(['./link/index.ts', './crash/index.ts'])

export interface ModuleEntry { readonly path: string; readonly ns: ModuleNamespace }

export const REQUIRED_ENTRIES: readonly ModuleEntry[] = Object.freeze(
  Object.entries(REQUIRED)
    .map(([path, ns]) => ({ path, ns }))
    .sort((a, b) => a.path.localeCompare(b.path)),  // 确定性顺序
)

export async function loadOptionalEntries(): Promise<{
  entries: ModuleEntry[]
  failed: Array<{ path: string; error: unknown }>
}> {
  const entries: ModuleEntry[] = []
  const failed: Array<{ path: string; error: unknown }> = []
  for (const [path, load] of Object.entries(OPTIONAL).sort(([a], [b]) => a.localeCompare(b))) {
    try { entries.push({ path, ns: await load() }) }
    catch (error) { failed.push({ path, error }) }   // 记日志，不崩溃
  }
  return { entries, failed }
}
```

**为什么这样分层（ADR-003 取舍）**：

- **必需模块 eager**：构建期固定清单，导入期错误在 CI/build 直接暴露，不会带病发到用户机器；收益（几十毫秒）不值得换动态 chunk 风险。
- **可选模块（`link`/`crash`）lazy**：它们本来就是"可整个关掉"的扩展（ADR-013/014）；lazy 让**导入失败**也能被捕获，符合"模块缺失/加载失败不崩溃"的硬要求。
- **注册失败**：所有模块的 `register` 都在 try/catch 内（§4.5），失败只标记该模块不可用。
- **缺失**：目录不存在时 glob 自然没有条目，UI 显示"功能未安装"，不是错误。
- 若 t5 实测 electron-vite 6 的 main 产物不兼容动态 chunk，可把 `link/crash` 改回 eager 并保留 register 级容错（写 ADR 记录；不影响本文契约）。

### 4.4 ModuleContext（模块唯一可依赖的内核面）

```ts
// src/shared/kernel.ts（摘录，完整见 §12.1）
export interface ModuleContext {
  readonly id: string
  readonly log: Logger
  readonly config: ConfigApi
  readonly ipc: IpcRegistrar
  readonly errors: ErrorFactory
  readonly paths: ModulePaths
  readonly ports: Ports
  readonly services: ServiceLocator
  readonly events: EventBus
  readonly settings: SettingsRegistrar   // 向设置页注册分区（store 聚合）
  readonly signal: AbortSignal           // 应用退出/模块卸载
}
```

- `log`：绑定模块前缀，支持 `trace/debug/info/warn/error/fatal`。
- `config`：`ctx.config(schema, defaults)` → `ConfigHandle<T>`（`get/set/onChange`），落 `dataRoot/modules/<id>/config.json`。
- `ipc`：`handle(contract, handlers)`、`emit(event, payload)`；通道名由内核生成，模块不手写字符串。
- `errors`：`errors.make(code, details?)` / `errors.is(e, code)`；code 必须在 `ERROR_CODES`。
- `paths`：`own`（独占可写）、`dataRoot`、`mcRoot`、`logs`、`cache`、`tmp`、`versions`、`libraries`、`assets`、`trash`、`assertInside`（只读视图）。
- `ports`：`fs`、`http`、`proc`、`clock`、`ids`、`dialogs`、`shell`（测试注入内存实现）。
- `services`：`get<T>(id)`；只能取 `dependsOn` 中的模块。
- `settings`：`register({ id, title, schema, order })`，供 `store` 聚合到设置页。

### 4.5 启动、拓扑与故障容忍

```ts
// src/main/index.ts（伪代码，≤120 行）
const disabled = new Set(flags.disableModules)
const optional = await loadOptionalEntries()                 // 可选模块导入失败已捕获
const failed: ModuleFailure[] = optional.failed.map((f) => ({ id: f.path, code: 'KERNEL.MODULE_FAILED', error: f.error }))

const defs = [...REQUIRED_ENTRIES, ...optional.entries]
  .map(({ path, ns }) => ({ path, ns, id: ns.moduleId, deps: ns.dependsOn ?? [] }))
  .filter((d) => !disabled.has(d.id))
assertUniqueIds(defs)                         // 重复 id → 启动失败（KERNEL.DUPLICATE_MODULE）
const order = topoSort(defs)                  // 环 → KERNEL.DEPENDENCY_CYCLE + 打印环路径

const active = new Set<string>()
for (const d of order) {
  const missing = d.deps.filter((x) => !active.has(x))
  if (missing.length) { failed.push({ id: d.id, code: 'KERNEL.DEPENDENCY_MISSING', missing }); continue }
  try {
    const reg = await d.ns.register(ctxFor(d))
    active.add(d.id)
    services.set(d.id, reg.service)
    disposeFns.push(reg.dispose)
  } catch (err) {
    failed.push({ id: d.id, code: 'KERNEL.MODULE_FAILED', error: toAppError(err) })
    log.module(d.id).error('register failed', err)   // 不崩溃
  }
}
```

- **缺失**：目录不存在 → glob 无条目；UI 显示"功能未安装"而不是错误。
- **加载失败**：可选模块（link/crash）导入失败 → 记 `KERNEL.MODULE_FAILED`，主链路照常；必需模块导入失败由构建门禁拦截（fail fast，避免带病发布）。
- **激活失败**：`register` 抛错 → 记 `failed`，依赖它的模块标记 `KERNEL.DEPENDENCY_MISSING`，应用继续；`system.status` 事件推给 UI，页面显示可关闭 Banner（design §7.4）。
- **启动顺序**：`log → store → net → download → java → auth → version → instance → mods → launch → crash → link`（拓扑排序的确定性结果）。
- **安全模式**：`--safe-mode` 只激活 `log/store/net/system`，用于排障；`--disable-modules=link,crash` 可单独关。

### 4.6 渲染层自注册（design §7.1 对齐）

```tsx
// src/renderer/features/instance/index.tsx
import type { RendererFeature } from '@renderer/app/features'

export default {
  id: 'instance',
  nav: { label: '实例', to: '/instances', order: 20, icon: 'cube' },
  routes: [
    { path: '/instances', element: () => import('./InstanceListPage') },
    { path: '/instances/:id', element: () => import('./InstanceDetailPage') },
  ],
} satisfies RendererFeature
```

- `src/renderer/app/features.ts` 🔒 用 `import.meta.glob('../features/*/index.tsx', { eager: true, import: 'default' })` 聚合，按 `order` 排序。
- 路由/导航/设置分区都由 feature 声明；`App.tsx` 永不因新增模块而改。
- 设计稿的页面路由（`/home`、`/instances`、`/download`、`/link`、`/logs`、`/settings`、`/about`）由各 feature 提供；壳只负责布局与 404。

### 4.7 架构规则（`npm.cmd run arch`，违反即红，无豁免）

| 规则 | 内容 |
|---|---|
| R1 | 模块之间禁止运行时 import（`modules/a` → `modules/b`） |
| R2 | 模块只可 import `@shared/kernel`、`@shared/errors`（核心契约）与自己的 `@shared/<name>`；**不得** import 其它模块的 shared（跨模块服务接口只允许 `import type`） |
| R3 | `electron` 只允许出现在 `main/index.ts`、`kernel/**`、模块的 `index.ts`/`handlers.ts`；`service.ts` 禁止 |
| R4 | 模块不得读写 `paths` 之外的目录；不得直读 `process.env`（走 `ctx.config`） |
| R5 | `src/shared/*.ts` 零副作用，不得 import `electron`/`node:*`（zod 除外） |
| R6 | `src/preload/**` 不得 import `@main/*` 或 `@renderer/*` |
| R7 | 模块顶层只允许 `const` 声明与 `export` |
| R8 | 每个 `contract.methods` 必须有同名 handler，反之亦然（conformance 兜底） |
| R9 | **禁止写入 `versions/<名>/PCL/**`**；PCL 配置只读（LIC-05） |
| R10 | 配置/`instance.json` 中的路径必须是相对 `mcRoot`（`paths.minecraftRoot` 是唯一允许的绝对路径例外，见 §8.2） |

### 4.8 新模块流程

```powershell
npm.cmd run new:module <name>
# 创建：modules/<name>/{index,service,handlers}.ts + __tests__/conformance.test.ts
#       shared/<name>.ts（hello 契约骨架）
#       renderer/features/<name>/index.tsx（空面板）
# 不修改任何冻结文件；`npm.cmd run dev` 立即看到空面板，`npm.cmd run test` 跑通 conformance
```

### 4.9 依赖预算（ADR-016）

- 模块开发者**不得**执行 `npm install`，不得改 `package.json`/lockfile。
- 已批准依赖集：zod、p-queue、fast-glob、semver、yauzl；React 侧只用 React + design 需要的工具（不引 icon 库，图标内联 SVG）。
- **ESM-only 风险**：`p-queue@10` 是 ESM-only；electron-vite 默认 externalize 依赖时可能 `require` 失败。t5 首日必须验证：能打包进 main bundle 就用，否则**自写队列（≤80 行，含并发/暂停/取消）**，不因此改架构。
- React Query **未批准**：P0 用 `useState/useEffect` + 小型 `useAsync` 即可；若 t10 证明需要缓存/失效，走依赖申请（体积/许可证/替代方案）。
- 新依赖 → "依赖申请"（用途/体积/许可证/内置替代）→ 每轮合并窗口统一落地；依赖变更单独 PR，只改 `package.json`+lockfile。
- 许可证必须 GPL-3.0 兼容（02 LIC-11/SEC-SUP-01）；禁止 GPL-2.0-only/CDDL/专有/SSPL/BSL。

---

## 5. 类型化 IPC（ADR-004）

### 5.1 契约单源

`src/shared/<name>.ts` 同时提供：**类型 + zod schema + 通道 + 客户端签名**。没有代码生成步骤（生成器会带来"忘了跑"的失败模式）。

```ts
// src/shared/instance.ts（节选）
import { z } from 'zod'
import { defineContract } from './kernel'

export const InstanceState = z.enum(['ready', 'missing-json', 'corrupt-json', 'missing-jar', 'unsupported'])
export const InstanceSummary = z.object({
  id: z.string(),
  dirName: z.string(),
  name: z.string(),
  mcVersion: z.string().nullable(),
  loader: z.object({ type: z.enum(['vanilla', 'fabric', 'forge', 'neoforge', 'quilt', 'unknown']), version: z.string().nullable() }),
  state: InstanceState,
  lastPlayedAt: z.number().int().nullable(),
  icon: z.string().nullable(),
})
export type InstanceSummary = z.infer<typeof InstanceSummary>

export const contract = defineContract({
  id: 'instance',
  methods: {
    list:   { input: z.void(), output: z.array(InstanceSummary) },
    get:    { input: z.object({ id: z.string() }), output: InstanceSummary },
    update: { input: z.object({ id: z.string(), patch: z.record(z.string(), z.unknown()) }), output: InstanceSummary },
  },
  events: {
    changed: { payload: z.object({ instanceId: z.string().nullable() }) },
  },
})
```

**契约四约束（conformance 断言）**：

1. `contract.id` 全小写 kebab，且等于模块 id 与目录名；
2. 每个 method 显式 `input`（无参用 `z.void()`）；
3. 每个 method 必须声明 `output`（不允许 `void` 黑洞）；
4. 事件 payload 必须可 `structuredClone`（无 class/Date/Map）。
5. 没有事件的模块传 `events: {}`（不要省略字段）。

### 5.2 通道命名与信封

```
调用：mc:<moduleId>:<method>          例 mc:instance:get
事件：mc:<moduleId>:evt:<event>       例 mc:instance:evt:changed
```

```ts
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape }
```

- **永不跨 IPC 抛异常**：Electron 会把 Error 序列化成字符串并丢掉 code/stack；信封让 UI 按 `code` 分诊。
- `Result` 只出现在 `api.$raw.*`；普通 `api.*` 在 renderer 客户端重建 `AppError` 并抛出（§5.6）。

### 5.3 注册、校验与发送方校验

内核 `registerIpc(def)` 对每个 method：

1. `assertTrustedSender(event)`：`event.senderFrame?.url` 必须是 `app://mc-launcher/`（生产）或 `http://localhost:5173/`（开发），否则 `IPC.UNTRUSTED_SENDER`。
2. `m.input.parse(raw)`：zod 权威校验；失败 → `IPC.INVALID_INPUT`（含字段路径，不含原始值）。
3. `handlers[method](ctx, input)`：可抛 `AppError`。
4. 开发期 `m.output.parse(out)` 自检。
5. 成功 `{ ok: true, data }`；失败 `{ ok: false, error: toAppError(err).toShape() }`，日志含 `traceId`。

### 5.4 事件、节流与背压

- 契约事件可声明 `throttleMs`（默认 0；高频必须声明）：下载进度 100、日志 100、启动输出 100。
- 节流 key 由内核按事件 payload 的 `key` 字段（如 `taskId`/`sessionId`）合并，避免多任务互相覆盖。
- 事件只是**提示**，不是状态源：UI 收到 `changed` 后重新 `list()`；窗口重载/丢事件也能恢复。
- `webContents` 销毁后内核清理订阅，避免向已关闭窗口发送。

### 5.5 preload 桥（冻结）

```ts
// src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron'
import { contracts } from './contracts'

const allowed = new Set<string>()
for (const c of contracts) {
  for (const m of Object.keys(c.methods)) allowed.add(`mc:${c.id}:${m}`)
  for (const e of Object.keys(c.events)) allowed.add(`mc:${c.id}:evt:${e}`)
}

const bridge = Object.freeze({
  meta: Object.freeze({ platform: process.platform, versions: process.versions }),
  invoke(channel: string, payload?: unknown) {
    if (!allowed.has(channel)) return Promise.reject(new Error(`blocked channel: ${channel}`))
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel: string, cb: (payload: unknown) => void) {
    if (!allowed.has(channel)) throw new Error(`blocked channel: ${channel}`)
    const h = (_e: unknown, p: unknown) => cb(p)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)
  },
})
contextBridge.exposeInMainWorld('mc', bridge)
```

### 5.6 renderer 客户端（冻结）

```ts
// 用法：api.instance.list() → Promise<InstanceSummary[]>；失败抛 AppError
export const api = createClient(contracts, window.mc)
export const onEvent = makeEventSubscriber(window.mc)

// 需要逐码分诊时：const r = await api.$raw.instance.get({ id }); if (!r.ok) ...
```

- `createClient` 在 `ok:false` 时 `throw new AppError(shape)`；UI 用 `error.code/userMessage/retryable`（design §7.4）。
- `api.$raw.*` 返回信封，给需要"错误即数据"的场景（如批量下载逐任务失败）。
- 客户端方法名由契约自动生成；不手写通道字符串。

### 5.7 契约如何被三层找到

- `src/shared/*.ts` 里还有 `kernel.ts`/`errors.ts`/`system.ts`，不能靠文件名挑契约。
- 用 `defineContract` 打的**品牌**（`Symbol.for('mc.contract')`）过滤：

```ts
// src/preload/contracts.ts（renderer/lib/ipc.ts 复用同一聚合函数）
const files = import.meta.glob<Record<string, unknown>>('../shared/*.ts', { eager: true })
export const contracts = Object.freeze(
  Object.values(files).flatMap((m) => Object.values(m)).filter(isContract),
)
```

- 同一 id 出现两次 → 启动失败 `KERNEL.DUPLICATE_CONTRACT`。
- zod 会随契约进 preload 包（几十 KB）；预算 ≤200 KB，超了再改"构建期生成通道清单"（当前不值得）。

### 5.8 兼容规则

- **只加不改**：新增 method/event 可以；改字段名/删除字段必须同步改 renderer 与 `contract`，并升 `contractVersion`（可选字段）。
- 契约文件是模块的公共 API；reviewer 按 02 LIC/错误码规则审查。
- 主进程不认识 renderer 的 DOM；renderer 不推断业务状态（启动按钮状态只来自 `launch.status`/事件，design §4.1）。

---

## 6. 模块规格

> 通用：`service.ts` 禁止 import electron；所有写盘落在 `ctx.paths.own` 或下表声明的共用目录；必须通过 conformance；长任务（>500ms）必须支持取消 + 进度事件。

### 6.1 `instance` — 实例与目录

- **职责**：扫描 `mcRoot/versions/*/`，识别 4 态（`ready`/`missing-json`/`corrupt-json`/`missing-jar`），读写 `instance.json`，解析 gameDir（`isolated`=`versions/<dir>/`；`shared`=`mcRoot/`），提供实例设置。
- **P0**：列表/详情/设置更新/创建（由 version 安装或 mods 导入调用）；**不做**删除/重命名/多 MC 目录（01 明确不要求）。
- **实例设置**：`java`、`memory` + `memoryMode`、`window`（宽/高/全屏）、`isolation`、`jvmArgs`、`autoJoin`；`memoryMode=auto` 时生效内存 = `clamp(物理内存×25%, 2048, 8192)`（01 R4.1），`custom` 时才使用 `memory` 区间。
- **P0 不读取** `PCL/Setup.ini`、`PCL/config.json`、`launcher_profiles.json`（01 R0.6）；PCL 只读导入是 P1（02 LIC-05）。
- **识别顺序**：目录存在 → `<dirName>.json` 存在且可解析 → `id` 匹配 → `jar` 存在；任一失败映射状态与 `reason`（不抛异常）。
- **性能**：只读 stat + JSON；15 实例 ≤500ms（热）；>200 行 UI 虚拟化（design §7.5）。
- **API**：`list/get/create/update/markPlayed/scan`；事件 `changed`。
- **测试**：15 实例夹具、3 个异常态、中文/全角路径、只读 PCL 目录（mtime/SHA 不变）。

### 6.2 `version` — 元数据、扁平化、安装计划

- **数据源**：`https://launchermeta.mojang.com/mc/game/version_manifest_v2.json`（主）/ `https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json`（镜像）；清单缓存 10 min（01 R1.1）。
- **安装计划**：manifest → version JSON → libraries（按 `rules` 过滤 Windows）→ assets index → objects → client jar → logging config。产出 `DownloadTask[]` 交给 `download`。
- **扁平化（ADR-007）**：安装/导入时展开 `inheritsFrom`：
  1. 沿链自底向上，子覆盖父；
  2. `libraries` 按 `group:artifact` 后写覆盖，保留顺序；
  3. `arguments.game/jvm` 与 legacy `minecraftArguments` 二选一；
  4. 输出**不含 `inheritsFrom`**，写 `x-mc-launcher: { flattenedAt, flattenedFrom }`；
  5. 循环/父缺失 → `VERSION_PARENT_NOT_FOUND` / `VERSION.INHERIT_CYCLE`，不写半成品。
- **P0 范围**：原版 1.20.1 安装；可解析/启动已有 Forge/Fabric 版本（只读）；**不安装加载器**（01 Q2，P1）。
- **API**：`manifest/listVersions/installVanilla/ensureFlattened/inspect`；事件 `install:progress`（复用 download）/`install:done`。
- **测试**：1.20.1 精确值（88 libs/assetIndex 5/mainClass）、继承夹具、幂等（连续展开字节一致）。

### 6.3 `download` — 队列、校验、断点

- **输入**：`DownloadTask { url, destRel, sha1|sha256, size, priority, sourceHint }`（相对 `mcRoot`，禁止绝对路径）；Modrinth 文件另带 `sha512`（02 API-03），有 sha512 时优先校验它。
- **并发**：默认 8（1–16），单主机 ≤4；`p-queue`；按任务 id 聚合进度（100ms）。
- **落盘**：`dest.part` → 哈希 → `rename`；失败删 `.part`；取消立即停新请求并清理；启动时清理 `tmp/` 下超过 24h 的 `.part` 与解压临时目录（保留用于续传的新文件）。
- **断点**：服务器 `Accept-Ranges: bytes` 且 `.part` 存在时用 Range；完成后整体校验；`200` 回退单连接。
- **源策略**：`net` 决定 URL；默认 BMCLAPI → 官方；连续失败 3 次熔断该源；全失败 `DOWNLOAD.NO_SOURCE`（列出失败 URL）。
- **锁**：同一 `dest` 只允许一个任务（内存锁 + `tmp/<sha1>.lock`，10 min 过期），双开共享 `mcRoot` 时不互相写坏。
- **API**：`enqueue/cancel/pause/resume/list/status`；事件 `progress/finished`。
- **测试**：本地 http 桩（206/断流/500/429/坏哈希/大文件），断言重试、续传、最终哈希。

### 6.4 `java` — 探测、选择、安装（P1 安装）

- **探测顺序**：实例覆盖 → `JAVA_HOME` → 内置 `dataRoot/java/`（P1）→ 注册表 `HKLM\SOFTWARE\JavaSoft\*` → 常见路径（`C:\Program Files\Java`、`Eclipse Adoptium`、`Zulu`、`tools/jdk21` 同级? 不写死本机路径）→ PATH。
- **验证**：`java -XshowSettings:properties -version`，超时 5 s，解析 `java.version/java.home/os.arch`；失败淘汰并记 `probe` 结果（坏 JDK 不能卡死启动器）。
- **选择**：优先版本 JSON `javaVersion.majorVersion`；缺省回退表（≥1.20.5→21，1.18–1.20.4→17，1.17→16，≤1.16.5→8）；实例可强制 major/path。
- **P0**：只探测/选择；不自动下载 JRE。
- **安全**：只执行用户选中/自动发现的 `java.exe`；启动 Java 时清洗注入类环境变量（§3.3）。
- **API**：`detect/choose/getCandidates`；事件 `detect:progress`（可选）。
- **测试**：假 `ProcessPort` 返回各种 `-version` 输出（中文乱码、stderr、损坏 JDK）。

### 6.5 `net` — HTTP 唯一出口

- **职责**：所有出站 HTTP/HTTPS 的 policy 层：UA、超时、重试、退避、源映射、熔断、代理、大小限制。
- **UA**：`mc-launcher/<version> (+<site/contact>)`；Modrinth 额外要求（02 API-01）由 `net` 统一注入；禁止各模块自拼。
- **超时/重试**：连接 10 s、总 60 s（下载流式例外）；429/5xx 指数退避 + jitter，尊重 `Retry-After`；每源 3 次。
- **源映射**：Mojang ↔ BMCLAPI 前缀表（02 SRC-07/12）；只允许 https；重定向 ≤3 跳且每跳校验主机白名单。
- **熔断**：连续失败 N=3 禁用源（会话级），事件/日志可读；不无限重试。
- **API**：`request/openStream/resolveUrl/listSources`；不暴露 fetch 原始实现。
- **测试**：注入 `HttpPort` 内存实现；L4 用本地 `http.createServer`。

### 6.6 `auth` — 账户三态与令牌

- **账户模型**：`Account { id, kind: 'offline'|'microsoft'|'authlib', name, uuid, ... }`；统一列表、切换不串号。
- **离线（P0-2）**：用户名 3–16 `[A-Za-z0-9_]`；UUID = `MD5("OfflinePlayer:"+name)` 的 v3 形式；`dataRoot/accounts.json` 只存 name/uuid（无 token）；启动参数 `--username --uuid --accessToken 0 --userType legacy`。
- **微软（P0-7 条件）**：设备码 flow（`consumers` 租户、public client、`XboxLive.signin offline_access`、PKCE）；未配置 client id → `MS_CLIENT_ID_MISSING`；403 → `MS_AUTH_NOT_APPROVED`；**禁止伪造成功**；真实登录 P1（02 §3.1.1 端点清单）。
- **令牌（02 SEC-AUTH）**：refresh token 仅 `safeStorage`（DPAPI）加密 → `dataRoot/modules/auth/sessions.bin`；access token/XSTS 只在内存；`basic_text` 拒绝持久化；退出登录清文件；日志/bat/报告零令牌。刷新：access 过期前 5 分钟**单飞**刷新；refresh token 按 90 天轮换、旧值删除；`invalid_grant` → 会话失效并引导重新登录，**不静默转离线**（02 SEC-AUTH-09/10）。
- **Authlib**：服务器 URL（HTTPS）+ 名称 + 注册链接；jar 固定版本 + SHA-256 白名单；输出 `getLaunchInjection() → { javaagentPath, apiRoot, prefetched, accessToken, uuid, name }`；launch 只拼装。
- **API**：`listAccounts/createOffline/select/beginDeviceCode/pollDeviceCode/logout/authlib.*`；事件 `accounts:changed`。
- **测试**：离线 UUID 精确值（`TestUser→097d3392-865a-3f3c-8b4a-da1c3473466c`）、非法名、设备码错误路径、token 不落盘。

### 6.7 `launch` — 参数纯函数、派生、监护

- **纯函数**：`buildLaunchPlan(flattened, instance, session, opts) → { argv, env, cwd, warnings }`；不碰磁盘/进程；输入已扁平化。
- **argv 规则**：classpath（rules 过滤 + client jar，`;` 分隔，不加引号）；natives 解压；占位符全替换（**无 `${...}` 残留**，01 R1.8）；`-Xmx` 恰好一次；`--gameDir` 按隔离；离线四件套；Authlib `-javaagent`。
- **自动进服（版本差异，2026-10-21 实测）**：1.20.1 客户端 `Main.class` 只有 `quickPlay*`，没有 `--server/--port`。判定 `supportsQuickPlay(version, mcVersion)`：版本 JSON 的 `arguments.game` 出现 `--quickPlay*`，或 MC 版本 ≥1.20 → 单个 token `--quickPlayMultiplayer <host>:<port>`；否则 `--server <host> --port <port>`（≤1.19）。`mcVersion` 取实例元数据（`instance.json.mcVersion`；改名实例如 `1.20.1-b` 仍按 `1.20.1` 判定）。两者只能出现其一，并参与受管参数去重。
- **一键启动（P0，用户 2026-10-21 明确要求）**：主页唯一主按钮只调用 `launch.start({ instanceId, accountId })`（`plan` 只用于 dry-run/排障）；主进程内部按 `instance`（选中且 `ready`）→ `java`（选择/校验）→ `auth`（会话）→ `version`（扁平化/完整性）→ argv → spawn 一气呵成；失败才返回明确错误码：无 Java `JAVA.NOT_FOUND`/`JAVA.INVALID`、未登录 `AUTH.NO_ACCOUNT`、版本损坏 `VERSION.JSON_CORRUPT`、参数非法 `LAUNCH.PLAN_INVALID`。无实例是 UI 状态（按钮变「安装/选择实例」），不调用 `start`；UI 只在失败时展开详情，不弹多步向导。
- **第三方兼容**：每次启动前最小必要重写 `mcRoot/launcher_profiles.json`（备份；不写 token）；实例 `LatestLaunch.bat`；品牌参数 `-Dminecraft.launcher.brand=mc-launcher`。
- **dry-run**：`plan({ dryRun:true })` 写 `dataRoot/logs/dry-run.json` 与 `launch-last.json/.bat`，**不创建进程**。
- **监护**：`spawn(java, argv, { shell:false, cwd, env })`；stdout/stderr 增量解码后按行写 `dataRoot/logs/game/<dirName>/<yyyyMMdd-HHmmss>.log`（单次启动一个文件；同秒冲突 `-2`；行首标 `[stdout]`/`[stderr]`；内容不脱敏，供崩溃栈阅读）并广播 `evt:output`（100ms 节流）；退出码映射；应用退出时按用户选择保留/结束子进程（design §4.1）。
- **API**：`plan/start/stop/status/lastReport?`；事件 `status/stage/output/exited`。
- **测试**：`fixtures/launch/` 4 组 argv golden（空格/中文、分辨率、离线、Authlib/进服）；断言无残留占位符。

### 6.8 `mods` — 资源管理与整合包导入

- **扫描**：`instance.gameDir(id)` 下的 `mods/`、`resourcepacks/`、`shaderpacks/`（`isolated`=`versions/<dir>/`，`shared`=`mcRoot/`）；名称/大小/启用状态；`.disabled` 重命名；同名启用+禁用冲突提示；删除；打开目录。
- **选择文件安装（P0）**：由系统文件选择器提供路径 → `installLocalFile(path)`；只接受 `.jar/.zip` 等白名单；路径校验；写当前实例；不执行内容。
- **拖入安装（P0）**：Dropzone 只是 UI 入口，与文件选择器**共用同一个** `installLocalFile(path)`；后端不区分来源，拖拽不改变主进程契约。design 的 Dropzone 组件标 P0，由 client-dev 在 t16 实现（本文件不改 `design/`）。
- **整合包**：`.mrpack` 解析 `modrinth.index.json`（URL+sha1+sha512），下载走 `download`，处理 `overrides/`、`client-overrides/`；本地 CF zip 只解析 `manifest.json` + overrides，**不调用 CF API**；普通 zip 识别 `overrides/mods/config`；zip-slip/大小/数量限制；失败清理半成品。
- **modsetHash**：对排序后的启用 mod 文件名+大小+sha1 计算（P0 可只做文件名+大小；P1 给 link 用）。
- **P0 不装加载器**：导入后 UI 明示"加载器需 P1 安装"（01 Q11）。
- **API**：`scan/installLocalFile/toggle/delete/openDir/importPack/computeModsetHash`；事件 `changed/import:progress`。
- **测试**：3 jar + 冲突夹具、非法类型、mrpack 最小包、zip-slip、CF zip 缺失清单。

### 6.9 `store` — 设置分区与数据目录

- **职责**：设置页分区聚合（`ctx.settings.register`）、读写内核 `config.json`、数据目录打开/清理缓存/迁移（迁移 P1）。
- **写路径**：所有写入经内核 `config`（唯一写者）；`store` 不直接写其它模块配置。
- **API**：`sections/getSettings/updateSettings/openDataDir/clearCache`；事件 `settings:changed`。
- **测试**：schema 兜底、未知键保留、原子写、并发写串行化。

### 6.10 `log` — 查询、订阅、诊断

- **职责**：查询 `dataRoot/logs/app-*.jsonl`（level/scope/时间/关键词）、订阅实时行（诊断模式全量，默认采样）、导出诊断包（日志+系统信息+模块状态，自动脱敏）。
- **内存**：环形缓冲 2,000 条；UI 上限 2,000 行（design §5.2）。
- **API**：`query/subscribe/exportDiagnostics/setLevel`；事件 `evt:line`（100ms）。
- **测试**：脱敏回归（假 token 样本）、大日志截断、滚动清理。

### 6.11 `system`（内核内建，不是模块）

- **职责**：返回应用版本、Electron/Chrome/Node 版本、`dataRoot/mcRoot`、便携标志、模块状态、许可证/源码链接、免责声明。
- **API**：`info/status/modules`；事件 `evt:modules`（模块激活/失败时）。
- **安全**：只读；不返回令牌/账户；`license.sourceUrl` 指向 GPL 对应源码（02 LIC-09）。

### 6.12 扩展 `link` — 联机（P0-6）

- **P0 范围**：局域网/同机回环房间；房间号 6 位 Crockford Base32；邀请码 `MCL-XXXXXX`（大小写不敏感）；成员 ≤8；成员"进入世界"按版本直连：1.20+ `--quickPlayMultiplayer host:port`，≤1.19 `--server host --port port`；无后端、无中继。
- **进程模型**：
  - `LocalRoomProvider`：房主进程内起 TCP 房间服务（绑定**私网 IP 或 127.0.0.1**，绝不 `0.0.0.0`）+ UDP 发现（固定端口，`LOOKUP <code>` → `{host, port, token}`）；成员通过邀请码解析房主地址。
  - 端口冲突：发现端口（默认 25999，可配）只由房主绑定，成员用临时端口查询；同机已有房主时第二个房间直接报错（P1 再支持多房间）。
  - `TunnelProvider`（P1/条件）：EasyTier/frp sidecar；运行时下载 + 固定版本 + SHA-256 + LGPL-3.0 声明；失败不影响 LAN 房间。
- **LAN 世界发现**：`launch` 输出订阅 + 读取实例 `logs/latest.log`，匹配 `Started serving on <port>` / `Local game hosted on port <port>`，≤5 s 更新房间地址；120 s 未发现 → 提示手动端口。
- **状态机**：`idle → creating → waiting → connected → closing → closed`；错误码 `ROOM_NOT_FOUND/ROOM_FULL/ROOM_CLOSED/VERSION_MISMATCH/NETWORK_UNREACHABLE/INVITE_INVALID`。
- **安全**（02 NET-13/14、SEC-NET-09）：邀请码高熵、可撤销、不写日志；房间协议不传任何账号 token；绑定私网/回环；不自动改防火墙；成员上限。
- **许可证**：LAN L0 不加载任何第三方二进制；隧道组件（若启用）随附 LGPL-3.0 全文 + 源码链接 + SHA-256，且不得静态链接/改包（02 NET-01~05）。
- **API**：`create/join/leave/status/members/enterWorld`；事件 `state/members/lanWorld`。
- **测试**：双开 L0 脚本、错误邀请码、版本不一致、关闭广播、netstat 无外部连接。

### 6.13 扩展 `crash` — 崩溃分析（P0-5）

- **输入**：订阅 `launch:evt:output` 累积；`launch:evt:exited` 触发 `analyze({ exitCode, lastLines, instanceId })`。
- **规则**：`modules/crash/rules/*.json`，P0 只做 5 类（Java 版本、内存不足、缺前置、Mod 冲突、OpenGL/驱动）；退出码 0 **永不**报崩溃；低置信度用"可能是…"。
- **输出**：`CrashReport { when, instance, java, memory, last100Lines, conclusions[], reportId }`；纯文本复制。
- **依赖方向**：`crash → launch`；launch 不得 import crash。
- **API**：`lastReport/get/analyze`；事件 `reportReady`。
- **测试**：4 类日志夹具 + 退出码 0 负向。

---

## 7. 数据目录布局与便携模式（ADR-005/009）

### 7.1 两个根：为什么必须分离

01 v1.2 明确 `--data-dir`（配置/日志/账户）与 `--mc-dir`（.minecraft）是**两个参数**（R0.2/R0.3）；40 研究稿把二者合并为 `.minecraft`，已不适用。分离后：

- 应用可便携（`data/` 随 exe），MC 目录可与 PCL/HMCL 共用同一份 `versions/libraries/assets`；
- 用户换 MC 目录不必迁移账户/日志；卸载应用不碰游戏目录。

### 7.2 `dataRoot`（应用私有，`--data-dir` / `MCL_DATA_DIR` / 默认 `<exeDir>/data`）

```
dataRoot/
├── config.json                 # 内核 + store（唯一写者，schemaVersion）
├── accounts.json               # auth（离线账户 name/uuid；无 token）
├── modules/
│   ├── auth/sessions.bin       # 加密 refresh token（safeStorage）
│   ├── version/manifest.json   # 清单缓存（10 min TTL）
│   ├── download/queue.json     # 未完成任务（可选）
│   ├── java/index.json         # 探测缓存（P1）
│   ├── link/                   # 房间状态/证书
│   └── <id>/config.json        # 模块配置（每个文件单写者）
├── logs/
│   ├── launcher.log            # 人类可读镜像（info+；01 证据口径要这个文件名）
│   ├── app-YYYYMMDD.jsonl      # 应用日志（JSONL，20MB×8）
│   ├── game/<dirName>/<yyyyMMdd-HHmmss>.log   # 启动器捕获的游戏输出（不脱敏；01 R5.2）
│   ├── launch-last.json/.bat    # 最近一次命令行（脱敏）
│   └── dry-run.json             # 最近一次 dry-run
├── cache/http/  cache/icons/
├── java/                       # 启动器管理的 JRE（P1）
├── tmp/                        # .part / 解压临时 / 锁
└── trash/                      # 实例删除回收站（P1）
```

### 7.3 `mcRoot`（= `.minecraft`，`--mc-dir` / `MCL_MC_DIR` / 首次选择）

```
mcRoot/
├── versions/
│   └── <dirName>/                 # 目录名 = 用户可见实例名（≠ 内部 id）
│       ├── <dirName>.json          # 扁平化版本 JSON（version 写）
│       ├── <dirName>.jar           # client jar（version 写）
│       ├── <dirName>-natives/      # natives（launch 写，可重建）
│       ├── instance.json           # 实例元数据（instance 写；PCL 忽略）
│       ├── LatestLaunch.bat        # 最近命令行（launch 写，已脱敏）
│       ├── PCL/                    # 外部工具目录（只读，R9）
│       ├── mods/ resourcepacks/ shaderpacks/ saves/ logs/ config/   # isolation=isolated 的 gameDir（01 R1.9）
│       └── options.txt
├── libraries/<group path>/...
├── assets/indexes/<id>.json
├── assets/objects/<ab>/<hash>
├── launcher_profiles.json          # 启动前最小重写（备份；无 token）
└── logs/                           # 游戏自身日志（launch 只读）
```

**文件级所有权**：

| 路径 | 所有者 | 说明 |
|---|---|---|
| `versions/<dir>/<dir>.json/.jar/-natives/` | `version` / `launch`（natives） | 其它模块只读 |
| `versions/<dir>/instance.json` | `instance` | 唯一实例元数据 |
| `versions/<dir>/PCL/**` | 外部 | **永不写**（LIC-05/R9） |
| `versions/<dir>/` 内的 `mods/`、`resourcepacks/`、`shaderpacks/`、`saves/`、`logs/`、`config/` | `mods`（资源目录）/ `launch`（读 logs） | isolation=isolated 时的 gameDir（01 R1.9） |
| `versions/<dir>/mods/`、`resourcepacks/`、`shaderpacks/` | `mods` | 经 instance 授权 |
| `mcRoot/libraries/`、`assets/` | `download` | 全局共享 |
| `mcRoot/launcher_profiles.json` | `launch` | 启动前写入（备份） |

### 7.4 根解析优先级

`dataRoot`：

1. `--data-dir <abs>`；
2. 环境变量 `MCL_DATA_DIR`；
3. `<exeDir>/data`（便携默认；01 Q3）；
4. 若 3 不可写 → `%APPDATA%\mc-launcher` + `APP.PORTABLE_NOT_WRITABLE` 警告。

`mcRoot`：

1. `--mc-dir <abs>`；
2. `MCL_MC_DIR`；
3. `config.json.paths.minecraftRoot`（绝对路径允许，唯一例外）；
4. 未设置 → 首启 UI 选择/新建（不猜、不默认 `%APPDATA%\.minecraft`）。

**app.setPath**：在 `app.whenReady()` 之前设置 `userData/sessionData/cache/logs/crashDumps/temp` 到 `dataRoot` 下，避免 Chromium 写回 `%APPDATA%`（40 §7.2）。

### 7.5 路径规则

- 配置/`instance.json` 中除 `paths.minecraftRoot` 外**不得出现绝对路径**；实例相关路径相对 `mcRoot`（便携/换盘不失效）。
- 实例 `dirName` 清洗：保留中文/全角；替换 `\ / : * ? " < > |`；去尾随空格/点；长度 ≤100；重名加 `-2`；禁止保留名（CON/NUL/COM1…）。
- 所有读写经 `path.resolve` + `assertInside`；长路径用 `\\?\` 或 Node 长路径 API。
- JSON 一律 **UTF-8 无 BOM**（01 §7.6）。

### 7.6 隔离映射

| `isolation` | gameDir | 适用 |
|---|---|---|
| `isolated`（**新安装默认**） | `versions/<dir>/` | 原版安装（01 P0-1 R1.9：`--gameDir versions/1.20.1`）、重整合包 |
| `shared` | `mcRoot/` | 导入的旧实例、需要与其它启动器共用 mods/saves |

> **与 PCL 对齐**：PCL 的版本隔离就是 `versions/<实例名>/` 本身（mods/saves/logs 直接在里面），**不再套一层 `.minecraft/`**；01 A1.7/A1.9 的断言依赖这一点。40 研究稿的 `.minecraft/` 子目录方案作废（§13.4）。

---

## 8. 配置格式（ADR-006）

### 8.1 原则

- **严格 JSON**（不用 JSON5/JSONC/TOML）：机器可写、可 diff、schema 可校验；注释诉求交给设置页/文档。
- **分片**：内核 `config.json`；模块 `modules/<id>/config.json`。一个文件只有一个写者。
- 必带 `schemaVersion`；迁移函数链式执行；迁移前备份；失败回落默认并保留 `.corrupt-<ts>`。
- 写入规约（内核 `config` 统一实现）：`.tmp` → fsync → rename（Windows 覆盖先 unlink/重试 EPERM）；写前备份 `.bak`；读入 zod `.catch(default)` 逐字段兜底；未知键保留；内容 hash 不变则不写。

### 8.2 `config.json`（内核 + store）

```jsonc
{
  "schemaVersion": 1,
  "app": {
    "theme": "system",                 // system | light | dark
    "window": { "width": 1280, "height": 800 },
    "logLevel": "info",
    "safeMode": false
  },
  "paths": {
    "minecraftRoot": "D:\\Games\\.minecraft",  // 绝对路径：唯一例外
    "dataRoot": null                            // 只读展示；由启动参数决定，不写
  },
  "network": {
    "sourcePolicy": "auto",            // auto | mirror-only | official-only
    "maxConcurrentDownloads": 8,       // 1..16
    "proxy": null,
    "timeoutMs": 10000
  },
  "launch": {
    "defaultMemoryMb": 4096,
    "extraJvmArgs": [],
    "showGameConsole": false,
    "closeLauncherWithGame": false
  },
  "ui": { "lastRoute": "/home", "density": "comfortable" },
  "advanced": { "telemetry": false }
}
```

### 8.3 `instance.json`（instance 独占）

```jsonc
{
  "schemaVersion": 1,
  "id": "5f3c9a1e",                    // 稳定短 id，改名不变
  "dirName": "1.20.1",                 // versions/ 下目录名
  "name": "1.20.1",                    // 展示名
  "mcVersion": "1.20.1",
  "loader": { "type": "vanilla", "version": null },
  "java": { "mode": "auto", "value": null },       // auto | major | path
  "memory": { "minMb": 1024, "maxMb": 4096 },
  "memoryMode": "auto",                             // auto | custom；auto = clamp(物理内存×25%, 2048, 8192)
  "window": { "width": 1280, "height": 720, "fullscreen": false },
  "isolation": "isolated",
  "serverAuth": { "type": "none" },                // none | authlib
  "autoJoin": null,                                 // { host, port }
  "jvmArgs": [],
  "source": "ours",                                 // ours | pcl | pack | manual
  "createdAt": 1761000000000,
  "lastPlayedAt": null,
  "playTimeSec": 0,
  "icon": null
}
```

**schema 强制**：`dirName` 非空/无非法字符/不以空格点结尾/≤100；`id` 与 `dirName` 解耦；路径字段不得为绝对路径（除 `java.value` 为 path 模式）。`memoryMode` 只能是 `auto|custom`；`auto` 时不使用 `memory` 的数值（`minMb` 取 1024），按 `clamp(物理内存×25%, 2048, 8192)` 计算并写回 UI；`window.width` 320–7680、`window.height` 240–4320、`fullscreen` 布尔（01 R4.1/R4.6，t6 已实现）。

### 8.4 模块配置

```ts
const cfg = await ctx.config(MyConfigSchema, DEFAULT_MY_CONFIG)
cfg.get(); await cfg.set({ ... }); cfg.onChange(cb)
```

迁移：`migrations: [(from: 1) => ...]`；索引即 `from`；失败不清空，改名 `.corrupt-<ts>`。

---

## 9. 错误模型

### 9.1 结构

```ts
export type ErrorCategory = 'auth'|'net'|'java'|'fs'|'process'|'version'|'mods'|'user'|'conflict'|'internal'|'kernel'|'link'
export interface AppErrorShape {
  code: string            // 'JAVA.NOT_FOUND'，全局唯一，命名空间=模块
  category: ErrorCategory
  message: string         // 开发/日志（英文，可含技术细节）
  userMessage: string     // 用户可见（中文，可直接展示）
  hint?: string           // 可执行建议
  retryable: boolean      // UI 是否给"重试"
  details?: Record<string, unknown>  // 已脱敏
  traceId: string
}
```

**规约**：code 必须在 `shared/errors.ts` 的 `ERROR_CODES`；CI 扫描未声明字面量；`retryable` 给 UI；`cause` 只留一层 `{code,message}`，路径把 `C:\Users\<name>` 换成 `<home>`；IPC 边界一律信封。

### 9.2 错误码表（P0 必须实现；完整表由 t5 建）

| code | category | retryable | userMessage（基线） |
|---|---|---|---|
| `AUTH.NO_ACCOUNT` | auth | false | 还没有登录 Microsoft 账号 |
| `AUTH.INVALID_GRANT` | auth | false | 登录已过期，请重新登录 |
| `AUTH.XSTS_NO_XBOX` | auth | false | 该账号没有 Xbox 档案，请先在 xbox.com 创建 |
| `AUTH.XSTS_CHILD` | auth | false | 未成年账号需要家长在 Microsoft 家庭中授权 |
| `MS_CLIENT_ID_MISSING` | auth | false | 未配置微软应用 ID，正版登录暂不可用 |
| `MS_AUTH_NOT_APPROVED` | auth | false | 微软应用尚未获得 Minecraft API 授权（待审批） |
| `AUTH.AUTHLIB_UNREACHABLE` | auth | true | 无法连接第三方登录服务器 |
| `NET.OFFLINE` | net | true | 网络不可用，请检查连接或代理 |
| `NET.HTTP_5XX` | net | true | 服务器暂时不可用（已重试 3 次） |
| `NET.MIRROR_INVALID` | net | false | 镜像地址不合法或缺少必要路径 |
| `DOWNLOAD.HASH_MISMATCH` | net | true | 文件校验失败，将重新下载 |
| `DOWNLOAD.NO_SOURCE` | net | true | 已无可用下载源 |
| `DOWNLOAD.CANCELLED` | net | false | 下载已取消 |
| `JAVA.NOT_FOUND` | java | false | 找不到可用的 Java 运行时 |
| `JAVA.INVALID` | java | false | 指定的 Java 路径无效或不是 Java 运行时 |
| `JAVA.VERSION_MISMATCH` | java | false | 该版本需要 Java {n}，当前是 {m} |
| `JAVA.PROBE_TIMEOUT` | java | true | Java 检测超时（可能是安装损坏） |
| `VERSION.NOT_FOUND` | version | false | 游戏版本不存在 |
| `VERSION_PARENT_NOT_FOUND` | version | false | 版本继承的父版本不存在 |
| `VERSION.INHERIT_CYCLE` | version | false | 版本继承链存在循环 |
| `VERSION.JSON_CORRUPT` | version | false | 版本 JSON 已损坏，需要修复 |
| `MODS.INCOMPATIBLE` | mods | false | {mod} 需要 {range}，当前 {ver} |
| `MODS.PACK_UNSUPPORTED` | mods | false | 无法识别这个整合包的结构 |
| `MODS.ZIP_SLIP` | mods | false | 压缩包包含非法路径，已拒绝导入 |
| `LAUNCH.EXIT_NONZERO` | process | true | 游戏异常退出（返回码 {code}） |
| `LAUNCH.OOM` | process | true | 内存不足，试试把最大内存调到 {n} MB |
| `LAUNCH.PLAN_INVALID` | process | false | 启动参数不完整，无法启动 |
| `LAUNCH.PATH_TOO_LONG` | process | false | 路径过长（超过 240 字符），请把实例/数据目录换到更短的路径 |
| `FS.NO_SPACE` | fs | false | 磁盘空间不足，还差 {n} GB |
| `FS.PATH_ESCAPE` | fs | false | 非法的文件路径 |
| `FS.NOT_WRITABLE` | fs | false | 目录不可写，请换一个目录 |
| `ROOM_NOT_FOUND` | link | false | 房间不存在或已关闭 |
| `ROOM_FULL` | link | false | 房间人数已满 |
| `ROOM_CLOSED` | link | false | 房间已关闭 |
| `VERSION_MISMATCH` | link | false | 双方游戏版本不一致，暂时不能加入 |
| `NETWORK_UNREACHABLE` | link | true | 无法连接到房主，请检查网络 |
| `INVITE_INVALID` | link | false | 邀请码不正确或已过期 |
| `TUNNEL_FAILED` | link | true | 联机组件未能启动，已退回直连 |
| `IPC.UNTRUSTED_SENDER` | kernel | false | 非法的调用来源 |
| `IPC.INVALID_INPUT` | kernel | false | 请求参数不合法 |
| `KERNEL.MODULE_FAILED` | kernel | false | 模块 {id} 启动失败，相关功能不可用 |
| `KERNEL.DEPENDENCY_MISSING` | kernel | false | 模块 {id} 缺少依赖 {dep} |
| `KERNEL.DEPENDENCY_CYCLE` | kernel | false | 模块依赖存在循环：{path} |
| `APP.PORTABLE_NOT_WRITABLE` | fs | false | 便携目录不可写，已切换到用户目录 |
| `INTERNAL` | internal | true | 发生了未预期的错误（{traceId}） |

> **命名例外（重要）**：01 验收里逐字引用的错误码（`VERSION_PARENT_NOT_FOUND`、`MS_CLIENT_ID_MISSING`、`MS_AUTH_NOT_APPROVED`、`ROOM_*`、`VERSION_MISMATCH`、`NETWORK_UNREACHABLE`、`INVITE_INVALID`）**保留无点形式**，不得改成 `MODULE.NAME`，否则断言失败；其余 code 一律 `模块.名称`。`ERROR_CODES` 同时记录 `category`，UI 不靠前缀猜分类。

> 与 design §4.4 的映射：design 的 `ROOM_*`/`VERSION_MISMATCH`/`INVITE_INVALID` 与本文**完全一致**（不做前缀改写）；t10 只消费 `code`，不写死文案。

### 9.3 错误→UI 落点（design §4.4）

- 可恢复（`retryable=true`）：Toast/Banner + 重试；不可恢复：对话框/内联 + 下一步；字段错误：字段下方；任务错误：任务行；模块失败：页面 Banner（可关闭）。
- 禁止把 `AppError.message` 直接展示；只展示 `userMessage/hint`，技术细节进详情/日志。

---

## 10. 日志分级与脱敏

### 10.1 级别与默认

| 级别 | 用途 | 生产默认 |
|---|---|---|
| `trace` | 每个 IPC/HTTP/argv | 关 |
| `debug` | 状态机迁移、缓存命中、规则求值 | 关 |
| `info` | 启动/关闭、模块激活、下载批次、登录成功 | 开 |
| `warn` | 可恢复异常（重试成功、镜像回退、配置兜底） | 开 |
| `error` | 有错误码的失败 | 开 |
| `fatal` | 模块激活失败、主进程未捕获 | 开（弹窗） |

运行时：`MC_LOG_LEVEL=trace` 或设置页"诊断模式"（30 min 自动降回）。

### 10.2 形态

- `dataRoot/logs/app-YYYYMMDD.jsonl`：每行 `{ts, level, scope, msg, traceId, ...fields}`；单文件 20 MB × 8。
- `dataRoot/logs/launcher.log`：同一 sink 的人类可读镜像（`2026-10-21T12:34:56.789+08:00 INFO [scope] msg`），供 QA/用户直接打开（01 §5.1 证据口径）。
- 首行环境指纹：`{electron, chrome, node, platform, arch, dataRoot, mcRoot, portable}`。
- 游戏输出独立：`logs/game/<dirName>/<yyyyMMdd-HHmmss>.log`（按行合并 stdout/stderr，标 `[stdout]`/`[stderr]`；内容不脱敏、不结构化——玩家要看崩溃栈；01 R5.2）。
- 内存环形缓冲 2,000 条；渲染层 `log:evt:line` 节流 100 ms（诊断模式全量）。
- 时间 ISO8601 带时区（01 §7.6）。

### 10.3 脱敏（sink 之前）

1. 键名 `/token|secret|password|cookie|authorization|refresh|session|accessToken/i` → `***`；
2. JWT 形态（`eyJ` 前缀三段）→ `***`；
3. argv 中 `--accessToken` 的下一个值 → `***`；
4. `C:\Users\<name>` → `<home>`；邮箱/用户名同理；
5. 房间码/邀请码不进日志（`link` 专用规则）。
6. **回归测试常绿**：`redaction.test.ts` + 假 token 样本；断言导出报告不含 `eyJ`。

---

## 11. 测试策略与 verify 命令（ADR-015）

### 11.1 分层

| 层 | 工具 | 范围 | 门禁 |
|---|---|---|---|
| L1 单元 | vitest | `service.ts` + 纯函数（扁平化、rules 求值、argv、错误映射、脱敏、路径清洗） | 每 PR；行覆盖 ≥70%，`launch/plan`、`version/flatten` 要求 100% 分支 |
| L2 契约一致性 | vitest + conformance kit | 契约↔handler、schema、错误码、事件可序列化 | 每 PR |
| L3 架构适应度 | dependency-cruiser（`npm.cmd run arch`） | §4.7 R1–R10 | 每 PR，红即不能合并 |
| L4 集成 | vitest + 本地 `http.createServer` | download/net/java/auth 的协议形态桩 | 每 PR |
| L5 E2E | Playwright `_electron` | 冷启动→首页→建实例→dry-run/派生（不跑真游戏） | 主干 + 发版 |
| L6 人工 | 文档 | 真实 1.20.1 启动、真实微软登录、双机联机、便携 U 盘 | 发版前（01 §5） |

### 11.2 conformance kit（并行开发关键装置）

```ts
// src/test/kit.ts（内核所有者维护；模块只调用）
describeModule({ ns, contract, handlers })
// 断言：
// 1. ns.moduleId === contract.id === 目录名，且匹配 /^[a-z][a-z0-9-]*$/
// 2. contract 的每个 method 有 handler，反之亦然
// 3. 每个 input.parse(undefined) 不抛（无参方法必须 z.void()）
// 4. 每个方法声明 output；错误码在 ERROR_CODES
// 5. 模块不运行时 import 其它模块（配合 arch）
// 6. 事件 payload structuredClone 不抛
// 7. dependsOn 的 id 都存在
// 8. 全局：REQUIRED_ENTRIES + loadOptionalEntries() 恰好覆盖 src/main/modules/*/index.ts；通道前缀不重叠
```

### 11.3 铁律

- **单元测试零网络、零真实磁盘**：`HttpPort`/`FsPort`/`ProcessPort` 注入内存实现；L4 才起本地桩（端口 0）。
- 禁止在测试里打真实 Mojang/Microsoft/Modrinth 接口（慢、限流、离线不可跑）。
- 文件系统用 `memfs` 或 `tmpdir()` + 自动清理；测试之间不共享目录。
- 必须存在的边界用例（来自本机）：中文/空格/全角路径；路径 >260；只读目录；`ENOSPC`；扁平化幂等；PCL 目录零改动；实例改名 id 不变。

### 11.4 E2E 稳定性

- `_electron.launch({ args: ['.', '--data-dir=<tmp>', '--mc-dir=<tmp>'] })`；每个用例独立目录。
- **启动验证（t5 门槛，01 §5.0 要求打包产物）**：`npm.cmd run pack` 后运行 `release/win-unpacked/mc-launcher.exe --data-dir <tmp> --mc-dir <tmp>`，断言窗口出现、首页可交互、生成 `config.json` 与 `logs/launcher.log`、退出无残留；Playwright 对 dev 构建跑同一组断言。
- 网络切本地桩（`MCL_HTTP_BASE`）；只断言"窗口出现 + 首页渲染 + 建实例 + dry-run 产出 argv"，**不跑真游戏**（CI 无 GPU）。
- 断言 `no-single-instance`：同时启动两个实例，都能出窗（P0-6 前置）。

### 11.5 npm 脚本（`package.json` 冻结，全部通用）

```jsonc
{
  "scripts": {
    "dev":        "electron-vite dev",
    "build":      "electron-vite build",
    "preview":    "electron-vite preview",
    "typecheck":  "tsc -b --pretty false",
    "lint":       "eslint . --max-warnings 0",
    "arch":       "node scripts/check-architecture.mjs",
    "guard":      "node scripts/check-frozen.mjs",
    "test":       "vitest run",
    "test:watch": "vitest",
    "test:e2e":   "playwright test",
    "check":      "npm run guard && npm run typecheck && npm run lint && npm run arch && npm run test",
    "new:module": "node scripts/new-module.mjs",
    "pack":       "electron-vite build && electron-builder --dir",
    "dist":       "electron-vite build && electron-builder",
    "clean":      "node scripts/clean.mjs"
  }
}
```

- 测试用 vitest include 通配（`src/**/*.test.ts`），新模块自动被发现；单模块调试用参数：`npm.cmd run test -- src/main/modules/instance`。
- electron-builder 配置（`package.json` 的 `build`）：`directories.output: "release"`、`productName: "mc-launcher"`、`appId: "com.mclauncher.desktop"`、`asar: true`、`files: ["out/**", "package.json"]`；`--dir` 产物必须是 `release/win-unpacked/mc-launcher.exe`（01 Q6）。
- 脚本必须 Windows 可用（Node 实现、`path.resolve`、不依赖 bash）。
- `pack` 输出 `release/win-unpacked/mc-launcher.exe`（`productName: "mc-launcher"`, `appId: "com.mclauncher.desktop"`, `asar: true`）。

### 11.6 下游任务 verify 命令口径（**全部 `npm.cmd`**）

| 任务 | verify（写进任务） |
|---|---|
| **t5** 脚手架 | `npm.cmd run check`；`npm.cmd run pack`；产物存在 `release/win-unpacked/mc-launcher.exe` |
| **t6** 启动链 | `npm.cmd run typecheck`；`npm.cmd run test` |
| **t8** 安装链 | `npm.cmd run typecheck`；`npm.cmd run test` |
| **t9** 联机 | `npm.cmd run typecheck`；`npm.cmd run test` |
| **t11** 账户/贯通 | `npm.cmd run typecheck`；`npm.cmd run test` |
| **t15** 资源/整合包 | `npm.cmd run typecheck`；`npm.cmd run test` |
| **t12** QA | `npm.cmd run check`；`npm.cmd run pack`；`npm.cmd run test:e2e` |
| **t13** 审查 | `npm.cmd run check` |

> 禁止 `npm test`/`npx ...`（`npm.ps1` 被 ExecutionPolicy 拦截）；CI 也固定 `npm.cmd`。

### 11.7 门禁

| 门 | 时机 | 内容 |
|---|---|---|
| pre-commit | 提交前 | `npm.cmd run guard && lint && typecheck`（Node hook，`core.hooksPath .githooks`，不引 husky） |
| PR | 每 PR | `npm.cmd run check`（含 arch + 单测） |
| 主干 | 合并后 | `npm.cmd run build && test:e2e` |
| 发版 | tag | `pack` + smoke（装/启动/建实例/卸载）+ 02 §9 闸门 |

### 11.8 t5 脚手架 Definition of Done

- [ ] 冻结文件就位且 `arch/frozen.manifest.json` 生成；`npm.cmd run guard` 绿。
- [ ] `_registry.ts` 能加载一个演示模块（`new:module hello` 生成的），UI 出现空面板。
- [ ] preload 白名单 + renderer `api` 客户端 + `system.info` 可用。
- [ ] `--data-dir/--mc-dir` 生效；默认 `<exeDir>/data`；无单实例锁（双开可出窗）。
- [ ] `npm.cmd run check` 绿；`npm.cmd run pack` 产出 exe。
- [ ] CSP/contextIsolation/sandbox/导航拦截按 §3.2 生效（E2E 断言）。
- [ ] 首屏 ≤2s（冷启动，日志首行到"首屏就绪"）。

---

## 12. 关键接口草案（可直接照写）

### 12.1 `src/shared/kernel.ts`

```ts
import type { ZodType } from 'zod'
import type { AppErrorShape } from './errors'

export type ModuleId = string
export const CONTRACT_BRAND = Symbol.for('mc.contract')

export interface MethodDef { input: ZodType; output: ZodType }
export interface EventDef { payload: ZodType; throttleMs?: number }

export type OutputOf<T> = T extends ZodType<infer O> ? O : never

export interface ContractDef<
  M extends Record<string, MethodDef> = Record<string, MethodDef>,
  E extends Record<string, EventDef> = Record<string, EventDef>,
> {
  readonly [CONTRACT_BRAND]: true
  readonly id: ModuleId
  readonly methods: M
  readonly events: E
}

export function defineContract<M extends Record<string, MethodDef>, E extends Record<string, EventDef>>(
  def: { id: ModuleId; methods: M; events: E },
): ContractDef<M, E> {
  return Object.freeze({ ...def, [CONTRACT_BRAND]: true as const })
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape }

export type Handler<M extends MethodDef> = (ctx: ModuleContext, input: OutputOf<M['input']>) =>
  Promise<OutputOf<M['output']>> | OutputOf<M['output']>

export type Handlers<C extends ContractDef> = {
  [K in keyof C['methods']]: Handler<C['methods'][K]>
}

export interface ModuleRegistration { service?: unknown; dispose?: () => Promise<void> | void }

export interface ModuleNamespace {
  readonly moduleId: ModuleId
  readonly dependsOn?: readonly ModuleId[]
  register(ctx: ModuleContext): Promise<ModuleRegistration> | ModuleRegistration
}

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void
  debug(msg: string, fields?: Record<string, unknown>): void
  info(msg: string, fields?: Record<string, unknown>): void
  warn(msg: string, fields?: Record<string, unknown>): void
  error(msg: string, fields?: Record<string, unknown>): void
  fatal(msg: string, fields?: Record<string, unknown>): void
}

export interface ConfigHandle<T> {
  get(): T
  set(next: T): Promise<void>
  onChange(cb: (next: T) => void): () => void
}
export interface ConfigApi {
  <T>(schema: ZodType<T>, defaults: T): Promise<ConfigHandle<T>>
}

export interface IpcRegistrar {
  handle<C extends ContractDef>(contract: C, handlers: Handlers<C>): void
  emit<E extends string>(event: E, payload: unknown): void
}

export interface ErrorFactory {
  make(code: string, details?: Record<string, unknown>): Error
  is(err: unknown, code: string): boolean
}

export interface ModulePaths {
  readonly own: string
  readonly dataRoot: string
  readonly mcRoot: string
  readonly versions: string
  readonly libraries: string
  readonly assets: string
  readonly logs: string
  readonly cache: string
  readonly tmp: string
  readonly trash: string
  assertInside(root: string, candidate: string): string
}

export interface Ports {
  fs: FsPort
  http: HttpPort
  proc: ProcessPort
  clock: ClockPort
  ids: IdPort
  dialogs: DialogPort
  shell: ShellPort
}
export interface HttpPort {
  request(url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal; timeoutMs?: number }): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }>
  openStream(url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }): Promise<{ status: number; headers: Record<string, string>; stream: AsyncIterable<Uint8Array> }>
}
export interface FsPort { readFile(p: string): Promise<Uint8Array>; writeFile(p: string, b: Uint8Array): Promise<void>; rename(a: string, b: string): Promise<void>; stat(p: string): Promise<{ size: number; mtimeMs: number; isFile(): boolean; isDirectory(): boolean }>; readdir(p: string): Promise<string[]>; mkdir(p: string, opts?: { recursive?: boolean }): Promise<void>; rm(p: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> }
export interface ProcessPort { spawn(exe: string, args: string[], opts: { cwd?: string; env?: Record<string, string>; signal?: AbortSignal }): ChildHandle }
export interface ChildHandle { pid: number | undefined; stdout: AsyncIterable<string>; stderr: AsyncIterable<string>; onExit(cb: (code: number | null) => void): void; kill(signal?: string): void }
export interface ClockPort { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }
export interface IdPort { trace(): string; uuid(): string; short(): string }
export interface DialogPort { openDirectory(opts?: { title?: string }): Promise<string | null>; showMessage(opts: { type: 'info'|'warning'|'error'; message: string; detail?: string }): Promise<void> }
export interface ShellPort { openPath(p: string): Promise<void>; openExternal(url: string): Promise<void> }

export interface ServiceLocator { get<T>(id: ModuleId): T }
export interface EventBus { emit(event: string, payload: unknown): void }
export interface SettingsRegistrar {
  register(section: { id: string; title: string; order?: number; schema: ZodType }): void
}

export interface ModuleContext {
  readonly id: ModuleId
  readonly log: Logger
  readonly config: ConfigApi
  readonly ipc: IpcRegistrar
  readonly errors: ErrorFactory
  readonly paths: ModulePaths
  readonly ports: Ports
  readonly services: ServiceLocator
  readonly events: EventBus
  readonly settings: SettingsRegistrar
  readonly signal: AbortSignal
}
```

### 12.2 `src/shared/errors.ts`（节选）

```ts
import { z } from 'zod'

export const AppErrorShapeSchema = z.object({
  code: z.string(),
  category: z.enum(['auth','net','java','fs','process','version','mods','user','conflict','internal','kernel','link']),
  message: z.string(),
  userMessage: z.string(),
  hint: z.string().optional(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
  traceId: z.string(),
})
export type AppErrorShape = z.infer<typeof AppErrorShapeSchema>

export const ERROR_CODES = {
  'JAVA.NOT_FOUND': { category: 'java', retryable: false, userMessage: '找不到可用的 Java 运行时' },
  'DOWNLOAD.HASH_MISMATCH': { category: 'net', retryable: true, userMessage: '文件校验失败，将重新下载' },
  'INVITE_INVALID': { category: 'link', retryable: false, userMessage: '邀请码不正确或已过期' },
  'KERNEL.MODULE_FAILED': { category: 'kernel', retryable: false, userMessage: '模块 {id} 启动失败，相关功能不可用' },
  // ...完整表见 §9.2
} as const

export class AppError extends Error {
  constructor(readonly shape: AppErrorShape) { super(shape.message) }
  get code() { return this.shape.code }
  get userMessage() { return this.shape.userMessage }
  get retryable() { return this.shape.retryable }
  toShape(): AppErrorShape { return this.shape }
}
```

### 12.3 `src/shared/instance.ts`

```ts
import { z } from 'zod'
import { defineContract } from './kernel'

export const InstanceState = z.enum(['ready', 'missing-json', 'corrupt-json', 'missing-jar', 'unsupported'])
export type InstanceState = z.infer<typeof InstanceState>

export const Loader = z.object({
  type: z.enum(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'unknown']),
  version: z.string().nullable(),
})

export const InstanceSummary = z.object({
  id: z.string(),
  dirName: z.string(),
  name: z.string(),
  mcVersion: z.string().nullable(),
  loader: Loader,
  state: InstanceState,
  reason: z.string().nullable(),
  isolation: z.enum(['shared', 'isolated']),
  lastPlayedAt: z.number().int().nullable(),
  icon: z.string().nullable(),
})
export type InstanceSummary = z.infer<typeof InstanceSummary>

export const InstancePatch = z.object({
  name: z.string().min(1).max(64).optional(),
  java: z.object({ mode: z.enum(['auto', 'major', 'path']), value: z.union([z.number().int(), z.string()]).nullable() }).optional(),
  memory: z.object({ minMb: z.number().int().min(512), maxMb: z.number().int().min(512).max(65536) }).optional(),
  memoryMode: z.enum(['auto', 'custom']).optional(),
  window: z.object({ width: z.number().int().min(320).max(7680), height: z.number().int().min(240).max(4320), fullscreen: z.boolean() }).optional(),
  isolation: z.enum(['shared', 'isolated']).optional(),
  jvmArgs: z.array(z.string()).optional(),
})

export const contract = defineContract({
  id: 'instance',
  methods: {
    list:   { input: z.void(), output: z.array(InstanceSummary) },
    get:    { input: z.object({ id: z.string() }), output: InstanceSummary },
    update: { input: z.object({ id: z.string(), patch: InstancePatch }), output: InstanceSummary },
    scan:   { input: z.object({ mcRoot: z.string().optional() }), output: z.object({ count: z.number().int() }) },
  },
  events: {
    changed: { payload: z.object({ instanceId: z.string().nullable() }) },
  },
})

export interface InstanceService {
  list(): Promise<InstanceSummary[]>
  create(input: { dirName: string; name?: string; mcVersion: string; loader: z.infer<typeof Loader>; isolation: 'shared' | 'isolated' }): Promise<InstanceSummary>
  get(id: string): InstanceSummary
  update(id: string, patch: z.infer<typeof InstancePatch>): Promise<InstanceSummary>
  markPlayed(id: string, playTimeSec: number): Promise<void>
  gameDir(id: string): string
}
```

### 12.4 `src/shared/download.ts`

```ts
import { z } from 'zod'
import { defineContract } from './kernel'
import { AppErrorShapeSchema } from './errors'

export const DownloadTask = z.object({
  url: z.string().url(),
  destRel: z.string().min(1),          // 相对 mcRoot，禁止绝对路径
  sha1: z.string().length(40).nullable(),
  sha256: z.string().length(64).nullable().optional(),
  size: z.number().int().nonnegative().nullable(),
  priority: z.number().int().min(0).max(9).default(5),
  sourceHint: z.enum(['auto', 'official', 'mirror']).default('auto'),
})
export type DownloadTask = z.infer<typeof DownloadTask>

export const DownloadProgress = z.object({
  jobId: z.string(),
  state: z.enum(['queued', 'running', 'verifying', 'paused', 'done', 'failed', 'cancelled']),
  done: z.number().int(),
  total: z.number().int(),
  bytesPerSec: z.number().nonnegative(),
  currentFile: z.string().nullable(),
  source: z.string().nullable(),
})
export type DownloadProgress = z.infer<typeof DownloadProgress>

export const contract = defineContract({
  id: 'download',
  methods: {
    enqueue: { input: z.object({ tasks: z.array(DownloadTask).min(1) }), output: z.object({ jobId: z.string() }) },
    cancel:  { input: z.object({ jobId: z.string() }), output: z.object({ cancelled: z.boolean() }) },
    pause:   { input: z.object({ jobId: z.string() }), output: z.object({ paused: z.boolean() }) },
    resume:  { input: z.object({ jobId: z.string() }), output: z.object({ resumed: z.boolean() }) },
    list:    { input: z.void(), output: z.array(DownloadProgress) },
    status:  { input: z.object({ jobId: z.string() }), output: DownloadProgress.nullable() },
  },
  events: {
    progress: { payload: DownloadProgress, throttleMs: 100 },
    finished: { payload: z.object({ jobId: z.string(), failed: z.array(AppErrorShapeSchema) }) },
  },
})

export interface DownloadService {
  enqueue(tasks: DownloadTask[]): Promise<{ jobId: string }>
  cancel(jobId: string): Promise<void>
}
```

### 12.5 `src/shared/launch.ts`

```ts
import { z } from 'zod'
import { defineContract } from './kernel'
import { AppErrorShapeSchema } from './errors'

export const LaunchState = z.enum(['idle', 'precheck', 'java', 'args', 'spawning', 'running', 'exited', 'crashed'])
export const LaunchPlan = z.object({
  sessionId: z.string(),
  dryRun: z.boolean(),
  javaPath: z.string(),
  cwd: z.string(),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  warnings: z.array(z.string()),
})
export type LaunchPlan = z.infer<typeof LaunchPlan>

export const LaunchStatus = z.object({
  instanceId: z.string(),
  state: LaunchState,
  sessionId: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  reportReady: z.boolean(),
})
export type LaunchStatus = z.infer<typeof LaunchStatus>

export const contract = defineContract({
  id: 'launch',
  methods: {
    plan:   { input: z.object({ instanceId: z.string(), accountId: z.string().nullable(), dryRun: z.boolean().default(false), server: z.object({ host: z.string(), port: z.number().int() }).nullable().default(null) }), output: LaunchPlan },
    start:  { input: z.object({ instanceId: z.string(), accountId: z.string().nullable(), server: z.object({ host: z.string(), port: z.number().int() }).nullable().default(null) }), output: z.object({ sessionId: z.string() }) },
    stop:   { input: z.object({ sessionId: z.string() }), output: z.object({ ok: z.boolean() }) },
    status: { input: z.object({ instanceId: z.string() }), output: LaunchStatus },
  },
  events: {
    status: { payload: z.object({ instanceId: z.string(), state: LaunchState, sessionId: z.string().nullable(), startedAt: z.number().int().nullable(), exitCode: z.number().int().nullable() }) },
    stage:  { payload: z.object({ instanceId: z.string(), stage: z.enum(['precheck','java','args','spawn']), detail: z.string().nullable() }) },
    output: { payload: z.object({ sessionId: z.string(), line: z.string() }), throttleMs: 100 },
    exited: { payload: z.object({ sessionId: z.string(), exitCode: z.number().int().nullable(), reportId: z.string().nullable() }) },
  },
})

export interface LaunchService {
  plan(input: z.infer<typeof contract.methods.plan.input>): Promise<LaunchPlan>
  start(input: z.infer<typeof contract.methods.start.input>): Promise<{ sessionId: string }>
}
```

> **一键启动契约**：主页主按钮只调 `start`；`plan` 仅供 dry-run/排障。`start` 内部完成 `instance → java → auth → version → argv → spawn`，失败按 §9.2 返回错误码（`JAVA.NOT_FOUND`/`AUTH.NO_ACCOUNT`/`VERSION.JSON_CORRUPT`/`LAUNCH.PLAN_INVALID`）；无实例是 UI 状态，不调用 `start`。

### 12.6 `src/shared/auth.ts`

```ts
import { z } from 'zod'
import { defineContract } from './kernel'

export const Account = z.object({
  id: z.string(),
  kind: z.enum(['offline', 'microsoft', 'authlib']),
  name: z.string(),
  uuid: z.string(),
  authlibServer: z.string().url().nullable(),
  createdAt: z.number().int(),
})
export type Account = z.infer<typeof Account>

export const DeviceCode = z.object({
  userCode: z.string(),
  verificationUri: z.string().url(),
  expiresIn: z.number().int(),
  interval: z.number().int(),
})

export const contract = defineContract({
  id: 'auth',
  methods: {
    list:            { input: z.void(), output: z.object({ accounts: z.array(Account), selectedId: z.string().nullable() }) },
    createOffline:   { input: z.object({ name: z.string().regex(/^[A-Za-z0-9_]{3,16}$/) }), output: Account },
    select:          { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
    beginDeviceCode: { input: z.void(), output: DeviceCode },
    pollDeviceCode:  { input: z.object({ flowId: z.string() }), output: z.union([z.object({ status: z.literal('pending') }), z.object({ status: z.literal('ok'), account: Account }), z.object({ status: z.literal('failed'), error: z.unknown() })]) },
    logout:          { input: z.object({ id: z.string() }), output: z.object({ ok: z.boolean() }) },
    setAuthlib:      { input: z.object({ id: z.string(), server: z.string().url() }), output: Account },
  },
  events: { changed: { payload: z.object({ selectedId: z.string().nullable() }) } },
})

export interface LaunchInjection {
  javaagentPath: string
  apiRoot: string
  prefetched: string | null
  accessToken: string
  uuid: string
  name: string
}
export interface AuthService {
  select(id: string): Promise<void>
  getLaunchInjection(accountId: string): Promise<LaunchInjection | null>
}
```

### 12.7 `src/shared/link.ts`

```ts
import { z } from 'zod'
import { defineContract } from './kernel'

export const RoomState = z.enum(['idle', 'creating', 'waiting', 'connected', 'closing', 'closed'])
export const RoomMember = z.object({ id: z.string(), name: z.string(), role: z.enum(['host','member']), pingMs: z.number().int().nullable(), path: z.enum(['direct','relay','unknown']) })
export const RoomInfo = z.object({
  code: z.string().length(6),
  invite: z.string().regex(/^MCL-[0-9A-HJKMNP-TV-Z]{6}$/i),
  state: RoomState,
  hostAddress: z.string().nullable(),
  worldPort: z.number().int().nullable(),
  members: z.array(RoomMember),
  relay: z.boolean(),
})
export type RoomInfo = z.infer<typeof RoomInfo>

export const contract = defineContract({
  id: 'link',
  methods: {
    create:     { input: z.object({ instanceId: z.string(), lan: z.boolean().default(false) }), output: RoomInfo },
    join:       { input: z.object({ invite: z.string() }), output: RoomInfo },
    leave:      { input: z.void(), output: z.object({ ok: z.boolean() }) },
    status:     { input: z.void(), output: RoomInfo.nullable() },
    enterWorld: { input: z.object({ }), output: z.object({ sessionId: z.string() }) },
  },
  events: {
    state:    { payload: z.object({ state: RoomState, code: z.string().nullable() }) },
    members:  { payload: z.array(RoomMember) },
    lanWorld: { payload: z.object({ port: z.number().int(), address: z.string() }) },
  },
})

export interface LinkService { status(): RoomInfo | null; enterWorld(): Promise<{ sessionId: string }> }
```

### 12.8 模块实现样例（`instance`）

```ts
// src/main/modules/instance/index.ts
import type { ModuleContext, ModuleRegistration } from '@shared/kernel'
import { contract } from '@shared/instance'
import { createInstanceService } from './service'
import { makeHandlers } from './handlers'

export const moduleId = 'instance'
export const dependsOn = ['store', 'version', 'java'] as const

export async function register(ctx: ModuleContext): Promise<ModuleRegistration> {
  const service = createInstanceService(ctx)
  ctx.ipc.handle(contract, makeHandlers(service))
  return { service, dispose: () => service.close() }
}
```

```ts
// src/main/modules/instance/service.ts（不得 import electron）
import type { InstanceService } from '@shared/instance'
import type { ModuleContext } from '@shared/kernel'

export function createInstanceService(ctx: ModuleContext): InstanceService & { close(): void } {
  return {
    async list() { /* 扫描 ctx.paths.versions，读 instance.json */ return [] },
    get(id) { throw ctx.errors.make('VERSION.NOT_FOUND', { id }) },
    async update(id, patch) { throw ctx.errors.make('INTERNAL') },
    async markPlayed(id, sec) { /* 写 instance.json */ },
    gameDir(id) { return ctx.paths.assertInside(ctx.paths.versions, ctx.paths.versions) },
    close() {},
  }
}
```

### 12.9 preload / renderer 胶水

```ts
// src/preload/contracts.ts
import { CONTRACT_BRAND, type ContractDef } from '@shared/kernel'
const files = import.meta.glob<Record<string, unknown>>('../shared/*.ts', { eager: true })
export const contracts: readonly ContractDef[] = Object.freeze(
  Object.values(files).flatMap((m) => Object.values(m))
    .filter((v): v is ContractDef => typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[CONTRACT_BRAND] === true),
)
```

```ts
// src/renderer/lib/ipc.ts
import { contracts } from '@preload/contracts'   // 只读类型/契约；不引入 preload 运行时
import { createClient, makeEventSubscriber } from './client'
export const api = createClient(contracts, window.mc)
export const onEvent = makeEventSubscriber(window.mc)
```

> `@preload/contracts` 只做类型/契约聚合；electron-vite 会把 shared 契约打进 renderer bundle（zod 体积可接受）。

### 12.10 其余契约一览（t5 建骨架时按此命名）

| `src/shared/<name>.ts` | methods（IPC） | events | 说明 |
|---|---|---|---|
| `version.ts` | `listVersions` / `inspect` / `installVanilla` / `flatten` | `install:done`（进度复用 download） | UI 安装页；加载器安装 P1 |
| `java.ts` | `detect` / `choose` / `candidates` | `detect:progress` | 设置/启动前选择 |
| `mods.ts` | `scan` / `toggle` / `installLocalFile` / `delete` / `openDir` / `importPack` / `computeModsetHash` | `changed` / `import:progress` | 资源页/拖入/选择文件/整合包（同一安装入口） |
| `store.ts` | `sections` / `getSettings` / `updateSettings` / `openDataDir` / `clearCache` | `settings:changed` | 设置页聚合；唯一写 `config.json` |
| `log.ts` | `query` / `subscribe` / `exportDiagnostics` / `setLevel` | `line`（100ms） | 日志页/诊断包 |
| `crash.ts` | `lastReport` / `analyze` | `reportReady` | P0-5 报告 |
| `system.ts` | `info` / `status` / `modules` | `modules` | 内核内建，不是模块 |
| `net.ts` | —（无 IPC） | — | 只作为 `NetService` 给 download/auth/version/mods 用 |

> `net` 不暴露 IPC 是刻意的：渲染层永远不直接发 HTTP；所有网络动作由主进程模块代理。

---

## 13. 与 01 / 02 / design 的对齐

### 13.1 P0 卡 → 模块/任务

| P0 | 断言要点 | 主模块 | 任务 |
|---|---|---|---|
| P0-0 骨架/UI/实例识别 | ≤2s、`--data-dir/--mc-dir`、15 实例 4 态、只读零改动、无 mock | instance/version + 壳 + store/log/system | t5/t6/t10 |
| P0-1 版本解析+原版安装+启动 | manifest/88 libs/3,575 assets、SHA1、dry-run、无 `${...}`、60s 主菜单 | version/download/java/launch/auth | t6/t8/t11 |
| P0-2 离线账户 | UUID `097d3392-…`、`--accessToken 0`、不串号 | auth/launch | t11 |
| P0-3 Java 检测 | `where java` 为空仍找到 3 runtime + JDK21，1.20.1 选 17 | java | t6 |
| P0-4 内存/JVM | `-Xmx` 一次、分辨率/全屏、参数落盘 | launch/instance/store | t6 |
| P0-5 日志/崩溃 | ≤10s 可读结论、复制报告、退出码 0 不误报 | launch/log/crash | t6 |
| P0-6 联机 | LAN 房间/邀请码/端口发现/一键进服/双开 | link/launch/instance | t9 |
| P0-7 设备码/Authlib/多账户 | 无 client id 诚实报错、Authlib 注入、不串号 | auth/launch | t11 |
| P0-8 资源/整合包 | 启停/冲突/拖入安装/选择文件安装/mrpack/CF zip 本地解析/无 CF API | mods/download/instance | t15/t16 |

### 13.2 02 → 架构落点

| 02 约束 | 架构落点 |
|---|---|
| SEC-APP-01~12 | §3.2/§5.3/§5.5；CSP/权限/导航/自更新（P1） |
| SEC-AUTH-01~12 | §6.6；`safeStorage`、90 天轮换、单飞刷新、entitlements |
| SEC-DL-01~14 | §6.3/§6.4；哈希矩阵、原子写、zip-slip、源白名单 |
| SRC-01~12 | §6.5/§6.9；UI 标源、可关镜像、JRE 不走 BMCLAPI 列表 |
| API-01~15 | §6.5/§6.8；Modrinth UA/300rpm/sha512；CF P0 不接 |
| NET-01~18 | §6.12；EasyTier 独立进程/运行时下载/LGPL |
| MC-10~20 | §6.3/§7.3；游戏文件/JSON 不进包；免责声明（§6.11 system） |
| LIC-01~12 | §4.7/§13.4；clean-room、GPL 源码可得、依赖白名单 |

### 13.3 design → 实现落点

| design | 落点 |
|---|---|
| 色板/字阶/间距/圆角 | `src/renderer/app/styles/tokens.css`（design §2.9 原样落地）；feature 不写 hex |
| 页面/路由 | feature 自注册（§4.6）；壳提供标题栏/左栏/内容区 |
| 启动按钮 6 态 / 一键启动 | 主按钮只调 `launch.start`（`plan` 仅 dry-run/排障）；`launch.status` + `launch:evt:status/stage`（§12.5）；失败才展开详情；UI 不猜 |
| 下载 6 态 | `download:evt:progress` + `status`；节流 100ms |
| 联机房主/成员 | `link` 契约 + 事件；邀请码/成员/NAT/中继字段 |
| 日志面板 | `log.query` + `log:evt:line`；2,000 行上限 |
| 错误文案 | §9.2/§9.3；design §4.4 的三句话结构 |
| 组件库 | `src/renderer/ui/*`；t10 实现，不含业务逻辑 |
| 拖入/Dropzone | design §5.1/§6.3 的 `Dropzone` 标 **P0**，由 client-dev 在 t16 实现；与「选择文件」共用 `installLocalFile(path)`，不改变主进程契约（03 §6.8） |
| 品牌占位 | `src/renderer/app/brand.ts`：`displayName: "Cubit Launcher"`（占位）、版本、图标；产品名/可执行文件仍 `mc-launcher`（01 Q6） |

### 13.4 与 40 研究稿的差异（以本文为准）

| # | 40 研究稿 | 本文（01 v1.2 口径） | 原因 |
|---|---|---|---|
| 1 | `dataRoot = .minecraft` 单根 | **`dataRoot` + `mcRoot` 双根** | 01 R0.2/R0.3 的 `--data-dir/--mc-dir` |
| 2 | 根配置 `app.json` | **`config.json`** | 01 A0.2 明确 `$DATA\config.json` |
| 3 | 单实例锁 `requestSingleInstanceLock` | **P0 禁用**；P1 可选 | 01 §5.0：P0-6 需双开 |
| 4 | 官方源优先 | **BMCLAPI → 官方**（可切） | 01 §7.2 本机实测；02 SRC-04 的"可关可回退"仍满足 |
| 5 | P0 含 Forge/NeoForge/Fabric 安装 | **P0 不装加载器**（P1） | 01 Q2 |
| 6 | 默认 `%APPDATA%\mc-launcher` | **默认 `<exeDir>/data`**（便携） | 01 Q3 |
| 7 | 扩展模块含 `updater` | **P0 不做 updater** | 01 P1；避免最大代码执行面 |
| 8 | 会话/令牌与 P0 范围较宽 | **P0 只做离线 + 设备码错误路径** | 01 Q10/P0-7 |
| 9 | `launch` 写实例 `LatestLaunch.bat` | 同时写 **`dataRoot/logs/launch-last.*`**（验收口径） | 01 R1.13 |
| 10 | 13 个模块 | **10 主线 + link/crash + system 内建** | 01 P0 卡与任务拆分 |
| 11 | `isolated` gameDir = `versions/<dir>/.minecraft/` | **`versions/<dir>/` 本身** | 01 R1.9/A1.7/A1.9 的 `--gameDir versions/1.20.1` 与 `versions/1.20.1/logs/latest.log` |

---

## 14. 风险与开放问题

### 14.1 风险

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | Electron 44 内置 Node ≠ 主机 Node 24 | 运行期 API 差异 | 首行日志打 `process.versions`；CI 用 Electron 跑测试；禁用实验 API |
| R2 | TS 7 / electron-vite 6 / Vite 8 兼容性 | 构建失败 | t5 首日验证；不兼容按 §2.4 回退（只改版本，不改架构） |
| R3 | eager glob 的导入期异常 | 整个应用启动失败 | R7 禁止顶层副作用；CI 构建门禁；`--safe-mode` |
| R4 | 双开共享 `mcRoot` 并发写 | 文件损坏 | 单文件锁 + 原子 rename + 哈希校验；README 警告不要同时安装同一版本 |
| R5 | 下载源/镜像质量 | 安装失败 | BMCLAPI→官方回退、源熔断、可切仅官方、日志标源 |
| R6 | 微软 Azure/MCE 审批 | 真实登录不可用 | P0 只做错误路径（`MS_CLIENT_ID_MISSING`/`MS_AUTH_NOT_APPROVED`）；01 Q10 立即申请 |
| R7 | 联机 LAN 被防火墙/AP 隔离 | L1 失败 | L0 回环必验；手动地址降级；不自动改防火墙 |
| R8 | EasyTier 隧道（P1）许可/成本 | 联机翻车 | 默认不依赖；独立模块 + provider；02 §6.6 结论 |
| R9 | 未签名 Electron 被杀软误报 | 装不上 | P1 代码签名；portable zip；文档说明 |
| R10 | 路径中文/长路径/全角 | 启动失败 | 全链路 UTF-8 + 夹具 + `\\?\`；L1 测试 |
| R11 | `package.json` 冻结导致依赖排队 | 模块开发被卡 | 依赖预算覆盖 90%；每日合并窗口 |
| R12 | GPL-3.0 源码义务 | 发布不合规 | 发布页/About 放源码链接；`COPYING/NOTICE`；02 G-01 |

### 14.2 开放问题（继承 01，不重复拍板）

| # | 问题 | 现状 | 建议 |
|---|---|---|---|
| Q-A | 加载器安装（Forge/NeoForge/Fabric）P1 首个任务 | 01 Q2 默认不在 P0 | P1 第一优先；`version` 预留 `installLoader()` 接口 |
| Q-B | 微软 Azure 应用 + MCE 审批负责人 | 01 Q10 未启动 | captain 立即指派；P0 不受阻 |
| Q-C | 整合包导入不含加载器的产品表述 | 01 Q11 默认"明示需 P1" | 保持；不得宣称可启动 |
| Q-D | 跨 NAT 隧道方案（t4） | 04 文档中 | `TunnelProvider` 接口已隔离；不阻塞 L0 |
| Q-E | 代码签名证书 | 未申请 | P1 前完成；P0 只发 portable zip |

---

## 15. 附录

### A. 冻结文件与守卫

`arch/frozen.manifest.json` 记录以下文件的 SHA-256；`npm.cmd run guard` 发现变更且 manifest 未同步 → 红（防手滑，不防恶意）：

```
package.json  package-lock.json  electron.vite.config.ts  tsconfig*.json
src/main/index.ts  src/main/kernel/**  src/main/modules/_registry.ts
src/preload/index.ts  src/preload/contracts.ts
src/renderer/app/**  src/renderer/lib/**
src/shared/kernel.ts  src/shared/errors.ts  src/shared/system.ts
scripts/**  arch/**
```

内核所有者合并窗口内更新 manifest 是正常操作，必须写入 PR 模板。

### B. 启动时序（首屏到可交互）

```
1. 解析 argv/env：--data-dir / --mc-dir / --safe-mode / --disable-modules
2. resolveDataRoot()（§7.4）→ app.setPath(userData/sessionData/cache/logs/crashDumps/temp)
3. app.whenReady()
4. Kernel.create()：logger（首行环境指纹）、config、paths、ports、system 契约
5. 读 config.json；解析 mcRoot（未设置 → 首启欢迎页）
6. topoSort(REQUIRED_ENTRIES + loadOptionalEntries())；逐模块 register（≤100ms/个，try/catch）
7. createWindow()（先出窗；show:false → ready-to-show）
8. 渲染层加载 app://（或 dev URL）；订阅 system:evt:modules
9. 后台 warmup（manifest 缓存、Java 探测）——不得阻塞首屏
10. 失败模块 → system 状态 → 页面 Banner，不阻塞其它功能
```

**预算**：窗口可见 ≤800 ms；可交互 ≤2 s（01 R0.1）。任何模块不得在 `register` 里做 >50 ms 同步工作。

### C. 术语

- **契约（contract）**：`src/shared/<name>.ts` 中 `defineContract` 定义的方法/事件 + zod schema。
- **信封（envelope）**：`{ ok, data } | { ok: false, error }`，跨 IPC 永不抛异常。
- **扁平化**：把 `inheritsFrom` 链展开成自包含版本 JSON（ADR-007）。
- **dataRoot / mcRoot**：应用私有数据根 / `.minecraft` 根（ADR-005）。
- **自注册**：模块通过目录 + `register(ctx)` 被内核发现，无需改冻结文件（ADR-003）。

### D. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| 1.0 | 2026-10-21 | 首版：ADR-001~016、三进程/安全基线、自注册契约、IPC 单源、12 模块规格、双根布局、配置/错误/日志、测试与 verify 口径、接口草案、01/02/design 对齐、与 40 的 10 处差异 |
| 1.1 | 2026-10-21 | 按 t6 真实机验证校准：①§6.7 自动进服改为版本判定（1.20+ `--quickPlayMultiplayer host:port`；≤1.19 `--server/--port`；1.20.1 `Main.class` 无 `--server`）；②§0.2/§6.7/§7.2/§10.2 游戏捕获日志统一为 `dataRoot/logs/game/<dirName>/<yyyyMMdd-HHmmss>.log`（`[stdout]/[stderr]` 标注，与游戏自身 `latest.log` 区分）；③§8.3/§12.3 增补 `memoryMode` 与 `window`（01 R4.1/R4.6）；④§9.2 增补 `JAVA.INVALID`。影响任务：t6（实现依据）、t9（联机进服断言）、t10（日志页/实例设置 UI）、t12（验收）、t21（本次对齐） |
| 1.2 | 2026-10-21 | 按 captain 裁定把拖拽安装降为 P1：§0.2 `mods`、§6.8（P0 改为 `installLocalFile(path)` + 文件选择器入口；拖拽只影响 UI 入口，P1 复用同一接口）、§12.10、§13.1 同步；§13.3 注明 design 的 Dropzone 标 P1，由 client-dev 处理（本文件不改 `design/`）。原因：t26 时用户未要求（**2026-10-21 14:26 用户明确要求「拖拽安装与一键启动」，见 1.3**），且 01 的 R8.2/F31–F33（P0）与 F57（P1）自相矛盾；PCL 日志证明拖拽整合包存在，当时保留 P1。影响任务：t15/t16（当时按 P0 不做 Dropzone 处理） |
| 1.3 | 2026-10-21 | 按用户明确选择「拖拽安装与一键启动」：①**恢复拖拽安装为 P0**（§0.2 `mods`、§6.8、§12.10、§13.1；Dropzone 是 UI 入口，与文件选择器共用 `installLocalFile(path)`，后端契约不变）；§13.3 的 design Dropzone 标回 P0（由 client-dev 在 t16 实现，本文件不改 `design/`）；②新增**一键启动**口径：§6.7 明确主页主按钮只调 `launch.start`，内部 `instance→java→auth→version→argv→spawn`，失败才展开详情；§12.5 加契约注；§13.3 启动按钮行同步。原因：用户 2026-10-21 明确要求两件都要（P0→P1→P0 的来回见 1.2 与本条）。影响任务：t15/t16（拖拽 P0）、t10/t11（主页一键启动与失败分支）、t12（验收） |
| 1.4 | 2026-10-21 | 补 t54 复审 R6 文档项：§9.2 错误码表新增 `LAUNCH.PATH_TOO_LONG`（process，240 字符硬预检；natives 目录/游戏日志路径超限时启动或 dry-run 直接失败并给可读提示）。来源：`src/main/kernel/paths.ts:16-29`、t54 §2 R6；不改变实现 |
