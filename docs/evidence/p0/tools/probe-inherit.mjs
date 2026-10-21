// t34 P0-1 inheritsFrom: real dry-run merge and missing-parent error.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 'qa-inherit-data')
fs.rmSync(dataDir, { recursive: true, force: true })
function writeChild(dirName, inheritsFrom, mainClass = null) {
  const dir = path.join(mcDir, 'versions', dirName)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const child = { id: dirName, inheritsFrom }
  if (mainClass) child.mainClass = mainClass
  fs.writeFileSync(path.join(dir, `${dirName}.json`), JSON.stringify(child), 'utf8')
  // A jar is required for the instance to count as launchable by the UI, but the
  // dry-run only needs the JSON; give it a copy so the state is ready.
  fs.copyFileSync(path.join(mcDir, 'versions', '1.20.1', '1.20.1.jar'), path.join(dir, `${dirName}.jar`))
}
writeChild('forge-like', '1.20.1', 'cpw.mods.bootstraplauncher.BootstrapLauncher')
writeChild('bad-parent', 'no-such-parent')
const result = {}
const app = await launch({ name: 'P0-1', dataDir, mcDir, port: 9401 })
try {
  const account = await app.invoke('mc:auth:createOffline', { name: 'InheritUser' })
  result.instances = (await app.invoke('mc:instance:list')).filter((i) => ['forge-like', 'bad-parent'].includes(i.id)).map((i) => ({ id: i.id, state: i.state, reason: i.reason }))
  const plan = await app.invoke('mc:launch:plan', { instanceId: 'forge-like', accountId: account.id, dryRun: true })
  result.merged = {
    mainClass: plan.argv.find((a) => a === 'cpw.mods.bootstraplauncher.BootstrapLauncher') ?? null,
    classpathCount: plan.classpath.length,
    hasParentLibrary: plan.classpath.some((c) => c.includes('lwjgl')) || plan.classpath.some((c) => c.includes('guava')),
    placeholders: plan.argv.filter((a) => a.includes('${')),
    argvCount: plan.argv.length,
    dryRunFile: fs.existsSync(path.join(dataDir, 'logs', 'dry-run.json')),
  }
  result.badParent = await app.invokeRaw('mc:launch:plan', { instanceId: 'bad-parent', accountId: account.id, dryRun: true })
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-1', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    instances: result.instances,
    merged: result.merged,
    badParent: result.badParent && { ok: result.badParent.ok, code: result.badParent.error?.code, message: result.badParent.error?.message },
    fatal: result.fatal ?? null,
  }, null, 2))
}
