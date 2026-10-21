const port = 9345
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
const page = list.find((t) => t.type === 'page' && String(t.url).startsWith('app://mc-launcher'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let id = 0; const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m) } }
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })
const evalp = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 60000 }); return r.result?.result?.value }
const invoke = async (channel, payload) => {
  const expr = payload === undefined
    ? `window.mc.invoke(${JSON.stringify(channel)}).then((r)=>JSON.stringify(r))`
    : `window.mc.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)}).then((r)=>JSON.stringify(r))`
  return JSON.parse(await evalp(expr))
}
console.log('settings', JSON.stringify((await invoke('mc:download:getSettings')).data))
const jobs = await invoke('mc:download:list')
console.log('jobs', JSON.stringify(jobs.data).slice(0, 500))
for (const job of jobs.data || []) { if (job.state === 'running' || job.state === 'queued') console.log('cancel', job.jobId, JSON.stringify((await invoke('mc:download:cancel', { jobId: job.jobId })).data)) }
ws.close()
