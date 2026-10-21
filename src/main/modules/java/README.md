# `src/main/modules/java` — Java 自动匹配与下载（t30）

> 读版本 JSON 的 `javaVersion.majorVersion` → 与本机 Java 匹配 → 缺失时从 **Adoptium / Microsoft OpenJDK** 一键下载（SHA-256 校验）→ 解压/验证到 `dataRoot/java/` → t6 检测器自动列为 `launcher-runtime`。
> 支持**实例级覆盖 > 全局默认 > 自动**，并把“为什么推荐这个 Java”作为契约字段返回。
> 契约：`src/shared/java.ts`；不修改 `main/index.ts` / `package.json`。

## 1. 结构

| 路径 | 内容 |
|---|---|
| `index.ts` | 模块注册（服务发布 + handlers，t20 内核自动接线） |
| `service.ts` | 检测缓存、requirement/match、设置、托管列表、下载 job、事件 |
| `handlers.ts` | 11 个契约方法 → service |
| `core/requirement.ts` | 版本 JSON → 所需主版本；实例/全局覆盖；推荐理由 |
| `core/providers.ts` | Adoptium / Microsoft OpenJDK 元数据与哈希来源 |
| `core/http.ts` | 只允许官方主机的 HTTPS 客户端；重定向 ≤3；`.part`→SHA-256→rename |
| `core/install.ts` | 下载 → 校验 → 解压（zip-slip/符号链接防护）→ probe 验证 → 原子移动 |
| `core/settings.ts` | `dataRoot/modules/java/settings.json`；托管根 `dataRoot/java` |
| `core/job.ts` | 下载任务状态机 + 100 ms 进度节流 |
| `core/errors.ts` | `JAVA.*` 可读错误码（用户消息/可重试/详情） |

## 2. 所需 Java 的判定

1. t6 `resolveVersion()` 合并 `inheritsFrom` 链；
2. 优先 `json.javaVersion.majorVersion`（`requiredSource:'version-json'`，同时返回 `javaVersionComponent`）；
3. 缺失时用 t6 的 `javaMajorForMinecraft(mcVersion)`（`requiredSource:'fallback'`）；
4. 仍无法判断 → `requiredMajor:null` / `requiredSource:'unknown'`，不猜（匹配时用最新已安装并明确说明）。

## 3. 匹配与覆盖优先级

```
instance.json 的 java（mode!=auto 且 value!=null）
  > 全局 settings.json 的 defaultJava（mode!=auto 且 value!=null）
  > 自动：requiredMajor 精确匹配 → 更高的 Java → 无匹配
```

- 实例级 `path`：先在检测列表中找；找不到则直接 `probe` 该路径（支持未被扫描的 JDK）。
- 实例级/全局 `major`：只接受该主版本；缺失时返回 `forced-major-missing`，并可一键下载该主版本。
- 非法显式路径 → `forced-path-invalid`（**不静默回退**，让用户改设置）。
- 自动匹配：`exact-match` / `newer-allowed`（更高版本通常可用，但模组可能不兼容）/ `no-java` / `required-missing` / `unknown-version`。

`JavaMatch` 同时返回：

- `reason: {code,text,details}` —— UI 直接显示“为什么推荐这个 Java”；
- `download: {needed,suggestedMajor,installedMajor,sources,reason}` —— 是否建议下载、下载哪个主版本；
- `alternatives`、`warnings`、`scope`（instance/global/auto）。

## 4. 下载源与安全

| 源 | 元数据 | 哈希 |
|---|---|---|
| Adoptium（默认） | `api.adoptium.net/v3/assets/latest/<major>/hotspot?os=…&architecture=…&image_type=jdk` | API 的 `binary.package.checksum`（SHA-256）+ `size` |
| Microsoft OpenJDK | `aka.ms/download-jdk/microsoft-jdk-<major>-windows-x64.zip` → 版本化 URL | 版本化 `.sha256sum.txt` |

