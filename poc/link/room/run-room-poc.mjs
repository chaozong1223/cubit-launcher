// Orchestrates the room-protocol PoC and asserts every documented behaviour.
// Usage: node run-room-poc.mjs [--out ../evidence/room]
// Exit code 0 only if all cases pass.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTicket, ErrorCodes } from './protocol.mjs'

function arg (name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback
}

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(arg('out', path.join(here, '..', 'evidence', 'room')))
const runId = new Date().toISOString().replace(/[:.]/g, '-')
const logDir = path.join(outDir, `run-${runId}`)
fs.mkdirSync(logDir, { recursive: true })
const roomFile = path.join(logDir, 'room.json')
const expiredFile = path.join(logDir, 'expired.ticket')
const eventsFile = path.join(logDir, 'host-events.jsonl')
const hostOut = fs.createWriteStream(path.join(logDir, 'host.out.log'))
const hostErr = fs.createWriteStream(path.join(logDir, 'host.err.log'))

const results = []
let host = null
let ready = null

function record (name, ok, detail, extra = {}) {
  results.push({ name, ok, detail, ...extra })
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} :: ${detail}`)
}

function waitForLine (stream, predicate, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timeout waiting for ${label}`)) }, timeoutMs)
    function onData (chunk) {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx)
        buf = buf.slice(idx + 1)
        const parsed = predicate(line)
        if (parsed !== undefined && parsed !== false && parsed !== null) { cleanup(); resolve(parsed) }
      }
    }
    function cleanup () { clearTimeout(timer); stream.off('data', onData) }
    stream.on('data', onData)
  })
}

async function startHost () {
  host = spawn(process.execPath, [
    path.join(here, 'host.mjs'),
    '--bind', '127.0.0.1', '--port', '0',
    '--name', 'poc-host', '--max', '2', '--mc-version', '1.20.1', '--loader', 'vanilla',
    '--heartbeat-ms', '1000', '--timeout-ms', '15000', '--ttl', '600',
    '--out', roomFile, '--expired-out', expiredFile, '--events', eventsFile
  ], { cwd: here, stdio: ['pipe', 'pipe', 'pipe'] })
  host.stdout.pipe(hostOut)
  host.stderr.pipe(hostErr)
  ready = await waitForLine(host.stdout, (line) => {
    if (!line.startsWith('HOST_READY ')) return undefined
    return JSON.parse(line.slice('HOST_READY '.length))
  }, 10000, 'HOST_READY')
  return JSON.parse(fs.readFileSync(roomFile, 'utf8'))
}

function sendHost (obj) {
  host.stdin.write(JSON.stringify(obj) + '\n')
}

function runMember (args, { onConnected, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [path.join(here, 'member.mjs'), ...args], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    let connectedSeen = false
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      resolve({ ok: false, code: 'POC_TIMEOUT', output: out, stderr: err, elapsed: timeoutMs })
    }, timeoutMs)
    proc.stdout.on('data', (chunk) => {
      out += chunk
      if (!connectedSeen && out.includes('MEMBER_CONNECTED')) {
        connectedSeen = true
        if (onConnected) onConnected(proc, out)
      }
    })
    proc.stderr.on('data', (chunk) => { err += chunk })
    proc.on('close', () => {
      clearTimeout(timer)
      const lines = out.split('\n').filter(l => l.startsWith('MEMBER_RESULT '))
      if (!lines.length) return resolve({ ok: false, code: 'NO_RESULT', output: out, stderr: err })
      try { resolve(JSON.parse(lines[lines.length - 1].slice('MEMBER_RESULT '.length))) } catch (e) { resolve({ ok: false, code: 'BAD_RESULT', output: out, stderr: err }) }
    })
  })
}

function tamperTicket (ticket) {
  const [prefix, code, bodyB64, sig] = ticket.split('.')
  const payload = JSON.parse(Buffer.from(bodyB64, 'base64url').toString('utf8'))
  payload.tunnel.worldPort = 25566
  payload.max = 64
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  return `${prefix}.${code}.${body}.${sig}`
}

function withTicket (ticket, args = []) {
  return ['--ticket', ticket, ...args]
}

