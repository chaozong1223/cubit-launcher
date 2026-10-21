// t45: focus the catalog with real key events and exercise the shared instance
// selection before opening the updates tab.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const app = await launch({ name: 't45', dataDir: path.join(ws, 'data'), mcDir: path.join(ws, 'mc'), port: 9404 })
const result = {}
const waitFor = async (expression, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await app.evaluate(expression)
    if (value) return value
    await sleep(300)
  }
  return null
}
const clickText = async (text) => app.evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}))
  if (!el) return 'missing'
  el.click(); return 'clicked'
})()`)
try {
  await app.goto('#/catalog', 3500)
  await waitFor(`Boolean(document.querySelector('input[placeholder*="sodium"]'))`, 10000)
  await app.evaluate(`document.querySelector('input[placeholder*="sodium"]').focus(); 'ok'`)
  for (const ch of 'sodium') {
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await sleep(60)
  }
  await sleep(400)
  result.typed = await app.evaluate(`document.querySelector('input[placeholder*="sodium"]').value`)
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
  await waitFor(`!document.body.innerText.includes('77496 个结果')`, 25000)
  await sleep(1200)
  result.catalog = {
    screenshot: await app.screenshot('catalog-search-sodium.png'),
    header: (await app.text()).split('\n').map((s) => s.trim()).filter((l) => l.includes('个结果') || l.includes('Sodium')).slice(0, 8),
    inputValue: await app.evaluate(`document.querySelector('input[placeholder*="sodium"]').value`),
  }

  // Shared instance select on CatalogPage, then switch to the updates tab.
  const selectReady = await waitFor(`(() => { const el = document.querySelector('#catalog-instance-select'); return Boolean(el && [...el.options].some((o) => o.value === '1.20.1')) })()`, 15000)
  result.selectReady = Boolean(selectReady)
  if (selectReady) {
    await app.evaluate(`(() => {
      const el = document.querySelector('#catalog-instance-select')
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
      setter.call(el, '1.20.1')
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return el.value
    })()`)
    await sleep(800)
  }
  result.selected = await app.evaluate(`document.querySelector('#catalog-instance-select')?.value ?? null`)
  await clickText('模组更新')
  await sleep(1200)
  await clickText('检查更新')
  await sleep(5000)
  result.updates = {
    screenshot: await app.screenshot('updates-check.png'),
    text: (await app.text()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => /个可更新|检查\s|跳过|错误|1\.20\.1|没有可更新/.test(l)).slice(0, 12),
  }
  result.checkBackend = await app.invoke('mc:catalog:checkUpdates', { instanceId: '1.20.1', includeDisabled: false })
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('t45', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    typed: result.typed,
    catalog: result.catalog,
    selectReady: result.selectReady,
    selected: result.selected,
    updates: result.updates,
    check: result.checkBackend && { checked: result.checkBackend.checked, matched: result.checkBackend.matched, updates: result.checkBackend.updates.length, skipped: result.checkBackend.skipped.length, errors: result.checkBackend.errors.length },
    fatal: result.fatal ?? null,
  }, null, 2))
}
