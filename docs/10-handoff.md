# 10 交接包（给下一个工作会话）

> 版本：2026-10-22 13:30
> 交接人：上一会话（大肥鱼）
> 目标读者：接手的 AI 会话 / 人类开发者
> **读这一份就够开工**，其余文档是细节参考

---

## 0. 一分钟摘要

| 项 | 值 |
|---|---|
| 项目 | Cubit Launcher —— Windows x64 的 Minecraft 启动器（Electron 44 + TS + React 19） |
| 路径 | `D:\DSH-工作文件\mc-launcher` |
| 许可证 | **GPL-3.0**（干净室实现，**没有**复制 PCL2 源码；HMCL 代码按 GPL 移植并保留版权头） |
| 仓库 | https://github.com/chaozong1223/cubit-launcher （remote 用 SSH，见 §7） |
| 当前提交 | `236c798`（main 分支，工作区干净） |
| 状态 | 功能基本齐全，typecheck 绿，`vitest` 498 passed / 20 skipped；**未完成项见 §5** |
| 微软正版登录 | ✅ 端到端打通（MCE 审批已通过），实测启动到中文主菜单 |
| AgentTeams 团队 | ❌ **对本会话永久失效**，见 §6；不要试图修复 |

---

## 1. 五分钟上手

```bat
:: 1) 开发模式（热重载）
cd /d D:\DSH-工作文件\mc-launcher
npm.cmd install
npm.cmd run dev

:: 2) 类型检查 + 单元测试（改完必跑）
npm.cmd run typecheck
npm.cmd run test

:: 3) 打包成可执行目录（会保留用户数据，见 §8）
npm.cmd --prefix mc-launcher run pack
:: 产物：release\win-unpacked\mc-launcher.exe

:: 4) 启动打包版
D:\DSH-工作文件\mc-launcher\start.cmd
```

> ⚠️ PowerShell 里**必须**用 `npm.cmd`，不能用 `npm`（执行策略限制）。
> ⚠️ 本机火绒会拦 Chromium 沙箱，启动器必须以 `--no-sandbox` 运行（`start.cmd` 已内置）。

---

## 2. 代码地图（改代码前必看）

```
src/
├─ main/
│  ├─ index.ts                 # 主进程入口：窗口/IPC/生命周期/退出语义
│  ├─ kernel/                  # ipc.ts（模块自注册通道）、logger、paths、security、config
│  ├─ core/                    # 纯 Node 逻辑，可单测，不依赖 Electron
│  │  ├─ version/              # 版本 JSON 解析、inheritsFrom 合并、classpath
│  │  ├─ java/                 # Java 探测/选择
│  │  ├─ instance/             # 扫描、settings、copy.ts（今天新加）
│  │  ├─ launch/               # args（拼参数）、natives、process、orchestrator、options（语言）
│  │  ├─ zip/                  # 无依赖 zip 读取（zip-slip 防护）
│  │  └─ errors.ts             # CoreError 错误码联合类型（加新码要动这里！）
│  └─ modules/<id>/            # 每个模块 index.ts 自注册：register(ctx) + handlers + service
│     ├─ instance/ version/ java/ launch/ download/ loader/ auth/ mods/
│     └─ net/ repair/ catalog/ assets/ crash/ hello/ system/
├─ preload/index.ts            # contextBridge：meta/system/invoke/on（形状白名单）
├─ renderer/app/               # React 界面（页面在 pages/，数据桥在 data/backend.ts）
└─ shared/<id>.ts              # zod 契约（IPC 通道 mc:<id>:<method> 的单一事实来源）
```

**新增一个能力的最小步骤**

1. `src/shared/<模块>.ts` 加方法（zod input/output）
2. `src/main/modules/<模块>/service.ts` 实现 + `handlers.ts` 暴露
3. `src/renderer/app/data/backend.ts` 加类型 + 调用（`invoke(描述, CH.xxx, payload)`）
4. 界面里调用
5. `npm.cmd run typecheck && npm.cmd run test`

