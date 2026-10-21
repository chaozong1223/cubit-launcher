# t45 evidence summary (supplement to docs/05 §16)

Build under test: 19:59:42 t44 package (sha/size 247,155,712 B), staged at `.e2e/t45-runtime`.
Runtime drift: t46 rebuilt `release` at 20:15/20:22; its 20:15 build logged `contract net method lanWorlds has no handler` and a renderer crash at 20:16, so page/one-click evidence was taken on the stable 19:59 package.

## Pages (t43/t44)

- Catalog: real UI search `sodium` -> 107 results, page 1/6; screenshot `catalog-search-sodium.png`; log `probe-catalog-final.log`; backend total=107.
- Updates: real check on `fabric-loader-0.19.5-1.20.1` -> 0 updates, checked 0/matched 0/skipped 0/errors 0; `updates-check.png`; `probe-catalog-final.log`.
- Saves: real `QA World` (1 world, level.dat + icon.png); `saves-list.png`; `probe-pages-fix.log`.
- Screenshots: `qa-shot.png` 1 image, 1 data URL; `screenshots-grid.png`; `probe-pages-fix.log`.
- Trash: delete `QA World` -> trash item `25be6a31-f7ec-49fe-a683-ba28cd16e90a` -> restore 1/failed 0 -> listSaves contains `QA World`; `trash-after-delete.png`; `probe-pages.log`.
- Logs/crash: qa-broken bad JVM arg -> crashed/jvm-args; panel shows JVM 启动参数错误/中置信度/Unrecognized VM option; diagnostics zip `diagnostics-1792584748271.zip` (3 files/3.0 MB); `logs-history-crash.png`, `crash-analysis.png`, `crash-exported.png`; `probe-pages.log`.

## One-click launch (real success)

- One click on `button[aria-label="启动游戏"]`; offline OneClickUser; 1.20.1 complete instance; Home shows current 1.20.1.
- Menu in 10,297 ms: `Setting user: OneClickUser`, `Backend library`, `Sound engine started`; status state=running, sessionId d9f96ac4-bd8f-4941-afae-506e8eee0770.
- Screenshots `main-menu.png` (Minecraft 1.20.1), `oneclick-running.png`; log `probe-onelaunch.log`.
- Defect: launcher UI stays “启动中…/等待游戏进程…” while status=running (no transition to running/stop button).

## Drag vs picker

- Drag: CDP real drop -> `t45-drag.jar` 256 B.
- Picker: native `#32770` “选择模组” dialog -> Alt+N + path + Enter -> `t45-picker.jar` 256 B.
- SHA-256 both `40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880`; consistent=true; cleaned via mods:remove (afterClean=[]).
- Screenshots `mods-after-drag.png`, `mods-after-picker.png`; log `probe-mods.log`.

## Commands

- `npm.cmd --prefix mc-launcher run test`: exit 0, 437 passed / 18 skipped; `gates.log`.
- `npm.cmd --prefix mc-launcher run e2e:install-launch`: exit 1 because t46 app holds `.e2e/runtime` (EPERM) and the 20:15 build has the lanWorlds handler gap; `e2e.log`.