- **不使用** BMCLAPI Java 列表（无哈希，docs/02 SRC-08）；JDK 不随安装包分发（LIC/GPL 合规，运行时下载）。
- 下载前先 `resolve` 元数据；没有 SHA-256 的包直接拒绝（`JAVA.PROVIDER_METADATA_INVALID`）。
- `JavaHttp` 只允许 `api.adoptium.net`、`github.com`/`objects.githubusercontent.com`、`aka.ms`/`download.visualstudio.microsoft.com` 等官方主机；非 HTTPS 拒绝（测试 loopback 例外）。
- 下载写 `.part`，流式 SHA-256 + 大小校验，通过后 rename；失败删除 `.part`。
- 解压前检查条目数（≤20,000）、符号链接、绝对路径/`..`/驱动器前缀（复用 t6 `safeEntryPath`）；解压到 `dataRoot/java/.tmp-*`。
- 解压后找到 `bin/java(.exe)`，先 `probeJavaExecutable`（`-XshowSettings:properties -version`）并校验主版本，再原子移动到 `dataRoot/java/<source>-<major>-<version>/`。
- 任何失败：清理临时目录、zip、`.part`，**已有 Java 列表不变**；最终目录只在验证通过后出现。

## 5. 进度、任务与事件

契约（`src/shared/java.ts`）：

- 方法：`detect / candidates / choose`（t6 保留）+ `requirement / match / settings / updateSettings / providers / managed / download / downloadStatus / cancelDownload`。
- 事件：`detectProgress`、`installProgress`（100 ms 节流）、`installFinished`。
- `installProgress.stage`：`resolve → download → verify → extract → validate → done`；同时带 `downloadedBytes/totalBytes/entriesDone/entriesTotal/currentFile/state/percent`。
- `download({major,source:'auto'|'adoptium'|'microsoft',force?})` 立即返回 `{jobId,major,source}`，后台任务；`cancelDownload` 中止；`downloadStatus` 可轮询（事件为主）。
- `installFinished.error` 是 `{code,message,retryable,details?}`，例如 `JAVA.HASH_MISMATCH`、`JAVA.CANCELLED`、`JAVA.VALIDATE_FAILED`。

## 6. 设置与 UI

`dataRoot/modules/java/settings.json`：

```json
{
  "schemaVersion": 1,
  "defaultJava": { "mode": "auto", "value": null },
  "preferredSource": "adoptium",
  "autoDownload": true
}
```

- 实例覆盖只读 `versions/<dir>/instance.json` 的 `java`，不写入实例文件；
- 修改实例设置仍由 t6/实例模块负责；本模块只解释优先级。
- `providers` 返回两个源的 `available/note`（Microsoft 仅 Windows x64）。
- `managed()` 列出 `dataRoot/java/` 下的托管 JDK（来自检测结果，不额外扫盘）。

## 7. 验证（2026-10-21）

```
npm.cmd --prefix mc-launcher run typecheck   # exit 0
npm.cmd --prefix mc-launcher run test -- src/main/modules/java
# 37 passed（requirement 5 / match 12 / providers 5 / install 7 / service 8）
MCL_REAL_JAVA=1 npm.cmd --prefix mc-launcher run test -- src/main/modules/java/__tests__/real-adoptium.test.ts
# 2 passed：真实 Adoptium Temurin 17 元数据（SHA-256/size），真实 Microsoft OpenJDK 21（版本化 alias + sha256sum）
```

覆盖点：版本 JSON/回退、实例>全局优先级、非法路径不回退、四种推荐理由、Adoptium/Microsoft 元数据、源回退、下载→校验→解压→probe→移动、zip-slip、缺 java、主版本不符、哈希不符、取消、重复主版本、失败不污染列表、t6 检测器自动识别 `dataRoot/java`。

## 8. 已知边界

1. **真实 190 MB JDK 下载未在本机跑完**：本机到 GitHub/Visual Studio CDN 速度不适合验收；下载/校验/解压/验证链路用本地 HTTP + 真实 ZIP 结构覆盖，真实元数据/哈希已实测。需要时可 `MCL_REAL_JAVA_DOWNLOAD=1` 扩展。
2. **Microsoft 仅 Windows x64**：其官方 aka.ms 只提供该组合的 zip/sha256sum；其它平台由 Adoptium 提供。
3. **内存**：`openZipFile` 将 zip 读入内存（JDK 约 190 MB），主进程峰值约 200 MB；后续可改用流式解压。
4. **重复主版本**：检测到同主版本（含系统 Java）时默认拒绝再下载；`force` 仅用于重装（同版本目录复用，不覆盖使用中的 JDK）。
5. **启动链接线**：t6 `orchestrator` 仍用自己的 `chooseJava` + 它已读取的实例设置；要应用**全局默认**和推荐理由，t11/t33 应在启动前调用 `match()`（本模块不修改启动内核）。
6. **上游可用性**：Adoptium API/微软 alias 若被网络策略拦截，会返回 `JAVA.PROVIDER_UNAVAILABLE` 并列出每个源的错误；不会回退到无哈希的镜像。
