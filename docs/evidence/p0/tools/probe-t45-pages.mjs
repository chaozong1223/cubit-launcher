// t45: verify the t43/t44 pages against the final packaged build.
// Real data only: Modrinth catalog, real saves/screenshots/trash, real crash log.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ws, 'data')
const outRoot = path.join(ROOT, 'docs', 'evidence', 'p0', 't45')
fs.mkdirSync(outRoot, { recursive: true })
const result = { workspace: ws, pages: {} }
const app = await launch({ name: 't45', dataDir, mcDir, port: 9402 })

const clickText = async (text, tag = 'button') => app.evaluate(`(() => {
  const el = [...document.querySelectorAll(${JSON.stringify(tag)})].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}))
  if (!el) return 'missing'
  el.click(); return 'clicked'
})()`)
const setSelect = async (id) => app.evaluate(`(() => {
  const el = document.querySelector('select[aria-label="选择目标实例"]')
  if (!el) return 'missing'
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
  setter.call(el, ${JSON.stringify(id)})
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return el.value
})()`)
const bodyText = async () => app.text()

try {
  // Deterministic account for later one-click evidence.
  const accounts = await app.invoke('mc:auth:list')
  const offline = accounts.accounts.find((a) => a.kind === 'offline' && a.name === 'TestUser')
  if (offline) await app.invoke('mc:auth:select', { id: offline.id })
  result.selectedAccount = offline?.id ?? null
  result.instances = (await app.invoke('mc:instance:list')).map((i) => ({ id: i.id, state: i.state, mcVersion: i.mcVersion, loader: i.loader }))

  // --- Catalog -------------------------------------------------------------
  await app.goto('#/catalog', 4000)
  result.pages.catalogInitial = {
    screenshot: await app.screenshot('catalog-initial.png'),
    text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30),
  }
  await app.evaluate(`(() => {
    const input = document.querySelector('input[placeholder*="sodium"]')
    if (!input) return 'input-missing'
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, 'sodium')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return 'typed'
  })()`)
  await clickText('搜索')
  await sleep(6000)
  result.pages.catalogSearch = {
    screenshot: await app.screenshot('catalog-search-sodium.png'),
    text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 40),
  }
  result.catalogBackend = await app.invoke('mc:catalog:search', { query: 'sodium', limit: 5, offset: 0 })

  // --- Mod updates ---------------------------------------------------------
  await app.goto('#/updates', 1200)
  await setSelect('1.20.1')
  await sleep(500)
  await clickText('检查更新')
  await sleep(4000)
  result.pages.updates = {
    screenshot: await app.screenshot('updates-check.png'),
    text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 35),
  }

  // --- Saves (real fixture: QA World) -------------------------------------
  await app.goto('#/saves', 1200)
  await setSelect('1.20.1')
  await sleep(800)
  result.pages.saves = {
    screenshot: await app.screenshot('saves-list.png'),
    text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30),
  }
  result.savesBackend = await app.invoke('mc:assets:listSaves', { instanceId: '1.20.1' })
  await clickText('备份 zip')
  await sleep(1500)
  result.savesAfterBackup = { text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => l.includes('备份') || l.includes('.zip')).slice(0, 8) }

  // --- Screenshots ---------------------------------------------------------
  await app.goto('#/screenshots', 1200)
  await setSelect('1.20.1')
  await sleep(1200)
  result.pages.screenshots = {
    screenshot: await app.screenshot('screenshots-grid.png'),
    text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 25),
    dataUrls: await app.evaluate("document.querySelectorAll('img').length"),
  }

  // --- Trash: delete the save, list, restore ------------------------------
  result.deleteSave = await app.invoke('mc:assets:deleteSaves', { instanceId: '1.20.1', names: ['QA World'] })
  await app.goto('#/trash', 1200)
  result.pages.trash = {
    screenshot: await app.screenshot('trash-after-delete.png'),
    text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30),
  }
  const trash = await app.invoke('mc:assets:listTrash')
  result.trashItems = trash.items.map((i) => ({ id: i.id, name: i.name, area: i.area }))
  result.restore = await app.invoke('mc:assets:restoreTrash', { ids: trash.items.filter((i) => i.name === 'QA World').map((i) => i.id) })
  result.savesAfterRestore = (await app.invoke('mc:assets:listSaves', { instanceId: '1.20.1' })).saves.map((s) => s.name)

  // --- Crash analysis: real bad JVM arg on qa-broken ----------------------
  await app.invoke('mc:instance:update', { id: 'qa-broken', patch: { jvmArgs: ['-XX:+UseDefinitelyNotARealGC'], window: { width: 1280, height: 720, fullscreen: false } } })
  const crashStarted = await app.invoke('mc:launch:start', { instanceId: 'qa-broken', accountId: offline?.id })
  let crashStatus = null
  for (let i = 0; i < 100; i += 1) {
    crashStatus = await app.invoke('mc:launch:status', { instanceId: 'qa-broken' })
    if (crashStatus.state === 'crashed' || crashStatus.state === 'exited') break
    await sleep(250)
  }
  result.crash = { sessionId: crashStarted.sessionId, status: crashStatus, report: await app.invoke('mc:launch:lastReport', { instanceId: 'qa-broken' }) }
  await app.invoke('mc:instance:update', { id: 'qa-broken', patch: { jvmArgs: [] } })

  await app.goto('#/logs', 1500)
  await setSelect('qa-broken')
  await sleep(800)
  result.pages.logs = {
    screenshot: await app.screenshot('logs-history-crash.png'),
    text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 30),
  }
  await clickText('分析最近一次崩溃')
  await sleep(2500)
  result.pages.crashAnalysis = {
    screenshot: await app.screenshot('crash-analysis.png'),
    text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => /JVM|参数|置信|Unrecognized|原因|证据|分析|诊断|复制/.test(l)).slice(0, 20),
  }
  await clickText('导出诊断包')
  await sleep(2500)
  result.pages.crashExport = {
    screenshot: await app.screenshot('crash-exported.png'),
    text: (await bodyText()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => l.includes('.zip') || l.includes('文件') || l.includes('导出')).slice(0, 10),
  }
  result.crashExportBackend = await app.invoke('mc:crash:exportReport', { analysis: await app.invoke('mc:crash:analyze', { instanceId: 'qa-broken' }) })
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  try { await app.screenshot('fatal.png') } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('t45', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    catalogInitial: result.pages.catalogInitial?.text?.slice(0, 8),
    catalogSearch: result.pages.catalogSearch?.text?.slice(0, 8),
    catalogHits: result.catalogBackend?.total,
    updates: result.pages.updates?.text?.slice(0, 8),
    saves: result.savesBackend?.saves?.map((s) => s.name),
    screenshots: result.pages.screenshots?.dataUrls,
    trash: result.trashItems,
    restore: result.restore,
    savesAfterRestore: result.savesAfterRestore,
    crash: { state: result.crash?.status?.state, hints: result.crash?.report?.crashHints?.map((h) => h.category) },
    crashAnalysis: result.pages.crashAnalysis?.text,
    crashExport: result.pages.crashExport?.text,
    fatal: result.fatal ?? null,
  }, null, 2))
}
