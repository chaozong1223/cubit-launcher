// t34 P0-1/P0-2 evidence: offline launch to the main menu, held long enough for
// an external window watcher to capture the game window, then stopped.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ws, 'data')
const gameLog = path.join(mcDir, 'versions', '1.20.1', 'logs', 'latest.log')
// Keep the watcher honest: it must only react to this launch's log.
if (fs.existsSync(gameLog)) fs.renameSync(gameLog, `${gameLog}.before-t34-menu-${Date.now()}`)
const result = { workspace: ws, gameLog }
const app = await launch({ name: 'P0-1', dataDir, mcDir, port: 9394 })
try {
  await app.invoke('mc:instance:update', {
    id: '1.20.1',
    patch: { window: { width: 1280, height: 720, fullscreen: false }, memory: { minMb: 1024, maxMb: 4096 }, jvmArgs: [] },
  })
  const accounts = await app.invoke('mc:auth:list')
  let account = accounts.accounts.find((a) => a.kind === 'offline' && a.name === 'TestUser')
  if (!account) account = await app.invoke('mc:auth:createOffline', { name: 'TestUser' })
  result.account = { id: account.id, name: account.name, uuid: account.uuid }
  const startedAt = Date.now()
  const started = await app.invoke('mc:launch:start', { instanceId: '1.20.1', accountId: account.id })
  result.sessionId = started.sessionId
  let menuAt = null
  let sawUser = false
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (fs.existsSync(gameLog)) {
      const text = fs.readFileSync(gameLog, 'utf8')
      sawUser = sawUser || text.includes('Setting user: TestUser')
      if (sawUser && text.includes('Sound engine started')) { menuAt = Date.now(); break }
    }
    await sleep(300)
  }
  result.menu = { found: Boolean(menuAt), sawUser, elapsedMs: menuAt ? menuAt - startedAt : null }
  result.markers = fs.existsSync(gameLog)
    ? fs.readFileSync(gameLog, 'utf8').split(/\r?\n/).filter((line) => /Setting user:|Backend library:|Sound engine started|textures\/atlas\/blocks\.png-atlas/.test(line))
    : []
  result.statusBeforeHold = await app.invoke('mc:launch:status', { instanceId: '1.20.1' })
  await app.goto('#/home', 1200)
  result.launcherScreenshot = await app.screenshot('launcher-running.png')
  // Give the external watcher time to capture the game window.
  await sleep(16000)
  try { await app.invoke('mc:launch:stop', { sessionId: started.sessionId }) } catch { /* may have exited */ }
  await sleep(2000)
  result.finalStatus = await app.invoke('mc:launch:status', { instanceId: '1.20.1' })
  result.report = await app.invoke('mc:launch:lastReport', { instanceId: '1.20.1' })
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-1', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    sessionId: result.sessionId,
    menu: result.menu,
    markers: result.markers,
    statusBeforeHold: result.statusBeforeHold,
    finalStatus: result.finalStatus,
    report: result.report && { classification: result.report.classification, exitCode: result.report.exitCode, hints: result.report.crashHints?.map((h) => h.category) },
    fatal: result.fatal ?? null,
  }, null, 2))
}
