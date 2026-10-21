// t34 P0-8 modpack: export a real .mrpack and import it back into a new instance.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 'qa-08b-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const outDir = path.join(ROOT, 'docs', 'evidence', 'p0', 'P0-8')
const outPath = path.join(outDir, 'qa-export.mrpack')
const result = {}
const app = await launch({ name: 'P0-8', dataDir, mcDir, port: 9400 })
try {
  const exported = await app.invoke('mc:mods:exportModpack', { instanceId: '1.20.1', outPath })
  result.exported = { ...exported, exists: fs.existsSync(exported.path), size: fs.existsSync(exported.path) ? fs.statSync(exported.path).size : 0 }
  const imported = await app.invoke('mc:mods:importModpack', { filePath: outPath, name: 'QA Import' })
  result.imported = imported
  const instances = await app.invoke('mc:instance:list')
  result.instances = instances.map((i) => ({ id: i.id, state: i.state, mcVersion: i.mcVersion, loader: i.loader }))
  const newInstance = imported.instanceId
  result.scanNew = await app.invoke('mc:mods:scan', { instanceId: newInstance })
  result.newInstanceFiles = fs.existsSync(path.join(mcDir, 'versions', imported.dirName))
    ? fs.readdirSync(path.join(mcDir, 'versions', imported.dirName))
    : []
  // Invalid modpack file must be rejected readably.
  const badFile = path.join(outDir, 'qa-not-a-pack.txt')
  fs.writeFileSync(badFile, 'not a zip', 'utf8')
  result.badFile = await app.invokeRaw('mc:mods:importModpack', { filePath: badFile })
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-8', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    exported: result.exported,
    imported: result.imported && { instanceId: result.imported.instanceId, dirName: result.imported.dirName, format: result.imported.format, downloaded: result.imported.downloaded, overrides: result.imported.overrides, needsBaseInstall: result.imported.needsBaseInstall },
    newFiles: result.newInstanceFiles,
    badFile: result.badFile && { ok: result.badFile.ok, code: result.badFile.error?.code, message: result.badFile.error?.message },
    fatal: result.fatal ?? null,
  }, null, 2))
}
