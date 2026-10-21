# `src/main/core` — 启动链领域内核（Electron 无关）

## 为什么有这一层

docs/03 §4.1 冻结的是**文件名**（`kernel/*.ts`、`modules/_registry.ts` 等），没有冻结目录本身。t5 交付的 `ModuleContext` 只有 `log` + `dataRoot`，没有 `ipc` / `services` / `paths`；而启动链需要的纯逻辑（继承合并、参数生成、进程监护）既要被 `version` / `instance` / `java` / `launch` 四个模块复用，又必须能在没有 Electron 的环境里单测。

因此 t6 增加 `src/main/core/` 作为**纯 Node/TS 领域层**，模块目录只做契约适配：

- `core/**`：不 import `electron`，不读 UI 配置；文件/进程能力经 `ports.ts` 注入。
- `modules/<id>/{index,service,handlers}.ts`：装配 + 契约映射；service 调 core。
- `shared/<id>.ts`：zod 契约（单源）。
- 冻结文件**零改动**：`npm.cmd run guard` 仍通过 19 个文件。

## 模块地图

| 路径 | 内容 |
|---|---|
| `version/` | `version.json` 解析、`inheritsFrom` 链加载/循环检测、扁平化（ADR-011）、loader/MC 版本识别、rules 求值、classpath/natives 解析、目录扫描 |
| `java/` | 版本号解析、`-XshowSettings:properties -version` 解析、多来源探测（manual / instance / `JAVA_HOME` / Mojang runtime / 启动器 runtime / 注册表 / 常见路径 / `PATH`）、去重、10 分钟缓存、按 required major 选择 |
| `instance/` | `versions/*` 四态扫描、`instance.json` 读写、`shared`/`isolated` gameDir、`<dir>-natives` 路径 |
| `launch/` | 纯函数 `buildLaunchPlan`（argv/env/classpath/占位符/受管参数）、dry-run 与 `launch-last` 落盘、natives 解压、spawn 监护、逐行日志、退出分类、崩溃关键行规则 |
| `zip/` | 无依赖 ZIP 读取（store/deflate、CRC、zip-slip/ADS/保留名/软链/配额），natives 与后续整合包复用 |
| `ports.ts` | `FsPort` / `ProcessPort`；Node 实现只在 service 装配时注入 |
| `launch/orchestrator.ts` | 端到端编排：实例 → 版本 → Java → 参数 → dry-run → natives → 进程 → 日志/退出报告 |

## 关键行为（与验收对应）

- **继承合并**：子覆盖父；`libraries` 按 `group:artifact:classifier` 合并（保留首次位置，避免覆盖掉 natives classifier）；结构化 `arguments.game/jvm` 父→子拼接；legacy `minecraftArguments` 整体覆盖；输出无 `inheritsFrom`，带 `x-mc-launcher.flattenedFrom`；循环 `VERSION.INHERIT_CYCLE`、缺父 `VERSION_PARENT_NOT_FOUND`。
- **Java**：探测顺序 manual/instance → `JAVA_HOME` → Mojang runtime → 启动器 runtime → 注册表 → 常见路径 → `PATH`；按 realpath 去重；坏 JDK/超时只记 `rejected`，不阻塞；选择 exact → 最小更高版本（带警告）→ 失败。
- **参数**：`-cp` 一次、`-Xmx/-Xms` 各一次、G1 + `-Dlog4j2.formatMsgNoLookups`、4 个 natives `-D`、`-Dstdout/stderr/file.encoding`（936→GBK；Java 18+ `COMPAT`）、品牌参数、web 分辨率/全屏、Authlib `-javaagent`、离线四件套 `--username/--uuid/--accessToken 0/--userType legacy`；离线**不带** `--clientId/--xuid`；任意残留 `${...}` 直接 `LAUNCH.PLAN_INVALID`。
- **dry-run**：只生成并落盘 `$DATA/logs/dry-run.json` + `launch-last.json/.bat`，不创建进程、不解压 natives。
- **进程**：`spawn(java, argv, {shell:false, cwd, env, windowsHide:true})`；stdout/stderr 用 `TextDecoder`（按代码页 GBK）增量解码，`\r\n` 跨块安全；逐行写 `$DATA/logs/game/<实例>/<yyyyMMdd-HHmmss>.log` 并回调；退出上报 code/signal/duration/classification；OOM、JVM 参数、Java 版本、缺类、模组冲突、图形 6 类关键行规则。
- **安全**：启动前清洗 `JAVA_TOOL_OPTIONS/_JAVA_OPTIONS/JDK_JAVA_OPTIONS/CLASSPATH`；`launch-last` 只写白名单环境变量；MS token 不落盘（`<redacted>`）；ZIP 解压条目/单文件/总量上限 + 路径校验。

## 已知边界与后续接线

1. **IPC 尚不能接**：`src/preload/index.ts`、`src/shared/channels.ts`、`src/main/kernel/ipc.ts` 都在 t5 冻结清单里；preload 只放行 `CHANNELS`。t6 已交付 `shared/{instance,version,java,launch}.ts` 契约与各模块 `handlers.ts`，但渲染层要到 t10 前由 captain/架构决策解冻或扩展内核 IPC。当前 `npm run guard` 仍全绿。
2. **服务定位器**：`modules/_services.ts` 是 `ctx.services` 的临时替身；模块注册时 publish，auth 之后可 `getService('launch').setAccountResolver(...)` 接通账户。
3. **启动器日志轮转**：`kernel/logger.ts` 冻结，R5.1 的 10 文件轮转留给内核 owner；t6 只负责游戏日志与 `launch-last`。
4. **崩溃报告模块**：t6 提供 `detectCrashHints` 与 `LaunchExitReport`，`crash` 扩展模块（规则库/报告 UI）仍未建。
5. **需求与架构文档冲突（已在代码中取一侧）**：
   - 1.20+ 客户端没有 `--server/--port`（实测 1.20.1 `Main.class` 仅有 `quickPlay*`），自动进服用 `--quickPlayMultiplayer host:port`；P0-6 A6.6 写的 `--server/--port` 需要 QA 改口径或仅在 ≤1.19 断言。
   - 游戏日志路径取 01 R5.2 的 `logs/game/<实例>/<ts>.log`，不是 03 §6.7 的 `logs/launch/<sessionId>.log`。
   - Java 错误码取 03 §9.2 的 `JAVA.NOT_FOUND` / 新增 `JAVA.INVALID`；01 A3.4 的 `JAVA_NOT_FOUND` 为文档笔误。
   - `instance.json` 增补 `window` 与 `memoryMode`（01 R4.1/R4.6 需要 per-instance 窗口与自动内存；03 §8.3 未列）。
   - natives 计数分两个：`natives`（规则允许的全部下载 jar，1.20.1=21）与 `nativesExtract`（本机架构实际解压，x64=7）。

## 验证

```powershell
npm.cmd --prefix mc-launcher run typecheck
npm.cmd --prefix mc-launcher run test
# 真实本机只读证据（可选）：
$env:MCL_REAL_MC='E:\MC\.minecraft'; $env:MCL_REAL_JAVA='1'
npm.cmd --prefix mc-launcher run test -- src/main/core/__tests__/real-machine.test.ts
```

真实夹具结论（2026-10-21）：15 个实例 = 12 ready + 3 missing-json；1.20.1 = 88 libs / 64 Windows / 21 natives 下载 / 7 解压 / 44 classpath / assetIndex 5 / Java 17；本机 Java = 17.0.15、21.0.7、21.0.12.1、25.0.1，1.20.1 自动选 17。
