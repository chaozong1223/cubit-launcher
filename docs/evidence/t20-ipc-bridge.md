# t20 验收证据 — 内核 IPC 桥（模块自注册通道）

> 任务：t20（implementation）· 执行人：core-dev · 日期：2026-10-21
> 范围：`src/preload/index.ts`、`src/shared/channels.ts`、`src/main/kernel/ipc.ts`
> 未改：`src/main/index.ts`、`package.json`、`src/renderer/app/**`（hash/变更清单见 §6）

## 1. 实现摘要

| 层 | 变化 |
|---|---|
| preload | 不再维护逐通道白名单；`isAllowedInvokeChannel` / `isAllowedEventChannel` 按**形状**放行静态通道 + `mc:<id>:<method>` / `mc:<id>:evt:<event>`。`fs:readFile`、`child_process` 等非模块形状立即拒绝 |
| channels | 新增 `MODULE_INVOKE_PATTERN`、`MODULE_EVENT_PATTERN`、`isModule*Channel`、`isAllowed*Channel`；`CHANNELS`/`INVOKE_CHANNELS`/`EVENT_CHANNELS` 保留 |
| kernel ipc | 模块契约 + `modules/<id>/handlers.ts` 自动发现；服务从 `_services` 取；每个方法统一走 sender 校验 → zod input → handler →（dev）zod output → `Result` 信封。新增 `moduleIpc.handle/emit/channels/has` 供模块自注册；模块自带 `modules/<id>/ipc.ts` 时内核跳过（避免二次 `ipcMain.handle`） |

发现规则：
- `BUILTIN_CONTRACTS`：instance / version / java / launch / net（静态 import，避免某个 shared 文件语法错误拖垮主进程启动）。
- `HANDLER_FACTORIES`：`import.meta.glob('../modules/*/handlers.ts', { eager: true })`。
- `SELF_MANAGED_MODULES`：`import.meta.glob('../modules/*/ipc.ts')`（非 eager，只取路径）——download 等自带 IPC 的模块由其自己注册。
- 新增模块选择：加进 `BUILTIN_CONTRACTS`，或在 `register()` 里 `import { moduleIpc } from '../../kernel/ipc'` 并 `moduleIpc.handle(contract, handlers)`；两种都不需要改 preload。

## 2. 模块自注册（验收 1）

打包产物 `launcher.log`（2026-10-21 05:43:21）：

```text
[ipc] module channels registered {"module":"instance","methods":4,"events":1}
[ipc] module channels registered {"module":"java","methods":3,"events":1}
[ipc] module channels registered {"module":"launch","methods":5,"events":4}
[ipc] module channels registered {"module":"net","methods":8,"events":4}
[ipc] module channels registered {"module":"version","methods":3,"events":1}
[ipc] module IPC bridge ready {"modules":["instance","java","launch","net","version"],"moduleInvokeChannels":23,"moduleEventChannels":11}
[app] ready {"modules":["system","hello","instance","java","launch","net","version"],"failedModules":[]}
```

`net` 是 t20 实现之后由 t9 新增的模块，未改 preload/ipc 映射即被自动发现 → 证明“新增通道不需要改 preload 源码白名单”。
`download` 自带 `modules/download/ipc.ts`，t20 内核按 `SELF_MANAGED_MODULES` 跳过自动接线；启动日志显示 `[module:download] download IPC registered {"channels":[...15 个 mc:download:*]}`，无第二次 `ipcMain.handle` 冲突。
单元测试：`src/preload/ipc-bridge.test.ts` 11 tests（模块通道注册/四模块 Result/sender/未注册/evt emit/通道模式）。

## 3. 渲染层调用四个模块（验收 2）

用打包 exe + `--remote-debugging-port=9333`，CDP `Runtime.evaluate` 在真实 renderer 主世界执行 `window.mc.invoke`（脚本 `data/tmp-ipc-cdp.mjs`，结果写入 `data/ipc-smoke-*/ipc-smoke-result.json`）：

| 调用 | 结果 |
|---|---|
| `app:getVersion`（静态） | `{ok:true,data:"0.1.0"}` |
| `mc:instance:list` | `{ok:true,data:[]}` |
| `mc:version:listVersions` `{}` | `{ok:true,data:[]}` |
| `mc:java:candidates` | `{ok:true,data:[4 个 Java]}`（17.0.15/21.0.7/21.0.12.1/25.0.1） |
| `mc:launch:status` `{instanceId:"smoke-instance"}` | `{ok:true,data:{state:"idle",sessionId:null,...}}` |

## 4. 未注册通道 / sender / 安全（验收 3、4）

同一 CDP 运行：

```text
mc:nope:list  → Error: No handler registered for 'mc:nope:list'
fs:readFile   → blocked channel: fs:readFile
security      → { requireType: "undefined", processType: "undefined", hasBridge: true, nodeVersion: "24.22.0" }
```

