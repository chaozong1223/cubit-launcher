# 40 · 架构设计：Minecraft 启动器（mc-launcher）

| 项 | 值 |
|---|---|
| 文档状态 | **基线（Baseline v1）** — 冻结后可被 ADR 变更，不可被下游实现者直接修改 |
| 日期 | 2026-10-21 |
| 读者 | 内核所有者（Kernel Owner）、模块实现者（10 主线 + 3 扩展）、测试/发布责任人 |
| 上游 | **`10-feature-matrix.md`（同目录）**：P0 范围、验收标准、PCL2 基线、人日口径以它为准；本文只负责"怎么建"，不重新论证"做什么"。本文 §0.1 的映射表确保 14 组 P0 验收逐条有归属 |
| 下游冻结物 | `src/main/index.ts`、`electron.vite.config.ts`、`package.json`、`src/main/kernel/**`、`src/main/modules/_registry.ts`、`src/preload/index.ts`、`src/preload/contracts.ts`、`src/shared/kernel.ts`、`src/shared/errors.ts` |

---

## 0. 决策摘要（TL;DR）

1. **运行时选 Electron 44 + TypeScript + React 19 + Vite**（经 electron-vite 6 编排）。理由不是"Electron 更好"，而是**本机零 SDK 即可构建 + 团队 TS 化 + 模块级并行**三项叠加后，交付速度的权重压倒了运行时开销的劣势。完整对比与回退触发条件见 §2。
2. **不采用"自装 .NET 8 SDK + WPF"**。除"本机无 SDK"外还有一条更硬的否决理由：**.NET 8 的 LTS 支持在 2026 年 11 月结束**（距今约 3 周），今天新起的项目若走 WPF，正确目标应是 .NET 10 LTS（支持至 2028-11），"装 .NET 8 SDK"本身就是一个即将过期的计划。
3. **三层进程模型**：`main`（Node，唯一可信边界）/ `preload`（桥，最小攻击面）/ `renderer`（React，无 Node）。`contextIsolation: true` + `sandbox: true` + `nodeIntegration: false` 是**不可协商项**。
4. **自注册靠"构建期文件系统即注册表"**：`import.meta.glob` 在构建时把 `src/main/modules/*/index.ts` 与 `src/shared/*.ts` 编译进注册表，**新增模块 = 新增文件，永不修改 `main/index.ts`**。模块顶层零副作用是硬约束（否则 glob 失效）。
5. **类型化 IPC 走"契约单源 + 结果信封"**：契约定在 `src/shared/<name>.ts`，zod 4 校验，handler **永不跨 IPC 抛异常**，一律返回 `Result<T>`。
6. **`package.json` 冻结的真实后果是"依赖预算"**：任何人不得 `npm install` 新依赖，内核所有者维护一份受审计依赖集；这是本方案唯一需要串行化的点，必须显式写进团队规约（§4.6）。
7. **模块数：10 个主线 + 3 个扩展**。需求写"9 个"但点名了 10 个（instance/version/java/launch/download/auth/mods/net/store/log），按 10 个落地；`10-feature-matrix.md` 的 P0 还要求**联机、更新器、崩溃分析**，按同一自注册协议追加为 `link` / `updater` / `crash` 三个扩展模块——**追加不需要改任何冻结文件**，这正是 §4.2 设计的收益。映射见 §0.1。
8. **实例根目录采用 `versions/<实例目录名>/`（PCL 兼容），不是自造的 `instances/<id>/`**。理由：`10-feature-matrix.md` 的 R10 把"零迁移读取现有 15 个 PCL 实例"列为高影响项，且 PCL/HMCL/官方启动器都按 `versions/*` 识别实例；自造布局会让我们的实例对其它工具不可见（ADR-010）。
9. **版本 JSON 一律扁平化落盘，运行期不做多级 `inheritsFrom` 合并**。继承链在**安装/导入时展开一次**（R6：继承链是缺陷来源）；`launch` 只消费已展开的 JSON（ADR-011）。
10. **只做 Windows x64 + 简体中文 + 单用户**。不做多语言框架、不做多平台抽象；任何"为将来跨平台预留"的抽象都视为架构宇航员行为，拒绝。

### 0.1 与 `10-feature-matrix.md` 的对齐（P0 → 模块）

本架构必须能承接 10 文档的 14 组 P0 验收，逐条落位如下（达不到就是架构缺陷）：

| 10 文档 P0 | 承载模块 | 架构侧要点 |
|---|---|---|
| P0-01 实例与版本管理 | `instance` + `version` | 实例根 = `versions/<目录名>/`；`id` 与目录名解耦（改名不破引用） |
| P0-02 原版安装与修复 | `version` + `download` | "修复" = 按哈希补齐缺失/损坏文件，不重下全部 |
| P0-03 Forge 安装 | `version` | 固定 installer 版本矩阵；**不引入 JavaWrapper/.NET**，用纯 Java 跑 installer + `launcher_profiles.json` 桩 |
| P0-04 NeoForge 安装 | `version` | 同上，installer 参数集不同 |
| P0-05 Fabric 安装 | `version` | profile JSON 直落，无需跑安装器 |
| P0-06 下载基础设施 | `net` + `download` | 源熔断、分段探测、`416`/`502` 分类、大小+哈希双校验、单线程回退 |
| P0-07 Java 管理 | `java` | 兼容 PCL 的 `VersionArgumentJavaV2` 语义（大版本 + 强制路径两种） |
| P0-08 账户三态 | `auth` | 离线 / 微软 / **Authlib**；Authlib 的 javaagent 注入由 `launch` 执行 |
| P0-09 启动链路与参数 | `launch` | 扁平化 JSON + `launcher_profiles.json` + `LatestLaunch.bat` |
| P0-10 模组/资源包/光影基础管理 | `mods` | 只做本地扫描、启停、依赖报告；不做在线更新 |
| P0-11 整合包安装 | `instance` + `mods` | 拖入 zip → 建实例 → 扫描校验 → 报告缺失前置 |
| P0-12 联机 | **`link`（扩展）** | EasyTier sidecar（运行时下载）+ 房间服务；**唯一需要后端的部分** |
| P0-13 日志与崩溃报告 | `log` + **`crash`（扩展）** + `launch` | 5 类高频规则；`LatestLaunch.bat` 由 `launch` 写 |
| P0-14 更新器 | **`updater`（扩展）** | Windows 不能替换运行中的 exe → 独立替换 helper + 回滚 |
| （贯穿）PCL 目录零迁移 | `instance/adapters/pcl.ts` | **只读**解析 `PCL\Setup.ini` / `config.json`，禁止写回（架构规则 + 测试） |

---

## 1. 约束与前提（本机实测）

```
$ node -v          → v24.20.0
$ npm -v           → 11.19.0（经 cmd /c；npm.ps1 被 PowerShell 执行策略拦截，见 §12.3）
$ dotnet --list-sdks        → （空）
$ dotnet --list-runtimes    → Microsoft.NETCore.App 6.0.33 / 7.0.20
                              Microsoft.WindowsDesktop.App 6.0.33 / 7.0.20
$ JAVA_HOME        → D:\DSH-工作文件\tools\jdk21\jdk-21.0.12.1+1
$ git --version    → 2.56.0.windows.2
```

由此推出三条会影响架构的硬前提：

