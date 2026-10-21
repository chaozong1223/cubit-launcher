# 06 · 用户手册（Cubit Launcher）

> 适用构建：`release/win-unpacked/mc-launcher.exe`（app 0.1.0，Electron 44.9.3）。
> **发布状态**：P0 **未通过**（依据 [`05-acceptance-report.md`](05-acceptance-report.md)，16 步冒烟未达 16/16）。本手册描述“当前能点到什么、失败时怎么读错误”，**不承诺下列功能都已通过验收**；遇到禁用/未接入/报错，按对应“当前限制”处理。

---

## 1. 启动、数据目录与便携模式

### 1.1 启动

```bat
:: 仓库根目录
start.cmd
:: 或带参数
start.cmd --data-dir D:\mcl-data --mc-dir E:\MC\.minecraft
```

`start.cmd` 会清掉 `ELECTRON_RUN_AS_NODE`；如果终端有 `DSH_SHELL=1`，会加 `--no-sandbox --disable-gpu --disable-software-rasterizer`（测试环境用，普通双击不需要）。

SmartScreen 拦截时，用：

```powershell
powershell -ExecutionPolicy Bypass -File .\launch.ps1 --data-dir D:\mcl-data --mc-dir E:\MC\.minecraft
```

### 1.2 两个根

| 根 | 参数/环境变量 | 内容 |
|---|---|---|
| `dataRoot` | `--data-dir` / `MCL_DATA_DIR` | 设置、账户、日志、缓存、回收站 |
| `mcRoot` | `--mc-dir` / `MCL_MC_DIR` | `.minecraft`：versions/libraries/assets/saves |

便携：`MCL_PORTABLE=1` → `<exeDir>/data`；`MCL_PORTABLE=0` → `%APPDATA%\mc-launcher`。未指定时打包版默认 `<exeDir>/data`，开发模式默认 `<cwd>/data`。便携目录不可写会回退 `%APPDATA%\mc-launcher` 并在日志记录警告。

**换 MC 目录不会搬走账户/日志；卸载启动器也不会删游戏目录。**

### 1.3 首次打开

1. 首次启动若没有 `mcRoot`，主页/欢迎区会让你选择或新建 `.minecraft`。
2. 选择后写进 `config.json`，下次直接使用。
3. 如果只想浏览现有实例：设置 `--mc-dir` 指向现有目录（例如 `E:\MC\.minecraft`），启动器只扫描 `versions/`，**不写 PCL 的 `Setup.ini`**。

---

## 2. 安装原版 1.20.1

1. 左侧「安装与下载」。
2. 选择目标 MC 目录（沿用 `mcRoot`）。
3. 选择版本 `1.20.1`（release）。
4. 开始安装；进度卡片会显示版本清单 → 版本 JSON → 客户端 jar → 支持库 → 资源索引 → 资源对象。
5. 完成后到「实例」/「主页」选中 `1.20.1`，点主页「启动游戏」。

**当前限制（05 B1）**：如果 assets 阶段出现 `DOWNLOAD.NO_SOURCE`，通常是镜像 CDN 超时后源被熔断。可到 **设置 → 下载** 切换“官方源/镜像源”、开关镜像后重试。05 之后 t46 已改 per-source 断路器，但**未按 01 v1.5 重跑全新安装**；因此不能把“换源后成功”当作通过验收。

**不要删除的目录**：`libraries/`、`assets/`、`versions/<实例>/<实例>.json/.jar`。需要修复时用实例详情/修复面板的“校验文件/修复缺失”。

---

## 3. 安装加载器（Forge / NeoForge / Fabric / Quilt）

入口：实例详情 →「安装/加载器」区域（或下载页的加载器选项；以当前构建的 UI 为准）。

| 加载器 | 当前状态 | 说明 |
|---|---|---|
| Fabric | ✅ 05 有真实安装证据 | 选 MC 版本 + loader 版本（如 `0.19.5`），产物 `fabric-loader-…`，mainClass `KnotClient` |
| Quilt | ✅ 05 有真实安装证据（按 01 属 P2） | 选 `0.30.1` 等版本，产物 `quilt-loader-…` |
| Forge | 🟡 仅 plan/hash，opt-in 未执行 | 05 拉到了 137 个版本与推荐版 `47.4.28`、installer sha1；因官方 maven 慢+约 60 MB 依赖，**未实际执行安装器**。执行路径由单测 fake-ProcessPort 覆盖 |
| NeoForge | 🟡 默认拒绝无上游哈希的 installer | `hashSource=none` 时必须显式 `allowUnverifiedInstaller=true`（用户确认）才继续；05 验证的是“拒绝”行为 |

