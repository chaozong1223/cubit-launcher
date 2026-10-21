// t45: exact-text button clicks + keyboard selection for catalog/updates.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const app = await launch({ name: 't45', dataDir: path.join(ws, 'data'), mcDir: path.join(ws, 'mc'), port: 9406 })
const result = {}
const clickExact = async (text) => app.evaluate(`(() => {
  const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === ${JSON.stringify(text)})
  if (!el) return 'missing'
  el.click(); return 'clicked'
})()`)
const key = async (k, code, vk) => {
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk })
}
try {
  await app.goto('#/catalog', 4000)
  await app.evaluate(`document.querySelector('input[placeholder*="sodium"]').focus(); 'ok'`)
  for (const ch of 'sodium') {
    await app.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, unmodifiedText: ch })
    await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
    await sleep(50)
  }
  await sleep(500)
  result.clickSearch = await clickExact('搜索')
  await sleep(12000)
  result.catalog = {
    screenshot: await app.screenshot('catalog-search-sodium.png'),
    header: (await app.text()).split('\n').map((s) => s.trim()).filter((l) => l.includes('个结果') || l === 'Sodium' || l.includes('Sodium Extra')).slice(0, 8),
  }

  await app.evaluate(`document.querySelector('#catalog-instance-select').focus(); 'ok'`)
  await key('Home', 'Home', 36)
  await sleep(800)
  result.selectedValue = await app.evaluate(`document.querySelector('#catalog-instance-select').value`)
  result.selectedText = await app.evaluate(`document.querySelector('#catalog-instance-select').selectedOptions[0].textContent.trim()`)
  result.clickUpdates = await clickExact('模组更新')
  await sleep(1500)
  result.clickCheck = await clickExact('检查更新')
  await sleep(5000)
  result.updates = {
    screenshot: await app.screenshot('updates-check.png'),
    summary: (await app.text()).split('\n').map((s) => s.trim()).filter((l) => /个可更新|检查 \d|跳过|错误|MC 未|vanilla|Fabric/.test(l)).slice(-10),
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
    clickSearch: result.clickSearch,
    catalog: result.catalog,
    selectedValue: result.selectedValue,
    selectedText: result.selectedText,
    clickUpdates: result.clickUpdates,
    clickCheck: result.clickCheck,
    updates: result.updates,
    check: result.checkBackend && { checked: result.checkBackend.checked, matched: result.checkBackend.matched, updates: result.checkBackend.updates.length },
    fatal: result.fatal ?? null,
  }, null, 2))
}
