const h = '76440d134c908d9c0114aecc9ffbb63cd3b18106'
for (const url of [
  `https://resources.download.minecraft.net/${h.slice(0,2)}/${h}`,
  `https://bmclapi2.bangbang93.com/assets/${h.slice(0,2)}/${h}`,
]) {
  const t = Date.now()
  try {
    const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 10000)
    const r = await fetch(url, { signal: ac.signal, redirect: 'follow' })
    clearTimeout(timer)
    const buf = await r.arrayBuffer()
    console.log(url, '->', r.status, buf.byteLength, 'ms', Date.now() - t, 'final', r.url.slice(0, 90))
  } catch (e) { console.log(url, '-> ERR', String(e), 'ms', Date.now() - t) }
}