| 编号 | 前提 | 架构后果 |
|---|---|---|
| P1 | **无任何 .NET SDK**，只有 6.0/7.0 运行时 | 连 `dotnet build` 都跑不了 WPF；6/7 均已停止支持（2024-11 / 2024-05），不可作为交付目标 |
| P2 | Node 24 + npm 可用 | 构建链零安装即可起步；但**运行时 Node 是 Electron 内置的那个**，不是主机 24.x |
| P3 | 工作目录含中文路径 `D:\DSH-工作文件\` | 全链路按 UTF-8 处理 argv/路径；**测试夹具必须包含中文+空格路径**（§11.4） |

> **P2 的常见误判**：`node -v` 是 24.20.0，但 `process.versions.node` 在 Electron 44 里是另一套版本。凡依赖"主机 Node 24 新特性"的代码（`node:sqlite`、`--experimental-strip-types`、`require(esm)` 的边角行为）都可能在运行时炸。**规则：构建工具可用主机 Node；应用代码只允许使用 Electron 内置 Node 的稳定 API**，且启动时把 `process.versions` 打进日志首行（§10.2），让版本漂移在第一时间可见。

### 1.1 版本锁定（实测于 2026-10-21，`npm view`）

| 包 | 版本 | 说明 |
|---|---|---|
| electron | 44.9.3 | 运行时，随 lockfile 锁定 |
| electron-vite | 6.0.0 | 三段式构建编排 |
| electron-builder | 26.15.3 | NSIS + portable 目标 |
| typescript | 7.0.2 | 原生编译器；若生态插件不兼容，回退 `5.9.x`（在 ADR 中记录） |
| vite | 8.3.4 | 仅作为 electron-vite 的底层 |
| react / react-dom | 19.3.1 | 渲染层 |
| zod | 4.6.7 | 契约校验（main 权威、renderer 预校验） |
| vitest | 5.0.5 | 单元/集成测试 |
| @playwright/test | 1.64.1 | `_electron` E2E |
| dependency-cruiser | 18.7.0 | 架构适应度函数 |
| yauzl 3.4.0 / semver 7.8.5 / fast-glob 3.3.3 / p-queue 10.0.0 | | 模块可用的受审计依赖 |
| @tanstack/react-query 5.104.5 / zustand 5.0.15 | | 渲染层状态 |

> 表内版本是**引导时的精确锁定值**；升级走 ADR，不随手 `npm update`。本文档不重复维护 lockfile 内容。

---

## 2. 选型对比：Electron+TS vs .NET 8 SDK + WPF

### 2.1 先把成本说清楚（不要只比"技术优劣"）

| 维度 | Electron 44 + TS + React | 自装 .NET SDK + WPF |
|---|---|---|
| 前置安装 | 无（`npm i` 拉 electron 二进制，~150–300MB 缓存，**项目局部**） | 需装 SDK（~200–300MB，`dotnet-install.ps1` 可免管理员装到用户目录，10–20 分钟） |
| 目标框架的正确选择 | 不适用 | **不是 .NET 8**：8 的 LTS 支持 2026-11 结束；应上 .NET 10 LTS（至 2028-11） |
| 版本可复现性 | 运行时版本锁在 lockfile 里，克隆仓库即一致 | SDK 版本靠 `global.json` 约束，**每台机器都要装对**，漂移是团队级风险 |
| 安装包体积（量级） | 90–120MB（Electron + Chromium） | 框架依赖 ~2MB / 自包含 80–150MB |
| 常驻内存（量级） | 200–300MB RSS（主+渲染+GPU+Utility） | 60–120MB RSS |
| 冷启动 | 1.5–3s（可优化到 1s 内） | 0.3–1s |
| UI 迭代速度 | Vite HMR，改样式即时可见 | XAML 热重载覆盖有限，重启更频繁 |
| 并行开发 | 类型契约跨层共享，模块可独立并行 | MVVM + XAML 下 UI 并行更容易冲突（同一 View 文件） |
| 领域库 | Node 生态打底，启动逻辑需自写/借 npm 包 | **CmlLib.Core 成熟度极高**，是 WPF 路线的真实优势 |
| 安全边界 | 主进程有完整 Node 能力，必须靠 IPC 白名单收口 | 无 JS 引擎，攻击面天然更小 |

### 2.2 加权决策矩阵（1–10 分，权重和为 100）

| 维度 | 权重 | Electron+TS | .NET 10 + WPF | Tauri 2（备选，见 2.4） |
|---|---:|---:|---:|---:|
| 交付速度与上手成本 | 25% | **9** | 5 | 4 |
| 本机可构建/可交付性 | 20% | **10** | 3 | 4 |
| 运行时开销（内存/体积/冷启动） | 15% | 5 | **9** | **9** |
| MC 领域生态 | 15% | 8 | **8** | 5 |
| 并行开发友好度 | 10% | **9** | 6 | 6 |
| 安全边界 | 10% | 5 | **7** | **8** |
| 便携/分发/更新 | 5% | 7 | 7 | **9** |
| **加权得分** | | **7.95** | 6.05 | 5.75 |

### 2.3 结论与"什么时候该反过来选"

**结论：选 Electron。** 但要说清楚这个决定买到了什么、放弃了什么：

- **买到**：今天就能 `npm i && npm run dev` 起窗口；类型契约让 13 个模块真正并行；UI 迭代以秒计。
- **放弃**：安装包 90MB+、常驻内存 200MB+、冷启动秒级。对一个"启动游戏后就退到后台"的工具，这三项可以接受；**但如果产品定位是"低配机器上的轻量启动器"，结论会翻**。

**WPF 反超的充分条件（三条同时成立才成立，单独任一条都不够）**：

1. .NET SDK 已作为团队标准环境预装（把"本机可构建性"从 3 拉到 9+）；
2. 团队 C#/WPF 熟练度不低于 TS/React（把"交付速度"从 5 拉到 8+）；
3. 产品把"安装包 < 30MB 或常驻内存 < 150MB"列为一等约束（把"运行时开销"权重提到 ≥30%）。

**回退触发条件（写进 beta 验收，不靠感觉）**：

| 指标 | 预算 | 超限动作 |
|---|---|---|
| 空载常驻 RSS（主界面待机 5 分钟） | ≤ 350MB | 触发 ADR 复评，评估 Tauri/WPF 迁移 |
| 安装包 | ≤ 130MB | 关闭 sourcemap、裁剪 locale、`asar` 优化；仍超则复评 |
| 冷启动到可交互 | ≤ 2.5s | 内核懒初始化（§4.2）、延迟加载 `mods` 解析器 |
| 单个模块崩溃导致白屏 | 0 次 | 视为内核缺陷，P0 |

> 迁移成本的诚实评估：**模块边界是为"可迁移"设计的**（§4.5 规定 `service.ts` 禁止 import `electron`）。但"可迁移"≠"免费迁移"，UI 层一定重写。真正的价值是：领域逻辑（版本解析/参数构造/Java 探测/下载校验）有独立测试，重写外壳时不用重推语义。

### 2.4 被否决的第三方案：Tauri 2

框架成熟、体积 ~10MB、IPC 也强类型。**否决理由**：本机无 Rust 工具链（引入第二个"要不要装 SDK"的问题）；Windows 上依赖 WebView2 运行时，而 WebView2 的版本/可用性在目标机器上不完全可控（Win10 老版本可能缺失）；启动器需要长时间托管子进程与流式日志，Tauri 侧要自写较多 Rust 胶水。**保留为体积成为一等约束时的逃生通道**。

---

## 3. 进程与分层架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│ main（Node，唯一可信边界，持有 fs/net/child_process）                      │
│                                                                         │
│  src/main/index.ts 🔒   启动序列：单实例锁 → 便携判定 → app.setPath        │
│                          → 创建 Kernel → 激活模块 → 建窗 → 注册 IPC        │
│  src/main/kernel/ 🔒    日志/配置/路径/端口/服务容器/生命周期/安全          │
│  src/main/modules/<name>/   ← 每个模块独占，自注册，见 §4                 │
└───────────────▲─────────────────────────────────────────────────────────┘
                │ ipcMain.handle('mc:<module>:<method>')   │ webContents.send
                │ 输入 zod 校验 → handler → Result 信封    │ 事件（可节流）
┌───────────────┴─────────────────────────────────────────────────────────┐
│ preload（沙箱，无 Node 直接暴露）                                          │
│  src/preload/index.ts 🔒  contextBridge.exposeInMainWorld('mc', {         │
│                              invoke, on, off, meta })                    │
│  通道白名单来自 src/shared/*.ts 的契约（glob），非白名单通道一律拒绝         │
└───────────────▲─────────────────────────────────────────────────────────┘
                │ window.mc.invoke(channel, payload)
┌───────────────┴─────────────────────────────────────────────────────────┐
│ renderer（React 19 + Vite，无 Node、无 remote、CSP 收紧）                  │
│  src/renderer/app/** 🔒   壳、路由、错误边界、主题                         │
│  src/renderer/features/<name>/**  ← 每个模块自己的 UI，自注册（§4.2.4）    │
│  src/renderer/lib/ipc.ts 🔒  由契约生成类型化客户端 api.instance.list()    │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.1 安全基线（不可协商）

```ts
// BrowserWindow webPreferences —— 任何 PR 修改这里都必须带 ADR
{
  preload: path.join(__dirname, '../preload/index.js'),
  contextIsolation: true,      // 默认值，仍需显式写明
  sandbox: true,               // preload 只能用 electron 的受限 API 子集
  nodeIntegration: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  allowRunningInsecureContent: false,
  webSecurity: true,
  spellcheck: false,
}
```

配套硬规则：

1. **preload 必须被打包成单文件**（`sandbox: true` 下没有裸 `require`，electron-vite 输出 CJS 单包即可满足）。
2. **发送方校验**：每个 handler 先验 `event.senderFrame.url` 属于本应用来源（生产 `app://mc-launcher/`，开发 `http://localhost:5173`），否则直接拒绝并记 `IPC.UNTRUSTED_SENDER`。这挡住被注入的 iframe/子框架调用全部 IPC。
3. **导航与开窗一律拦截**：`will-navigate` 只放行应用来源；`setWindowOpenHandler` 返回 `deny`，外链走 `shell.openExternal` 且只允许 `https:` + 主机白名单。
4. **CSP**：`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.mojang.com https://*.minecraftservices.com; connect-src 'self'`。生产禁 `unsafe-eval`。
5. **路径穿越**：所有来自 renderer 的路径参数必须过 `ctx.paths.assertInside(root, p)`，失败抛 `FS.PATH_ESCAPE`。**禁止**把 renderer 传来的绝对路径直接拼进 `fs`。
6. **解压防护**（natives/mods）：条目数上限、单条目解压后大小上限、拒绝 `..` 与绝对路径（zip-slip）、拒绝软链接。
7. **子进程**：只用 `spawn(cmd, argsArray, { shell: false })`，绝不拼命令行字符串。

---

## 4. 模块化内核：自注册与零改动

### 4.1 冻结文件清单（下游实现者不得修改）

| 文件 | 作用 | 内容可变性 |
|---|---|---|
| 🔒 `package.json` | 依赖 + 脚本 | 仅内核所有者，走"依赖预算"（§4.6） |
| 🔒 `electron.vite.config.ts` | 三段式构建 + 别名 | 仅内核所有者 |
| 🔒 `src/main/index.ts` | 启动序列 | 冻结 |
| 🔒 `src/main/kernel/**` | 内核服务 | 冻结（ADRs 变更） |
| 🔒 `src/main/modules/_registry.ts` | glob 注册表 | 冻结（就 8 行） |
| 🔒 `src/preload/index.ts` | 桥 | 冻结 |
| 🔒 `src/preload/contracts.ts` | 从 `@shared/*.ts` 汇总契约（glob） | 冻结 |
| 🔒 `src/shared/kernel.ts`、`src/shared/errors.ts` | 契约与错误的公共类型 | 冻结 |
| 🔒 `src/renderer/app/**`、`src/renderer/lib/**` | 壳与客户端 | 冻结 |
| ✅ `src/main/modules/<name>/**` | 模块实现 | **模块所有者独占** |
| ✅ `src/shared/<name>.ts` | 模块契约（唯一允许模块所有者改的共享文件） | **模块所有者独占** |
| ✅ `src/renderer/features/<name>/**` | 模块 UI | **模块所有者独占** |
| ✅ `src/main/modules/<name>/__tests__/**` | 模块测试 | **模块所有者独占** |

**为什么 `main/index.ts` 必须冻结**：它是 10 条并行分支唯一必然相交的文件。任何"顺手加一行 import"都会让分支合并变成串行排队，并且破坏"模块可独立删除"的性质。globbing 注册表把这个交叉点彻底消掉了。

### 4.2 自注册协议

#### 4.2.1 main 侧：`_registry.ts`（冻结，8 行）

```ts
// src/main/modules/_registry.ts            🔒 永不修改
import type { ModuleDefinition } from '@shared/kernel'

const found = import.meta.glob<{ default: ModuleDefinition }>('./*/index.ts', {
  eager: true,
  import: 'default',
})

/** 构建期即固定的模块清单；新增模块 = 新增目录，无需改此文件 */
export const MODULE_DEFS: readonly ModuleDefinition[] = Object.freeze(
  Object.entries(found)
    .map(([path, def]) => ({ path, def }))
    .sort((a, b) => a.path.localeCompare(b.path))   // 确定性顺序
    .map((x) => x.def),
)
```

**关键取舍（ADR-002）**：用 `eager: true` 而不是惰性 `import()`。理由：

- 惰性导入在主进程 ESM/CJS 混合输出下会踩动态 chunk 的坑，收益只是几十毫秒启动时间；
- eager 让"坏模块"在**构建期**暴露（语法/类型错误直接 CI 红），而不是在用户机器上某个功能才炸；
- 故障隔离靠**逐模块 try/catch 激活**实现，不靠导入隔离。

#### 4.2.2 模块定义（`src/shared/kernel.ts` 冻结）

```ts
export interface ModuleDefinition<S = unknown> {
  /** 必须等于契约 id；conformance 测试会断言 */
  readonly id: ModuleId
  readonly title: string
  /** 拓扑依赖：只能依赖"更低层"的模块，内核检测环 */
  readonly dependsOn?: readonly ModuleId[]
  /** 本模块对外暴露的服务（其它模块通过 ctx.getService 拿） */
  activate(ctx: ModuleContext): Promise<ActivatedModule<S>> | ActivatedModule<S>
}

export interface ActivatedModule<S = unknown> {
  readonly service?: S
  dispose?(): Promise<void>
}
```

#### 4.2.3 内核启动序列（`index.ts` 内部，伪代码）

```ts
const defs = MODULE_DEFS
assertUniqueIds(defs)                       // 重复 id → 直接失败
const order = topoSort(defs)                 // 有环 → 打印环路径并失败
for (const def of order) {
  try {
    const activated = await def.activate(ctxFor(def))
    services.set(def.id, activated.service)
    registerIpcFor(def.id)                   // 契约 → ipcMain.handle（§5）
  } catch (err) {
    failed.push({ id: def.id, error: toAppError(err) })   // 不中断启动
    log.module(def.id).fatal('activation failed', err)
  }
}
// 把 failed 列表通过 system 模块的 status 契约送到渲染层，显示"某模块不可用"
```

> **设计意图**：一个团队把 `mods` 模块写崩了，其余 9 个模块照常可用，UI 上只看到"模组管理不可用：MODS.ACTIVATION_FAILED"。这直接服务于并行开发。

#### 4.2.4 renderer 侧：`features` 自注册

```ts
// src/renderer/app/features.ts               🔒 永不修改
const found = import.meta.glob<{ default: RendererFeature }>('../features/*/index.tsx', {
  eager: true, import: 'default',
})
export const FEATURES = Object.values(found)
  .map((f) => f.default)
  .sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
```

模块 UI 通过 `RendererFeature` 挂载：`nav`（导航项）、`routes`（路由）、`settingsSections`（设置页分节）。这样 `App.tsx` 永远不用改。

#### 4.2.5 模块骨架（复制即可开工）

```
src/main/modules/instance/
├── index.ts          # defineModule：仅装配，不含业务逻辑
├── service.ts        # 业务实现；【禁止 import 'electron'】→ 纯 vitest 可测
├── handlers.ts       # 把 service 映射到契约方法
├── repository.ts     # instance.json 读写（注入 FsPort）
└── __tests__/
    ├── service.test.ts
    └── conformance.test.ts
src/shared/instance.ts          # 契约 + 类型 + zod schema（唯一共享文件）
src/renderer/features/instance/index.tsx
```

```ts
// src/main/modules/instance/index.ts
import { defineModule } from '@kernel/module'
import { contract } from '@shared/instance'
import * as handlers from './handlers'
import { createService } from './service'

export default defineModule({
  id: 'instance', title: '实例管理', contract, dependsOn: ['store', 'version'],
  async activate(ctx) {
    const service = await createService(ctx)         // ctx 注入 ports
    return { service, dispose: () => service.close() }
  },
  handlers,                                          // 契约方法名 → 函数
})
```

**硬规则**：`index.ts` 只做装配（≤ 40 行），业务在 `service.ts`；`service.ts` 里出现 `import ... from 'electron'` 会被 `npm run arch` 直接判红。

