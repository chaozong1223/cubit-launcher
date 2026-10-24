# 交接：启动链与联机（2026-10-24 ~ 25）

> 本文件接在 `docs/10-handoff.md` 之后，记录 2026-10-24 那一长段修复的结论与未完成项。
> §4/§5 已于 2026-10-24 晚补做（联机设置面板 + WAN 端点 + 中继测试），见对应章节的「补记」。

## 1. 当前状态

| 项 | 值 |
|---|---|
| 代码 | `a7a812b` 之后的联机探测改动 + 2026-10-24 晚的「公网端点/中继设置」 |
| 发布 | `v0.1.0`，GitHub Releases：https://github.com/chaozong1223/cubit-launcher/releases/tag/v0.1.0 |
| 基线 | typecheck 0；`npm run test` **671 passed / 25 skipped**（79 files passed / 11 skipped） |
| 打包 | `npm.cmd --prefix mc-launcher run pack`（会保留 `data/`；锁住时 pack 会拒绝并说明） |
| 契约 | `net` 现在 14 个方法 / 5 个事件（新增 `settings` / `updateSettings` / `probePublicIp` / `testRelay`） |

## 2. 本轮修好的启动链问题（都已验证）

按发现顺序，每条都对应一次真实崩溃：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | `Failed to locate library: lwjgl.dll` | 新版 LWJGL natives jar 内部有 `windows/x64/…` 子目录，平铺前 JVM 找不到 | `extractNatives` 平铺 + 镜像到 `java/`（26.x 的 `java.library.path` 指向 `natives/java`） |
| 2 | 26.x 起动仍缺 DLL | 官方 JSON 写的是 `-Djava.library.path=${natives_directory}/java` | 同上，同时把缓存标记升到 schemaVersion 3 |
| 3 | jinput-platform 被判缺失 | natives-only 库没有主 jar，代码按 maven 坐标虚构了路径 | `declaresArtifact()`：只有声明了 `downloads.artifact`（或有 `url`）才检查主 jar |
| 4 | `ClassNotFoundException: net.minecraft.client.Minecraft` | 客户端 jar 取了叶子版本目录里的 Forge universal | `resolveClientJar` 优先取 `chain[0]`（原版）的 jar |
| 5 | 同上，换版本后复发 | 继承合并键 `group:artifact:classifier` 丢了版本号，1.12.2 的两代 LWJGL 互相覆盖（macOS 版胜出） | 合并键改为 `group:artifact:version:classifier` |
| 6 | 1.12.2 仍报主类找不到 | LaunchWrapper 时代 Forge 需要忽略 jar 签名 | mainClass 为 `net.minecraft.launchwrapper.Launch` 时注入 `-Dfml.ignoreInvalidMinecraftCertificates` / `-Dfml.ignorePatchDiscrepancies` |
| 7 | `Pixel format not accelerated` / `No OpenGL context` | 新下载的 java.exe 没有 GPU 偏好；Windows 按 exe 路径分配显卡 | 启动前向 `HKCU\…\UserGpuPreferences` 写入 `GpuPreference=2;`（PCL 同样做法） |
| 8 | 同上，偶发 | 临时目录落在含中文的数据根（`D:\DSH-工作文件\…`） | `-Djava.io.tmpdir` 改到 `%LOCALAPPDATA%\Temp\mc-launcher-game` |
| 9 | Java 8 下载失败 `unable to verify the first certificate` | 本机无法验证 github.com 证书 | 先试 `ghfast.top` 镜像再回退官方；镜像主机加入下载白名单 |
| 10 | 静态版本用错 Java | `detectMinecraftVersion` 只认继承链，PCL 的"独立版本"没有 `inheritsFrom` → 判为未知 → 回落最新 Java | 从 `clientVersion` / `--fml.mcVersion` 兜底 |
| 11 | 关掉启动器游戏被杀 | `will-quit` 无条件 kill | 游戏进程 `detached`；退出对话框改为「退出启动器（游戏继续）」，`quitAction === 'keep-game'` 时不 kill |

另外：内存分配从"物理内存 25%（上限 8G）"改为 `2048 + 模组数 × 40 MiB`，受 `min(70% RAM, 16G)` 约束（233 模组的 1.12.2 整合包 → 11368 MB）。

## 3. 联机的真实架构（重要，别再误判）

