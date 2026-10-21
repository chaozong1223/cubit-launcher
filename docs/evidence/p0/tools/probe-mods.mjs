// t34 P0-8 probe: real mods/resourcepacks/shaderpacks scan + install through the
// shared installLocalFile entry (used by both drag & file picker), enable/disable,
// remove, and a real CDP drag event on the renderer dropzone.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
if (!ws) throw new Error('no e2e workspace')
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 'qa-08-data')
fs.rmSync(dataDir, { recursive: true, force: true })
fs.mkdirSync(path.join(dataDir, 'fixtures'), { recursive: true })

const seedJar = path.join(ROOT, 'data', 't33-drop-test.jar')
if (!fs.existsSync(seedJar)) throw new Error(`missing seed jar ${seedJar}`)
const dragJar = path.join(dataDir, 'fixtures', 'qa-entry-drag.jar')
const pickerJar = path.join(dataDir, 'fixtures', 'qa-entry-picker.jar')
const resourceZip = path.join(dataDir, 'fixtures', 'qa-resource.zip')
const shaderZip = path.join(dataDir, 'fixtures', 'qa-shader.zip')
for (const [src, dest] of [[seedJar, dragJar], [seedJar, pickerJar], [seedJar, resourceZip], [seedJar, shaderZip]]) {
  fs.copyFileSync(src, dest)
}

const app = await launch({ name: 'P0-8', dataDir, mcDir, port: 9382 })
const result = { workspace: ws, mcDir, fixtures: { dragJar, pickerJar, resourceZip, shaderZip } }

function conflicts(files) {
  const enabledNames = new Set(files.enabled.map((f) => f.name))
  return files.disabled.filter((f) => enabledNames.has(f.name)).map((f) => f.name)
}
function summarise(scan) {
  const files = scan.files
  return {
    mods: { enabled: files.mods.enabled.map((f) => f.fileName), disabled: files.mods.disabled.map((f) => f.fileName), conflicts: conflicts(files.mods) },
    resourcepacks: { enabled: files.resourcepacks.enabled.map((f) => f.fileName), disabled: files.resourcepacks.disabled.map((f) => f.fileName), conflicts: conflicts(files.resourcepacks) },
    shaderpacks: { enabled: files.shaderpacks.enabled.map((f) => f.fileName), disabled: files.shaderpacks.disabled.map((f) => f.fileName), conflicts: conflicts(files.shaderpacks) },
    issues: scan.issues ?? [],
  }
}