### 4.3 ModuleContext 与 Ports（模块唯一可依赖的内核面）

```ts
export interface ModuleContext {
  readonly id: ModuleId
  readonly log: Logger                      // 已绑定模块前缀，含 trace/debug/.../fatal
  readonly paths: ModulePaths               // 独占目录 + 全局目录只读视图
  readonly config: <T>(s: ZodType<T>, d: T) => Promise<ConfigHandle<T>>
  readonly services: { get<T>(id: ModuleId): T }   // 只能取 dependsOn 里的
  readonly events: { emit<K>(channel: EventChannel, payload: unknown): void }
  readonly ports: {
    fs: FsPort; net: HttpPort; proc: ProcessPort; clock: ClockPort; ids: IdPort
    dialogs: DialogPort; shell: ShellPort
  }
}
```

**Ports 是测试策略的地基**：`service.ts` 只依赖这些接口，测试里注入内存实现，于是"零网络、零磁盘、毫秒级"的单元测试成为默认，而不是例外。

`ModulePaths`（内核为每个模块算好，模块不得自己 `path.join(userData, ...)`）：

```ts
interface ModulePaths {
  /** 模块独占可写目录：<dataRoot>/modules/<id>/ —— 别人不许写 */
  readonly own: string
  /** 以下一律【只读】使用，写入必须走对应模块的契约 */
  readonly dataRoot: string
  readonly versions: string    // 实例根也在这里（versions/<目录名>/，ADR-010）
  readonly libraries: string
  readonly assets: string
  readonly java: string
  readonly cache: string
  readonly logs: string
  readonly tmp: string
  assertInside(root: string, candidate: string): string   // 路径穿越防线
}
```

### 4.4 依赖拓扑

```
kernel（无模块依赖）
  ├─ log        （叶子：日志查询/导出/级别）
  ├─ store      （叶子：持久化原语、设置读写、数据目录管理）
  └─ net        （叶子：HTTP/代理/镜像/条件请求）
        ├─ download   → net
        ├─ java       → net, store
        └─ auth       → net, store
              ├─ version  → net, download, store
              ├─ mods     → net, version
              └─ instance → store, version, java
                    └─ launch → java, version, auth, download, instance, store
```

激活序（拓扑排序的确定性结果）：
`log → store → net → download → java → auth → version → mods → instance → launch`

**环检测**：内核 `topoSort` 遇环时抛出 `KERNEL.DEPENDENCY_CYCLE` 并打印完整环路径（例：`a → b → c → a`）。这是并行开发里最常见的自伤，必须一眼能修。

**跨模块调用只走 `services.get`**，不 import 别的模块文件。理由：import 会把两个模块的构建/Rollup chunk 绑死，且让"独占目录"失去意义。

### 4.5 目录即所有权 + 架构适应度函数

`npm run arch` 用 dependency-cruiser（或等价自研 AST 扫描）执行以下规则，**违反即红，不允许 `// eslint-disable` 式豁免**：

| 规则 | 内容 | 违规示例 |
|---|---|---|
| R1 | 模块之间禁止互相 import | `modules/mods` 里 `import ... from '../version/service'` |
| R2 | 模块只能 import `@shared/<自己的名字>`，不得 import 其它 `@shared/<别人的名字>` | 见上；跨模块数据交换走服务接口或事件 |
| R3 | `electron` 只允许出现在 `main/index.ts`、`kernel/**`、模块的 `index.ts`/`handlers.ts` | `service.ts` 里 `import { app } from 'electron'` |
| R4 | 模块不得读写 `paths` 之外的目录；不得 `process.env` 直读（走 `ctx.config`） | 硬编码 `C:\Users\...` |
| R5 | `src/shared/*.ts` 必须零副作用、不得 import `electron`/`node:*` | 共享文件里 `fs.readFileSync` |
| R6 | `src/preload` 不得 import 任何 `@main` 路径 | 桥里拉业务代码 |
| R7 | 模块顶层语句只允许 `const` 声明与 `export` | 模块加载时就去建目录/发请求 |
| R8 | 每个 `contract.methods` 必须有同名 handler；每个 handler 必须有契约 | 漏注册/野通道 |
| R9 | **禁止写入 `versions/<名>/PCL/**`**（`Setup.ini`/`config.json` 只读）；`launcher_profiles.json` 是唯一例外，只允许 `launch` 在启动前按 §6.5 重写 | 导入 PCL 实例时"顺手"规范化它的 ini |
| R10 | 落盘路径必须是相对 `dataRoot` 的；禁止把绝对路径写进配置或 `instance.json` | `"gameDir": "D:\\games\\mc"` |

R7 是 glob 方案能成立的前提，R9 是"零迁移"承诺的技术兑现（用户 15 个现有实例的原配置不能被我们改动，否则就是破坏），两条都必须进 CI。

### 4.6 依赖预算：`package.json` 冻结的真实后果

**这是本方案唯一必须串行化的点，必须提前讲明白**，否则第 3 天就会出现 6 个分支同时改 `package.json` / `package-lock.json`。

规则：

1. **模块开发者不得执行 `npm install <pkg>`**，也不得手改 `package.json`。
2. 内核所有者在引导时一次性装好"受审计依赖集"，模块**只能**用这份清单里的包：

   | 用途 | 已批准 |
   |---|---|
   | 校验 | `zod` |
   | 并发/队列 | `p-queue` |
   | 文件遍历/通配 | `fast-glob` |
   | 版本号语义比较 | `semver` |
   | zip 读取（jar 解析、natives 解压） | `yauzl` |
   | 哈希 | `node:crypto`（内置） |
   | HTTP | `globalThis.fetch`（Electron 内置 Node 自带）+ `ctx.ports.net` |
   | 路径 | `node:path`（内置） |

3. 需要新依赖 → 提交 **"依赖申请"**（写明用途、体积影响、许可证、是否有内置替代），由内核所有者在**每周一次的合并窗口**统一落地。窗口外的请求排下一轮。
4. 依赖变更必须单独成一个 PR，只改 `package.json` + lockfile，不带业务代码——这样冲突永远只发生在这一个 PR 上。

> 如果你觉得这条太严：替代方案是"每个模块一个 npm workspace 子包"，代价是构建复杂度翻倍、且 Electron 打包要处理多包 hoisting。**对 10 人、单仓库、单产物的项目，依赖预算更划算。** 未来模块数翻倍时再考虑 workspace。

---

## 5. 类型化 IPC

### 5.1 契约单源（`src/shared/<name>.ts`）

一个文件同时提供：类型、zod schema、通道名、客户端签名。**没有任何代码生成步骤**——生成器会带来"忘了跑"的失败模式。

```ts
// src/shared/instance.ts
import { z } from 'zod'
import { defineContract } from './kernel'

export const LoaderType = z.enum(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge'])
export type LoaderType = z.infer<typeof LoaderType>

export const InstanceSummary = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(64),
  mcVersion: z.string(),
  loader: z.object({ type: LoaderType, version: z.string().nullable() }),
  lastPlayedAt: z.number().int().nullable(),
})
export type InstanceSummary = z.infer<typeof InstanceSummary>

export const contract = defineContract({
  id: 'instance',
  methods: {
    list:     { input: z.void(),                                            output: z.array(InstanceSummary) },
    get:      { input: z.object({ id: z.string() }),                        output: InstanceSummary },
    create:   { input: z.object({ name: z.string().min(1), mcVersion: z.string(),
                                  loader: z.object({ type: LoaderType, version: z.string().nullable() }),
                                  memoryMb: z.number().int().min(512).max(32768).default(4096) }),
                output: InstanceSummary },
    remove:   { input: z.object({ id: z.string(), toTrash: z.boolean().default(true) }),
                output: z.object({ ok: z.boolean() }) },
  },
  events: {
    changed: { payload: z.object({ instanceId: z.string().nullable() }) },
  },
})
```

契约的**四个约束**（conformance 测试逐条断言）：

1. `contract.id` 是全小写 kebab，且等于模块 id；
2. 每个 method 的 `input` 显式声明（无参用 `z.void()`，不要省略）；
3. 每个 method 的 `output` 必须声明（返回值永远是数据，不是 `void` 的黑洞）；
4. 事件 `payload` 必须是可结构化克隆的纯数据（无 class 实例、无 `Date`、无 `Map`）。

### 5.2 通道命名与结果信封

```
调用：mc:<moduleId>:<method>        例 mc:instance:create
事件：mc:<moduleId>:evt:<event>     例 mc:instance:evt:changed
```

**信封（永不跨 IPC 抛异常）**：

```ts
export type Result<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape }
```

为什么不让 `ipcMain.handle` 直接抛错：Electron 会把 `Error` 序列化成 `"Error invoking remote method 'x': <message>"`，**丢掉 code、stack、cause**，渲染层只能靠正则猜错误类型。显式信封让"错误即数据"，UI 可以按 `code` 精确分诊（§9）。

### 5.3 校验与发送方校验（`kernel/ipc.ts`，冻结）

```ts
function register(def: ModuleDef, handlers: Handlers) {
  for (const [method, m] of Object.entries(def.contract.methods)) {
    ipcMain.handle(channel(def.id, method), async (event, raw) => {
      const t0 = performance.now()
      const traceId = ctx.ids.trace()
      try {
        assertTrustedSender(event)                        // §3.1-2
        const input = m.input.parse(raw)                  // 输入校验（权威）
        const out = await handlers[method](ctx, input)    // 可能抛 AppError
        if (import.meta.env.DEV) m.output.parse(out)      // 输出自检仅开发期
        return { ok: true, data: out }
      } catch (err) {
        const e = toAppError(err, { module: def.id, method, traceId })
        ctx.log.module(def.id)[e.code === 'IPC.UNTRUSTED_SENDER' ? 'warn' : 'error'](
          `${method} failed: ${e.code}`, { traceId, durationMs: performance.now() - t0 })
        return { ok: false, error: e.toShape() }
      }
    })
  }
}
```

### 5.4 事件与背压

- 高频事件（下载进度、日志流）在契约里声明 `throttleMs`，内核按 `(channel, key)` 合并：默认 100ms 内只发最后一帧，**key 通常是任务 id**，否则多任务进度会互相覆盖。
- 渲染层必须能"重连"：事件只是**提示**，不是状态源。UI 收到 `instances:changed` 后重新 `list()`（React Query invalidate）。这样窗口重载、事件丢失都不会导致状态错乱。
- 事件在 `webContents` 销毁后自动停发（内核在 `on('destroyed')` 里清理订阅表），避免向已关闭窗口 `send` 报错。

### 5.5 preload 桥（`src/preload/index.ts`，冻结）

```ts
import { contextBridge, ipcRenderer } from 'electron'
import { contracts } from './contracts'             // 同一套 glob：../shared/*.ts，见 5.7

const allowed = new Set<string>()
for (const c of contracts) {
  for (const m of Object.keys(c.methods)) allowed.add(`mc:${c.id}:${m}`)
  for (const e of Object.keys(c.events))  allowed.add(`mc:${c.id}:evt:${e}`)
}

const bridge = {
  meta: { platform: process.platform, versions: process.versions },  // 只读快照
  invoke(channel: string, payload?: unknown) {
    if (!allowed.has(channel)) throw new Error(`blocked channel: ${channel}`)
    return ipcRenderer.invoke(channel, payload)
  },
  on(channel: string, cb: (payload: unknown) => void) {
    if (!allowed.has(channel)) throw new Error(`blocked channel: ${channel}`)
    const h = (_: unknown, p: unknown) => cb(p)
    ipcRenderer.on(channel, h)
    return () => ipcRenderer.removeListener(channel, h)     // 必须能退订
  },
}

contextBridge.exposeInMainWorld('mc', Object.freeze(bridge))
```

> 白名单是**安全基线**，不是便利层：即使渲染层被 XSS 注入，也只能调这 30 来个已声明方法，碰不到 `fs`/`child_process`。

### 5.6 renderer 客户端（`src/renderer/lib/ipc.ts`，冻结）

```ts
// api.instance.list()            → Promise<InstanceSummary[]>
// api.instance.create({...})     → Promise<InstanceSummary>   （参数类型由 zod 推出）
// api.$raw.instance.create(...)  → Promise<Result<...>>       （需要逐码分诊时）
export const api = createClient(contracts, window.mc)
export const onEvent = makeEventSubscriber(window.mc)
```

