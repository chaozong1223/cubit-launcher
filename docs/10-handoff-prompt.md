# 新会话开场提示词（直接复制粘贴）

---

## 版本 A：一句话版（推荐）

> 接手 `D:\DSH-工作文件\mc-launcher` 这个 Minecraft 启动器项目。
> 先完整读 `docs/10-handoff.md`，再按里面 §10 的顺序开工：**分享包 → 投影 → 链接导入 → 皮肤 → 联机 SDK → 内存/性能**。
> 注意：AgentTeams 团队已失效不要修；改 TS 源码**不要用 PowerShell**；打包必须用 `npm.cmd --prefix mc-launcher run pack`（它会保留用户数据）。
> 每完成一项：typecheck + test + pack + 真机验证 + 提交推送。

---

## 版本 B：详细版（新会话上下文很干净时用）

> 你是接手的 AI 会话，继续开发 `D:\DSH-工作文件\mc-launcher`（Cubit Launcher，GPL-3.0，已开源在 https://github.com/chaozong1223/cubit-launcher，当前提交 `236c798`）。
>
> **第一步：读 `mc-launcher/docs/10-handoff.md`**（12 节，含代码地图、环境坑、微软登录参数、未完成任务、调试技巧、用户偏好）。读它比读别的任何文档都省时间。
>
> **当前状态**
> - Electron 44 + TS + React 19，15 个自注册模块，typecheck 绿，`vitest` 498 passed / 20 skipped
> - 已完成：实例/版本/安装/加载器/Java/账户（离线+微软正版+皮肤站）/启动/模组/整合包/资源库/联机/存档截图日志回收站/崩溃分析/复制版本
> - 微软正版登录已端到端打通（MCE 审批通过，实测启动到中文主菜单）
>
> **这次要做（按顺序，每个都要真机验证）**
> 1. 分享包导出/导入（**包里绝不能有 token**）
> 2. 投影管理（`.litematic` 是 gzip NBT，要解析尺寸）
> 3. 粘贴 CurseForge/Modrinth 链接导入整合包
> 4. 皮肤管理（本地/链接/恢复默认，只影响本机）
> 5. 第三方联机 SDK 清单（严格校验，防命令注入）
> 6. 内存优化面板 + 性能自动调优
>
> **硬约束**
> - 改 TS 源码只用编辑工具，**不要用 PowerShell 读写**（会把中文变乱码，已经踩过一次）
> - 打包只用 `npm.cmd --prefix mc-launcher run pack`（`scripts/pack-safe.mjs` 会保住 `release/win-unpacked/data`）
> - AgentTeams 团队对本工作区已失效（绑死会话），**不要试图修复或删除**；需要并行就用 `summon_expert(s)`
> - 用户成本敏感，重活尽量放在谷时；对"假成功"零容忍，验证不了要明说
>
> 开工前先跑 `npm.cmd run typecheck && npm.cmd run test` 确认基线，然后直接开始第 1 项。
