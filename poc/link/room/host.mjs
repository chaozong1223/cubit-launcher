// Room host PoC: control channel + invite ticket + heartbeat + lifecycle.
// Usage:
//   node host.mjs --bind 127.0.0.1 --port 0 --out room.json --events events.jsonl
// Prints one line: HOST_READY {"code":...,"controlPort":...,"roomFile":...}
// Reads NDJSON commands on stdin: {"cmd":"world","port":25565} | {"cmd":"close"} | {"cmd":"freeze","value":true}
import net from 'node:net'
import fs from 'node:fs'
import crypto from 'node:crypto'
import {
  createHostIdentity, issueTicket, parseTicket, shortInvite, normalizeCode,
  helloAuth, welcomeAuth, hmac, safeEqual, ErrorCodes, LinkError
} from './protocol.mjs'

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const bind = arg('bind', '127.0.0.1')
const requestedPort = Number(arg('port', '0'))
const maxMembers = Number(arg('max', '8'))
const mcVersion = arg('mc-version', '1.20.1')
const loader = arg('loader', 'vanilla')
const heartbeatMs = Number(arg('heartbeat-ms', '5000'))
const timeoutMs = Number(arg('timeout-ms', '15000'))
const ttlSeconds = Number(arg('ttl', '600'))
const outFile = arg('out', 'room.json')
const expiredOut = arg('expired-out', '')
const eventsFile = arg('events', '')

const identity = createHostIdentity({ hostName: arg('name', 'poc-host'), mcVersion, loader, maxMembers })
const members = new Map()
const startedAt = Date.now()
let world = { port: null, state: 'pending', address: null }
let frozen = false
let closing = false
let ticket = null

function event (type, data = {}) {
  const line = JSON.stringify({ at: new Date().toISOString(), type, ...data })
  if (eventsFile) fs.appendFileSync(eventsFile, line + '\n')
  console.log(`EVT ${line}`)
}

function roomInfo () {
  return {
    code: identity.code,
    invite: shortInvite(identity.code),
    hostName: identity.identity.hostName,
    mc: identity.identity.mc,
    max: maxMembers,
    members: [...members.values()].map(m => ({ id: m.id, name: m.name, role: m.role, mcVersion: m.mcVersion, loader: m.loader, path: m.path })),
    world,
    createdAt: startedAt,
    expiresAt: ticket ? ticket.payload.exp * 1000 : null
  }
}

function send (socket, obj) {
  if (socket.destroyed) return
  socket.write(JSON.stringify(obj) + '\n')
}

function broadcast (obj, except = null) {
  for (const m of members.values()) if (m.socket !== except) send(m.socket, obj)
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8')
  socket.setNoDelay(true)
  let buffer = ''
  let member = null
  let authenticated = false

  const fail = (code, message, detail) => {
    send(socket, { t: 'ERROR', code, message, detail })
    event('error', { code, message, detail, memberId: member?.id })
    socket.end()
  }

  socket.on('data', (chunk) => {
    buffer += chunk
    if (buffer.length > 65536) { fail(ErrorCodes.TICKET_MALFORMED, 'control line too large'); return }
    let idx
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx)
      buffer = buffer.slice(idx + 1)
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch { fail(ErrorCodes.TICKET_MALFORMED, 'bad json'); return }
      handle(msg)
    }
  })

  function handle (msg) {
    if (frozen) return
    if (msg.t === 'HELLO') {
      if (authenticated) return fail(ErrorCodes.AUTH_FAILED, 'already authenticated')
      try {
        if (msg.v !== 1) throw new LinkError(ErrorCodes.INVITE_INVALID, 'protocol version')
        if (normalizeCode(msg.code) !== identity.code) throw new LinkError(ErrorCodes.INVITE_INVALID, 'code mismatch')
        if (!msg.nonce || typeof msg.nonce !== 'string' || msg.nonce.length > 64) throw new LinkError(ErrorCodes.AUTH_FAILED, 'nonce')
        if (!msg.member || typeof msg.member.id !== 'string' || typeof msg.member.name !== 'string') throw new LinkError(ErrorCodes.AUTH_FAILED, 'member shape')
        if (msg.member.name.length > 32) throw new LinkError(ErrorCodes.AUTH_FAILED, 'name too long')
        const expected = helloAuth(identity.token, { code: identity.code, nonce: msg.nonce, memberId: msg.member.id })
        if (!safeEqual(expected, msg.auth ?? '')) throw new LinkError(ErrorCodes.AUTH_FAILED, 'bad auth')
        const exp = ticket.payload.exp * 1000
        if (Date.now() > exp) throw new LinkError(ErrorCodes.INVITE_EXPIRED, 'ticket expired')
        if (msg.member.mcVersion !== mcVersion || msg.member.loader !== loader) {
          throw new LinkError(ErrorCodes.VERSION_MISMATCH, `host ${mcVersion}/${loader}, member ${msg.member.mcVersion}/${msg.member.loader}`)
        }
        if (members.size >= maxMembers) throw new LinkError(ErrorCodes.ROOM_FULL, `max ${maxMembers}`)
        if ([...members.values()].some(m => m.id === msg.member.id)) throw new LinkError(ErrorCodes.AUTH_FAILED, 'duplicate member id')
        member = {
          id: msg.member.id,
          name: msg.member.name,
          role: 'member',
          mcVersion: msg.member.mcVersion,
          loader: msg.member.loader,
          path: msg.member.path === 'relay' ? 'relay' : 'direct',
          socket,
          lastSeen: Date.now()
        }
        members.set(member.id, member)
        authenticated = true
        send(socket, {
          t: 'WELCOME',
          v: 1,
          room: roomInfo(),
          members: [...members.values()].map(m => ({ id: m.id, name: m.name, role: m.role, mcVersion: m.mcVersion, loader: m.loader, path: m.path })),
          world,
          auth: welcomeAuth(identity.token, { code: identity.code, nonce: msg.nonce })
        })
        event('member_join', { memberId: member.id, name: member.name, mcVersion: member.mcVersion, loader })
        broadcast({ t: 'EVENT', event: 'members', members: [...members.values()].map(m => ({ id: m.id, name: m.name, role: m.role, mcVersion: m.mcVersion, loader: m.loader, path: m.path })) }, socket)
      } catch (err) {
        fail(err.code ?? ErrorCodes.AUTH_FAILED, err.message, err.detail)
      }
      return
    }
    if (!authenticated || !member) return fail(ErrorCodes.AUTH_FAILED, 'HELLO required')
    member.lastSeen = Date.now()
    if (msg.t === 'PING') {
      send(socket, { t: 'PONG', seq: msg.seq, ts: Date.now(), members: [...members.values()].map(m => ({ id: m.id, name: m.name, role: m.role, path: m.path })), world })
      return
    }
    if (msg.t === 'LEAVE') {
      event('member_leave', { memberId: member.id, reason: 'client_leave' })
      members.delete(member.id)
      broadcast({ t: 'EVENT', event: 'members', members: [...members.values()].map(m => ({ id: m.id, name: m.name, role: m.role, path: m.path })) })
      socket.end()
      return
    }
    fail(ErrorCodes.TICKET_MALFORMED, `unknown message ${msg.t}`)
  }

  socket.on('close', () => {
    if (member && members.has(member.id)) {
      members.delete(member.id)
      event('member_leave', { memberId: member.id, reason: 'socket_closed' })
      broadcast({ t: 'EVENT', event: 'members', members: [...members.values()].map(m => ({ id: m.id, name: m.name, role: m.role, path: m.path })) })
    }
  })
  socket.on('error', () => { /* close handler cleans up */ })
})