`createClient` 在 `ok:false` 时**重建 `AppError` 并抛出**，于是 UI 侧可以统一：

```ts
function useCreateInstance() {
  return useMutation({
    mutationFn: api.instance.create,
    onError: (e: AppError) => toast.error(e.userMessage, { description: e.hint, id: e.code }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['instance', 'list'] }),
  })
}
```

### 5.7 契约如何被三层同时找到（preload / renderer 各自 glob）

`src/shared/` 里除了各模块契约，还有 `kernel.ts`、`errors.ts` 这类公共文件，所以**不能靠文件名**挑契约。用品牌符号过滤，保持需求要求的 `src/shared/<name>.ts` 命名不变：

```ts
// src/preload/contracts.ts                        🔒
import { CONTRACT_BRAND, type ContractDef } from '@shared/kernel'

const files = import.meta.glob<Record<string, unknown>>('../shared/*.ts', { eager: true })

export const contracts: readonly ContractDef[] = Object.freeze(
  Object.values(files)
    .flatMap((m) => Object.values(m))
    .filter((v): v is ContractDef =>
      typeof v === 'object' && v !== null && (v as Record<symbol, unknown>)[CONTRACT_BRAND] === true),
)
```

- **同一份聚合逻辑**被 `src/preload/contracts.ts` 与 `src/renderer/lib/ipc.ts` 各 import 一次（三个消费者、一个来源）。契约对象没有副作用，重复导入只是模块实例复用，不产生额外开销。
- **品牌过滤优于文件名约定**：新增 `shared/foo.ts` 只要 `export const contract = defineContract(...)` 就自动生效；写 `shared/utils.ts` 不会误入。
- 同一 id 出现两次 → 启动即失败（`KERNEL.DUPLICATE_CONTRACT`），防止两个模块抢同一个通道前缀。
- **体积代价**：zod 会随契约进 preload 包（几十 KB 量级）。预算上限 200KB；超了再改为"构建期生成通道清单"，届时用 ADR 记录（当前不值得为此增加一个代码生成步骤）。

---

## 6. 模块规格

> **数量口径**：需求写"9 个模块"但点名了 10 个（instance、version、java、launch、download、auth、mods、net、store、log）。本文按 **10 个主线模块**落地；`10-feature-matrix.md` 的 P0 另有 3 项能力（联机/更新器/崩溃分析）不在该清单内，按 §0.1 追加为 **3 个扩展模块**。合计 13 个。
>
> **扩展模块不是"以后再说"**：它们已在 P0 验收里（P0-12/13/14），必须现在就有归属和目录。之所以能"追加而不动冻结文件"，正是因为 §4.2 的 glob 注册表与 §5.7 的契约聚合——这是本架构对"范围必然膨胀"的正面回答。

所有模块的公共契约：
- 独占可写目录 `<dataRoot>/modules/<id>/`（`ctx.paths.own`）；
- 除下表"共用目录"列明示的目录外，**不得写任何其它目录**；
- `service.ts` 不得 import `electron`；
- 必须通过 §11.2 的 conformance 套件。

| 模块 | 独占目录 | 共用目录（写） | 依赖 | 对外服务（`services.get`） |
|---|---|---|---|---|
| `log` | `modules/log/` | `logs/` | — | `LogService`（查询/导出/设置级别） |
| `store` | `modules/store/` | `app.json`（根配置） | — | `StoreService`（KV、设置、数据目录信息） |
| `net` | `modules/net/` | `cache/http/` | — | `NetService`（HTTP 统一出口、镜像、代理） |
| `download` | `modules/download/` | `libraries/`、`assets/`、`tmp/` | net | `DownloadService`（队列/校验/断点） |
| `java` | `modules/java/` | `java/` | net, store | `JavaService`（探测/选择/安装） |
| `auth` | `modules/auth/` | — | net, store | `AuthService`（会话/刷新/离线） |
| `version` | `modules/version/` | `versions/<名>/`（版本产物，见 §6.1 所有权表） | net, download, store | `VersionService`（元数据/扁平化/加载器安装） |
| `mods` | `modules/mods/` | 实例内 `mods/`（经 instance 授权） | net, version | `ModsService`（扫描/元数据/依赖报告） |
| `instance` | `modules/instance/` | `versions/<名>/instance.json`、`.minecraft/`、`trash/` | store, version, java | `InstanceService`（CRUD/导入 PCL/整合包） |
| `launch` | `modules/launch/` | `logs/launch/`、实例内 `LatestLaunch.bat` | java, version, auth, download, instance, store | `LaunchService`（参数构造/派生/监护） |
| **扩展** `link` | `modules/link/` | 实例内 `.link/`（房间状态） | net, launch, instance | `LinkService`（房间/NAT/中继） |
| **扩展** `updater` | `modules/updater/` | `updates/` | net | `UpdaterService`（检查/下载/替换/回滚） |
| **扩展** `crash` | `modules/crash/` | — | log, launch, mods | `CrashService`（规则匹配/报告生成） |

### 6.1 `version` — 版本元数据、扁平化与加载器安装

- **数据源**：`https://piston-meta.mojang.com/mc/game/version_manifest_v2.json`（带 ETag 条件请求，缓存到 `modules/version/`），单版本 JSON 落 `versions/<目录名>/<目录名>.json`。
- **扁平化落盘（ADR-011，硬要求）**：在**安装/导入时**把 `inheritsFrom` 链展开并物化成一个自包含 JSON，**运行期不再做多级合并**。理由（对应 10 文档 R6）：
  1. 继承链是缺陷来源——PCL 自己写入时也倾向扁平化（`史前世界 2.json` 无 `inheritsFrom`，117 个 libraries 全量）；
  2. 运行期合并 = 每次启动重算一个可能出错的东西，且出错后归因困难；
  3. 扁平化后 `launch` 只读一个文件，参数构造退化为纯函数，可做 golden test。

  展开规则（**只在安装时执行一次**）：
  1. 沿链自底向上，子级覆盖父级；
  2. `libraries` 按 `group:artifact` **后写覆盖**（Forge 覆盖 vanilla 版本号），保留原有顺序；
  3. `arguments.game/jvm` 与 legacy `minecraftArguments` **二选一**（1.13+ 用前者），不可混用；
  4. 产出 JSON **必须不含 `inheritsFrom`**（conformance 断言），并写 `x-mc-launcher: { flattenedAt, flattenedFrom }` 供排障。
- **加载器安装**：Fabric/Quilt 走 profile JSON 直落；Forge/NeoForge 需运行 installer jar——**已知坑**：installer 要求 `gameDir/launcher_profiles.json` 存在，且需要匹配大版本的 Java。由 `version.ensureLauncherProfiles()` 写最小桩文件，UI 明示"正在安装 Forge，需要 Java 17/21"。**不引入 JavaWrapper/.NET**：用已就绪的 Java 直接跑，显式 `-Dfile.encoding=UTF-8`，并固定 installer 版本矩阵（版本漂移是 R5）。
- **`versions/<目录名>/` 的文件级所有权**（避免两个模块抢同一目录）：

  | 路径 | 所有者 |
  |---|---|
  | `<目录名>.json`、`<目录名>.jar`、`<目录名>-natives/` | `version`（`launch` 只读） |
  | `instance.json` | `instance` |
  | `PCL/**`、`PCL\Setup.ini`、`PCL\config.json` | 外部（**只读**，我们永不写） |
  | `.minecraft/**`（gameDir） | `instance`（`launch` 只读） |

- **测试**：`fixtures/versions/` 存 1.20.1、1.16.5、fabric-1.20.1、forge-1.20.1 的**裁剪版** JSON；断言扁平化后的 `classpath` 条目数与顺序、`mainClass`、`assetIndex.id`，且输出**无 `inheritsFrom`**。

### 6.2 `java` — 探测、选择、安装

- **探测顺序**（每个候选都要实跑验证，不能只看目录名）：
  1. 实例级覆盖（绝对路径）；
  2. `JAVA_HOME`；
  3. 内置 `java/` 目录（由本模块安装的运行时）；
  4. Windows 注册表 `HKLM\SOFTWARE\JavaSoft\*` 与常见安装路径扫描；
  5. PATH 上的 `java`。
  
  验证方式：`java -XshowSettings:properties -version`，解析 `java.version` / `java.home` / `os.arch`；**超时 5s，失败即淘汰该候选**（这是"装了坏 JDK 导致启动器卡死"的根源）。
- **必需大版本判定**：优先用版本 JSON 的 `javaVersion.majorVersion`（权威）；缺省时回退表：≥1.20.5→21，1.18–1.20.4→17，1.17→16，≤1.16.5→8。
- **自动安装**：`RuntimeProvider` 接口 + 默认 `AdoptiumProvider`（`api.adoptium.net/v3/assets/latest/{major}/hotspot?os=windows&architecture=x64&image_type=jre`），下载后解压到 `java/<vendor>-<major>-<arch>/`，写入 `modules/java/index.json`（含 sha256）。Mojang 官方 runtime 索引作为第二实现（可选）。
- **测试**：用假的 `ProcessPort` 返回各种 `-version` 输出（含中文乱码、含 stderr 才输出的老 JDK），断言解析与选择优先级。

### 6.3 `auth` — Microsoft 登录（协议隔离）

- **流程**：OAuth2 授权码 → XBL (`user.auth.xboxlive.com/user/authenticate`) → XSTS (`xsts.auth.xboxlive.com/xsts/authorize`) → MC (`api.minecraftservices.com/authentication/login_with_xbox`) → profile (`/minecraft/profile`) → 权限校验（`/entitlements/mcstore`）。
- **两种回调实现**（`AuthFlow` 接口的两个 provider）：
  - `loopback`：自建 Azure 应用 + `http://127.0.0.1:<ephemeral>/callback` + PKCE(S256)。干净，但**需要团队注册应用**（风险 R-2）。
  - `nativeclient`：`redirect_uri=https://login.microsoftonline.com/consumer/oauth2/nativeclient`，从重定向后 URL 中取 code。无需注册，但依赖既有约定、易随上游变更失效。
  
  两者都实现 `AuthFlow`，默认用哪个由配置决定，**协议变更时只换 provider**。
- **令牌存储**：refresh token 用 Electron `safeStorage`（Windows 上是 DPAPI）加密后存 `modules/auth/sessions.bin`；access token 只留在内存。**任何令牌不得进 JSON 配置、不得进日志**（§10.3 脱敏）。
- **刷新策略**：access token 过期前 5 分钟静默刷新；刷新失败（`invalid_grant`）→ 标记会话失效并提示重新登录，**不要静默降级成离线模式**（会导致"进服务器被踢"的迷惑体验）。
- **账户三态（P0-08）**，统一抽象为 `AuthSession { kind: 'microsoft' | 'offline' | 'authlib', ... }`：

  | 态 | 凭据 | 启动注入 | 备注 |
  |---|---|---|---|
  | 微软正版 | MSA token 链 | `--accessToken` + `--userType msa` | 主路径，见上 |
  | 离线 | 本地用户名 | 伪造 UUID（v3），`--userType legacy` | `UUID = MD5("OfflinePlayer:" + name)`，用户名 3–16 位 `[A-Za-z0-9_]`；UI 必须标注"仅单机/自建服（`online-mode=false`）可用" |
  | **Authlib**（第三方 Yggdrasil） | 该服务器的 `authserver` 凭据 | **`-javaagent:<authlib-injector.jar>=<serverUrl>`** + `-Dauthlibinjector.yggdrasil.prefetched=<base64>` | 对应 PCL 的 `VersionServerLogin=4` + `VersionServerAuthServer`；agent jar 由 `auth` 管理、`launch` 注入 |

  Authlib 的**注入点归 `launch`**（它才构建 JVM 参数），但**服务器地址/凭据归 `auth`**：`auth` 通过 `AuthService.getLaunchInjection()` 返回 `{ javaagentPath, prefetched, accessToken, uuid, name }`，`launch` 只做拼装，不解析协议——这样协议变更不波及启动链路。
