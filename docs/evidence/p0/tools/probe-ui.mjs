// t34 P0-0 / P0-3 probe: read-only scan of the user's real .minecraft, page
// reachability screenshots, and theme persistence through the real UI.
import fs from 'node:fs'
import path from 'node:path'
import { launch, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const mcDir = 'E:\\MC\\.minecraft'
const dataDir = path.join(ROOT, '.e2e', 'qa-00-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const app = await launch({ name: 'P0-0', dataDir, mcDir, port: 9380 })
const result = { mcDir, dataDir, pages: {}, theme: {}, errors: [] }
try {
  const instances = await app.invoke('mc:instance:list')
  const versions = await app.invoke('mc:version:listVersions', {})
  const java = await app.invoke('mc:java:detect', { force: false })
  const requirement = await app.invoke('mc:java:requirement', { versionId: '1.20.1' })
  const match = await app.invoke('mc:java:match', { versionId: '1.20.1' })
  result.instances = {
    count: instances.length,
    states: instances.map((item) => ({ id: item.id, dirName: item.dirName, state: item.state, mcVersion: item.mcVersion, loader: item.loader, reason: item.reason })),
    missingJson: instances.filter((item) => item.state === 'missing-json').map((item) => item.id),
    notReady: instances.filter((item) => item.state !== 'ready').map((item) => item.id),
  }
  result.versions = {
    count: versions.length,
    sample: versions.slice(0, 5).map((item) => ({ id: item.id, state: item.state, mcVersion: item.mcVersion })),
    notReady: versions.filter((item) => item.state !== 'ready').map((item) => item.id),
  }
  result.java = {
    count: java.candidates.length,
    candidates: java.candidates.map((item) => ({ path: item.path, major: item.major, version: item.version, vendor: item.vendor, arch: item.arch, source: item.source })),
    requirement,
    match,
  }

  // Page reachability + screenshots (7 core pages + spec).
  for (const [hash, file] of [
    ['#/home', 'page-home.png'],
    ['#/instances', 'page-instances.png'],
    ['#/download', 'page-download.png'],
    ['#/link', 'page-link.png'],
    ['#/settings', 'page-settings.png'],
    ['#/logs', 'page-logs.png'],
    ['#/about', 'page-about.png'],
    ['#/components', 'page-components.png'],
  ]) {
    await app.goto(hash, 1200)
    const body = await app.text()
    result.pages[hash] = {
      firstLine: body.split('\n').filter(Boolean).slice(0, 3).join(' | '),
      length: body.length,
      screenshot: await app.screenshot(file),
    }
  }

  // Theme: toggle through the real titlebar button, then reload and re-read.
  await app.goto('#/home', 800)
  result.theme.initial = await app.evaluate("JSON.stringify({ mode: document.documentElement.dataset.themeMode, theme: document.documentElement.dataset.theme, stored: localStorage.getItem('mc-launcher.theme-mode') })")
  await app.evaluate("document.querySelector('.titlebar button.btn--icon')?.click(); 'clicked'")
  await sleep(500)
  result.theme.afterToggle = await app.evaluate("JSON.stringify({ mode: document.documentElement.dataset.themeMode, theme: document.documentElement.dataset.theme, stored: localStorage.getItem('mc-launcher.theme-mode') })")
  result.theme.toggleScreenshot = await app.screenshot('theme-toggled.png')
  await app.evaluate("location.reload(); 'reloading'")
  await sleep(2500)
  for (let i = 0; i < 100; i += 1) {
    if (await app.evaluate("typeof window.mc !== 'undefined'")) break
    await sleep(100)
  }
  result.theme.afterReload = await app.evaluate("JSON.stringify({ mode: document.documentElement.dataset.themeMode, theme: document.documentElement.dataset.theme, stored: localStorage.getItem('mc-launcher.theme-mode') })")
  result.theme.afterReloadScreenshot = await app.screenshot('theme-after-reload.png')

  result.instanceListScreenshot = path.join(app.outDir, 'page-instances.png')
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  try { await app.screenshot('fatal.png') } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-0', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({ count: result.instances?.count, missingJson: result.instances?.missingJson, java: result.java?.count, theme: result.theme, pages: Object.keys(result.pages ?? {}), fatal: result.fatal ?? null }, null, 2))
}
