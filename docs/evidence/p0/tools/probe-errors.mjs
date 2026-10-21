// t34 P0-1/P0-5/P0-6 error paths: corrupt jar repair, missing jar precheck,
// bad JVM arg crash report timing, download disabled, raw error envelopes.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
if (!ws) throw new Error('no e2e workspace')
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 'qa-errors-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const result = { workspace: ws, mcDir, dataDir }

function makeInstance(dirName, { dropJar = false, corruptJar = false } = {}) {
  const dir = path.join(mcDir, 'versions', dirName)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const sourceJson = path.join(mcDir, 'versions', '1.20.1', '1.20.1.json')
  const sourceJar = path.join(mcDir, 'versions', '1.20.1', '1.20.1.jar')
  const json = JSON.parse(fs.readFileSync(sourceJson, 'utf8'))
  json.id = dirName
  fs.writeFileSync(path.join(dir, `${dirName}.json`), JSON.stringify(json), 'utf8')
  if (!dropJar) fs.copyFileSync(sourceJar, path.join(dir, `${dirName}.jar`))
  if (corruptJar) fs.writeFileSync(path.join(dir, `${dirName}.jar`), Buffer.alloc(10, 0x41))
  return dir
}

makeInstance('qa-broken', { corruptJar: true })
makeInstance('qa-nojar', { dropJar: true })

