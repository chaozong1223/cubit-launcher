// Minimal Minecraft Java Edition status-list ping client (protocol 763 = 1.20.1).
// Usage: node mc-status.mjs <host> <port> [protocolVersion] [hostnameForHandshake]
// Prints one JSON line: {ok, host, port, latencyMs, version, protocol, players, motd, error}
import net from 'node:net'

const host = process.argv[2] ?? '127.0.0.1'
const port = Number(process.argv[3] ?? 25565)
const protocol = Number(process.argv[4] ?? 763)
const handshakeHost = process.argv[5] ?? host

function varInt (value) {
  const out = []
  let v = value >>> 0
  do {
    let byte = v & 0x7f
    v >>>= 7
    if (v) byte |= 0x80
    out.push(byte)
  } while (v)
  return Buffer.from(out)
}

function packet (id, payload) {
  const body = Buffer.concat([varInt(id), payload])
  return Buffer.concat([varInt(body.length), body])
}

function string (s) {
  const b = Buffer.from(s, 'utf8')
  return Buffer.concat([varInt(b.length), b])
}

function readVarInt (buf, offset) {
  let value = 0
  let shift = 0
  let pos = offset
  while (pos < buf.length) {
    const byte = buf[pos++]
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, pos }
    shift += 7
    if (shift > 35) throw new Error('varint too long')
  }
  return null
}

function readString (buf, offset) {
  const len = readVarInt(buf, offset)
  if (!len) return null
  const end = len.pos + len.value
  if (buf.length < end) return null
  return { value: buf.subarray(len.pos, end).toString('utf8'), pos: end }
}

const startedAt = Date.now()
const socket = net.createConnection({ host, port })
socket.setTimeout(5000)
let chunks = []
let done = false

function finish (result) {
  if (done) return
  done = true
  console.log(JSON.stringify({ host, port, latencyMs: Date.now() - startedAt, ...result }))
  socket.destroy()
}

socket.on('connect', () => {
  const handshake = Buffer.concat([
    varInt(protocol),
    string(handshakeHost),
    Buffer.from([(port >> 8) & 0xff, port & 0xff]),
    varInt(1)
  ])
  socket.write(packet(0x00, handshake))
  socket.write(packet(0x00, Buffer.alloc(0)))
})

socket.on('data', (data) => {
  chunks.push(data)
  const buf = Buffer.concat(chunks)
  const len = readVarInt(buf, 0)
  if (!len || buf.length < len.pos + len.value) return
  const body = buf.subarray(len.pos, len.pos + len.value)
  const id = readVarInt(body, 0)
  if (!id || id.value !== 0x00) return finish({ ok: false, error: `unexpected packet id ${id?.value}` })
  const json = readString(body, id.pos)
  if (!json) return finish({ ok: false, error: 'short status payload' })
  try {
    const status = JSON.parse(json.value)
    finish({
      ok: true,
      version: status.version?.name,
      protocol: status.version?.protocol,
      players: { online: status.players?.online, max: status.players?.max, sample: status.players?.sample?.map(p => p.name) },
      motd: typeof status.description === 'string' ? status.description : status.description?.text
    })
  } catch (err) {
    finish({ ok: false, error: `bad json: ${err.message}` })
  }
})

socket.on('timeout', () => finish({ ok: false, error: 'timeout' }))
socket.on('error', (err) => finish({ ok: false, error: err.message }))
socket.on('close', () => finish({ ok: false, error: 'closed before status' }))