const summary = { runId, startedAt: new Date().toISOString(), cases: results, ok: false }
try {
  const room = await startHost()
  const { ticket } = room
  const parsed = parseTicket(ticket)
  record('ticket-self-verifies', parsed.payload.code === room.code, `code=${room.code} exp=${parsed.payload.exp}`)

  // 1. normal join + world update + PONG
  const normal = await runMember(withTicket(ticket, ['--name', 'alice', '--hold', '2500']), {
    onConnected: () => sendHost({ cmd: 'world', port: 25565, address: '127.0.0.1:25565' })
  })
  const worldEvent = normal.events?.some(e => e.type === 'room_event' && e.event === 'world' && e.world?.port === 25565)
  record('normal-join', normal.ok === true && normal.connected === true && worldEvent, `connected=${normal.connected} worldUpdate=${worldEvent} elapsed=${normal.elapsedMs}ms`, { code: normal.code })

  // 2. short code only -> INVITE_INCOMPLETE
  const shortOnly = await runMember(['--code', room.code, '--hold', '1000'], { timeoutMs: 8000 })
  record('short-code-incomplete', shortOnly.code === ErrorCodes.INVITE_INCOMPLETE, `${shortOnly.code} ${shortOnly.message ?? ''}`)

  // 3. tampered ticket -> signature invalid
  const tampered = await runMember(withTicket(tamperTicket(ticket), ['--name', 'mallory']), { timeoutMs: 8000 })
  record('tampered-ticket-rejected', tampered.code === ErrorCodes.TICKET_SIGNATURE_INVALID, `${tampered.code} ${tampered.message ?? ''}`)

  // 4. expired ticket -> INVITE_EXPIRED
  const expiredTicket = fs.readFileSync(expiredFile, 'utf8').trim()
  const expired = await runMember(withTicket(expiredTicket, ['--name', '迟到者']), { timeoutMs: 8000 })
  record('expired-ticket-rejected', expired.code === ErrorCodes.INVITE_EXPIRED, `${expired.code} ${expired.message ?? ''}`)

  // 5. version mismatch -> VERSION_MISMATCH
  const mismatch = await runMember(withTicket(ticket, ['--name', 'bob', '--mc-version', '1.20.4']), { timeoutMs: 10000 })
  record('version-mismatch', mismatch.code === ErrorCodes.VERSION_MISMATCH, `${mismatch.code} ${mismatch.message ?? ''}`)

  // 6. wrong room token -> AUTH_FAILED
  const badAuth = await runMember(withTicket(ticket, ['--name', 'eve', '--auth-tamper', 'true']), { timeoutMs: 10000 })
  record('bad-token-rejected', badAuth.code === ErrorCodes.AUTH_FAILED, `${badAuth.code} ${badAuth.message ?? ''}`)

  // 7. room full (max=2): hold two members, third is rejected
  const holdA = runMember(withTicket(ticket, ['--name', 'hold-a', '--hold', '7000']), { timeoutMs: 9000 })
  const holdB = runMember(withTicket(ticket, ['--name', 'hold-b', '--hold', '7000']), { timeoutMs: 9000 })
  await new Promise(r => setTimeout(r, 1200))
  const third = await runMember(withTicket(ticket, ['--name', 'third']), { timeoutMs: 8000 })
  record('room-full', third.code === ErrorCodes.ROOM_FULL, `${third.code} ${third.message ?? ''}`)
  await Promise.all([holdA, holdB])

  // 8. heartbeat timeout while host is frozen
  const hb = await runMember(withTicket(ticket, ['--name', 'hb-victim', '--heartbeat-ms', '300', '--timeout-ms', '1200', '--hold', '6000']), {
    timeoutMs: 12000,
    onConnected: () => setTimeout(() => sendHost({ cmd: 'freeze', value: true }), 500)
  })
  record('heartbeat-timeout', hb.code === ErrorCodes.HEARTBEAT_TIMEOUT, `${hb.code} ${hb.message ?? ''} elapsed=${hb.elapsedMs}ms`)
  sendHost({ cmd: 'freeze', value: false })
  await new Promise(r => setTimeout(r, 800))

  // 9. host close -> members notified with ROOM_CLOSED
  const closeCase = await runMember(withTicket(ticket, ['--name', 'close-victim', '--hold', '8000']), {
    timeoutMs: 12000,
    onConnected: () => setTimeout(() => sendHost({ cmd: 'close', reason: 'HOST_LEFT' }), 500)
  })
  record('host-close-notifies-members', closeCase.code === ErrorCodes.ROOM_CLOSED, `${closeCase.code} ${closeCase.message ?? ''} elapsed=${closeCase.elapsedMs}ms`)

  // 10. join after host gone -> NETWORK_UNREACHABLE
  const gone = await runMember(withTicket(ticket, ['--name', 'late']), { timeoutMs: 8000 })
  record('join-after-close-fails', gone.code === ErrorCodes.NETWORK_UNREACHABLE, `${gone.code} ${gone.message ?? ''}`)

  const ok = results.every(r => r.ok)
  summary.ok = ok
  summary.finishedAt = new Date().toISOString()
  summary.cases = results
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2))
  fs.writeFileSync(path.join(outDir, 'summary-latest.json'), JSON.stringify(summary, null, 2))
  const md = [
    `# Room protocol PoC (${runId})`,
    '',
    `- room code: ${room.code} (invite ${room.invite})`,
    `- control port: ${room.controlPort}`,
    `- ticket payload: \`${JSON.stringify(parsed.payload)}\``,
    '',
    '| case | result | detail |',
    '| --- | --- | --- |',
    ...results.map(r => `| ${r.name} | ${r.ok ? 'PASS' : 'FAIL'} | ${String(r.detail).replace(/\|/g, '\\|')} |`),
    '',
    `**overall: ${ok ? 'PASS' : 'FAIL'}**`,
    '',
    'Host events: host-events.jsonl; host output: host.out.log.'
  ].join('\n')
  fs.writeFileSync(path.join(logDir, 'RESULT.md'), md)
  console.log(`\noverall ${ok ? 'PASS' : 'FAIL'} -> ${logDir}`)
  process.exitCode = ok ? 0 : 1
} catch (err) {
  record('orchestrator', false, err.message)
  summary.cases = results
  summary.ok = false
  summary.error = err.message
  fs.writeFileSync(path.join(logDir, 'summary.json'), JSON.stringify(summary, null, 2))
  console.error(err)
  process.exitCode = 1
} finally {
  if (host && !host.killed) { host.kill('SIGTERM'); setTimeout(() => host.kill('SIGKILL'), 500) }
}
