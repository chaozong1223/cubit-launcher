// t45: one-click launch from Home with a real offline account and a complete
// 1.20.1 instance. Clicks the primary button exactly once, waits for the game's
// "Sound engine started", screenshots the launcher, then leaves the process
// running for the external window capture.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 't45-onelaunch-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const gameLog = path.join(mcDir, 'versions', '1.20.1', 'logs', 'latest.log')
if (fs.existsSync(gameLog)) fs.renameSync(gameLog, `${gameLog}.before-t45-${Date.now()}`)
const launcherLog = path.join(dataDir, 'logs', 'launcher.log')
const result = { workspace: ws, dataDir, gameLog }
const app = await launch({ name: 't45', dataDir, mcDir, port: 9407 })
try {
  const account = await app.invoke('mc:auth:createOffline', { name: 'OneClickUser' })
  await app.invoke('mc:auth:select', { id: account.id })
  await app.invoke('mc:instance:update', {
    id: '1.20.1',
    patch: { window: { width: 1280, height: 720, fullscreen: false }, memory: { minMb: 1024, maxMb: 4096 }, jvmArgs: [] },
  })
  await app.goto('#/home', 1800)
  await sleep(1000)
  result.homeBefore = {
    text: (await app.text()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => /当前实例|一键启动|自动账户|1\.20\.1|TestUser|OneClick/.test(l)).slice(0, 12),
    launchButtons: await app.evaluate(`JSON.stringify([...document.querySelectorAll('button')].filter((b) => /启动游戏|安装|选择实例/.test(b.getAttribute('aria-label') || '')).map((b) => ({ label: b.getAttribute('aria-label'), text: b.textContent.trim(), disabled: b.disabled })))`),
  }
  const startedAt = Date.now()
  result.click = await app.evaluate(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '启动游戏' || b.textContent.trim() === '启动游戏')
    if (!btn) return { clicked: false, reason: 'button missing' }
    btn.click()
    return { clicked: true, label: btn.getAttribute('aria-label'), text: btn.textContent.trim(), disabled: btn.disabled }
  })()`)
  let menuAt = null
  let sawUser = false
  const deadline = Date.now() + 240_000
  while (Date.now() < deadline) {
    if (fs.existsSync(gameLog)) {
      const text = fs.readFileSync(gameLog, 'utf8')
      sawUser = sawUser || text.includes('Setting user: OneClickUser')
      if (sawUser && text.includes('Sound engine started')) { menuAt = Date.now(); break }
    }
    await sleep(300)
  }
  result.menu = { found: Boolean(menuAt), sawUser, elapsedMs: menuAt ? menuAt - startedAt : null }
  result.markers = fs.existsSync(gameLog)
    ? fs.readFileSync(gameLog, 'utf8').split(/\r?\n/).filter((line) => /Setting user:|Backend library:|Sound engine started|textures\/atlas\/blocks\.png-atlas/.test(line))
    : []
  result.launcherLogTail = fs.existsSync(launcherLog)
    ? fs.readFileSync(launcherLog, 'utf8').split(/\r?\n/).filter((line) => /launch plan prepared|game process started|game process exited/.test(line))
    : []
  await sleep(6000)
  result.status = await app.invoke('mc:launch:status', { instanceId: '1.20.1' })
  result.homeAfter = {
    screenshot: await app.screenshot('oneclick-running.png'),
    text: (await app.text()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => /游戏运行中|启动中|结束游戏|退出|当前实例|OneClickUser|启动状态/.test(l)).slice(0, 15),
  }
  result.clicks = 1
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  try { await app.screenshot('fatal.png') } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  // Leave the app + game running so the external capture script can photograph
  // the real Minecraft window. The caller stops them afterwards.
  const file = writeResult('t45', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    homeBefore: result.homeBefore,
    click: result.click,
    menu: result.menu,
    markers: result.markers,
    status: result.status,
    homeAfter: result.homeAfter?.text,
    clicks: result.clicks,
    fatal: result.fatal ?? null,
  }, null, 2))
  // Do not call app.close(): it kills the game. The caller kills it later.
  process.exit(result.fatal ? 1 : 0)
}
