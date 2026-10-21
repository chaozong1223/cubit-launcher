// t61: global drag (jar + auto-detected mrpack + CurseForge zip), then delete an
// instance to the launcher trash and restore it.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 't61-drag-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const temp = path.join(process.env.LOCALAPPDATA ?? 'C:\\Windows\\Temp', 'Temp')
fs.mkdirSync(temp, { recursive: true })
const fixtures = {
  jar: path.join(temp, 't61-global.jar'),
  mrpack: path.join(temp, 't61-pack.mrpack'),
  curse: path.join(temp, 't61-curse.zip'),
}
fs.copyFileSync(path.join(ROOT, 'data', 't33-drop-test.jar'), fixtures.jar)
fs.copyFileSync(path.join(ROOT, 'docs', 'evidence', 'p0', 'P0-8', 'qa-export.mrpack'), fixtures.mrpack)
fs.copyFileSync(path.join(ROOT, 'data', 't57', 'qa-curse.zip'), fixtures.curse)
const result = { workspace: ws, fixtures }
const app = await launch({ name: 't61', dataDir, mcDir, port: 9524 })

const drop = async (file) => {
  const data = {
    items: [{ mimeType: 'text/uri-list', data: `file:///${file.replace(/\\/g, '/')}` }],
    files: [file],
    dragOperationsMask: 1,
  }
  for (const type of ['dragEnter', 'dragOver', 'drop']) {
    await app.send('Input.dispatchDragEvent', { type, x: 640, y: 360, data })
  }
  await sleep(2500)
  return (await app.text()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => /已安装|已导入|整合包|目标|失败|需要|加载器|原版|判断|证据|文件/.test(l)).slice(0, 12)
}
try {
  await app.goto('#/home', 1600)
  const before = await app.invoke('mc:instance:list')
  result.beforeInstances = before.map((i) => i.id)
  result.jarText = await drop(fixtures.jar)
  result.jarScreenshot = await app.screenshot('global-drop-jar.png')
  result.modsAfterJar = (await app.invoke('mc:mods:scan', { instanceId: '1.20.1' })).files.mods.enabled.map((f) => f.fileName)

  result.mrpackText = await drop(fixtures.mrpack)
  result.mrpackScreenshot = await app.screenshot('global-drop-mrpack.png')
  await sleep(2000)
  const afterPack = await app.invoke('mc:instance:list')
  result.afterPackInstances = afterPack.map((i) => i.id)
  result.newFromPack = afterPack.map((i) => i.id).filter((id) => !result.beforeInstances.includes(id))

  result.curseText = await drop(fixtures.curse)
  result.curseScreenshot = await app.screenshot('global-drop-cf.png')
  await sleep(3000)
  const afterCurse = await app.invoke('mc:instance:list')
  result.afterCurseInstances = afterCurse.map((i) => i.id)
  result.newFromCurse = afterCurse.map((i) => i.id).filter((id) => !result.afterPackInstances.includes(id))

  const target = result.newFromCurse[0] ?? result.newFromPack[0]
  result.deleteTarget = target
  if (target) {
    await app.goto('#/instances', 1600)
    const delClick = await app.evaluate(`(() => { const b = document.querySelector('button[aria-label="删除实例 ${target}"]'); if (!b) return 'missing'; b.click(); return 'clicked' })()`)
    await sleep(800)
    result.dialogScreenshot = await app.screenshot('delete-dialog.png')
    result.dialogText = (await app.text()).split('\n').map((s) => s.trim()).filter((l) => /删除|回收站|libraries|运行中/.test(l)).slice(0, 10)
    result.confirmClick = await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '移入回收站'); if (!b) return 'missing'; b.click(); return 'clicked' })()`)
    await sleep(2500)
    result.afterDeleteInstances = (await app.invoke('mc:instance:list')).map((i) => i.id)
    result.flashText = (await app.text()).split('\n').map((s) => s.trim()).filter((l) => /已移入回收站|恢复/.test(l)).slice(0, 6)
    result.deleteScreenshot = await app.screenshot('instance-deleted.png')
    const trash = await app.invoke('mc:assets:listTrash')
    result.trashInstance = trash.items.filter((i) => i.kind === 'other' || i.instanceId === target).map((i) => ({ id: i.id, name: i.name, kind: i.kind, instanceId: i.instanceId }))
    await app.goto('#/trash', 1500)
    result.trashScreenshot = await app.screenshot('trash-instance.png')
    result.restoreClick = await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '恢复实例'); if (!b) return 'missing'; b.click(); return 'clicked' })()`)
    await sleep(2500)
    result.afterRestoreInstances = (await app.invoke('mc:instance:list')).map((i) => i.id)
    result.restoreScreenshot = await app.screenshot('instance-restored.png')
  }
  result.curseApiLogs = fs.existsSync(path.join(dataDir, 'logs', 'launcher.log'))
    ? (fs.readFileSync(path.join(dataDir, 'logs', 'launcher.log'), 'utf8').match(/api\.curseforge\.com/g) ?? []).length
    : null
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  try { await app.screenshot('fatal.png') } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('t61', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    before: result.beforeInstances,
    jar: { text: result.jarText, mods: result.modsAfterJar },
    mrpack: { text: result.mrpackText, newInstances: result.newFromPack },
    curse: { text: result.curseText, newInstances: result.newFromCurse, apiHits: result.curseApiLogs },
    deleteTarget: result.deleteTarget,
    dialog: result.dialogText,
    afterDelete: result.afterDeleteInstances,
    flash: result.flashText,
    trash: result.trashInstance,
    restoreClick: result.restoreClick,
    afterRestore: result.afterRestoreInstances,
    fatal: result.fatal ?? null,
  }, null, 2))
}