const app = await launch({ name: 'P0-5', dataDir, mcDir, port: 9392 })
try {
  const account = await app.invoke('mc:auth:createOffline', { name: 'CrashUser' })
  result.account = account.id

  // 1) Corrupt client jar: scan must flag it, repair must restore the exact SHA1.
  const scan1 = await app.invoke('mc:repair:scan', { versionId: 'qa-broken', verify: 'hash' })
  let scan1Status = null
  for (let i = 0; i < 300; i += 1) {
    scan1Status = await app.invoke('mc:repair:status', { jobId: scan1.jobId })
    if (scan1Status && ['done', 'failed', 'cancelled'].includes(scan1Status.state)) break
    await sleep(500)
  }
  const rep1 = await app.invoke('mc:repair:report', { jobId: scan1.jobId })
  result.repairScanBefore = {
    jobId: scan1.jobId,
    state: scan1Status?.state ?? null,
    ok: rep1.ok,
    counts: rep1.counts,
    corrupt: rep1.corrupt.map((i) => ({ destRel: i.destRel, actualSize: i.actualSize, expectedSize: i.expectedSize, reason: i.reason })),
  }
  const repair = await app.invoke('mc:repair:repair', { versionId: 'qa-broken', verify: 'hash' })
  let progress = null
  const deadline = Date.now() + 300_000
  while (Date.now() < deadline) {
    progress = await app.invoke('mc:repair:status', { jobId: repair.jobId })
    if (progress && ['done', 'failed', 'cancelled'].includes(progress.state)) break
    await sleep(1000)
  }
  await sleep(1500)
  const scan2 = await app.invoke('mc:repair:scan', { versionId: 'qa-broken', verify: 'hash' })
  let scan2Status = null
  for (let i = 0; i < 300; i += 1) {
    scan2Status = await app.invoke('mc:repair:status', { jobId: scan2.jobId })
    if (scan2Status && ['done', 'failed', 'cancelled'].includes(scan2Status.state)) break
    await sleep(500)
  }
  const rep2 = await app.invoke('mc:repair:report', { jobId: scan2.jobId })
  result.repair = {
    jobId: repair.jobId,
    finalState: progress?.state ?? null,
    stage: progress?.stage ?? null,
    ok: rep2.ok,
    counts: rep2.counts,
    jarSize: fs.existsSync(path.join(mcDir, 'versions', 'qa-broken', 'qa-broken.jar')) ? fs.statSync(path.join(mcDir, 'versions', 'qa-broken', 'qa-broken.jar')).size : null,
    jarSha1: fs.existsSync(path.join(mcDir, 'versions', 'qa-broken', 'qa-broken.jar')) ? (await import('node:crypto')).createHash('sha1').update(fs.readFileSync(path.join(mcDir, 'versions', 'qa-broken', 'qa-broken.jar'))).digest('hex') : null,
  }

  // 2) Missing jar: launch must be blocked by precheck with a readable error and no process.
  result.missingJar = await app.invokeRaw('mc:launch:start', { instanceId: 'qa-nojar', accountId: account.id })

  // 3) Bad JVM arg: launch must crash fast and produce a classified report.
  await app.invoke('mc:instance:update', { id: '1.20.1', patch: { jvmArgs: ['-XX:+UseDefinitelyNotARealGC'], window: { width: 1280, height: 720, fullscreen: false } } })
  const t0 = Date.now()
  let sessionId = null
  let report = null
  let status = null
  try {
    const started = await app.invoke('mc:launch:start', { instanceId: '1.20.1', accountId: account.id })
    sessionId = started.sessionId
  } catch (error) {
    result.crashStartError = String(error)
  }
  const crashDeadline = Date.now() + 60_000
  while (sessionId && Date.now() < crashDeadline) {
    status = await app.invoke('mc:launch:status', { instanceId: '1.20.1' })
    if (status.state === 'crashed' || status.state === 'exited' || status.reportReady) break
    await sleep(250)
  }
  report = await app.invoke('mc:launch:lastReport', { instanceId: '1.20.1' })
  result.badJvm = {
    sessionId,
    elapsedMs: Date.now() - t0,
    status,
    report: report && {
      exitCode: report.exitCode,
      classification: report.classification,
      durationMs: report.durationMs,
      crashHints: report.crashHints,
      logFile: report.logFile,
      lastLines: report.lastLines.slice(-5),
    },
  }
  await app.invoke('mc:instance:update', { id: '1.20.1', patch: { jvmArgs: [] } })

  // 4) Launch artifacts for the crash run.
  result.artifacts = {
    launchLastJson: fs.existsSync(path.join(dataDir, 'logs', 'launch-last.json')),
    launchLastBat: fs.existsSync(path.join(dataDir, 'logs', 'launch-last.bat')),
    dryRunJson: fs.existsSync(path.join(dataDir, 'logs', 'dry-run.json')),
    gameLogDir: fs.existsSync(path.join(dataDir, 'logs', 'game')),
    gameLogs: fs.existsSync(path.join(dataDir, 'logs', 'game'))
      ? fs.readdirSync(path.join(dataDir, 'logs', 'game'), { recursive: true }).filter((f) => String(f).endsWith('.log')).slice(0, 5)
      : [],
    launcherLog: fs.existsSync(path.join(dataDir, 'logs', 'launcher.log')),
  }

  // 5) Download disabled is a real, readable failure path (no network involved).
  await app.invoke('mc:download:updateSettings', { downloadEnabled: false })
  result.downloadDisabled = await app.invokeRaw('mc:download:fetchManifest', { force: true })
  await app.invoke('mc:download:updateSettings', { downloadEnabled: true })

  // 6) Raw error envelopes for the Java paths (for the error-code inventory).
  result.javaRaw = await app.invokeRaw('mc:launch:plan', { instanceId: 'qa-nojar', accountId: account.id, dryRun: true })
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-5', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    repairBefore: result.repairScanBefore && { ok: result.repairScanBefore.ok, corrupt: result.repairScanBefore.corrupt.length, counts: result.repairScanBefore.counts },
    repairAfter: result.repair && { state: result.repair.finalState, ok: result.repair.ok, sha1: result.repair.jarSha1, size: result.repair.jarSize },
    missingJar: result.missingJar && { ok: result.missingJar.ok, code: result.missingJar.error?.code, message: result.missingJar.error?.message },
    badJvm: result.badJvm && { elapsedMs: result.badJvm.elapsedMs, state: result.badJvm.status?.state, classification: result.badJvm.report?.classification, hints: result.badJvm.report?.crashHints?.map((h) => h.category) },
    downloadDisabled: result.downloadDisabled && { ok: result.downloadDisabled.ok, code: result.downloadDisabled.error?.code, message: result.downloadDisabled.error?.message },
    fatal: result.fatal ?? null,
  }, null, 2))
}