**必读文档**：`docs/03-architecture.md`（ADR 与模块边界）、`docs/02-compliance-security.md`（红线：不许碰 PCL 源码、令牌不许落明文）

---

## 3. 本机环境坑（踩过的，别再踩）

| 坑 | 现象 | 正确做法 |
|---|---|---|
| **低完整性级别** | 本机 Chromium 沙箱起不来 → 启动器必须 `--no-sandbox` → Chromium 把自己降到 Low IL → 游戏继承 Low → 写 `E:\MC`、`%TEMP%` 被拒（EPERM / AccessDeniedException） | ① 已把 `E:\MC\.minecraft` 标为 Low IL（`icacls /setintegritylevel`）；② 启动游戏时注入 `-Djava.io.tmpdir=<dataRoot>/tmp/game`（`orchestrator.ts` + `args.ts` 的 `tempDir`） |
| **PowerShell 改 TS 源码** | 中文全部变 `�` 乱码（Get-Content 按 ANSI 解 UTF-8） | **只用 edit/write 工具改源码**。已因此损坏过一次 `renderer/app/data/backend.ts` |
| **打包清数据** | electron-builder 重建 `win-unpacked` → `data/` 被删，账户/配置丢失 | 已用 `scripts/pack-safe.mjs`：打包前把 `data/` 暂存到 `release/.data-stash`，打完还原。**不要绕过 `npm run pack`** |
| **npm.ps1 被策略拦** | `npm : 无法加载文件 npm.ps1` | 用 `npm.cmd` |
| **SSH 22 端口不通** | `ssh -T git@github.com` 超时 | 已配 `~/.ssh/config`：`HostName ssh.github.com`、`Port 443`、`IdentityFile ~/.ssh/cubit_ed25519` |
| **git push 报证书吊销** | schannel 吊销检查失败 | `git -c http.schannelCheckRevoke=false push ...` |
| **SmartScreen** | 双击 exe 弹"Windows 已保护你的电脑" | 桌面快捷方式指向 `start.cmd`（绕开），或点"更多信息→仍要运行" |
| **火绒** | 会拦未知程序的 Chromium 沙箱 | 启动器目录加入信任区（可选，加不了也能用） |

---

## 4. 微软正版登录（已验证，别改坏）

```
授权端点: https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize
令牌端点: https://login.microsoftonline.com/consumers/oauth2/v2.0/token
scope:     XboxLive.signin offline_access        ← 不要加 openid/profile（会报 AADSTS70011）
redirect:  http://localhost:53117/               ← 必须是已注册 URI，端口固定（Azure 会校验）
client_id: 66a65f38-49c2-47d9-a655-677dd877a1e9  （公共客户端，已过 MCE 审批）
```

- 实现位置：`src/main/modules/auth/hmcl-port/oauth.ts`（移植自 HMCL，保留版权头）+ `service.ts`
- 链路：code → token → Xbox Live user → XSTS → `login_with_xbox` → profile
- 实测账户：`chaozong_1223` / uuid `01e72a0e-1faf-4447-a3c0-3aa30d629c8b`
- **小缺陷**：登录成功后再调 `pollAuthCode` 会返回 `AUTH.FLOW_NOT_FOUND`（无害，建议改成返回上次结果或 `already-completed`）
- 测试里用 `MCL_AUTH_CALLBACK_PORTS=0` 避免和真机占用 53117 打架

---

## 5. 未完成任务（按优先级，含验收标准）

### 5.1 P1 分享包导出 / 导入

- **目标**：把一个实例（版本、mods、资源包、光影、配置、可选存档）打包成单文件分享给别人；导入后能直接玩
- **建议实现**：`src/shared/instance.ts` 加 `exportSharePack` / `importSharePack`；`modules/instance/share/` 或 `modules/mods/` 下实现；zip 复用 `core/zip/reader.ts`
- **安全红线**：包里**绝对不能**包含 accessToken / refreshToken / 账号 cookie；导出前扫描并剔除，日志留证
- **验收**：导出 → 拿到干净电脑导入 → 实例可启动；冲突（同名实例/同名 mod）有覆盖/跳过/重命名选择；失败可回滚