```
EasyTier sidecar（--no-tun）
  房主: -i 10.144.144.1  -n <alias>/32->192.168.77.1/32  -l tcp://<lanIp>:<peerPort>
  成员: -i 10.144.144.2  --no-listener  -p tcp://<host>:<peerPort>  --port-forward …
```

**设计上就不创建 TUN 虚拟网卡**，所以：

- ❌ 不要检查 `10.144.x` 网卡是否存在——曾经加过这个校验，把所有健康房间判死（已回滚）
- ❌ EasyTier 日志里的 `no_tun = true` 是**正常**的
- ✅ 判断隧道是否就绪：`sidecar started` + `host tunnel ready`

`easytier-core` 依赖 `Packet.dll`（静态导入，缺它进程直接 `STATUS_DLL_NOT_FOUND`），发行包里已内置：

```
resources/easytier/{easytier-core.exe, easytier-cli.exe, wintun.dll, Packet.dll, WinDivert64.sys, LICENSE-LGPL-3.0.txt}
```

`build/extra/easytier/` 里是构建源（exe/dll 被 `.gitignore` 忽略，用 `node scripts/fetch-easytier.mjs` 拉取并校验哈希）。

## 4. ~~未解决：邀请码缺公网端点~~ → 已解决（2026-10-24 晚）

**现状**：邀请码 `endpoints` 只有 `{"kind":"lan","host":"10.91.60.10"}`。跨网络的朋友拿到也用不了。

**已尝试**：启动后调 `easytier-cli --rpc-portal …:rpcPort node` 读 `Public IPv4` → 写入 `{"kind":"wan", …}`。

**问题**：打包后的 Electron 子进程执行同一命令拿到**空 stdout**（日志 `public ip probe candidates: []`），而在 PowerShell 里手工执行能返回 `114.247.65.90` / `219.143.23.90`。怀疑 asar 打包下的子进程环境问题，未定位。

**补记（后续会话）**：根因没继续查，改为**两个独立来源 + 允许手填**：

1. `net.settings` / `net.updateSettings` / `net.probePublicIp` / `net.testRelay` 四个新契约方法；`dataRoot/modules/net/config.json` 新增 `publicIp`（IPv4 或 DDNS）与 `autoProbe`。
2. 手填地址**优先**于探测结果；探测走 `src/main/modules/net/publicip.ts`：先 `easytier-cli node`，再 `https://ip.3322.net` → `https://ipv4.icanhazip.com` → `https://api.ipify.org`（主进程 `fetch`，不依赖子进程）。本机实测：`4.ipw.cn` 解析不到、`api.ipify.org` 直接失败，`ip.3322.net`（122ms）与 `icanhazip.com`（575ms）都返回真实出口 IP，所以顺序按国内可达性排。两条来源都失败时把原因写进 `probeDetail`，`设置 → 联机` 直接显示。
3. **同时修掉一个更致命的问题**：成员侧 `tryTunnel` 原来只读 `kind === 'lan'` 端点，WAN 端点签进邀请码也从来没用过。现在按 `wan → lan → 邀请码中继 → 本机配置中继` 依次尝试（`tunnelPeers()`）。
4. `设置 → 联机` 由占位页改成真实面板；联机页删掉「需要管理员/TUN」的过时横幅（本模块是 `--no-tun`，日常不需要管理员）。

**仍然成立**：即使拿到公网 IP，**双方都是运营商 CGNAT 时依然连不上**，此时必须有中继。

**注意**：打包版的 `easytier-cli` 空 stdout 仍未定位（现在不影响功能，因为 echo 兜底）；要深挖就在 asar 下比对 `process.execPath`、`cwd` 与 `resources/easytier` 的实际路径。

## 5. 中继（已接入设置，仍需一台公网机器）

`net/config.json` 支持 `relayPeers: string[]`，默认空。现在：

- `设置 → 联机` 可增删中继（最多 4 个，`tcp://host:port` / `udp://…`），并可「测试」——`net.testRelay` 做一次 TCP 握手（4s 超时），区分「地址写错」与「网络不通」。
- 房主与成员**都要配同一个中继**；成员侧也会自动尝试本机配置的中继（邀请码里没有时）。
- 自建：一台公网机器 `easytier-core -l tcp://0.0.0.0:11010`，两端 `-p` 指向它。