- 未注册的模块形状通道由 main 的“无 handler”拒绝；非模块形状由 preload 直接拒绝。
- `src/preload/ipc-bridge.test.ts`：untrusted sender → `IPC.UNTRUSTED_SENDER`；空参数 → `IPC.INVALID_INPUT`；未注册 `mc:nope:list` / `fs:readFile` / `child_process:spawn` 均无 handler。
- 打包 e2e smoke：`windowVisible=true`、`rendererErrors=[]`、`nodeRequire=false`、`nodeProcess=false`、`blockedChannelRejected=true`。
- `src/main/index.ts` 未改（hash 见 §6），`webPreferences` 仍 `contextIsolation:true, sandbox:true, nodeIntegration:false`。

## 5. 验证命令

| 命令 | 结果 |
|---|---|
| `npm.cmd --prefix mc-launcher run typecheck` | 2026-10-21 13:47 全仓 exit 0；t20 文件在 node side 单独复跑 exit 0 |
| `npm.cmd --prefix mc-launcher run test` | 2026-10-21 13:47：13 files passed + 1 skipped；113 passed / 7 skipped。t20 单测 `src/preload/ipc-bridge.test.ts` 11/11 passed |
| `npm.cmd --prefix mc-launcher run build` | main 278,236 B、preload 2.85 kB、renderer 790.39 kB（t10 并发 UI） |
| `npm.cmd run guard` | 19 files passed（三个文件按新基线重新冻结） |
| `npm.cmd run pack` + `npm.cmd run e2e:install-launch` | `smoke-ok.json`，`title="主页 · Cubit Launcher"`，`rendererErrors=[]`、`nodeRequire=false`、`nodeProcess=false`、`blockedChannelRejected=true` |
| CDP IPC 验收 | 见 §3/§4 |

> 并发说明：以上三命令在 13:47（t8 生产代码 + t10 首版 UI 已就位）全绿。t20 完成后 t8 继续新增测试、t10 继续改 renderer，全仓 typecheck/test 会短暂出现只属于这两个任务的错误（如 `modules/download/__tests__/*`、`renderer/app/data/backend.ts`）；t20 的 `tsc -p tsconfig.node.json --noEmit` 在 13:48 单独复跑 exit 0，t20 自身文件无错误，最终收口由 t8/t10/t22 负责。

## 6. 未触碰受保护文件（验收 6）

| 文件 | 当前 SHA-256 | t5 基线 | 结论 |
|---|---|---|---|
| `src/main/index.ts` | `69d1776e157380629a21fe4262fa4fe8a1c5c568b405395ec530b4e6279743db` | 同值 | 未改 |
| `package.json` | `540a30ef335b45b6e6f43d801f8b1e503a96cb9c89e04a55c45d66e053473eaa` | 同值 | 未改 |
| `src/renderer/app/**` | — | — | t20 的代码 changedPaths 不含该目录（该目录由 t10 并发修改，非本任务） |

本任务代码 changedPaths（scope 内）：`src/preload/index.ts`、`src/preload/ipc-bridge.test.ts`、`src/shared/channels.ts`、`src/main/kernel/ipc.ts`。
另有 scope 外行政/文档变更：`arch/frozen.manifest.json`（三个解冻文件重定基线，guard 需要）与 `docs/evidence/t20-ipc-bridge.md`（本证据）。

## 7. 说明与后续

1. **`ctx.ipc` 字面量**：t5 的 `_registry.ts` 在冻结清单内，无法把 `ipc` 注入 `{ log, dataRoot }`。t20 用“内核自动发现契约 + handler + service”达到同等效果；`moduleIpc` 作为公开 registrar 导出，未来模块可在自己的 `register()` 里 `moduleIpc.handle(...)` 自注册，无需改 preload/内核。若 captain 后续要严格保留 `ctx.ipc`，需要再解冻 `_registry.ts` 与模块 index（t20 范围内不做）。
2. **download 自带 IPC**：`modules/download/ipc.ts` 由 install-dev 负责（sender 校验 + Result + 100ms 进度事件）；内核通过 `SELF_MANAGED_MODULES` 跳过该模块，不会二次注册。2026-10-21 打包实测：download 注册 15 个 `mc:download:*`，无 “second handler” 异常。
3. **事件推送**：`moduleIpc.emit` 校验合约事件 schema；launch 的 `status/stage/output` 已可推送（`output` 100ms 节流）；`exited` 事件因 orchestrator payload 缺 `reportId` 会被 schema 拒绝（t10 可用 `status`/`lastReport` 兜底，或后续在 t6 orchestrator 补 `reportId:null`）。
4. **重新冻结**：三个解冻文件完成修改后用 `node scripts/check-frozen.mjs --write` 重定基线；后续再改需再次解冻。