**加载器要求父版本已存在**：先装对应原版（如 1.20.1），再装加载器。安装器会写实例 JSON，**不建议**同时用 PCL 改同一实例。

---

## 4. Java：选择与自动下载

### 4.1 检测与选择

1. 设置 → Java，或实例详情 → 设置（当前实例详情“设置”tab 仍是占位；请用全局设置页）。
2. 页面会列出 `java.detect` 的真实候选（路径/版本/vendor/source）。
3. 可选“自动选择”或指定某个 `java.exe`；实例级覆盖优先。
4. 保存后用 `launch.plan` 的 dry-run 校验命令行里的 Java 路径。

1.20.1 需要 Java 17；05 实测自动选 `17.0.15`（`java-runtime-beta`）。本机若 `where java` 为空，启动器仍会扫描 `JAVA_HOME`、Mojang runtime、注册表与常见安装路径。

### 4.2 自动下载（P1，后端有、UI 未暴露）

`java.download` 后端已实现 Adoptium/Microsoft 包解析、哈希校验、解压到托管目录、进度事件；**当前 UI 没有“下载 Java”按钮**，05 也未验收。需要 Java 时：

- 优先使用已安装的 Java 17/21；
- 或用系统安装的 JDK；
- 或等 P1 UI 接线后再用自动下载。

---

## 5. 账户

设置 → 账户。账户页明确写着“没有后端成功响应时不会伪造账户”。

### 5.1 离线账户

1. 输入 3–16 位 `[A-Za-z0-9_]` 用户名。
2. 创建后自动选中；启动参数为 `--username <name> --uuid <标准离线 UUID> --accessToken 0 --userType legacy`。
3. 可创建多个离线账户并切换。

### 5.2 微软设备码（正版）

1. 在“微软登录（设备码）”区点「开始微软登录」。
2. 页面会显示 `verification_uri` 与 `user_code`；在浏览器打开地址并输入代码。
3. 成功后账户列表出现 microsoft 账户。

**未配置/未获批时**：

- `MS_CLIENT_ID_MISSING`：没有注入 Azure client id；
- `MS_AUTH_NOT_APPROVED`（或接口 403）：Azure 应用尚未获得 Minecraft API（MCE）权限。

这两种情况**不会伪造登录**。MCE 审批是外部流程（以周计；本机已提交，结果未回），审批到货前请用离线/Authlib。client id 可在账户页“微软应用配置”里填写（public client，无 secret）。

### 5.3 Authlib（第三方皮肤站）

1. 在“Authlib 皮肤站”填 HTTPS 地址（如 `https://littleskin.cn/api/yggdrasil`）与用户名。
2. 创建后启动器会下载/校验 `authlib-injector`（固定版本 + SHA-256），启动时注入 `-javaagent:<jar>=<api>`。
3. 首次启用会提示“将把登录信息发送给 <host>”；只允许 HTTPS；不可达会明确报错。

**当前限制（05 B6）**：05 时账户页没有微软/Authlib UI 入口；当前代码已接 AccountSettingsPanel，但 **Authlib 实机登录到主菜单未复验**。若你看到的是旧构建，请以当前 `release` 为准；仍失败就按错误提示处理，不要当作已验收。

### 5.4 多账户切换

账户列表可切换；切换后启动参数会使用当前账户。若发现串号（命令行仍是上一个用户名/UUID），请记录到问题中——这是 P0-7 的验收点。

---

## 6. 模组 / 资源包 / 光影

实例详情 →「模组 / 资源包 / 光影」三个 tab。

- **扫描**：读取当前实例的 `mods/`、`resourcepacks/`、`shaderpacks/`，显示名称、大小、启用状态。
- **启用/禁用**：通过 `.disabled` 重命名实现；不会删除文件。
- **冲突**：同名启用 + 禁用并存会提示；依赖问题会显示 `issues`。
- **删除**：选中后删除（`mods.remove`），不会进回收站；请确认。
- **安装**：
  - 点「选择文件」→ 系统文件对话框；
  - 或把文件**拖入**页面/拖拽区（Dropzone）；
  - 两个入口最终都调用 `mods.installLocalFile(path)`，落盘到**当前实例**。
