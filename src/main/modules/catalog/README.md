# `src/main/modules/catalog` — 资源库搜索与模组更新（t41）

> 基于 Modrinth 的启动器内 catalog：搜索、详情、一键安装到实例、已装模组更新检查/更新。
> P0 只接 Modrinth；CurseForge **不调 API**，只生成/打开项目页。
> 契约：`src/shared/catalog.ts`；模块通过 `moduleIpc` 自注册，**不改** `main/index.ts` / `package.json`。

## 1. 结构

| 路径 | 内容 |
|---|---|
| `index.ts` | 自注册：`moduleIpc.handle(catalogContract, handlers)` + 事件转发；注入 mods 服务与 `shell.openExternal` |
| `handlers.ts` | 8 个契约方法 → service |
| `service.ts` | 搜索/详情/安装、更新检查（并发 worker）、更新 + 回收站、页面 URL |
| `core/modrinth.ts` | Modrinth v2 客户端：唯一 UA、300 rpm 限流、内存缓存、429/5xx 重试、哈希反查 |
| `core/download.ts` | 文件下载：`.part` → sha1/sha512/大小校验 → 原子 rename；CDN host 白名单 |

## 2. Modrinth API 约束（docs/02 API-01..）

- **唯一 User-Agent**：`mc-launcher/<version> (+site; contact)`，所有 API/CDN 请求共用。
- **速率**：默认每次 API 请求间隔 200 ms（5 req/s，即 300/min）；测试可调 0；429/5xx 指数退避（最多 2 次重试）。搜索/更新 worker 并发 4，但受全局限流约束。
- **缓存**：搜索、项目、版本列表、文件哈希反查均在内存缓存（TTL 5 min，最多 300 项）；不落盘、不转存元数据。
- **校验**：版本文件同时带 sha1/sha512 时两者都校验；大小不符/哈希不符删除 `.part` 并报 `CATALOG.HASH_MISMATCH` / `CATALOG.SIZE_MISMATCH`；CDN 仅允许 `cdn.modrinth.com` / `*.modrinth.com`（测试 loopback 例外）。
- **不调用 CurseForge API**：`pageUrl`/`openPage` 仅拼 `https://www.curseforge.com/minecraft/mc-mods/<slug>` 并交给 `shell.openExternal`。

## 3. 搜索与详情

`search({query, loaders, gameVersion, projectType, limit, offset})`：

- Modrinth facets：`project_type:<type>` + `categories:<loader>` + `versions:<gameVersion>`；
- 返回 `hits/total/offset/limit/cached/source`，含 slug/title/description/icon/downloads/follows/loaders/gameVersions/pageUrl；
- 同名查询命中缓存时 `cached:true` 且不发请求；分页通过 offset/limit 透传。

`project({idOrSlug})`、`versions({projectId, gameVersion?, loader?})` 用于详情/版本选择。

## 4. 一键安装

`install({instanceId, projectId, versionId?, allowPrerelease})`：

1. 解析实例（`scanInstances` + `instance.json` 的 mcVersion/loader/isolation）；找不到 → `CATALOG.INSTANCE_NOT_FOUND`；
2. 无 versionId → 取该项目与实例 MC/loader 兼容的最新版本；无兼容 → `CATALOG.INCOMPATIBLE`；
3. 兼容性硬校验（MC 版本 + loader 必须都匹配）；beta/alpha 需 `allowPrerelease=true`，否则 `CATALOG.PRERELEASE`；
4. 下载 primary 文件到 `dataRoot/tmp/catalog-*`，sha1/sha512/大小校验；
5. 通过 mods 模块 `installLocalFile` 安装（统一处理 `.disabled`、重名、元数据），临时目录清理；
6. 返回目标路径、哈希、版本类型、warning；
事件 `installProgress`（resolve/download/install/done）。

## 5. 更新检查与更新

`checkUpdates({instanceId, includeDisabled})`：

