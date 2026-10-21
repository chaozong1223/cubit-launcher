# t6 验收证据 — 启动链（实例/版本解析、Java 检测、参数生成、进程与日志）

> 任务：t6（implementation）· 执行人：core-dev · 日期：2026-10-21
> 代码位置：`mc-launcher/src/main/core/**`、`src/main/modules/{instance,version,java,launch}/**`、`src/shared/{instance,version,java,launch}.ts`
> 冻结文件零改动：`npm.cmd run guard` → `Frozen guard passed (19 files).`

## 1. 验证命令（按契约顺序）

| # | 命令 | 结果 |
|---|---|---|
| 1 | `npm.cmd --prefix mc-launcher run typecheck` | exit 0，无输出 |
| 2 | `npm.cmd --prefix mc-launcher run test` | 9 passed / 1 skipped（92 tests：85 passed，7 skipped=真实机测试） |
| 3 | `$env:MCL_REAL_MC='E:\MC\.minecraft'; $env:MCL_REAL_JAVA='1'; npm.cmd run test -- src/main/core/__tests__/real-machine.test.ts` | 7 passed（真实 `.minecraft` 只读） |
| 4 | `npm.cmd run guard` | 19 files passed |
| 5 | `npm.cmd run build` | out/main 172.33 kB（51 modules）、preload、renderer 成功 |
| 6 | `npm.cmd run pack` + `npm.cmd run e2e:install-launch` | `smoke-ok.json`，`windowVisible=true`、`rendererErrors=[]`、`blockedChannelRejected=true` |
| 7 | 打包产物 `launcher.log` | `modules=["system","hello","instance","java","launch","version"]`，`failedModules=[]` |

## 2. 验收项 → 证据

| 验收项 | 证明 |
|---|---|
| 解析 `version.json` 并合并 `inheritsFrom`（Forge/Fabric） | `src/main/core/__tests__/inherit.test.ts` 16 tests：Forge 子类 mainClass 覆盖、库按 group:artifact:classifier 合并且保留位置、arguments 父→子拼接、legacy `minecraftArguments` 整体覆盖、`jar` 字段、循环/缺父错误、扁平化幂等、真实 NeoForge 扁平包识别 |
| Java 检测覆盖注册表/JAVA_HOME/PATH/便携/常见路径 + 主次版本号 | `src/main/core/__tests__/java.test.ts` 15 tests：七类来源同测（manual、java-home、mojang-runtime、launcher-runtime、registry、common-path、path）、realpath 去重、坏 JDK/超时只记 rejected、10 分钟缓存、`1.8.0_402/17.0.15/21.0.12.1/21-ea/25+36` 解析、选择规则；真实机探测到 17.0.15 / 21.0.7 / 21.0.12.1 / 25.0.1，1.20.1 选 17 |
| 启动命令含 classpath、natives、`-D`、用户名/UUID/accessToken 占位；dry-run 完整命令行 | `src/main/core/__tests__/args.test.ts` 14 tests：`-cp` 后 4 段 classpath（含 client jar，无引号）、4 个 natives `-D` 指向 `1.20.1-natives`、G1/编码/品牌/`-Dlog4j2`、离线四件套、无 `--clientId/--xuid`、`-Xmx` 恰好 1 次、无 `${...}`、1.20+ quickPlay / legacy `--server`、Authlib `-javaagent`、自定义受管参数拒绝；真实 1.20.1 dry-run 断言 A1.7 全部字段 |
| 子进程日志逐行流式回传；退出码 + 耗时 | `src/main/core/__tests__/process.test.ts` 7 tests：真实 spawn Node 子进程，stdout/stderr 行在退出前到达、日志文件 `[stdout]/[stderr]` 标记、exitCode=3、durationMs、classification=crashed、OOM 规则命中；正常退出（Sound engine started）→ normal；快速 exit 0 无标记 → suspect；stop → killed；缺失 java → `PROCESS.SPAWN_FAILED`；`LineSplitter` CRLF 跨块/超长行 |
| vitest 覆盖继承合并与参数生成且全部通过 | 上表 85 passed / 0 failed（7 真实机测试默认 skip，显式开启后 7 passed） |

## 3. 真实本机只读夹具（2026-10-21）

- `E:\MC\.minecraft\versions`：15 个目录 = **12 ready + 3 missing-json**（`1.21.1-Forge_52.1.1`、`1.21.1-Forge_52.1.10`、`The Last Voyage of the Harpy Express`）。
- 1.20.1：`libraries.total=88`、Windows 适用 `allowed=64`、natives 下载 `21`、x64 实际解压 `7`、`classpath=44`、`assetIndex.id=5`、`javaVersion.majorVersion=17`、chain `["1.20.1"]`。
- 真实 Java：`java-runtime-beta 17.0.15`、`java-runtime-delta 21.0.7`、`java-runtime-epsilon 25.0.1`、`JAVA_HOME jdk-21.0.12.1`；`where java` 为空仍全部找到；1.20.1 自动选择 17.0.15。
- Orchestrator dry-run（真实实例）耗时 308–449 ms，生成 `$DATA/logs/dry-run.json`、`launch-last.json`、`launch-last.bat`；主类 `net.minecraft.client.main.Main`，`--accessToken 0`，无 `${...}`。

## 4. 交付物清单

- 纯内核：`src/main/core/{version,java,instance,launch,zip}/**`、`ports.ts`、`errors.ts`、`index.ts`、`README.md`
- IPC 契约：`src/shared/{instance,version,java,launch}.ts`（zod 单源 + service 接口）
- 模块适配：`src/main/modules/{instance,version,java,launch}/{index,service,handlers}.ts`
- 服务定位器：`src/main/modules/_services.ts`（`ctx.services` 的临时替身）
- 上下文解析：`src/main/modules/_context.ts`
- 测试：`src/main/core/__tests__/*.test.ts`（92 tests）、`vitest.config.mts`
- clean-room：`docs/clean-room-log.md` CR-002（未接触 PCL 源码）

## 5. 已知边界（需下游/队长决策）

1. **IPC 接线**：`src/preload/index.ts`、`src/shared/channels.ts`、`src/main/kernel/ipc.ts` 在 t5 冻结清单内，preload 只放行既有 `CHANNELS`；t6 已给出契约 + handlers，但渲染层调用需要解冻/扩展内核 IPC（t10 前置）。
2. **自动进服**：1.20.1 客户端无 `--server/--port`（实测 `Main.class` 仅 `quickPlay*`），实现为 `--quickPlayMultiplayer host:port`；P0-6 A6.6 的 `--server/--port` 断言需改为版本条件。
3. **日志路径**：取 01 R5.2 `$DATA/logs/game/<实例>/<yyyyMMdd-HHmmss>.log`（03 §6.7 写的是 `logs/launch/<sessionId>.log`）。
4. **错误码**：`JAVA.NOT_FOUND` / `JAVA.INVALID`（03 §9.2），01 A3.4 的 `JAVA_NOT_FOUND` 视为笔误。
5. **instance.json 扩展**：新增 `window`、`memoryMode`（01 R4.1/R4.6 需要，03 §8.3 未列）；`memoryMode=auto` 时按 `clamp(物理×25%,2048,8192)`。
6. **启动器日志轮转**（R5.1）由冻结的 `kernel/logger.ts` 负责，t6 未改。
7. **账户接线**：launch 通过 `setAccountResolver` 注入账户；t11 未接前 `plan/start` 诚实报 `LAUNCH.ACCOUNT_REQUIRED`。
