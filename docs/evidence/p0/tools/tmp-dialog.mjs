import { launch, newestWorkspace, sleep } from './cdp-lib.mjs'
const ws = newestWorkspace()
const app = await launch({ name: 't45', dataDir: 'D:/DSH-工作文件/mc-launcher/.e2e/t45-dialog-data', mcDir: ws + '/mc', port: 9409 })
try {
  await app.goto('#/instances/1.20.1', 1500)
  await app.evaluate(`(() => { const t = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '模组'); if (t) t.click(); return 'ok' })()`)
  await sleep(1200)
  console.log('click', await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '选择文件'); if (!b) return 'missing'; b.click(); return 'clicked' })()`))
  await sleep(2500)
  console.log('dialog screenshot', await app.screenshot('picker-dialog.png'))
} finally { app.close() }

