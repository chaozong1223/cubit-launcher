const port = 9345;
const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = list.find((t) => t.type === 'page' && String(t.url).startsWith('app://mc-launcher'));
if (!page) { console.log('no page'); process.exit(0); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let id = 0; const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); p(m); } };
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalp = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 30000 }); return r.result?.result?.value; };
const r = JSON.parse(await evalp("window.mc.invoke('mc:download:list').then((x)=>JSON.stringify(x))"));
console.log(JSON.stringify(r, null, 2).slice(0, 3000));
ws.close();
