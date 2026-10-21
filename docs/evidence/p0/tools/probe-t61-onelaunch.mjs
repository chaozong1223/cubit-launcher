// t61: one-click launch on the final build, real UI click once, wait for the
// Minecraft main menu, capture the game window, then use the new 结束游戏 button.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 't61-oneclick-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const gameLog = path.join(mcDir, 'versions', '1.20.1', 'logs', 'latest.log')
if (fs.existsSync(gameLog)) fs.renameSync(gameLog, `${gameLog}.before-t61-${Date.now()}`)
const outDir = path.join(ROOT, 'docs', 'evidence', 't61')
const result = { workspace: ws, dataDir, gameLog }
const app = await launch({ name: 't61', dataDir, mcDir, port: 9520 })
try {
  const account = await app.invoke('mc:auth:createOffline', { name: 'T61User' })
  await app.invoke('mc:auth:select', { id: account.id })
  await app.invoke('mc:instance:update', {
    id: '1.20.1',
    patch: { window: { width: 1280, height: 720, fullscreen: false }, memory: { minMb: 1024, maxMb: 4096 }, jvmArgs: [] },
  })
  await app.goto('#/home', 1800)
  await sleep(800)
  result.homeBefore = await app.evaluate(`JSON.stringify({ buttons: [...document.querySelectorAll('button')].map((b) => ({ text: b.textContent.trim(), label: b.getAttribute('aria-label'), disabled: b.disabled })).filter((b) => /启动游戏|启动中|游戏运行中|结束游戏|安装|选择实例/.test(b.text)) })`)
  const startedAt = Date.now()
  result.click = await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '启动游戏' || b.textContent.trim() === '启动游戏'); if (!b) return 'missing'; b.click(); return 'clicked' })()`)
  let menuAt = null
  let sawUser = false
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (fs.existsSync(gameLog)) {
      const text = fs.readFileSync(gameLog, 'utf8')
      sawUser = sawUser || text.includes('Setting user: T61User')
      if (sawUser && text.includes('Sound engine started')) { menuAt = Date.now(); break }
    }
    await sleep(300)
  }
  result.menu = { found: Boolean(menuAt), sawUser, elapsedMs: menuAt ? menuAt - startedAt : null }
  result.markers = fs.existsSync(gameLog)
    ? fs.readFileSync(gameLog, 'utf8').split(/\r?\n/).filter((l) => /Setting user:|Backend library:|Sound engine started|textures\/atlas\/blocks\.png-atlas/.test(l))
    : []
  await sleep(1500)
  result.buttonsAfterMenu = await app.evaluate(`JSON.stringify([...document.querySelectorAll('button')].map((b) => b.textContent.trim()).filter((t) => /结束游戏|运行中|启动中|游戏运行中/.test(t)))`)
  result.screenshotRunning = await app.screenshot('oneclick-running.png')
  const capture = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'docs', 'evidence', 'p0', 'tools', 'capture-h2edgy.ps1'), '-GameLog', gameLog, '-OutDir', outDir, '-TimeoutSeconds', '20'], { encoding: 'utf8', timeout: 60_000 })
  result.capture = { status: capture.status, stdout: String(capture.stdout ?? '').trim().slice(0, 500) }
  result.stopClick = await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '结束游戏'); if (!b) return 'missing'; b.click(); return 'clicked' })()`)
  let after = null
  for (let i = 0; i < 80; i += 1) {
    after = await app.invoke('mc:launch:status', { instanceId: '1.20.1' })
    if (after.state !== 'running') break
    await sleep(250)
  }
  result.afterStop = after
  result.screenshotAfterStop = await app.screenshot('oneclick-stopped.png')
  result.afterStopText = (await app.text()).split('\n').map((s) => s.trim()).filter((l) => /已结束|退出码|耗时|就绪|启动游戏/.test(l)).slice(0, 10)
  result.report = await app.invoke('mc:launch:lastReport', { instanceId: '1.20.1' })
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  try { await app.screenshot('fatal.png') } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('t61', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    homeBefore: result.homeBefore,
    click: result.click,
    menu: result.menu,
    markers: result.markers,
    buttonsAfterMenu: result.buttonsAfterMenu,
    capture: result.capture,
    stopClick: result.stopClick,
    afterStop: result.afterStop,
    afterStopText: result.afterStopText,
    report: result.report && { classification: result.report.classification, exitCode: result.report.exitCode, durationMs: result.report.durationMs },
    fatal: result.fatal ?? null,
  }, null, 2))
}
