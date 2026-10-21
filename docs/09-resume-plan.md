# 恢复清单（谷底时段续跑用）

> 记录时间：2026-10-21 14:5x
> 原因：用户主动停止团队，在办与待办的 9 个任务被标记为 `cancelled`（终态，`agent_teams_resume` 不会重建）。
> 恢复方式：`agent_teams_resume(reason)` 后，按本文件**逐条重建**这 9 个任务（契约以此为准），再让调度器继续。

## 已完成（18 个，不需要重建）

t1 需求矩阵 / t2 合规安全 / t3 架构 ADR / t4 联机选型 / t5 脚手架 / t6 启动内核 / t7 界面设计 / t8 安装链 / t9 联机 MVP / t17 加载器安装器 / t20 IPC 桥 / t21 文档口径 / t22 渲染层视觉 / t23 logger EPIPE / t25 数据目录 / t26+t27 文档口径复核

## 需重建的 9 个任务

### R1 = 原 t11｜账户 + 端到端（core-dev，deps: t5,t6,t8,t20）
- kind: implementation｜inScope: `mc-launcher/src/main/modules/auth/`、`mc-launcher/src/shared/auth.ts`、`mc-launcher/scripts/`
- verify: `npm.cmd --prefix mc-launcher run typecheck` / `run test` / `run e2e:install-launch`
- 验收：离线账户可启动进主菜单；微软设备码支持注入 client id，未获批时必须诚实报错（不得假成功），取到令牌则加密落盘且日志无明文；**错误映射须覆盖 AADSTS70002 / 50149 / unauthorized_client / 650053 / Minecraft 403**；Authlib-Injector 注入不崩；e2e 在全新目录装 1.20.1 并启动到主菜单，退出码 0。
- 备注：停止时 t11 是 claimed 状态，`src/main/modules/auth/` 可能已有半成品，重建后要求先读现状再续。

### R2 = 原 t15｜模组/资源包/光影 + 整合包（core-dev，deps: t5,t6,t8）
- kind: implementation｜inScope: `mc-launcher/src/main/modules/mods/`、`mc-launcher/src/shared/mods.ts`
- verify: typecheck / test
- 验收：扫描三目录并分类；启用禁用用 `.disabled`；**解析 fabric.mod.json / mods.toml 依赖，提示缺失前置**；支持 `installLocalFile(path)`（拖拽与选择器共用同一入口）；.mrpack 与常见 zip 整合包导入。

### R3 = 原 t16｜界面收口 + 模组页 + 一键启动（client-dev，deps: t22,t20,R2,t8,t9）
- kind: integration｜inScope: `mc-launcher/src/renderer/`
- verify: typecheck / build
- 验收：全部页面走 window.mc 真实通道，grep 无 mock；模组页三分页 + **拖拽 Dropzone**（与选择文件共用入口）+ 整合包导入；主页**一键启动**（选中实例→自动 Java/内存→启动，失败才展开详情）。

### R4 = 原 t18｜Java 自动匹配与下载（install-dev，deps: t5,t6）
- kind: implementation｜inScope: `mc-launcher/src/main/modules/java/`、`mc-launcher/src/shared/java.ts`
- verify: typecheck / test
- 验收：按 `javaVersion.majorVersion` 匹配；缺失时从 Adoptium / Microsoft OpenJDK 下载对应主版本，哈希校验、解压到托管目录、自动入列表；实例级覆盖优先；提供"为什么推荐这个 Java"的理由。

### R5 = 原 t19｜文件校验与一键修复（install-dev，deps: t5,t6,t8）
- kind: implementation｜inScope: `mc-launcher/src/main/modules/repair/`、`mc-launcher/src/shared/repair.ts`
- verify: typecheck / test
- 验收：校验 client jar / libraries / assets 哈希；输出缺失/损坏/多余三类清单；一键只重下坏文件；**绝不动 mods/saves/config**。

### R6 = 原 t24｜首启发现已有 .minecraft（core-dev，deps: t5,t6）
- kind: implementation｜inScope: `mc-launcher/src/main/modules/instance/`、`mc-launcher/src/shared/instance.ts`
- verify: typecheck / test
- 验收：扫描 `%APPDATA%\.minecraft`、盘根、安装目录旁；列出候选让用户选择导入或新建；支持手动指定目录并持久化；无候选时给可操作引导，不静默空白。

### R7 = 原 t12｜端到端验收报告（qa，deps: R1,R2,R3,R4,R5,t9,t17,t21,t22）
- kind: verification｜inScope: `mc-launcher/docs/`
- verify: `run test` / `run e2e:install-launch`
- 验收：按 01 v1.5 逐条 pass/fail + 证据路径；覆盖全新装 1.20.1、离线启动、镜像/续传、账户、联机、模组与拖拽、加载器、异常路径。
- **口径（不得误判）**：Forge/NeoForge 真实安装器执行属 opt-in（本机 75KB/s），未执行不判失败；NeoForge `hashSource=none` 时默认拒绝是预期安全行为；加载器要求父版本已存在属正常。

### R8 = 原 t13｜代码与安全审查（reviewer，deps: R7）
- kind: review, round 1｜reviewedTaskId = R1
- 验收：逐文件审查启动/安装/账户/联机；覆盖子进程清理、并发竞态、路径兼容、令牌不落明文、邀请码校验、静默失败；verdict pass 或 needs_revision + file:line findings。

### R9 = 原 t14｜README + 用户手册 + 交接（planner，deps: R7,R8）
- kind: work
- 验收：README 诚实标注已实现/未实现（P0/P1/P2 对照 01 v1.5）；用户手册覆盖安装、Java、账户（含"未获批"提示）、模组、联机降级、日志排查；交接文档写目录结构、模块自注册、如何新增模块；仓库根写 **LICENSE（GPL-3.0）+ NOTICE**（EasyTier LGPL-3.0、Modrinth API）。

## 恢复时的注意事项

1. **先 resume**（需要理由），再重建任务；halted 状态下不能建任务。
2. 重建后确认依赖指向新任务 id（R2→R3、R1→R7→R8→R9）。
3. 全仓门禁已知会短暂被新文件挡住，以 `R7` 收口后的复跑为准。
4. MCE 审批结果（client_id `66a65f38-49c2-47d9-a655-677dd877a1e9`）到货后再补接线，不属于本次重建范围。
