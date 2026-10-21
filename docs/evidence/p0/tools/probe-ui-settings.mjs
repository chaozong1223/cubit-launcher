// t34 UI evidence: settings/account, settings/java, settings/launch, logs, download
// pages on the current packaged build; plus selected-account persistence.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 'qa-02-data')
const out = { pages: {} }
let app = await launch({ name: 'P0-2', dataDir, mcDir, port: 9398 })
try {
  const list = await app.invoke('mc:auth:list')
  const testUser = list.accounts.find((a) => a.name === 'TestUser')
  await app.invoke('mc:auth:select', { id: testUser.id })
  for (const [hash, file] of [
    ['#/settings/account', 'settings-account.png'],
    ['#/settings/java', 'settings-java.png'],
    ['#/settings/launch', 'settings-launch.png'],
    ['#/logs', 'logs-page.png'],
    ['#/download', 'download-page.png'],
    ['#/instances', 'instances-page.png'],
  ]) {
    await app.goto(hash, 1300)
    const text = await app.text()
    out.pages[hash] = {
      screenshot: await app.screenshot(file),
      lines: text.split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 26),
    }
  }
  out.accounts = list.accounts.map((a) => ({ name: a.name, kind: a.kind }))
  out.selectedBeforeRestart = (await app.invoke('mc:auth:list')).selectedId
} catch (error) {
  out.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
}

app = await launch({ name: 'P0-2', dataDir, mcDir, port: 9399 })
try {
  const after = await app.invoke('mc:auth:list')
  out.selectedAfterRestart = after.selectedId
  out.selectedNameAfterRestart = after.accounts.find((a) => a.id === after.selectedId)?.name ?? null
  out.after = after.accounts.map((a) => ({ name: a.name, kind: a.kind }))
} catch (error) {
  out.restartFatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-2', out)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    pages: Object.fromEntries(Object.entries(out.pages).map(([k, v]) => [k, v.lines.slice(0, 6)])),
    selectedBeforeRestart: out.selectedBeforeRestart,
    selectedAfterRestart: out.selectedAfterRestart,
    selectedNameAfterRestart: out.selectedNameAfterRestart,
    fatal: out.fatal ?? out.restartFatal ?? null,
  }, null, 2))
}