### 5.2 P1 投影管理（Litematica）

- **目标**：管理实例 `gameDir/schematics/` 下的 `.litematic` / `.nbt`
- **难点**：`.litematic` 是 **gzip 压缩的 NBT**，需要解析头部 `Metadata`（TotalVolume / EnclosingSize）显示尺寸
- **建议**：`modules/assets/` 加 `schematics/*` 方法，或新模块；NBT 解析器自己写（不引依赖，跟现有 zip 读取风格一致）
- **验收**：列出名称/尺寸 X×Y×Z/大小/时间；拖入导入（冲突处理）；删除进回收站；未装 Litematica 时给安装引导

### 5.3 P1 粘贴链接导入整合包

- **目标**：粘贴 `curseforge.com/minecraft/modpacks/...` 或 `modrinth.com/modpack/...` 直接导入
- **建议**：`modules/catalog/` 解析链接 → 取版本文件 → 下载校验 → 复用现有 mrpack/CF 导入链
- **验收**：合法链接能装成实例；非法/私密链接给可读中文提示；用户确认后才开始下载

### 5.4 P2 皮肤管理

- **目标**：本地皮肤文件、从链接导入、第三方皮肤站皮肤、恢复默认
- **约束**：**只影响本机**，不修改/上传微软或皮肤站上的官方皮肤
- **验收**：PNG 规格校验（64×64 / 64×32 等）、离线缓存、切账户不串皮肤

### 5.5 P2 第三方联机 SDK 清单

- **目标**：允许用户把第三方联机 SDK 的 JSON 清单放进目录，作为备选通道（内置 EasyTier 仍是默认）
- **安全**：必填字段校验、命令白名单（禁 shell 元字符）、路径不得越界、可选哈希校验；未通过拒绝加载
- **验收**：合法清单加载并启动 sidecar；字段缺失/命令注入/哈希不符 ⇒ 拒绝

### 5.6 P2 内存优化面板 + 性能自动调优

- **目标**：显示本机/实例内存与游戏进程占用；按 mod 数量推荐 `-Xmx`；一键应用；安全释放缓存与临时文件；内存不足预警
- **已有基础**：`modules/java/`（检测与选择）、`core/java/`、`instance.memory`
- **注意**：不编造数据，识别不到硬件就降级并说明

### 5.7 P3 清理项

- `pollAuthCode` 的 `FLOW_NOT_FOUND`（见 §4）
- 加载器安装器日志逐 chunk UTF-8 解码（中文花屏，`modules/loader/core/installer.ts:176-178`，评审遗留 H13/R1）
- `docs/07-final-acceptance.md` 与 README 的状态口径随新功能更新

---

## 6. AgentTeams 团队（已失效，不要修）

- 团队 `mc-launcher` 绑在会话 `session-c3d3c72d-280b-45d6-8a17-24fe6aff6b3d` 上，该会话已死；当前会话是它的 fork
- 任何成员操作（status/create/delete/send）都报 `member operations require the live captain session ...`
- **重启 DSH 无效**；不要改 `.agent-teams` 状态文件（会破坏插件状态）
- **影响**：不能用任务板派活。替代方案：`summon_expert` / `summon_experts`（Agency 专家，可用）+ 主会话直接写代码
- 如果一定要清掉：只能在 Web 左侧团队面板手动"结束/归档"

---

## 7. 账号与密钥位置（**不要写进仓库**）