- **打开文件夹**：定位实例的 `mods/` 或对应目录。
- **整合包**：拖拽/选择 `.mrpack` 或常见 zip → 解析 manifest/overrides → 新建实例并写文件。**P0 不安装加载器**；导入后若缺加载器，UI 会提示需要 P1 安装，不能宣称可直接启动。

**当前限制（05 B7）**：CF zip、Zip-Slip、普通 zip、无加载器提示的端到端证据不足；虽有单测，不要把这些当作已验收。

---

## 7. 资源库与模组更新（Modrinth）

### 7.1 资源库

1. 左侧「资源库」。
2. 选择目标实例（顶部“目标实例”）。
3. 输入关键词、选项目类型/加载器/游戏版本，点「搜索」。
4. 结果卡片显示图标、作者、下载量、简介、加载器/MC 版本；选项目可看详情/版本。
5. 一键安装前会做兼容性预检：原版/无 MC 版本/加载器不匹配/非模组项目会禁用按钮并说明原因；后端会再次校验。
6. **当前 catalog.install 只支持把模组落到 `mods/`**；资源包/光影/整合包在 UI 明确禁用并引导打开 Modrinth 项目页，不伪造安装。

### 7.2 模组更新

1. 「模组更新」→ 选实例 →「检查更新」。
2. 检查会按 Modrinth 文件 SHA-1 反查；自行重打包/未收录 jar 会 `skipped`。
3. 结果给出可更新项、changelog 摘要、`risk`（ok/warning/blocked）与原因。
4. 更新前会提示“旧文件进回收站”，需要确认；成功后显示 `previousFile/recycledPath`，可打开数据目录手动回滚。

### 7.3 CurseForge

只提供“打开项目页”；**没有 API key，不搜索、不下载、不代理**。P1 若接入 CF，需自备官方 key 且满足 02 的 API-16~22。

---

## 8. 存档 / 截图 / 回收站

- **存档**：选实例 → 列出 `saves/` 世界（名称/大小/修改时间/有无 icon）；「备份 zip」生成备份；批量删除只会**移入回收站**，页内二次确认；可打开目录/在文件夹显示。
- **截图**：选实例 → 缩略图网格（主进程读文件返回 data URL；不伪造占位图）；可打开/在文件夹显示/批量移入回收站。
- **回收站**：列出可恢复项（save/screenshot/log/other），支持单条恢复/一键恢复全部；**没有永久删除入口**；恢复冲突不覆盖，会显示失败原因。清理磁盘需手动处理 `dataRoot/trash`。

---

## 9. 崩溃分析

入口：日志页 →「分析最近一次崩溃」（或实例详情的崩溃面板）。

1. 读取该实例最近一次游戏日志、`launch-last.json`、实例 Java/内存/模组上下文，输出：
   - 分类（Java 版本/缺失库/模组冲突/内存不足/显卡 OpenGL/正版认证/文件损坏/端口占用/JVM 参数/未知）；
   - 现象、可能原因、证据、替代可能、置信度、上下文；
   - 可执行动作：调整 Java/内存、安全模式（禁用/恢复模组）、修复文件、打开链接/目录、复制文本、导出诊断包。
2. 未知/日志不足时明确 `uncertain=true`，**不编造原因**，给“导出诊断包/打开日志/复制求助模板”。
3. 「复制报告」「导出诊断包」可把 `analysis.md/json`、`game.log`、`launch-last.json`、`instance.json` 打包。

**当前限制（05 B4）**：崩溃**不会自动弹窗**；请在日志页手动分析。05 之后已补 `crash-reports/` 落盘与日志轮转，但未复验；自动弹窗仍未实现。

---

## 10. 联机（房间 / LAN 世界 / 降级链）

入口：左侧「联机」。

### 10.1 创建房间（房主）

1. 选择真实实例（版本/加载器会参与一致性检查）。
2. 点「创建房间」；得到 6 位房间号 + `MCL-XXXXXX` 邀请码 + 完整 ticket。
3. 复制邀请码给朋友；房间状态会显示成员/传输方式/隧道状态。

### 10.2 加入房间（成员）

