const port = Number(process.argv[2] || 9345)
const patch = JSON.parse(process.argv[3] || '{}')
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.url).startsWith('app://mc-launcher'))
if (!page) { console.error('no page'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m) } }
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalp = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 }); return r.result?.result?.value }
const invoke = async (channel, payload) => JSON.parse(await evalp(`window.mc.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)}).then((r)=>JSON.stringify(r))`))
const out = await invoke('mc:download:updateSettings', patch)
console.log(JSON.stringify(out))
ws.close()