- **测试**：把整条链路的 HTTP 打桩成固定响应；覆盖 XSTS 错误码 `2148916233`（无 Xbox 账号）、`2148916238`（未成年需家长）等，转成人话 `userMessage`；Authlib 侧用一个本地假 Yggdrasil 服务端验证 `prefetched` 生成与 agent 参数拼装。

### 6.4 `download` — 队列、校验、断点

- 输入是 `DownloadTask { url, dest, sha1|sha256, size, priority }` 的集合（version 模块产出）。
- 并发上限默认 8（`p-queue`），按主机限流（`files.minecraftforge.net` 之类限得更低）；镜像重写由 `net` 负责。
- **原子落盘**：写 `dest.part` → 校验哈希 → `rename`。哈希不符删除重试（默认 2 次），仍失败报 `DOWNLOAD.HASH_MISMATCH`（**不要**静默接受损坏文件，这是"进游戏黑屏"的经典成因）。
- 断点续传：仅当服务器返回 `Accept-Ranges: bytes` 且已有 `.part` 时用 `Range`。
- 进度事件按任务聚合节流 100ms，带 `{ done, total, bytesPerSec, currentFile }`。
- **测试**：本地 `http.createServer` 夹具（支持 206/断流/500/429/错误哈希），断言重试、续传、最终文件哈希。

### 6.5 `launch` — 参数构造、派生、监护

这是全系统最需要 golden test 的模块。**参数构造纯函数化**：`buildLaunchPlan(flattenedVersion, instance, session, opts) → { argv, env, cwd }`，不碰磁盘不碰进程。输入是**已扁平化的版本 JSON**（§6.1），所以这里没有继承逻辑。

- **classpath**：libraries（按 rules 过滤）+ client jar；Windows 分隔符 `;`；含空格路径**不要**加引号（argv 数组传参，加了反而错）。
- **natives**：解压 `classifiers.natives-windows-<arch>` 到 `versions/<名>/<名>-natives/`（对齐 PCL 命名，见 10 文档 §3.3），按 `extract.exclude` 排除 `META-INF/`；1.19+ 起多数库已不再需要。
- **替换占位符**：`${auth_player_name}`、`${version_name}`、`${game_directory}`、`${assets_root}`、`${assets_index_name}`、`${auth_uuid}`、`${auth_access_token}`、`${user_type}`、`${version_type}`、`${natives_directory}`、`${launcher_name}`、`${launcher_version}`、`${classpath}`、`${resolution_width/height}`。
- **rules 求值**：`os.name`（windows）、`os.arch`（x86/x86_64/arm64）、`os.version`（正则）、`features`（`has_custom_resolution`、`is_demo_user`、`has_quick_plays_support`）。**求值必须与官方语义一致**（allow/disallow 顺序敏感），单测覆盖 20+ 组合。
- **第三方工具兼容（PCL 已建立的"事实标准"，见 10 文档 §3.3）**：
  1. 每次启动前重写实例根 `launcher_profiles.json`（`profiles.<name>`、`clientToken`、`authenticationDatabase`、`selectedUser`）——HMCL/Modrinth 等靠它识别实例；
  2. 固定品牌参数：`-Dminecraft.launcher.brand=mc-launcher`、`-Dminecraft.launcher.version=<ver>`、`--versionType mc-launcher`；
  3. **写 `LatestLaunch.bat`**：把本次真实命令行落成 bat（**令牌脱敏**后写入），排障时可一键复现；
  4. 自动进服：`--server <ip> --port <port>`（1.20+ 用 `--quickPlayMultiplayer`）。
- **Authlib 注入**：若 `auth` 返回 `getLaunchInjection()` 非空，追加 `-javaagent:<path>=<serverUrl>` 与 `-Dauthlibinjector.yggdrasil.prefetched=<b64>`；**agent 失效时必须阻断启动**并提示，而不是静默用错误身份进服。
- **安全**：`--accessToken` 会出现在进程命令行（同用户可见，Minecraft 生态既定事实）。缓解：令牌短生命周期、日志与 `LatestLaunch.bat` 双脱敏（§10.3）。
- **监护**：`spawn` 后按行读 stdout/stderr 写 `logs/launch/<sessionId>.log`（原始），并**通过契约事件** `evt:output` 广播（`crash` 订阅，`launch` 不认识 `crash`——依赖方向单向，避免成环）；退出码映射表；父进程退出时确保子进程被回收（`taskkill /T`）。
- **测试**：`fixtures/launch/` 存 4 个代表性期望 argv（逐 token 比对），覆盖：带空格/中文路径、自定义分辨率、离线会话、Authlib 注入、自动进服。

### 6.6 `mods` — jar 扫描与依赖报告

- 解析 `fabric.mod.json` / `quilt.mod.json` / `META-INF/neoforge.mods.toml` / `META-INF/mods.toml` / `mcmod.info`（遗留），统一映射成 `ModMeta { id, name, version, loader, mcRange, depends[], conflicts[] }`。
- 用 `yauzl` **只读需要的条目**（不整包解压），单 jar 超时 2s；10k 文件的目录要能扫完并且 UI 不卡（分批 + 进度）。
- 防护：条目数上限 5k、单条目解压上限 64MB（防 zip bomb）。
- 产出：`ModReport { missing[], incompatible[], duplicates[], disabled[] }`，给"一键禁用冲突项"用。
- **非目标（v1 明确不做）**：从 Modrinth/CurseForge 自动下载修复依赖。
- **测试**：夹具用真实 jar 的**最小化重打包**（20 个 jar，含 1 个损坏 zip、1 个 zip bomb）。

### 6.7 `instance`、`store`、`net`、`log`

- **`instance`**：`versions/<目录名>/instance.json` 的管理者。**目录名 = 用户可见实例名**（与 PCL 一致，这是"别的工具也能看见我们的实例"的前提），但 `id` 是独立且稳定的短 uuid 存在 `instance.json` 里——改名只动目录名，id 不变，引用不断。目录名清洗规则（必须单测）：保留中文/全角，替换 `\ / : * ? " < > |`，去尾随空格与点，长度上限 100，重名加 `-2`。删除进 `trash/` 保留 7 天。
  - **导入的三种入口**：① 自研 `.mclaunch`；② **PCL 目录只读导入**（`adapters/pcl.ts`：解析 `PCL\Setup.ini`、`PCL\config.json`、版本 JSON，**绝不写回**，架构规则 R9）；③ 整合包 zip 拖入（建实例 → `mods` 扫描 → 报告缺失前置）。
- **`store`**：内核级持久化原语的上层——`app.json` 读写、设置项 schema 注册（设置页由各模块声明自己的 section，`store` 只做聚合）、数据目录迁移/打开目录/清理缓存。
- **`net`**：**全部 HTTP 的唯一出口**。条件请求（ETag/Last-Modified）、重试（429/5xx，指数退避 + jitter，尊重 `Retry-After`）、超时（连接 10s / 总 60s，下载例外）、镜像重写（官方 ↔ 镜像，按 URL 前缀映射）、**按源熔断**（连续失败 N 次禁用该源，对齐 PCL 的"下载源已被禁用/已无可用下载源"）、代理（`undici.ProxyAgent`，与 `session.setProxy` 分开配置）、UA 固定 `mc-launcher/<ver> (+<contact>)`。
- **`log`**：日志查询（按 level/模块/时间）、导出诊断包（日志 + 系统信息 + 模块状态，**自动脱敏**）、运行时调级、订阅推送到渲染层的"日志"面板。

### 6.8 `launch` 与 `instance` 的边界（易错点）

`instance` **不得**依赖 `launch`（否则环）。"最近游玩时间"由 `launch` 在启动成功时调用 `InstanceService.markPlayed()` 写入——依赖方向是 `launch → instance`，单向。

### 6.9 扩展 `link` — 联机（P0-12）

这是**唯一需要后端服务**的模块，架构上必须把它隔离成"可以整个关掉而不影响其它 12 个模块"。

- **进程模型**：EasyTier 作为 **sidecar 子进程**（`link` 独占 `modules/link/easytier/<ver>/`），房间生命周期 = sidecar 生命周期。**运行时下载、不随包分发**（许可证与分发方式待审，见 R3），下载走 `download` + 哈希校验 + 固定版本号。
- **房间服务**：邀请码、成员列表、节点/中继列表需要远端。抽象为 `RoomProvider { create(), join(code), leave(), nodes() }`，默认实现指向我们（或社区）的 HTTP 服务；**接口必须允许自填节点**，且**断网时单机功能完全不受影响**。
- **实例一致性校验（差异化点）**：进房前比对 `mods` 清单哈希（`mods` 模块提供 `computeModsetHash()`），不一致则**加入前拦截并列出差异**，不靠玩家自己猜。
- **NAT/中继可观测**：只展示真实值（NAT 类型、是否中继、ping），**不美化**；房主掉线 5s 内广播房间关闭。
- **安全**：sidecar 只监听 `127.0.0.1`；房间码不落日志（§10.3 脱敏规则扩展）；sidecar 二进制必须校验哈希与签名后再执行。
- **非目标**：好友系统、大厅匹配、语音（10 文档 §6.1 已明确）。

### 6.10 扩展 `updater` — 更新器（P0-14）

- **Windows 硬约束**：**不能替换正在运行的 exe**。流程必须是：下载 → 校验 → 落 `updates/<ver>/` → 启动独立替换 helper（或以参数重启自身进入"替换模式"）→ 主进程退出 → 替换 → 拉起新版本。
- **原子 + 可回滚**：替换前把旧目录改名 `app.old-<ts>/`，新版本就位后启动成功（健康检查：窗口 3s 内可见）才删除旧目录；失败则回滚并展示错误。断电场景：用 `pending.json` 标记"替换中"，下次启动发现标记即回滚。
- **离线静默**：检查更新超时 10s，失败只记 debug 日志，**不阻塞启动**、不弹窗。
- **便携模式**：可执行文件可能在只读介质 → 自动更新**关闭**，仅提示"新版本可手动下载"（§7.2）。
- **通道**：`stable` / `beta` 两个通道，清单签名校验（Ed25519 公钥内置），**拒绝未签名的更新包**——这是唯一不可妥协项（更新器是最大的代码执行面）。

### 6.11 扩展 `crash` — 崩溃分析（P0-13）

- **输入**：`crash` **订阅** `launch` 的 `evt:output` 流式累积，退出时由 `launch:evt:exited` 触发 `analyze({ exitCode, lastLines, instanceId })`。**依赖方向必须是 `crash → launch`**；`launch` 里不得出现任何 `crash` 的符号（否则 §4.4 的环检测会直接拒启动）。
- **规则库**：`modules/crash/rules/*.json`，每条 `{ id, matcher: { regex, exitCodes?, window }, conclusion, suggestion, severity }`。P0 只做 5 类高频（Java 版本不符、内存不足、缺失前置、Mod 冲突关键词、OpenGL/驱动）——与 10 文档 §6.2 一致，**先窄后宽**。
- **产出**：`CrashReport { when, instance, java, memory, last100Lines, conclusions[] }`，至少 1 条可读结论；"复制报告"给**纯文本**（不是截图提示），含可定位路径。
- **误报防线**：退出码 0 一律**不报崩溃**（P0-13 负向用例）；规则命中但置信度低时降级为"可能是…"而不是断言。
- **与 `log` 的分工**：`log` 负责"存与导"，`crash` 负责"读懂"。不要把规则引擎塞进日志模块——规则会频繁迭代，日志不该跟着发版。

---

## 7. 数据目录布局与便携模式

### 7.1 布局

**`<dataRoot>` 就是 `.minecraft` 根**（PCL/HMCL/官方启动器认的那个目录）。实例根在 `versions/` 下，而不是自造的 `instances/`。