try {
  result.initial = summarise(await app.invoke('mc:mods:scan', { instanceId: '1.20.1' }))

  // Entry 1: the same IPC that the drag handler calls (path from getPathForFile).
  result.dragEntryInstall = await app.invoke('mc:mods:installLocalFile', { instanceId: '1.20.1', path: dragJar, kind: 'mods' })
  // Entry 2: the same IPC the system file picker calls.
  result.pickerEntryInstall = await app.invoke('mc:mods:installLocalFile', { instanceId: '1.20.1', path: pickerJar, kind: 'mods' })
  result.afterBothEntries = summarise(await app.invoke('mc:mods:scan', { instanceId: '1.20.1' }))

  // Resource pack / shader pack install + toggle.
  result.resourceInstall = await app.invoke('mc:mods:installLocalFile', { instanceId: '1.20.1', path: resourceZip, kind: 'resourcepacks' })
  result.shaderInstall = await app.invoke('mc:mods:installLocalFile', { instanceId: '1.20.1', path: shaderZip, kind: 'shaderpacks' })
  result.kindsInstalled = summarise(await app.invoke('mc:mods:scan', { instanceId: '1.20.1' }))
  result.disable = await app.invoke('mc:mods:setEnabled', { instanceId: '1.20.1', kind: 'mods', names: ['qa-entry-picker.jar'], enabled: false })
  result.afterDisable = summarise(await app.invoke('mc:mods:scan', { instanceId: '1.20.1' }))
  result.enable = await app.invoke('mc:mods:setEnabled', { instanceId: '1.20.1', kind: 'mods', names: ['qa-entry-picker.jar'], enabled: true })

  // Conflict fixture (same name enabled + disabled) must be reported, not silently merged.
  const modsDir = path.join(mcDir, 'versions', '1.20.1', 'mods')
  fs.mkdirSync(modsDir, { recursive: true })
  fs.copyFileSync(seedJar, path.join(modsDir, 'qa-conflict.jar'))
  fs.copyFileSync(seedJar, path.join(modsDir, 'qa-conflict.jar.disabled'))
  result.conflictScan = summarise(await app.invoke('mc:mods:scan', { instanceId: '1.20.1' }))
  fs.rmSync(path.join(modsDir, 'qa-conflict.jar.disabled'), { force: true })

  // Real UI drag: navigate to the instance detail mods tab and drop a file on the
  // Dropzone through CDP Input.dispatchDragEvent.
  await app.goto('#/instances/1.20.1', 1400)
  const clicked = await app.evaluate(`(() => {
    const tab = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '模组')
    if (tab) { tab.click(); return 'tab-clicked' }
    return 'tab-missing'
  })()`)
  await sleep(1200)
  await app.screenshot('mods-before-drag.png')
  const rect = await app.evaluate(`(() => {
    const zone = document.querySelector('.dropzone')
    if (!zone) return null
    const r = zone.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, text: zone.textContent.slice(0, 80) }
  })()`)
  let dragUi = { clicked, rect, dispatched: false, error: null }
  if (rect) {
    try {
      await app.evaluate(`(() => {
        window.__qaDropEvents = []
        const zone = document.querySelector('.dropzone')
        for (const t of ['dragenter', 'dragover', 'drop']) {
          zone.addEventListener(t, (e) => window.__qaDropEvents.push(t + ':' + (e.dataTransfer?.files?.length ?? -1)), true)
        }
        return 'listening'
      })()`)
      const data = {
        items: [{ mimeType: 'text/uri-list', data: `file:///${dragJar.replace(/\\/g, '/')}` }],
        files: [dragJar],
        dragOperationsMask: 1,
      }
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await app.send('Input.dispatchDragEvent', { type, x: rect.x, y: rect.y, data })
      }
      dragUi.dispatched = true
      await sleep(2500)
      dragUi.events = await app.evaluate('JSON.stringify(window.__qaDropEvents ?? [])')
      dragUi.textAfterDrop = (await app.text()).split('\n').filter((line) => line.includes('qa-entry') || line.includes('拖')).slice(0, 6)
      dragUi.scanAfterDrop = summarise(await app.invoke('mc:mods:scan', { instanceId: '1.20.1' }))
      await app.screenshot('mods-after-ui-drag.png')
    } catch (error) {
      dragUi.error = String(error?.stack ?? error)
    }
  }
  result.dragUi = dragUi

  await app.screenshot('mods-after-both-entries.png')

  // Remove the test files from the golden instance so later probes are clean.
  result.remove = await app.invoke('mc:mods:remove', { instanceId: '1.20.1', kind: 'mods', names: ['qa-entry-drag.jar', 'qa-entry-picker.jar', 'qa-conflict.jar'] })
  result.removeResource = await app.invoke('mc:mods:remove', { instanceId: '1.20.1', kind: 'resourcepacks', names: ['qa-resource.zip'] })
  result.removeShader = await app.invoke('mc:mods:remove', { instanceId: '1.20.1', kind: 'shaderpacks', names: ['qa-shader.zip'] })
  result.clean = summarise(await app.invoke('mc:mods:scan', { instanceId: '1.20.1' }))
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  try { await app.screenshot('fatal.png') } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-8', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    initialMods: result.initial?.mods.enabled.length,
    dragEntry: result.dragEntryInstall?.fileName ?? result.dragEntryInstall?.path ?? null,
    pickerEntry: result.pickerEntryInstall?.fileName ?? result.pickerEntryInstall?.path ?? null,
    after: result.afterBothEntries?.mods.enabled,
    kinds: result.kindsInstalled && { rp: result.kindsInstalled.resourcepacks.enabled, sh: result.kindsInstalled.shaderpacks.enabled },
    conflict: result.conflictScan?.mods.conflicts,
    clean: result.clean?.mods.enabled,
    fatal: result.fatal ?? null,
  }, null, 2))
}