1. mods 模块 `scan` 得到已装 mod 文件（默认启用项；可选 disabled）；对每个文件计算 SHA-1；
2. `GET /v2/version_file/<sha1>?algorithm=sha1` 反查当前 Modrinth 版本；404 → skipped（Modrinth 未收录）；
3. `GET /v2/project/<id>/version?game_versions=&loaders=` 取版本，按 MC 版本 + loader 双重过滤，按 `date_published` 选最新；
4. 当前已最新 / 没有更新 → skipped；有更新 → 更新项：
   - `currentFile/currentVersion`、`latestVersionId/Version`、`changelogSummary`（Markdown 清理 + 900 字截断）、download URL/hash/size；
   - `risk`：`ok`（release 且兼容）/`warning`（beta/alpha）/`blocked`（无兼容版本）；
   - `reason/warnings` 明确说明不兼容原因；
5. 并发 4 个 worker，`checkProgress`（scan/hash/lookup/versions/compare）事件；错误按文件收集，不中断整体；
6. 返回 `updates/skipped/errors/checked/matched/durationMs`。

`update({instanceId, projectId, versionId, currentFile?, allowPrerelease})`：

- 先做与 install 相同的兼容性/预发布硬校验；`currentFile` 缺省时扫描并哈希反查定位，找不到 → `CATALOG.CURRENT_FILE_REQUIRED`；
- 下载新版本并校验 → 通过 mods 安装；
- 旧文件移动到 `dataRoot/trash/catalog/<instance>/<timestamp>/<file>`（同名加后缀），返回 `recycledPath`；不直接删除；
- 旧文件是 `.disabled` 时新文件也改回 `.disabled`，保持用户启停状态；
- 失败时删除新安装文件，旧文件保留（回收站操作在安装成功后）。

## 6. CurseForge 边界

- 契约没有 CF 搜索/版本/下载方法；`pageUrl({provider:'curseforge', slug})` 仅返回官网 URL；
- `openPage` 调注入的 `openExternal`（生产为 Electron `shell.openExternal`）；
- 测试断言 CF 页面调用期间本地 HTTP 服务器请求数为 0。

## 7. 验证

```
npm.cmd --prefix mc-launcher run typecheck
npm.cmd --prefix mc-launcher run test -- src/main/modules/catalog
```

- `catalog.test.ts`（9）：搜索筛选/分页/缓存、300 rpm 请求间隔、项目/版本、安装哈希校验、安装不兼容、beta 显式确认、更新检查/changelog/回收站、blocked + disabled 保留、CurseForge 页面零 API；
- `registration.test.ts`（2）：8 个 handler 与契约一一对应、3 个事件声明；
- `real-modrinth.test.ts`（opt-in，`MCL_REAL_MODRINTH=1`）：真实搜索 sodium（359 hits）、项目与 1.20.1/fabric 版本元数据、sha512 存在；
- 全仓回归见交付报告；`typecheck`/`test` 通过；`guard` 当前受其它任务并发修改 frozen `channels/ipc/preload/bridge` 影响（非本任务改动）。

## 8. 边界

1. P0 只处理 Modrinth；CF 只跳转。搜索只覆盖 `mod/resourcepack/shader/modpack` 的 Modrinth facet，不接 CF。
2. 更新检查依赖本地文件 SHA-1 能在 Modrinth 反查到；自行改过/重新打包的 jar 会 skipped（不会误更新）。
3. 更新选择“兼容的最新版本”，不会降级；beta/alpha 需要 UI 显式 `allowPrerelease`。
4. 旧文件进回收站而非删除；回收站清理策略留给后续（当前不自动清空）。
5. 并发 4 + 200 ms 全局限流；几百个 mod 会按进度事件逐步完成，不做批量 `POST /version_files`（P1 可优化为批量哈希反查）。
6. catalog 的 `scanInstances`/`readInstanceSettings` 仅读 t6 数据；不修改实例设置。
