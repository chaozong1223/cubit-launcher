// Room member PoC: verifies the invite ticket offline, connects to the control
// channel, authenticates with the room token, sends heartbeats and reports a
// stable result line: MEMBER_RESULT {...}
// Usage:
//   node member.mjs --ticket-file room.ticket --code ABC123 --name alice --hold 8000
//   node member.mjs --code ABC123            # short code only -> INVITE_INCOMPLETE
import net from 'node:net'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  parseTicket, normalizeCode, helloAuth, welcomeAuth, safeEqual, ErrorCodes, LinkError, shortInvite
} from './protocol.mjs'

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const name = arg('name', 'member')
const codeArg = arg('code', '')
const mcVersion = arg('mc-version', '1.20.1')
const loader = arg('loader', 'vanilla')
const heartbeatMs = Number(arg('heartbeat-ms', '5000'))
const timeoutMs = Number(arg('timeout-ms', '15000'))
const holdMs = Number(arg('hold', '0'))
const path = arg('path', 'direct')
const memberId = arg('id', crypto.randomBytes(6).toString('hex'))
let ticketText = arg('ticket', '')
const ticketFile = arg('ticket-file', '')
if (!ticketText && ticketFile) ticketText = fs.readFileSync(ticketFile, 'utf8').trim()

const startedAt = Date.now()
const events = []
let resultSent = false
let socket = null
let interval = null
let lastPong = Date.now()
let connected = false

function event (type, data = {}) {
  events.push({ at: new Date().toISOString(), type, ...data })
}

function finish (result) {
  if (resultSent) return
  resultSent = true
  if (interval) clearInterval(interval)
  try { socket?.destroy() } catch { }
  const payload = {
    memberId,
    name,
    mcVersion,
    loader,
    connected,
    elapsedMs: Date.now() - startedAt,
    events,
    ...result
  }
  console.log(`MEMBER_RESULT ${JSON.stringify(payload)}`)
  setTimeout(() => process.exit(result.ok ? 0 : 2), 50)
}

function fail (code, message, detail) {
  event('error', { code, message, detail })
  finish({ ok: false, code, message, detail })
}

if (!ticketText) {
  if (codeArg) fail(ErrorCodes.INVITE_INCOMPLETE, 'only a 6-char code was provided; cross-network join needs the full MCL1 ticket')
  else fail(ErrorCodes.INVITE_INVALID, 'no ticket or code')
} else {
  let parsed
  try {
    parsed = parseTicket(ticketText, { expectedCode: codeArg || undefined })
  } catch (err) {
    fail(err.code ?? ErrorCodes.INVITE_INVALID, err.message)
  }
  if (parsed) {
    const { payload } = parsed
    const token = Buffer.from(payload.net.secret, 'base64url')
    if (arg('auth-tamper', 'false') === 'true') token[0] ^= 0xff
    const endpoint = payload.endpoints[0]
    event('ticket_verified', { code: payload.code, roomId: payload.roomId, exp: payload.exp, endpoint, mc: payload.mc })
    socket = net.createConnection({ host: endpoint.host, port: endpoint.port })
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    socket.setTimeout(8000)
    let buffer = ''
    let nonce = null
    let helloSentAt = 0

    socket.on('connect', () => {
      nonce = crypto.randomBytes(16).toString('base64url')
      helloSentAt = Date.now()
      const hello = {
        t: 'HELLO',
        v: 1,
        code: payload.code,
        nonce,
        member: { id: memberId, name, mcVersion, loader, path },
        auth: helloAuth(token, { code: payload.code, nonce, memberId })
      }
      socket.write(JSON.stringify(hello) + '\n')
      event('hello_sent', { code: payload.code, mcVersion, loader })
    })

    socket.on('data', (chunk) => {
      buffer += chunk
      if (buffer.length > 65536) return fail(ErrorCodes.TICKET_MALFORMED, 'control line too large')
      let idx
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx)
        buffer = buffer.slice(idx + 1)
        if (!line.trim()) continue
        let msg
        try { msg = JSON.parse(line) } catch { return fail(ErrorCodes.TICKET_MALFORMED, 'bad json from host') }
        handle(msg)
      }
    })

    function handle (msg) {
      if (msg.t === 'WELCOME') {
        if (msg.room?.code !== payload.code) return fail(ErrorCodes.INVITE_INVALID, 'welcome code mismatch')
        const expected = welcomeAuth(token, { code: payload.code, nonce })
        if (!safeEqual(expected, msg.auth ?? '')) return fail(ErrorCodes.AUTH_FAILED, 'welcome auth failed')
        connected = true
        lastPong = Date.now()
        event('welcome', { room: msg.room, members: msg.members, world: msg.world })
        console.log(`MEMBER_CONNECTED ${JSON.stringify({ code: payload.code, invite: shortInvite(payload.code), room: msg.room, members: msg.members, world: msg.world, authOk: true })}`)
        interval = setInterval(() => {
          if (Date.now() - lastPong > timeoutMs) {
            fail(ErrorCodes.HEARTBEAT_TIMEOUT, `no PONG for ${timeoutMs}ms`)
            return
          }
          socket.write(JSON.stringify({ t: 'PING', seq: Date.now(), ts: Date.now() }) + '\n')
        }, heartbeatMs)
        if (holdMs > 0) setTimeout(() => finish({ ok: true, code: 'OK', message: 'hold finished' }), holdMs)
        return
      }
      if (msg.t === 'PONG') {
        lastPong = Date.now()
        event('pong', { seq: msg.seq, members: msg.members, world: msg.world })
        return
      }
      if (msg.t === 'EVENT') {
        event('room_event', { event: msg.event, members: msg.members, world: msg.world })
        return
      }
      if (msg.t === 'CLOSE') {
        const code = msg.reason === 'HOST_LEFT' ? ErrorCodes.ROOM_CLOSED : (msg.reason === 'KICKED' ? ErrorCodes.ROOM_CLOSED : ErrorCodes.ROOM_CLOSED)
        event('room_closed', { reason: msg.reason })
        finish({ ok: false, code, message: `room closed: ${msg.reason}`, reason: msg.reason })
        return
      }
      if (msg.t === 'ERROR') {
        fail(msg.code ?? ErrorCodes.INVITE_INVALID, msg.message ?? 'host error', msg.detail)
      }
    }

    socket.on('timeout', () => {
      if (!connected) fail(ErrorCodes.NETWORK_UNREACHABLE, 'connect/hello timeout')
    })
    socket.on('error', (err) => {
      if (!connected) fail(ErrorCodes.NETWORK_UNREACHABLE, err.message)
      else fail(ErrorCodes.ROOM_CLOSED, `socket error: ${err.message}`)
    })
    socket.on('close', () => {
      if (!resultSent) {
        if (!connected) fail(ErrorCodes.NETWORK_UNREACHABLE, 'closed before welcome')
        else fail(ErrorCodes.HEARTBEAT_TIMEOUT, 'host connection lost (no CLOSE frame)')
      }
    })
  }
}
