import fs from 'node:fs'
const idx = JSON.parse(fs.readFileSync('.e2e/e2e-install-H2EdGy/mc/assets/indexes/5.json','utf8'))
const keys = Object.keys(idx.objects).filter(k => idx.objects[k].size > 200000).slice(0, 12)
let ok = 0, fail = 0; const times = []
for (const k of keys) {
  const h = idx.objects[k].hash
  const url = `https://resources.download.minecraft.net/${h.slice(0,2)}/${h}`
  const t = Date.now()
  try {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 10000)
    const r = await fetch(url, { signal: ac.signal })
    const b = await r.arrayBuffer(); clearTimeout(timer)
    if (r.ok && b.byteLength === idx.objects[k].size) { ok++; times.push(Date.now()-t) } else { fail++; console.log('BAD', k, r.status, b.byteLength) }
  } catch (e) { fail++; console.log('ERR', k, String(e).slice(0,80), Date.now()-t) }
}
console.log(JSON.stringify({ok, fail, avgMs: times.reduce((a,b)=>a+b,0)/(times.length||1), maxMs: Math.max(...times,0)}))
