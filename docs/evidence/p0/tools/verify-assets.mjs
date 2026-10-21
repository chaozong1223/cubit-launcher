import fs from 'node:fs'
import crypto from 'node:crypto'
const mc = '.e2e/e2e-install-H2EdGy/mc'
const idx = JSON.parse(fs.readFileSync(`${mc}/assets/indexes/5.json`, 'utf8'))
const keys = Object.keys(idx.objects)
const sample = keys.sort(() => Math.random() - 0.5).slice(0, 40)
let ok = 0; const bad = []
for (const k of sample) {
  const o = idx.objects[k]
  const p = `${mc}/assets/objects/${o.hash.slice(0,2)}/${o.hash}`
  try {
    const buf = fs.readFileSync(p)
    const h = crypto.createHash('sha1').update(buf).digest('hex')
    if (h === o.hash && buf.length === o.size) ok++; else bad.push(`${k} hash=${h} size=${buf.length}/${o.size}`)
  } catch (e) { bad.push(`${k} ${String(e)}`) }
}
console.log(`assets sample: matched=${ok} mismatched=${bad.length} of ${sample.length}`)
for (const b of bad) console.log(b)
console.log(`index totalSize=${Object.values(idx.objects).reduce((a,o)=>a+o.size,0)}`)
