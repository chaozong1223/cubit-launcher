// t34 P0-0 fixtures: corrupt JSON / missing jar states must be visible and must
// never spawn a process when clicked (launch attempted).
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { launch, ROOT, writeResult } from './cdp-lib.mjs'

const fixtures = path.join(ROOT, '.e2e', 'qa-fixtures')
fs.rmSync(fixtures, { recursive: true, force: true })
fs.mkdirSync(path.join(fixtures, 'versions', 'broken-json'), { recursive: true })
fs.writeFileSync(path.join(fixtures, 'versions', 'broken-json', 'broken-json.json'), '{', 'utf8')
fs.mkdirSync(path.join(fixtures, 'versions', 'no-jar'), { recursive: true })
const base = JSON.parse(fs.readFileSync('E:\\MC\\.minecraft\\versions\\1.20.1\\1.20.1.json', 'utf8'))
base.id = 'no-jar'
fs.writeFileSync(path.join(fixtures, 'versions', 'no-jar', 'no-jar.json'), JSON.stringify(base), 'utf8')

const dataDir = path.join(ROOT, '.e2e', 'qa-00-fixtures-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const javawCount = () => {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq javaw.exe', '/NH'], { encoding: 'utf8' })
    return (out.match(/javaw\.exe/g) ?? []).length
  } catch { return -1 }
}
const result = { fixtures }
const before = javawCount()
const app = await launch({ name: 'P0-0', dataDir, mcDir: fixtures, port: 9393 })
try {
  const instances = await app.invoke('mc:instance:list')
  result.instances = instances.map((i) => ({ id: i.id, state: i.state, reason: i.reason, mcVersion: i.mcVersion }))
  const account = await app.invoke('mc:auth:createOffline', { name: 'FixUser' })
  result.brokenStart = await app.invokeRaw('mc:launch:start', { instanceId: 'broken-json', accountId: account.id })
  result.noJarStart = await app.invokeRaw('mc:launch:start', { instanceId: 'no-jar', accountId: account.id })
  result.javawBefore = before
  result.javawAfter = javawCount()
  await app.goto('#/instances', 1500)
  result.screenshot = await app.screenshot('fixtures-instances.png')

  // Full-width colon path: the detail page of the real instance must render.
  const weird = await app.evaluate(`encodeURIComponent('Hunt：History 1949 - Blood Testament')`)
  result.detail = { id: weird }
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-0', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    instances: result.instances,
    broken: { ok: result.brokenStart?.ok, code: result.brokenStart?.error?.code, message: result.brokenStart?.error?.message },
    noJar: { ok: result.noJarStart?.ok, code: result.noJarStart?.error?.code, message: result.noJarStart?.error?.message },
    javaw: { before: result.javawBefore, after: result.javawAfter },
    fatal: result.fatal ?? null,
  }, null, 2))
}