```
<dataRoot>/                          # = .minecraft 根
├── app.json                         # 内核配置（store 独占写；PCL 不认，互不干扰）
├── versions/
│   └── <实例目录名>/                 # 目录名 = 用户可见实例名（≠ 内部 id）
│       ├── <实例目录名>.json          # 扁平化版本 JSON（version 写；无 inheritsFrom）
│       ├── <实例目录名>.jar           # 客户端 jar（version 写）
│       ├── <实例目录名>-natives/      # natives 解压产物（launch 写，可重建）
│       ├── instance.json            # 我们的实例元数据（instance 写；PCL 忽略）
│       ├── LatestLaunch.bat         # 最后一次命令行（launch 写，令牌已脱敏）
│       ├── PCL/                     # 外部工具目录：Setup.ini / config.json
│       │                            #   ★ 只读：我们永不写（架构规则 R9）
│       └── .minecraft/              # 版本隔离时的 gameDir（isolation=isolated）
│           ├── mods/ config/ saves/ resourcepacks/ shaderpacks/ logs/
│           └── options.txt
├── assets/                          # 全实例共享
│   ├── indexes/<indexId>.json
│   └── objects/<ab>/<hash>
├── libraries/<group path>/...
├── launcher_profiles.json           # 每次启动前重写（launch 写；兼容第三方工具）
├── java/<vendor>-<major>-<arch>/
├── modules/<id>/                    # 各模块独占状态（他人禁止读写）
├── cache/{http,icons,avatars}/
├── logs/{app-YYYYMMDD.log, launch/<sessionId>.log}
├── updates/                         # updater 独占
├── tmp/
└── trash/<目录名>-<ts>/
```

**三条布局决策，各有代价**：

| 决策 | 买到的 | 付出的 |
|---|---|---|
| 实例根 = `versions/<名>/`（ADR-010） | PCL/HMCL/官方启动器都能看见我们的实例；"零迁移"只需只读解析 | 目录名必须是用户可见名 → 中文/空格/非法字符清洗、重名处理成为必做项（R7） |
| 版本 JSON 扁平化（ADR-011） | 启动期无合并逻辑，排障简单；与 PCL 行为一致 | 磁盘占用略增（117 个 libraries 全量）；导入别人的继承式 JSON 时要展开 |
| `assets/`+`libraries/` 全局共享（ADR-004） | 10 个实例省约 5–9GB | 实例间库版本耦合；用 `isolation: isolated` 兜底（硬链接复制，同卷不占双份） |

**版本隔离映射**（对齐 PCL 的 `LaunchArgumentIndieV2`）：

| 我们的 `isolation` | gameDir | 说明 |
|---|---|---|
| `shared`（默认） | `<dataRoot>/` | 所有实例共用根 `.minecraft` 的 mods/saves |
| `isolated` | `versions/<名>/.minecraft/` | 每实例独立 mods/saves（整合包场景） |

**为什么 assets/libraries 全局共享**：一个 1.20 实例的资源对象约 500MB–1GB，每实例各存一份会迅速到 10GB 级。共享 + 每实例独立 gameDir 是 Prism/HMCL 的通行做法。

### 7.2 便携模式判定（顺序即优先级）

```
1. 命令行 --portable
2. 环境变量 MC_LAUNCHER_HOME=<绝对路径>       （最高可控性，适合多份并存）
3. <exeDir>/portable.marker 存在
4. 以上都没有 → 标准模式
```

- 数据根：便携 = `<exeDir>/data`；标准 = `%APPDATA%\mc-launcher`。
- **必须在 `app.whenReady()` 之前**调用 `app.setPath('userData', <dataRoot>)`，并且同步设置 `sessionData`、`cache`、`logs`、`crashDumps`、`temp`，否则 Chromium 仍会往 `%APPDATA%` 写，便携就成了假的。
- 便携模式下**禁用自动更新**（可执行文件可能在只读介质上），并在关于页显示"便携模式"。
- **`exeDir` 不可写时**（如装在 `C:\Program Files`）→ 不静默降级，弹明确提示并回落标准模式，记 `APP.PORTABLE_NOT_WRITABLE`。
- **可迁移性硬约束**：`instance.json` 里的路径一律**存相对 `dataRoot` 的相对路径**；读取时解析成绝对路径。否则 U 盘一换盘符，全部实例失效。（§8.3 有 schema 强制）
- 便携模式下的单实例锁：锁文件放 `<dataRoot>/.lock`，不要放系统临时目录（同一 U 盘插两台机器时行为才一致）。

---

## 8. 配置格式

### 8.1 格式决策（ADR-008）

- **JSON，严格模式**：不用 JSON5/JSONC/TOML。理由：需要机器可写、schema 可校验、diff 可读；注释的诉求交给"设置页 + 文档"，不给解析器增加方言。
- **分片**：内核配置 `app.json` 与模块配置 `modules/<id>/config.json` **物理分离**。理由：多模块写同一个文件必然产生写竞争和 lost update；分片后每个文件只有一个写者。
- **必带 `schemaVersion`**，迁移函数链式执行。

### 8.2 `app.json`（内核独占）

```jsonc
{
  "schemaVersion": 1,
  "app":     { "theme": "system", "closeToTray": false, "updateChannel": "stable" },
  "paths":   { "minecraftRoot": null, "java": null, "assets": null },  // null = 默认；相对 dataRoot；R10 禁止绝对写入
  "network": { "mirror": "official", "maxConcurrentDownloads": 8,
               "proxy": null, "timeoutMs": 60000 },
  "launch":  { "defaultMemoryMb": 4096, "extraJvmArgs": [], "showGameConsole": true },
  "advanced":{ "logLevel": "info", "telemetry": false }
}
```

> **不做多语言框架**（10 文档 §6.3）：`userMessage` 直接写简体中文常量，不引入 i18n 抽象。`theme` 只做 `system|light|dark`，不做主题包机制。

写入规约（`kernel/config` 统一实现）：

1. **原子写**：同目录 `.tmp` → `fsync` → `rename`；Windows 上 rename 覆盖需先 `unlink` 或使用 `fs.rename` 的重试（`EPERM`）。
2. **备份**：每次写前把旧文件复制成 `app.json.bak`（保留 1 份）。
3. **校验**：读入用 zod schema `.catch(default)` 逐字段兜底（用户手改坏了也要能启动），但**未知键保留**（前向兼容：老版本读新配置不丢数据）。
4. **不写盘直到变化**：算 hash 比对，避免无意义的磁盘写与 mtime 抖动。

### 8.3 `instance.json`（`instance` 模块独占）

```jsonc
{
  "schemaVersion": 1,
  "id": "5f3c9a1e",                      // 稳定短 uuid，永不随改名变化
  "dirName": "1.20.1 整合包",             // = versions/ 下的目录名（可读、可改）
  "name": "1.20.1 整合包",                // 展示名，允许与 dirName 不同
  "mcVersion": "1.20.1",
  "loader": { "type": "fabric", "version": "0.15.11" },
  "java":   { "mode": "auto", "value": null },        // auto | major(17) | path(绝对)
  "memory": { "minMb": 1024, "maxMb": 6144 },         // 读 PCL 的百分比配置时按物理内存换算
  "isolation": "isolated",                            // shared | isolated（§7.1 映射表）
  "serverAuth": { "type": "none" },                   // none | authlib（url/register 见 auth）
  "autoJoin": null,                                   // { host, port } —— 对应 PCL 的 VersionServerEnter
  "jvmArgs": [],
  "source": "pcl",                                    // ours | pcl | pack | manual（导入来源，排障用）
  "createdAt": 1761000000000,
  "lastPlayedAt": null,
  "playTimeSec": 0,
  "icon": null
}
```

schema 层强制（这些是"看起来小事、出事很大"的项）：

- `dirName`：非空、无 `\ / : * ? " < > |`、不以空格或点结尾、长度 ≤ 100；
- `id` 与 `dirName` **解耦**：改名流程 = 重命名目录 + 更新 `dirName`，`id` 不变，所有引用（房间、快捷方式、最近游玩）都不失效；
- 任何路径字段**不得为绝对路径**（`.refine(p => !path.isAbsolute(p) && !p.includes('..'))`），否则便携模式必然失效；

### 8.4 模块配置与迁移

```ts
// 模块自己声明 schema，内核只管原子读写
const cfg = await ctx.config(MyConfigSchema, DEFAULT_MY_CONFIG)   // → ConfigHandle<T>
cfg.get(); await cfg.set({ ... }); cfg.onChange(cb)
```

迁移：`migrations: [(from: 1) => ({...})]` 数组，索引即 `from` 版本；内核按序执行到当前版本，迁移前自动备份。**迁移失败不得清空配置**——回落默认值并把坏文件改名 `.corrupt-<ts>` 保留给用户/支持排查。

---

## 9. 错误模型

### 9.1 结构

```ts
export type ErrorCategory =
  | 'auth' | 'net' | 'java' | 'fs' | 'process'
  | 'version' | 'mods' | 'user' | 'conflict' | 'internal' | 'kernel'

export interface AppErrorShape {
  code: string            // 'JAVA.NOT_FOUND'，全局唯一，命名空间 = 模块
  category: ErrorCategory
  message: string         // 面向开发者/日志（英文，可含技术细节）
  userMessage: string     // 面向用户（中文，可直接展示）
  hint?: string           // 可执行建议："点这里安装 Java 21"
  retryable: boolean      // UI 决定是否给"重试"按钮
  details?: Record<string, unknown>   // 已脱敏的结构化上下文
  traceId: string         // 与日志行对齐
}
```

### 9.2 规约

- **code 必须声明**在 `src/shared/errors.ts` 的 `ERROR_CODES` 常量表里（该文件冻结，新增 code 走"内核所有者合并窗口"，与依赖预算同窗口）。CI 扫描 `toAppError`/`new AppError` 的字符串字面量，未声明即红——防止 13 个模块各造一套同义词。
- **`retryable` 是给 UI 的**：`DOWNLOAD.HASH_MISMATCH` retryable=true（再下一次），`AUTH.INVALID_GRANT` false（必须重新登录）。
- **不透传原始异常**：`cause` 只保留一层 `{ code, message }`，路径要脱敏（把 `C:\Users\<name>` 换成 `<home>`），避免把用户名/邮箱泄进日志与崩溃报告。
- **IPC 边界一律信封化**（§5.2）；`service.ts` 内部可以 `throw`，但必须是 `AppError` 或其可被 `toAppError` 归一的类型。

### 9.3 常用错误码（节选，完整表见 `src/shared/errors.ts`）

| code | category | retryable | userMessage（例） |
|---|---|---|---|
| `AUTH.NO_ACCOUNT` | auth | false | 还没有登录 Microsoft 账号 |
| `AUTH.INVALID_GRANT` | auth | false | 登录已过期，请重新登录 |
| `AUTH.XSTS_NO_XBOX` | auth | false | 该账号没有 Xbox 档案，请先在 xbox.com 创建 |
| `AUTH.XSTS_CHILD` | auth | false | 未成年账号需要家长在 Microsoft 家庭中授权 |
| `NET.OFFLINE` | net | true | 网络不可用，请检查连接或代理 |
| `NET.HTTP_5XX` | net | true | 服务器暂时不可用（已重试 3 次） |
| `NET.MIRROR_INVALID` | net | false | 镜像地址不合法或缺少必要路径 |
| `DOWNLOAD.HASH_MISMATCH` | net | true | 文件校验失败，将重新下载 |
| `JAVA.NOT_FOUND` | java | false | 找不到可用的 Java 运行时 |
| `JAVA.VERSION_MISMATCH` | java | false | 该版本需要 Java {n}，当前是 {m} |
| `JAVA.PROBE_TIMEOUT` | java | true | Java 检测超时（可能是安装损坏） |
| `VERSION.NOT_FOUND` | version | false | 游戏版本不存在 |
| `VERSION.INHERIT_CYCLE` | version | false | 版本继承链存在循环 |
| `MODS.INCOMPATIBLE` | mods | false | {mod} 需要 {range}，当前 {ver} |
| `LAUNCH.EXIT_NONZERO` | process | true | 游戏异常退出（代码 {code}） |
| `LAUNCH.OOM` | process | true | 内存不足，试试把最大内存调到 {n}MB |
| `FS.PATH_ESCAPE` | fs | false | 非法的文件路径 |
| `INTERNAL` | internal | true | 发生了未预期的错误（{traceId}） |
| `KERNEL.DEPENDENCY_CYCLE` | kernel | false | 模块依赖存在循环：{path} |
| `KERNEL.MODULE_FAILED` | kernel | false | 模块 {id} 启动失败，相关功能不可用 |

---

## 10. 日志分级与脱敏

### 10.1 级别

