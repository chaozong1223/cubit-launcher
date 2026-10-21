import { launch, newestWorkspace, sleep } from './cdp-lib.mjs'
const ws = newestWorkspace()
const app = await launch({ name: 't45', dataDir: 'D:/DSH-工作文件/mc-launcher/.e2e/t45-dialog3-data', mcDir: ws + '/mc', port: 9411 })
await app.goto('#/instances/1.20.1', 1500)
await app.evaluate(`(() => { const t = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '模组'); if (t) t.click(); return 'ok' })()`)
await sleep(1200)
console.log('click', await app.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '选择文件'); if (!b) return 'missing'; b.click(); return 'clicked' })()`))
console.log('HOLDING')
setInterval(() => {}, 2000)
