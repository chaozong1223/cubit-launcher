# P0-6 L0：真实 LAN 世界发现与成员进世界（t64）

日期：2026-10-21  
范围：真实 1.20.1 客户端 + 启动器 net 模块；不是伪造日志。  
结论：**LAN 世界发现与成员真实进入已打通；但“离线账户直接凭邀请码地址一键进服”仍被原版 1.20.1 的会话校验拒绝，需走原版 LAN 浏览器。** 本条作为 P0-6 的 L0 证据与残余风险记录。

## 1. 实测环境

- 游戏：1.20.1 原版客户端，Java 17（`runtime/java-runtime-beta`）。
- 实例：`.e2e/t61-fresh/mc/versions/1.20.1-lan`，在版本 JSON 的 `arguments.game` 末尾追加字面量
  `--quickPlaySingleplayer t64lan`，并把世界目录复制到 `saves/t64lan`；由 `LaunchOrchestrator`（与 Electron 启动器同一套 plan/启动链）启动。
- 房主账户：离线 `T64Host`；成员账户：离线 `T64Member`（UUID 不同）。
- 网络：同机回环 + 本机 LAN，不涉及 EasyTier；L0 只验 LAN 世界。

## 2. 实测步骤

1. 房主 `RoomService.create({instanceId:'1.20.1-lan', transport:'lan'})`，再用 `LaunchOrchestrator.start` 启动客户端；版本 JSON 的 quick-play 参数让游戏直接进入 `t64lan` 世界。
2. 游戏内 `Esc` → **Open to LAN / 对局域网开放** → **Start LAN World**。
3. 从真实游戏日志确认：
   - `Started serving on 60321`
   - `Local game hosted on port [60321]`
4. 启动器 `RoomService` 的 `startWorldPoll()` 只读 `dataRoot/logs/game/1.20.1-lan/*.log` 最新文件的尾部 128 KB，解析到端口 **60321**，`RoomInfo.world = { state:'open', port:60321 }`，并自动重签 ticket。不是手工调用 `setWorldPort`。
5. 成员 `RoomService.join({ticket, instanceId:'1.20.1'})`（邀请码 ticket）成功进入房间：
   - 成员列表为 **host + member 两人**；
   - `transport='lan'`。
6. 成员启动原版客户端到主菜单，通过 **Multiplayer → 局域网世界列表** 选中房主世界并点击 **加入服务器**。

## 3. 真实证据

- 自动测试（可作为可复跑证据）：
  - `src/main/modules/net/__tests__/real-lan.test.ts`
  - 运行：`$env:MCL_REAL_LAN='1'; npx vitest run src/main/modules/net/__tests__/real-lan.test.ts`
  - 结果：`1 passed`，约 97 秒。
- 证据文件：`docs/evidence/t64/real-lan-result.json`
  - `discoveredPort: 60321`
  - `startedServing: "Started serving on 60321"`
  - `memberJoined: "T64Member[/26.125.118.57:60416] logged in with entity id 628 ..."`
  - `offlineLooseAuth: true`（房主日志同时有 `Failed to verify username but will let them in anyway!`）
- 截图：
  - `docs/evidence/t64/t64-host-lanscreen.png`：游戏内 LAN 设置页，端口 60321；
  - `docs/evidence/t64/t64-member-lanlist.png`：成员 LAN 列表出现 `T64Host - 新的世界`；
  - `docs/evidence/t64/t64-member-in-world.png`：成员已进入世界（暂停菜单显示“断开连接”，说明是多人客户端）。
- 原始日志：
  - 房主：`docs/evidence/t64/host-1.20.1-lan.log`
  - 成员：`docs/evidence/t64/member-1.20.1.log`
  - 测试输出：`docs/evidence/t64/real-lan-test-run.txt`

## 4. 关键发现（产品缺口，不伪造）

原版 1.20.1 的“直接连接 / `--quickPlayMultiplayer`”对**离线账户**会返回：

```
无法连接至服务器
登录失败：无效会话（请尝试重启游戏及启动器）
```

`RoomService.enterWorld()` / `joinLanWorld()` 当前把地址注入为 `server`（1.20+ 转 `--quickPlayMultiplayer`），因此**离线账户的一键直连必然失败**；这不是日志发现或 ticket 的问题。真实可用的离线路径是原版 **LAN 浏览器**：房主日志明确打印 `Failed to verify username but will let them in anyway!`，随后成员 `logged in with entity id`。

要闭环“离线账户也一键进服”，需要以下任一后续能力（不在本次 net/shared 范围）：

- 使用正版微软账户（登录后 Direct Connect 可正常通过会话校验）；
- 启动器提供“离线 LAN 浏览器”入口：成员启动到多人游戏 LAN 列表，由 UI 选择房主世界（当前 main 侧没有这种启动模式）；
- 或引入可离线 LAN 的服务端属性补丁（会改变原版实例，需单独评审）。

## 5. latest.log 轮转/截断

`LanWorldDiscovery.localWorlds()` 不直接依赖 `latest.log` 单文件：

- 扫描 `dataRoot/logs/game/<实例>/*.log`，选择最新文件；
- 先按 mtime 降序，mtime 相同（同一毫秒轮转）再按时间戳文件名降序；
- 只读文件尾部 128 KB，避免大日志/截断日志把内存或正则预算打满；
- 找不到世界时 `lanWorlds` 返回 `reason`（可读中文），不再只给空数组。

单元测试见 `src/main/modules/net/__tests__/discovery.test.ts`：轮转时只读新日志、旧日志端口不冒充、截断/无 LAN 行不误报、空目录有可读原因。

## 6. 未闭环/边界

- **离线账户 + 邀请码地址的一键进服未闭环**；本轮真实进入走的是原版 LAN 浏览器。若 P0-6 验收要求“点击邀请码即进服”，该项仍为 **FAIL（需正版账户或 main 侧新增 LAN 浏览器启动模式）**。
- 自动化点击依赖桌面会话与固定窗口坐标（1296×759），不是 headless；CI 不能直接跑本文件。
- 房主使用离线账户，因此 `Failed to verify username...` 是原版对离线 LAN 的宽松放行，不是启动器绕过认证。
- 本轮没有验证 EasyTier 隧道下的真实 Mac/另一网络进世界；L0 只覆盖本机 LAN。