1. 输入邀请码（短码或完整 ticket）。
2. 加入成功后，房间面板显示成员、ping、LAN 世界列表。
3. 房主在游戏里“对局域网开放”后，发现器会读取实例 `logs/latest.log` 的端口；成员可“进入世界”，启动器用 1.20+ `--quickPlayMultiplayer host:port`（≤1.19 用 `--server/--port`）直连。

### 10.3 降级链

设计顺序：**LAN 房间 → 直连 P2P → 中继 → 手动端口映射 → 只复制地址/外部工具**。

- 隧道引擎为 EasyTier 2.7.0（LGPL-3.0，独立进程、运行时下载、固定 SHA-256、可关闭；不会静默提权/TUN）。
- 跨网 P2P/中继是条件项：本机单出口 + Symmetric NAT，公共节点不可用，**L2 未闭环**。
- 失败时 UI 会显示原因/手动映射指引；不会无限转圈，也不会默认连公网中继。

### 10.4 当前限制（05 B5）

05 时 L0 未闭环：房主不计入成员、ping 为 null、LAN 世界发现与一键进世界未实测；旧邀请码错误码也不完全符合 01。当前代码已有 `lanWorlds/joinLanWorld`、房主成员、ping 字段与手动映射 UI，但**未按 05 复验**。首次使用前请用双进程/双机自测，并记录错误码。

---

## 11. 日志与诊断包

- **日志页**：实时输出/历史日志双视图；来源（启动器/游戏）、级别（trace..fatal）、搜索过滤；跟随/暂停/清空；来源文件列表；「导出日志 zip」「导出诊断包」。
- **设置 → 日志与诊断**：显示 `dataRoot`、`launcher.log` 路径，可打开目录。
- **捕获的游戏输出**：`dataRoot/logs/game/<实例>/<时间>.log`（stdout/stderr 标注）；游戏自身日志在实例 `logs/latest.log`（两者不同）。
- **诊断包**：包含日志/系统信息/实例信息；导出前会做敏感串过滤。**不要把 accessToken/refresh token/密码贴到公开 issue**。

---

## 12. 常见问题

| 现象 | 处理 |
|---|---|
| 双击 exe 闪退，终端有 `ELECTRON_RUN_AS_NODE` | 用 `start.cmd`；或 `Remove-Item Env:\ELECTRON_RUN_AS_NODE` 后再启动 |
| SmartScreen | 未签名；用 `launch.ps1` 或“更多信息→仍要运行” |
| `npm.ps1` 被禁止运行 | 用 `npm.cmd` |
| 全新安装 `DOWNLOAD.NO_SOURCE` | 设置→下载 切换源/镜像后重试；见 05 B1，不要把重试成功当作验收通过 |
| Java 找不到/版本不符 | 设置→Java 选候选；自动下载 UI 未暴露（P1）；错误码 `JAVA.NOT_FOUND`/`JAVA.INVALID` |
| 微软登录报 `MS_CLIENT_ID_MISSING`/`MS_AUTH_NOT_APPROVED` | 未配置/待审批；用离线/Authlib；不要伪造成功 |
| Authlib 报不可达 | 检查 HTTPS 地址/网络；启动器不会卡死 |
| 联机开房/加入失败 | 看房间错误码/手动映射提示；L0 未按 05 复验，L2 未闭环 |
| 崩溃没弹窗 | 日志页手动「分析最近一次崩溃」；导出诊断包 |
| 设置项灰色/不可点 | 该控件在当前构建未接线；以 05 的阻断项为准，不要当作已支持 |

---

## 13. 已知限制（必须与 README/05 一致）

- **P0 未通过**：B1（全新安装源熔断）、B2（实例设置 tab 仍占位）、B4（崩溃无自动弹窗）、B5（L0 未闭环）、B7（P0-8 证据不足）等仍未按 01 v1.5 复验。
- **微软真实登录**：依赖 Azure 应用 + MCE 审批（外部，以周计）；未获批时只有诚实错误路径。
- **联机**：L1 同 LAN 双设备、L2 跨网/中继未具备本机闭环条件；隧道失败按手动映射降级。
- **加载器**：Forge 安装器未实际执行（opt-in 口径）；NeoForge 无哈希默认拒绝。
- **资源包/光影/整合包**：资源库安装目前只支持 mods；整合包导入不安装加载器。
- **未签名**：无代码签名/自动更新；SmartScreen 属预期。