| 级别 | 用途 | 生产默认 |
|---|---|---|
| `trace` | 每个 IPC 调用、每条 HTTP、每次 argv | 关 |
| `debug` | 状态机迁移、缓存命中、规则求值结果 | 关 |
| `info` | 启动/关闭、模块激活、下载批次完成、登录成功 | **开** |
| `warn` | 可恢复异常（重试成功、镜像回退、配置项非法已兜底） | 开 |
| `error` | 操作失败但有明确错误码 | 开 |
| `fatal` | 模块激活失败、主进程未捕获异常 | 开（并弹窗） |

运行时可调：`MC_LOG_LEVEL=trace` 环境变量，或用户在设置页切到"诊断模式"（自动带 `trace` + 30 分钟后自动降回）。

### 10.2 形态

- **文件**：`logs/app-YYYYMMDD.log`，**JSONL**（每行一个对象：`ts, level, scope, msg, traceId, ...fields`）。滚动：单文件 20MB × 保留 8 个。为什么 JSONL 而不是人类可读文本：支持诊断包做机器聚合，且字段化后脱敏可逐字段做。
- **首行必打环境指纹**（版本漂移的第一现场）：
  ```json
  {"level":"info","scope":"app","msg":"boot","electron":"44.9.3","chrome":"...","node":"...","platform":"win32","arch":"x64","dataRoot":"<home>/AppData/Roaming/mc-launcher","portable":false}
  ```
- **游戏输出单独成文件**：`logs/launch/<sessionId>.log`（**原文、不脱敏、不结构化**——玩家要看崩溃栈原文），与 app 日志分开，避免游戏刷屏把应用日志冲掉。
- **内存环形缓冲**：保留最近 2000 条，崩溃时随诊断包导出。
- **渲染层**：`log` 模块推送 `evt:line`（节流 100ms，仅诊断模式全量），供"日志"面板。

### 10.3 脱敏（在 sink 之前做，不是之后）

```
规则：
1. 键名匹配 /token|secret|password|cookie|authorization|refresh|session/i → 值替换为 "***"
2. 值形如 JWT（三段 base64url，含 "eyJ" 前缀）→ "***"
3. argv 中 --accessToken 的下一个 token → "***"
4. 路径中的 C:\Users\<xxx> → "<home>"；用户名、邮箱同理
5. 会话 id 保留（便于对齐），但不含账号标识
```

**回归测试**：`__tests__/redaction.test.ts` 里放一份"真实形状"的日志样本（含假 token），断言脱敏后不含 `eyJ`、不含用户名。这条测试必须常绿——泄露一次就是事故。

---

## 11. 测试策略

### 11.1 分层

| 层 | 工具 | 范围 | 门禁 |
|---|---|---|---|
| L1 单元 | vitest | `service.ts` + 纯函数（版本合并、规则求值、argv 构造、错误映射、脱敏） | 每 PR，行覆盖 ≥ 70%，`launch/plan` 与 `version/merge` 要求 100% 分支 |
| L2 契约一致性 | vitest + conformance kit | 每个模块的契约 ↔ handler 双向对齐、schema 可解析、错误码已声明 | 每 PR |
| L3 架构适应度 | dependency-cruiser | §4.5 的 R1–R10 | 每 PR，**红即不能合并** |
| L4 集成 | vitest + 本地 http 服务器 | download/net/java/auth 对真实协议形态的桩服务 | 每 PR |
| L5 E2E | Playwright `_electron` | 冷启动→建实例→（桩）登录→启动到"游戏进程已派生" | 主干合并 + 发版 |
| L6 人工清单 | 文档 | 真机：真实 Microsoft 登录、真实启动 1.20.1 / Forge、便携 U 盘 | 发版前 |

### 11.2 conformance 套件（并行开发的关键装置）

```ts
// src/test/kit.ts（内核所有者维护，模块只调用）
describeModule({ contract, def, handlers })
// 自动断言：
// 1. def.id === contract.id，且匹配 /^[a-z][a-z0-9-]*$/
// 2. contract 的每个 method 都有 handler，反之亦然（无野方法）
// 3. 每个 method.input.parse(undefined) 不抛（无参方法必须声明 z.void()）
// 4. 每个 error code 在 ERROR_CODES 中
// 5. 模块不 import 其它模块（配合 arch）
// 6. 事件 payload 经过 structuredClone 不抛（可序列化）
// 7. def.dependsOn 里每个 id 都真实存在
```

每个模块只要加一行 `describeModule(...)`，就自动获得上述 7 项保障。**这是"13 个模块各写各的、合起来还能跑"的机械保证**（10 主线 + 3 扩展，全部走同一套断言）。

**额外两条全局断言**（不属于单个模块，放 `src/test/global.test.ts`）：

8. 注册表里每个 `def.id` 唯一，且 `import.meta.glob` 的结果与 `MODULE_DEFS` 长度一致（防止"文件加了但没被 glob 到"）；
9. `contract` 的通道前缀全集互不相交（防止两个模块抢 `mc:instance:*`）。

### 11.3 铁律：单元测试零网络、零真实磁盘

- `net` 的 `HttpPort` 在测试里注入内存实现；L4 才用 `http.createServer` 起本地桩（端口 0 自动分配，杜绝端口冲突）。**禁止**在测试里打真实 Mojang/Microsoft 接口——一是慢，二是会因对方限流变成 flaky，三是离线也跑不了。
- 文件系统用 `memfs` 或 `tmpdir()` + 自动清理；测试之间不得共享目录。

### 11.4 必须存在的边界用例（来自本机现实）

