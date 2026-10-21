// t45 follow-up: make the real UI interactions deterministic (wait for async
// instances, use CDP text input, verify the controlled <select> actually changed).
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ws, 'data')
const result = {}
const app = await launch({ name: 't45', dataDir, mcDir, port: 9403 })

const waitFor = async (expression, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await app.evaluate(expression)
    if (value) return value
    await sleep(250)
  }
  return null
}
const selectInstance = async (id) => {
  const ready = await waitFor(`(() => { const el = document.querySelector('select[aria-label="选择目标实例"]'); return Boolean(el && !el.disabled && [...el.options].some((o) => o.value === ${JSON.stringify(id)})) })()`)
  if (!ready) return { ok: false, reason: 'select not ready' }
  const value = await app.evaluate(`(() => {
    const el = document.querySelector('select[aria-label="选择目标实例"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(id)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return el.value
  })()`)
  await sleep(800)
  const after = await app.evaluate(`document.querySelector('select[aria-label="选择目标实例"]')?.value ?? null`)
  return { ok: after === id, requested: id, value, after }
}
const clickText = async (text) => app.evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().includes(${JSON.stringify(text)}))
  if (!el) return 'missing'
  el.click(); return 'clicked'
})()`)

try {
  // Catalog: wait for the page, type through CDP, then search.
  await app.goto('#/catalog', 3500)
  await waitFor(`Boolean(document.querySelector('input[placeholder*="sodium"]'))`, 10000)
  await app.evaluate(`document.querySelector('input[placeholder*="sodium"]').focus(); 'focused'`)
  await app.send('Input.insertText', { text: 'sodium' })
  await sleep(300)
  result.typed = await app.evaluate(`document.querySelector('input[placeholder*="sodium"]').value`)
  await clickText('搜索')
  await waitFor(`document.body.innerText.includes('sodium') && !document.body.innerText.includes('77496 个结果')`, 20000)
  await sleep(1000)
  result.catalog = {
    screenshot: await app.screenshot('catalog-search-sodium.png'),
    text: (await app.text()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => l.includes('个结果') || l.includes('Sodium') || l.includes('Fabric API') || l.includes('sodium')).slice(0, 12),
    inputValue: await app.evaluate(`document.querySelector('input[placeholder*="sodium"]').value`),
  }

  // Updates: select 1.20.1 deterministically.
  await app.goto('#/updates', 1500)
  result.updatesSelect = await selectInstance('1.20.1')
  await sleep(800)
  await clickText('检查更新')
  await sleep(4000)
  result.updates = {
    screenshot: await app.screenshot('updates-check.png'),
    text: (await app.text()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => /个可更新|检查中|没有可更新|1\.20\.1|跳过|错误/.test(l)).slice(0, 12),
  }

  // Saves: select 1.20.1 and list the fixture.
  await app.goto('#/saves', 1500)
  result.savesSelect = await selectInstance('1.20.1')
  await sleep(1200)
  result.saves = {
    screenshot: await app.screenshot('saves-list.png'),
    text: (await app.text()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => l.includes('QA World') || l.includes('个世界') || l.includes('备份')).slice(0, 10),
  }

  // Screenshots: select 1.20.1 and show the real thumbnail.
  await app.goto('#/screenshots', 1500)
  result.screenshotsSelect = await selectInstance('1.20.1')
  await sleep(1200)
  result.screenshots = {
    screenshot: await app.screenshot('screenshots-grid.png'),
    text: (await app.text()).split('\n').map((s) => s.trim()).filter(Boolean).filter((l) => l.includes('qa-shot') || l.includes('张')).slice(0, 8),
  }
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('t45', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify(result, null, 2))
}