对照 `PCL-Community/PCL-CE`（**Apache-2.0 开源**，`PCL.Core/Link/EasyTier/`）：它的中继做法是 `-p <relay>` + `ETRelay.RelayList`（Community / Selfhosted / Custom 三类）。我们已补齐对应参数：`--private-mode true`、`--relay-network-whitelist`、`--enable-quic-proxy`、`--enable-kcp-proxy`、`--use-smoltcp`、`--encryption-algorithm chacha20`。公共中继实测不可达（`public.easytier.cn:11010` 等）。

## 6. 合规边界（重要）

- `Meloong-Git/PCL`（官方 PCL2）：GitHub 标 `NOASSERTION`，**不是**标准开源协议。
- `PCL-Community/PCL-CE`：**Apache-2.0**，可以读、可以学（与我们 GPL-3.0 兼容），但它是 C#，不能直接复制，只能按思路在 TS 里重写。
- `xpcl.aeling.cn` 的 XPCL：基于 PCL 的二次创作，**不可直接用**。仅做过可执行文件字符串观察（黑盒）。
- 我们自己的规则见 `docs/clean-room-log.md`。

## 7. 关键文件

| 文件 | 作用 |
|---|---|
| `src/main/core/version/classpath.ts` | 库解析、`declaresArtifact`、natives 平铺 |
| `src/main/core/version/load.ts` | `resolveClientJar`、`detectMinecraftVersion` |
| `src/main/core/version/name.ts` | 继承合并键（含版本号） |
| `src/main/core/launch/args.ts` | JVM 参数、FML 证书标志、编码 |
| `src/main/core/launch/orchestrator.ts` | 启动编排、GPU 偏好、临时目录、缺失检查日志 |
| `src/main/core/launch/natives.ts` | natives 平铺 + `java/` 镜像 |
| `src/main/core/java/select.ts` | Java 选择优先级 + 严格主版本 |
| `src/main/modules/net/args.ts` | EasyTier 参数（房主/成员/穿透） |
| `src/main/modules/net/room.ts` | 房间状态机、邀请码、公网探测、`settings()/updateSettings()`、成员候选端点（`tunnelPeers`） |
| `src/main/modules/net/publicip.ts` | 公网地址探测（CLI 解析 / HTTPS echo / CGNAT 提示）与中继 TCP 测试 |
| `src/main/modules/net/config.ts` | `net/config.json` 读写与清洗（`publicIp` / `autoProbe` / `relayPeers`） |
| `src/main/modules/net/easytier.ts` | sidecar 生命周期、内置副本安装 |
| `src/main/modules/net/ticket.ts` | 邀请码编解码与校验（`kind: lan/wan/relay`） |

## 8. 常用命令

```bash
npm run typecheck
npm run test
node scripts/check-frozen.mjs --write   # 改了冻结文件后
npm run pack                            # 打包（先关掉所有 mc-launcher.exe）
npm run dist                            # electron-builder 直出
node scripts/fetch-easytier.mjs         # 拉取 EasyTier 侧车（含 Packet.dll）
```

发布：`scripts/publish-release.ps1`（从环境读 `GH_TOKEN`，不要写到磁盘）。

## 9. 环境坑

- 本机 `git push` 走 SSH（`ssh.github.com:443`），偶发网络错误重试即可。
- GitHub API 需要 PAT，存放在交接文档约定的位置；**不要**写进仓库。
- 打包前必须杀干净 `mc-launcher.exe`（含管理员进程），否则 `pack-safe` 会拒绝执行。
- 本机提权请求会被静默拒绝（`Start-Process -Verb RunAs` 返回 "canceled by the user"，`ShellExecute runas` 无进程）。联机走 `--no-tun`，**日常不需要管理员**。
- **AI 会话内起不了 GUI**：agent 的 shell 带着 `ELECTRON_RUN_AS_NODE=1`，`npm run dev` 会把 `out/main/index.js` 当 Node 脚本跑（报 `electron.protocol` 为 undefined）；去掉该变量后 `electron.exe --version` 仍以 `-2147483645`(0x80000003) 立刻退出，打包好的 `mc-launcher.exe` 同样秒退、不写日志。**结论：`pack` 之后要真机看一眼，必须由本人从资源管理器双击启动**；agent 侧只能做到 typecheck + vitest + build/pack + 检查 `out/main/index.js` 里是否含新代码。