function issueCurrentTicket (port) {
  return issueTicket(identity, {
    endpoints: [{ kind: 'lan', host: bind, port }],
    tunnel: {
      provider: 'easytier',
      version: '2.7.0',
      vip: '10.144.144.1',
      mappedCidr: '192.168.77.1/32',
      worldPort: 25565,
      controlPort: 25998
    },
    ttlSeconds
  })
}

const sweeper = setInterval(() => {
  if (frozen) return
  const now = Date.now()
  for (const m of [...members.values()]) {
    if (now - m.lastSeen > timeoutMs) {
      members.delete(m.id)
      event('member_leave', { memberId: m.id, reason: 'heartbeat_timeout' })
      send(m.socket, { t: 'ERROR', code: ErrorCodes.HEARTBEAT_TIMEOUT, message: 'heartbeat timeout' })
      m.socket.destroy()
      broadcast({ t: 'EVENT', event: 'members', members: [...members.values()].map(x => ({ id: x.id, name: x.name, role: x.role, path: x.path })) })
    }
  }
}, Math.max(200, Math.floor(timeoutMs / 3)))

server.listen(requestedPort, bind, () => {
  const port = server.address().port
  ticket = issueCurrentTicket(port)
  const room = {
    ...roomInfo(),
    ticket: ticket.ticket,
    ticketPayload: ticket.payload,
    controlPort: port,
    bind,
    heartbeatMs,
    timeoutMs,
    maxMembers
  }
  fs.writeFileSync(outFile, JSON.stringify(room, null, 2))
  if (expiredOut) {
    const past = Math.floor(Date.now() / 1000) - 3600
    const expired = issueTicket(identity, {
      endpoints: [{ kind: 'lan', host: bind, port }],
      now: past,
      ttlSeconds: 60
    })
    fs.writeFileSync(expiredOut, expired.ticket)
    event('expired_ticket_issued', { file: expiredOut })
  }
  event('room_created', { code: identity.code, controlPort: port, bind, maxMembers, mcVersion, loader })
  console.log(`HOST_READY ${JSON.stringify({ code: identity.code, invite: shortInvite(identity.code), controlPort: port, roomFile: outFile, ticket: ticket.ticket })}`)
})

function shutdown (reason) {
  if (closing) return
  closing = true
  for (const m of members.values()) send(m.socket, { t: 'CLOSE', reason })
  event('room_closed', { reason })
  setTimeout(() => {
    for (const m of members.values()) m.socket.destroy()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 500)
  }, 100)
}

process.on('SIGINT', () => shutdown('HOST_LEFT'))
process.on('SIGTERM', () => shutdown('HOST_LEFT'))

// stdin control channel (used by run-room-poc.mjs)
let stdinBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk
  let idx
  while ((idx = stdinBuffer.indexOf('\n')) >= 0) {
    const line = stdinBuffer.slice(0, idx)
    stdinBuffer = stdinBuffer.slice(idx + 1)
    if (!line.trim()) continue
    let cmd
    try { cmd = JSON.parse(line) } catch { continue }
    if (cmd.cmd === 'world') {
      world = { port: Number(cmd.port) || null, state: 'open', address: cmd.address ?? null }
      event('world_update', world)
      broadcast({ t: 'EVENT', event: 'world', world })
    } else if (cmd.cmd === 'close') {
      shutdown(cmd.reason ?? 'HOST_LEFT')
    } else if (cmd.cmd === 'freeze') {
      frozen = Boolean(cmd.value)
      event('freeze', { value: frozen })
    } else if (cmd.cmd === 'kick') {
      const m = members.get(cmd.memberId)
      if (m) { send(m.socket, { t: 'CLOSE', reason: 'KICKED' }); m.socket.destroy(); members.delete(m.id) }
    }
  }
})
