// t45: drag-and-drop vs native file picker, each measured once on the same
// 1.20.1 instance, with size/SHA-256 comparison of the installed files.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 't45-mods-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const temp = path.join(process.env.LOCALAPPDATA ?? 'C:\\Windows\\Temp', 'Temp')
fs.mkdirSync(temp, { recursive: true })
const dragJar = path.join(temp, 't45-drag.jar')
const pickerJar = path.join(temp, 't45-picker.jar')
const seed = path.join(ROOT, 'data', 't33-drop-test.jar')
fs.copyFileSync(seed, dragJar)
fs.copyFileSync(seed, pickerJar)
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const result = { workspace: ws, fixtures: { dragJar, pickerJar, seedBytes: fs.statSync(seed).size, dragSha256: sha256(dragJar), pickerSha256: sha256(pickerJar) } }
const app = await launch({ name: 't45', dataDir, mcDir, port: 9408 })
try {
  await app.goto('#/instances/1.20.1', 1500)
  await app.evaluate(`(() => { const t = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '模组'); if (t) t.click(); return t ? 'tab-clicked' : 'tab-missing' })()`)
  await sleep(1200)
  result.before = await app.invoke('mc:mods:scan', { instanceId: '1.20.1' })
  result.beforeScreenshot = await app.screenshot('mods-before.png')
  const rect = await app.evaluate(`(() => { const z = document.querySelector('.dropzone'); if (!z) return null; const r = z.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height } })()`)
  result.dropzone = rect
  if (rect) {
    const data = {
      items: [{ mimeType: 'text/uri-list', data: `file:///${dragJar.replace(/\\/g, '/')}` }],
      files: [dragJar],
      dragOperationsMask: 1,
    }
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      await app.send('Input.dispatchDragEvent', { type, x: rect.x, y: rect.y, data })
    }
    result.dragEvents = await app.evaluate(`JSON.stringify(window.__qaDropEvents ?? [])`)
    await sleep(2000)
  }
  const afterDrag = await app.invoke('mc:mods:scan', { instanceId: '1.20.1' })
  result.afterDrag = {
    enabled: afterDrag.files.mods.enabled.map((f) => ({ fileName: f.fileName, size: f.size })),
    screenshot: await app.screenshot('mods-after-drag.png'),
  }

  // Native picker: click once, then fill the dialog from PowerShell.
  result.pickerClick = await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '选择文件'); if (!b) return 'missing'; b.click(); return 'clicked' })()`)
  await sleep(1200)
  const helper = spawnSync('powershell', ['-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'docs', 'evidence', 'p0', 'tools', 'picker-dialog.ps1'), '-Path', pickerJar], { encoding: 'utf8', timeout: 60000 })
  result.pickerHelper = { status: helper.status, stdout: String(helper.stdout ?? '').trim(), stderr: String(helper.stderr ?? '').trim().slice(0, 500) }
  await sleep(2500)
  const afterPicker = await app.invoke('mc:mods:scan', { instanceId: '1.20.1' })
  result.afterPicker = {
    enabled: afterPicker.files.mods.enabled.map((f) => ({ fileName: f.fileName, size: f.size })),
    screenshot: await app.screenshot('mods-after-picker.png'),
  }
  const modsDir = path.join(mcDir, 'versions', '1.20.1', 'mods')
  const installed = fs.existsSync(modsDir) ? fs.readdirSync(modsDir).filter((f) => f.startsWith('t45-')) : []
  result.installedFiles = installed.map((name) => ({ name, size: fs.statSync(path.join(modsDir, name)).size, sha256: sha256(path.join(modsDir, name)) }))
  result.consistent = result.installedFiles.length >= 2 &&
    new Set(result.installedFiles.map((f) => f.sha256)).size === 1 &&
    new Set(result.installedFiles.map((f) => f.size)).size === 1
  await app.invoke('mc:mods:remove', { instanceId: '1.20.1', kind: 'mods', names: installed })
  result.afterClean = (await app.invoke('mc:mods:scan', { instanceId: '1.20.1' })).files.mods.enabled.map((f) => f.fileName)
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  try { await app.screenshot('fatal.png') } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('t45', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    fixtures: result.fixtures,
    dragEvents: result.dragEvents,
    afterDrag: result.afterDrag,
    pickerClick: result.pickerClick,
    pickerHelper: result.pickerHelper,
    afterPicker: result.afterPicker,
    installedFiles: result.installedFiles,
    consistent: result.consistent,
    afterClean: result.afterClean,
    fatal: result.fatal ?? null,
  }, null, 2))
}