| 项 | 位置 | 说明 |
|---|---|---|
| GitHub token | `C:\Users\Supreme\.cubit\github-token.txt` | 只读 issue 监控用；推送走 SSH 不需要它 |
| SSH 私钥 | `~/.ssh/cubit_ed25519` | 已加到 GitHub 账号 |
| 业务状态 | `release\win-unpacked\data\` | 账户（DPAPI 加密）、config.json、日志、回收站 |
| 皮肤站 | 用户自填 | 登录名是**注册邮箱**，不是昵称 |

推送流程：

```bat
git add -A
git -c user.name="chaozong1223" -c user.email="chaozong1223@users.noreply.github.com" commit -m "..."
git push origin main     :: SSH over 443，已配置
```

推送前建议扫一遍密钥（`sk-`/`ghp_`/私钥头/用户密码）。

---

## 8. 调试技巧（很省时间）

- **无头驱动界面**：启动加 `--remote-debugging-port=9455`，然后用小脚本调 IPC：
  ```js
  // _scratch/cdp-eval2.mjs <port> "<js 表达式>"
  // 例：await window.mc.invoke('mc:instance:list')
  ```
  （`_scratch/` 不在仓库里，可自行重建这个 20 行脚本）
- **游戏日志**：`data/logs/game/<实例名>/<时间>.log`（启动器捕获的 stdout/stderr）
- **启动器日志**：`data/logs/launcher.log` + `app-*.jsonl`
- **真机验证法**：`mc:launch:plan` 拿 argv 干跑，再 `mc:launch:start` 真启动，对比日志
- **本机真实 MC**：`E:\MC\.minecraft`（15 个实例，含 Forge 整合包 `[神道传说]…`）

---

## 9. 已知缺陷 / 限制

| 项 | 影响 | 备注 |
|---|---|---|
| 低完整性限制 | 共享模式实例、部分写系统目录的模组仍可能失败 | 已尽量用目录放行 + tmpdir 重定向绕过 |
| 共享隔离实例不能复制 | 界面上"复制"按钮对共享实例禁用 | 共享实例没有独立目录，复制会等于复制整个 .minecraft |
| CurseForge API | 只能打开项目页，没有检索/下载 | 需要用户 Google 账号申请 key |
| 安装器中文日志花屏 | 仅日志可读性 | H13/R1，低危 |
| 云存档 / 多设备协同 / 一键分享链接 | 未做 | 需要服务器长期运维，P2 |

---

## 10. 建议的开工顺序

```
1) npm.cmd run typecheck && npm.cmd run test     # 确认基线是绿的
2) 分享包（§5.1）→ 投影（§5.2）→ 链接导入（§5.3）
3) 皮肤（§5.4）→ 联机 SDK 清单（§5.5）→ 内存/性能（§5.6）
4) 每完成一项：typecheck + test + pack + 真机验证 + 提交推送
5) 全部完成后更新 docs/07-final-acceptance.md 与 README 的状态口径
```

## 11. 用户偏好（重要）

- 中文交流；**成本敏感**（曾多次问"还要花多少钱"，建议在谷时 00:30–08:30 做重活）
- 不喜欢 AI 助手类功能（Nova 式），明确说过不做
- 喜欢"先给结论再解释"，长篇解释要收敛
- 报错时希望直接给可操作方案，不要堆理论
- 对"假成功"零容忍：验证不了就明说

---

## 12. 参考文档索引

| 文档 | 内容 |
|---|---|
| `docs/01-requirements.md` | 需求与 P0/P1/P2 范围（约 6 万字符 / 138 KB） |
| `docs/02-compliance-security.md` | 合规红线与安全约束（PCL/HMCL 许可边界） |
| `docs/03-architecture.md` | 架构 ADR、模块边界、IPC 设计 |
| `docs/04-multiplayer-design.md` | 联机方案（EasyTier、无 TUN、邀请票据） |
| `docs/05-acceptance-report.md` | 历次验收记录与证据索引 |
| `docs/06-review-round3-t54.md` | 三轮代码审查最终结论（pass） |
| `docs/08-p0-6-lan-e2e.md` | LAN 世界进世界真机证据 |
| `docs/08-hmcl-comparison.md` | HMCL 对照分析（可借鉴点） |
| `docs/clean-room-log.md` | 干净室阅读记录（PCL 源码只读留痕） |
