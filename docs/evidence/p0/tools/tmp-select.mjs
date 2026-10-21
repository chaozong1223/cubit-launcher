import { launch, newestWorkspace, ROOT, sleep } from './cdp-lib.mjs'
const ws = newestWorkspace()
const app = await launch({ name: 't45', dataDir: ws + '/data', mcDir: ws + '/mc', port: 9405 })
try {
  await app.goto('#/catalog', 4000)
  console.log('selects', await app.evaluate(`JSON.stringify([...document.querySelectorAll('select')].map((s, i) => ({ i, id: s.id, aria: s.getAttribute('aria-label'), value: s.value, disabled: s.disabled, options: [...s.options].slice(0,3).map(o=>o.value) })))`))
  await app.evaluate(`document.querySelector('#catalog-instance-select').focus(); 'ok'`)
  await app.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Home', code: 'Home', windowsVirtualKeyCode: 36 })
  await sleep(800)
  console.log('after Home', await app.evaluate(`document.querySelector('#catalog-instance-select').value`))
  console.log('header', (await app.text()).split('\n').filter(l=>l.includes('目标实例')||l.includes('Fabric')||l.includes('1.20.1')).slice(0,6))
} finally { app.close() }