- **路径含中文与空格**：`D:\DSH-工作文件\mc-launcher\...`。断言 argv 数组、JVM 参数、classpath 分隔、zip 解压、日志路径全链路正确。
- **路径长度 > 260**：开启 `longPathAware`（应用 manifest），并有测试确认长路径创建成功（Windows 需系统策略配合，失败时给明确提示而非神秘 `ENOENT`）。
- **只读介质上的便携模式**（模拟：把 `dataRoot` 指到只读目录）。
- **磁盘空间不足**：`ENOSPC` 映射成 `FS.NO_SPACE` + 可读提示 + "清理缓存"入口。
- **扁平化幂等**：对同一个 forge JSON 连续展开两次，结果字节一致；输出**不含 `inheritsFrom`**。
- **PCL 只读**：导入 `versions\史前世界 2\` 后，断言 `PCL\Setup.ini` 的 `LastWriteTime` 与内容**均未变化**（对应架构规则 R9）。
- **实例改名**：改 `dirName` 后，房间引用 / 最近游玩 / 快捷方式仍指向同一 `id`（§8.3 的解耦要求）。

### 11.5 E2E 的稳定性做法

- 用 `_electron.launch({ args: ['.', '--portable', `--user-data-dir=${tmp}`] })`，每个用例独立数据目录；
- 网络全部由环境变量切到本地桩（`MC_HTTP_BASE`），不让 CI 依赖外网；
- 只断言"窗口出现 + 首页渲染 + 建实例成功 + 启动按钮产生进程"，真实游戏启动留给人测（CI 没有 GPU/无头图形栈，跑真游戏必 flaky）。

---

## 12. 工程门禁与 npm 脚本口径

### 12.1 脚本（`package.json` 冻结，但脚本必须"通用"）

```jsonc
{
  "scripts": {
    "dev":        "electron-vite dev",
    "build":      "electron-vite build",
    "preview":    "electron-vite preview",
    "typecheck":  "tsc -b --pretty false",
    "lint":       "eslint . --max-warnings 0",
    "format":     "prettier --write .",
    "arch":       "node scripts/check-architecture.mjs",
    "guard":      "node scripts/check-frozen.mjs",
    "test":       "vitest run",
    "test:watch": "vitest",
    "test:e2e":   "playwright test",
    "check":      "npm run guard && npm run typecheck && npm run lint && npm run arch && npm run test",
    "new:module": "node scripts/new-module.mjs",
    "clean":      "node scripts/clean.mjs",
    "dist":       "npm run build && electron-builder",
    "dist:dir":   "npm run build && electron-builder --dir",
    "postinstall":"electron-builder install-app-deps"
  }
}
```

**为什么每个脚本都必须"通用"**：一旦某个模块需要 `"test:instance": "vitest run src/main/modules/instance"`，`package.json` 就必须被改，冻结即破。所以：

- 测试用 **vitest 的 include 通配**（`src/**/*.test.ts`），新模块的测试自动被发现；
- 单模块调试用**参数**而非新脚本：`npm run test -- src/main/modules/instance`；
- 架构检查、冻结守卫都是"扫目录"，不枚举模块名。

### 12.2 门禁

| 门 | 时机 | 内容 |
|---|---|---|
| 本地 pre-commit | 提交前 | `npm run guard && npm run lint && npm run typecheck`（**Node 写的 hook，放 `.githooks/`，`git config core.hooksPath .githooks` 一次性启用**——不走 husky，避免改 `package.json`） |
| PR | 每 PR | `npm run check`（含 arch + 全部单测） |
| 主干 | 合并后 | `npm run build && npm run test:e2e` |
| 发版 | tag | + `dist` 产物 smoke（装、启动、建实例、卸载） |

`check-frozen.mjs` 的做法：`arch/frozen.manifest.json` 存冻结文件的 sha256；文件被改动且 manifest 没同步更新 → 红。注意这是**防手滑，不是防恶意**——内核所有者合并窗口内更新 manifest 是正常操作，必须写进 PR 模板。

### 12.3 Windows/PowerShell 口径（本机实测坑）

- 本机 `npm.ps1` 被执行策略拦截（`UnauthorizedAccess`）。**文档与脚本统一用 `npm.cmd`**，或在 README 写明一次性处理：
  ```powershell
  Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
  ```
- 所有脚本必须是**Node 实现**（`node scripts/*.mjs`），不用 `rm -rf`/`cp -r`/`&&` 依赖 bash 的写法；npm 在 Windows 上用 `cmd.exe` 执行，`&&` 可用，但 `$VAR` 不可用。
- 路径中文：脚本里一律用 `path.resolve` + `fileURLToPath(import.meta.url)`，不手拼字符串。

---

## 13. 并行开发手册

### 13.1 分工与冲突矩阵

**编制口径对齐 `10-feature-matrix.md` §4.6：P0 约 163 人日 ≈ 4 人一个季度**（不是 10 人）。所以"13 个模块"不等于"13 个人"：**每人负责 2–3 个模块，按依赖分组**。

| 角色 | 编制 | 负责 | 绝不触碰 |
|---|---|---|---|
| 内核所有者 | 1 | `kernel/**`、`index.ts`、`package.json`、`preload/**`、`shared/kernel.ts`、`shared/errors.ts`、`scripts/**` | 各模块业务实现 |
| 平台组 | 1 | `net` + `download` + `java` + `updater` | 内核文件、别人的模块 |
| 版本组 | 1 | `version` + `instance` + `mods` | 同上 |
| 体验组 | 1 | `launch` + `auth` + `crash` + `log` + `store` | 同上 |
| 联机组（Spike 后定） | 0.5–1 | `link`（含 EasyTier 可行性 Spike，见 10 文档 R9） | 同上 |
| 测试/发布 | 0.5 | `tests/**`、`playwright.config.ts`、`.github/**` | 业务实现 |

**冲突面收敛结论**：写入集合按"模块目录 + 自己的 shared 文件 + 自己的 feature 目录"切分，两两不相交；唯一共享点是 `package.json` 与 `shared/errors.ts` 的新增错误码——两者都由内核所有者在**每周一次的合并窗口**批量处理。**并行度不是靠人多，而是靠写入集合不相交**：4 人也能安全并行，13 人也一样。

### 13.2 开工顺序（依赖决定，对齐 10 文档的周节奏）

```
第 0 周（内核所有者，串行，必须最先完成）
  kernel 骨架 + 冻结文件 + _registry + conformance kit + new:module + CI
  → 产出："新模块 10 分钟能跑起来并出现在 UI 上"的最小垂直切片

第 1 周
  平台组: net → download          （下载是 version/java 的前置）
  体验组: store → log             （设置与日志是所有人调试的前置）
  版本组: java 探测（只读本地）    （不依赖下载）
  联机组: EasyTier Spike（双机穿透 + 中继，10 文档 R9 要求第 2 周出结论）

第 2 周
  版本组: version（依赖 download）→ instance（PCL 只读导入）
  体验组: auth（三态）| launch 参数构造（先用夹具 JSON，不等真实下载）
  联机组: Spike 结论 → link 是否进 P0 的决策点（不成立就砍，别拖到第 3 周）

第 3 周
  体验组: launch 端到端 + crash 规则（先把 5 类高频做完）
  版本组: mods（扫描/依赖报告）+ 整合包导入
  平台组: updater（替换 helper 与回滚）
```

**关键路径**：`net → download → version → launch`。这条链上任何一环延期，直接推迟发版；其余模块都可以并行吸收。**`link` 不在关键路径上**——它失败不应拖垮主链路，这也是把它做成独立扩展模块的原因。

### 13.3 每个模块的 Definition of Done

- [ ] `shared/<name>.ts` 契约通过 `describeModule` 全 9 项（含全局两断言）；
- [ ] `npm run check` 本地全绿（arch 的 R1–R10 无豁免）；
- [ ] `service.ts` 无 `electron` 依赖，L1 单测覆盖决策分支；
- [ ] 所有用户可见失败路径都有**已声明**的 error code + 中文 `userMessage` + `hint`；
- [ ] 所有写盘只落在 `ctx.paths.own` 或表内声明的共用目录；
- [ ] 长任务（>500ms）都有取消（`AbortSignal`）与进度事件；
- [ ] 日志不含令牌/用户名（脱敏测试覆盖到本模块）；
- [ ] 手工走查：卸载模块（删目录）后应用仍能启动，且 UI 明确显示"该功能不可用"。

### 13.4 `new:module` 生成器

`npm run new:module instance` 只创建（**不修改任何冻结文件**）：

```
src/main/modules/instance/{index.ts,service.ts,handlers.ts,repository.ts,__tests__/conformance.test.ts}
src/shared/instance.ts（带 z.void() 的 hello 方法骨架）
src/renderer/features/instance/index.tsx（一个能渲染的空面板）
```

生成即能 `npm run dev` 看到空面板、`npm run test` 跑通 conformance —— 把"我的模块还没接上"这类问题消灭在第一天。

---

## 14. ADR 索引

| ADR | 决策 | 关键取舍 |
|---|---|---|
| ADR-001 | Electron 44 + TS + React 而非 .NET SDK + WPF | 用 90MB 体积/200MB 内存换"零 SDK 起步 + 并行交付"；回退条件见 §2.3 |
| ADR-002 | `import.meta.glob` eager 自注册，逐模块 try/catch 激活 | 放弃惰性加载的启动收益，换取确定性与构建期失败 |
| ADR-003 | 契约单源 + zod + `Result` 信封，不跨 IPC 抛异常 | 多写一层信封，换取错误可分类、可诊断 |
| ADR-004 | assets/libraries 全局共享，gameDir 每实例独立 | 省 10× 磁盘；代价是实例间的库版本耦合（用 `isolated` 兜底） |
| ADR-005 | 内核服务（log/config/fs/net/proc）与同名模块分离 | `log/store/net` 若作为依赖提供方会形成环；故能力在内核，模块只做 UI/编排 |
| ADR-006 | 目录即所有权 + 10 条依赖规则进 CI | 多一份 CI 成本，换多人并行不互相踩 |
| ADR-007 | 依赖预算而非 npm workspace | 牺牲"自由加包"，换单产物、单 lockfile、低构建复杂度 |
| ADR-008 | JSON + `schemaVersion` + 分片配置 + 原子写 | 放弃注释与 TOML 的可读性，换机器可写与无写竞争 |
| ADR-009 | 令牌只进 `safeStorage`，日志强制脱敏 | 调试时看不到明文令牌，换泄露面收敛 |
| ADR-010 | **实例根 = `versions/<目录名>/`**（PCL 兼容），`id` 与目录名解耦 | 目录名必须是用户可见名 → 清洗/重名/中文成为必做项；换来与现有工具互见、"零迁移"可行 |
| ADR-011 | **版本 JSON 安装时扁平化，运行期不合继承** | 磁盘略增、导入时多一步展开；换来启动期无合并、排障简单、与 PCL 行为一致 |
| ADR-012 | 联机/更新器/崩溃分析作为**独立扩展模块**而非塞进 launch/log | 多 3 个模块的边界维护；换来关键路径不被联机拖累、规则库可独立迭代 |

**ADR-005 需要展开一句**：需求里的 `log`/`store`/`net` 如果是"给别的模块用的能力"，它们就必须是内核服务，不能是依赖它们的模块——否则 `launch → store` 和 `store → ...` 立刻成环。**能力放内核，模块放交互**，这条决定了整个依赖图能不能是 DAG。

---

## 15. 风险与开放问题

| 编号 | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R-1 | `package.json` 冻结导致依赖申请排队 | 模块开发被卡 | 依赖预算提前覆盖 90% 需求（§4.6）；每周固定窗口 |
| R-2 | **Microsoft OAuth 需要 Azure 应用注册**（client id、redirect） | 登录功能无法自测/上线 | 先用 `nativeclient` provider 兜底；同步申请自有应用 ID；provider 接口已隔离 |
| R-3 | .NET 8 已进入 EOL 窗口（2026-11） | 若未来转向 WPF，目标框架选择需重做 | 不受影响（已选 Electron）；只在 ADR-001 复评时参考 |
| R-4 | Electron 内置 Node ≠ 主机 Node 24 | 用了主机新 API 的代码运行时炸 | 首行日志打 `process.versions`；CI 用 `electron -v` 校验；禁用实验性 API |
| R-5 | 未签名 Electron 应用被 Defender/国产杀软误报 | 用户装不上 | 早期申请代码签名证书；优先发 portable zip；提交厂商白名单 |
| R-6 | Minecraft 认证协议随上游变更 | 登录失效 | `AuthFlow` provider 化；错误码透传到 UI 便于快速定位 |
| R-7 | Forge/NeoForge installer 需要 `launcher_profiles.json` 与特定 Java | 加载器安装失败率高 | `version.ensureLauncherProfiles()`；安装前强制 Java 版本校验；失败给原文日志链接 |
| R-8 | 镜像（国内网络）质量参差 | 下载慢/失败 | 镜像可关；失败自动回退官方；镜像健康检查 + 用户可自定义 |
| R-9 | 13 个模块 13 套错误码同义词 | 用户看到不一致的提示 | `ERROR_CODES` 单一来源 + CI 扫描（§9.2） |
| R-10 | **联机需要后端服务**（房间/邀请码/节点） | 项目从"纯桌面"变成"桌面 + 服务端"，运维与成本进入范围 | `RoomProvider` 接口化、可自填节点、断网不影响单机；**Spike 不成立就砍**（§13.2） |
| R-11 | 更新器是最大的代码执行面 | 被篡改的更新包 = 任意代码执行 | 清单 Ed25519 签名 + 内置公钥，拒绝未签名包（§6.10） |
| R-12 | 替换运行中的 exe 在 Windows 上不可行 | 更新必失败或需要提权 | 独立替换 helper + `pending.json` 断电回滚（§6.10） |
| R-13 | EasyTier 许可证与分发方式未审 | 可能要求开源或禁止随包分发 | 只做运行时下载、不随包分发（10 文档 R3）；法务先审再上 |

**开放问题——只保留真正没定的**（已由 `10-feature-matrix.md` 拍板的，这里不再重复问）：

| # | 问题 | 现状 | 建议 |
|---|---|---|---|
| Q1 | **联机的差异化到底是什么**？（PCL2 已有 EasyTier 房间+邀请码+中继） | 未定；决定 22 人日是否值得 | 押"实例一致性校验 / 零账号建房 / 断线可续"三点（10 文档 Q1）；架构已为这三点留出 `mods.computeModsetHash()` 与房间状态持久化 |
| Q2 | **联机是否自建中继**、预算上限 | 未定 | 先"社区节点 + 用户自填"，自建 1 个兜底（10 文档 Q2） |
| Q3 | **微软登录用自建 Azure 应用还是设备码** | 未定；影响 `auth` 工时 | 先设备码（无回调域名、审核简单），`loopback` provider 后置（10 文档 Q4）；架构两者都留了接口 |
| Q4 | 原版下载合规结论由谁出 | 未定；是发布闸门 | 法务书面结论；产品永远保留"离线导入/自备源"（10 文档 Q3） |
| Q5 | 整合包格式：自研 `.mclaunch` 还是兼容 Modrinth `.mrpack` | 未定 | P0 先"拖入 zip 即建实例"（够用）；`.mrpack` 解析放 P1 |

**已在架构层面定死、不再开会讨论的**（避免重复消耗决策带宽）：

- 实例根用 `versions/<名>/`，不用 `instances/<id>/`（ADR-010）；
- 版本 JSON 扁平化，不做运行期继承（ADR-011）；
- 支持离线登录（三态之一），但 UI 必须标注适用边界；
- Forge/NeoForge/Fabric 全在 P0（10 文档 P0-03~05）；
- 只做 Windows x64 + 简体中文，不做跨平台与多语言抽象。

---

## 附录 A · 完整契约示例（可直接复制）

```ts
// src/shared/download.ts
import { z } from 'zod'
import { defineContract } from './kernel'
import { AppErrorShapeSchema } from './errors'

export const DownloadTask = z.object({
  url: z.string().url(),
  destRel: z.string(),                 // 相对 dataRoot，禁止绝对路径
  sha1: z.string().length(40).nullable(),
  size: z.number().int().nonnegative().nullable(),
  priority: z.number().int().min(0).max(9).default(5),
})
export type DownloadTask = z.infer<typeof DownloadTask>

export const DownloadProgress = z.object({
  jobId: z.string(),
  done: z.number().int(), total: z.number().int(),
  bytesPerSec: z.number().nonnegative(),
  currentFile: z.string().nullable(),
  state: z.enum(['queued', 'running', 'verifying', 'done', 'failed', 'cancelled']),
})
export type DownloadProgress = z.infer<typeof DownloadProgress>

export const contract = defineContract({
  id: 'download',
  methods: {
    enqueue:  { input: z.object({ tasks: z.array(DownloadTask).min(1) }),
                output: z.object({ jobId: z.string() }) },
    cancel:   { input: z.object({ jobId: z.string() }),
                output: z.object({ cancelled: z.boolean() }) },
    status:   { input: z.object({ jobId: z.string() }),
                output: DownloadProgress.nullable() },
  },
  events: {
    progress: { payload: DownloadProgress, throttleMs: 100 },
    finished: { payload: z.object({ jobId: z.string(), failed: z.array(AppErrorShapeSchema) }) },
  },
})
```

```ts
// src/main/modules/download/index.ts
import { defineModule } from '@kernel/module'
import { contract } from '@shared/download'
import * as handlers from './handlers'
import { createService } from './service'

export default defineModule({
  id: 'download',
  title: '下载',
  contract,
  dependsOn: ['net'],
  async activate(ctx) {
    const service = await createService(ctx)
    return { service, dispose: () => service.abortAll() }
  },
  handlers,     // { enqueue, cancel, status }
})
```

---

## 附录 B · 启动时序（首屏到可交互）

```
1. app.requestSingleInstanceLock()         失败 → 聚焦已有窗口并退出
2. resolveDataRoot()                        读 --portable / env / marker
3. app.setPath('userData'|'sessionData'|'cache'|'logs'|'crashDumps', ...)
4. app.whenReady()
5. Kernel.create()                          → logger（首行环境指纹）、config、paths、ports
6. topoSort(MODULE_DEFS)                    → 环检测
7. 激活 log → store → net                   （同步完成，快）
8. createWindow()                           → 先出窗，避免"白屏等待"
9. 异步激活 download/java/auth/version/mods/instance/launch
   每个完成 → 事件 'system:evt:moduleState' → 渲染层渐进式可用
10. 失败的模块 → 侧边栏显示"不可用"+ 原因，不阻塞其余功能
```

**性能预算**：窗口可见 ≤ 800ms（第 8 步之前的工作必须极轻）；可交互（实例列表出来）≤ 2.5s。第 9 步与第 8 步重叠执行，是达到该预算的关键——**任何模块都不得在激活时做超过 50ms 的同步工作**，重活必须流式化。

---

*本文档为 v1 基线。变更流程：提 ADR → 内核所有者评审 → 改本文档 → 同步 `arch/frozen.manifest.json`。下游实现者不需要、也不允许直接修改本文档或任何冻结文件。*
