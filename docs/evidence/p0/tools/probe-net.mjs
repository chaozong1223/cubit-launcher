// t34 P0-6 probe: two packaged app processes (different --data-dir) create/join
// a LAN room, inspect members/latency, exercise invite errors, set the world
// port, enter the world through quickPlay, and verify close propagation.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
if (!ws) throw new Error('no e2e workspace')
const mcDir = path.join(ws, 'mc')

// A fake 1.20.4 instance (copied files, rewritten id) to prove VERSION_MISMATCH.
const fake = path.join(mcDir, 'versions', 'qa-1.20.4')
if (!fs.existsSync(fake)) {
  fs.cpSync(path.join(mcDir, 'versions', '1.20.1'), fake, { recursive: true })
  const json = JSON.parse(fs.readFileSync(path.join(fake, '1.20.1.json'), 'utf8'))
  json.id = 'qa-1.20.4'
  fs.writeFileSync(path.join(fake, 'qa-1.20.4.json'), JSON.stringify(json), 'utf8')
  fs.rmSync(path.join(fake, '1.20.1.json'))
  fs.renameSync(path.join(fake, '1.20.1.jar'), path.join(fake, 'qa-1.20.4.jar'))
}

const dataA = path.join(ROOT, '.e2e', 'qa-06-A')
const dataB = path.join(ROOT, '.e2e', 'qa-06-B')
for (const dir of [dataA, dataB]) fs.rmSync(dir, { recursive: true, force: true })

const result = { workspace: ws, mcDir, dataA, dataB, steps: {} }
const a = await launch({ name: 'P0-6', dataDir: dataA, mcDir, port: 9384 })
let b = null
let server = null
try {
  // Accounts and selected instances (separate data dirs -> no pollution).
  await a.invoke('mc:auth:createOffline', { name: 'HostUser' })
  result.steps.instancesA = (await a.invoke('mc:instance:list')).map((i) => ({ id: i.id, mcVersion: i.mcVersion, loader: i.loader, state: i.state }))

  const created = await a.invoke('mc:net:create', { instanceId: '1.20.1', transport: 'lan', consentTunnel: false })
  result.steps.created = {
    code: created.code, invite: created.invite, state: created.state, transport: created.transport,
    tunnel: created.tunnel, world: created.world, ports: created.ports, members: created.members,
    expiresAt: created.expiresAt, maxMembers: created.maxMembers,
  }
  const invite = await a.invoke('mc:net:copyInvite')
  result.steps.invite = { code: invite.code, expiresAt: invite.expiresAt, ticketLength: invite.ticket.length, ticketPrefix: invite.ticket.slice(0, 5) }
  if (!invite.ticket.startsWith('MCL1.')) throw new Error(`unexpected ticket format: ${invite.ticket.slice(0, 12)}`)

  b = await launch({ name: 'P0-6', dataDir: dataB, mcDir, port: 9385 })
  await b.invoke('mc:auth:createOffline', { name: 'MemberUser' })
  result.steps.instancesB = (await b.invoke('mc:instance:list')).map((i) => ({ id: i.id, mcVersion: i.mcVersion, loader: i.loader, state: i.state }))

  const joined = await b.invoke('mc:net:join', { ticket: invite.ticket, instanceId: '1.20.1' })
  result.steps.joined = {
    code: joined.code, state: joined.state, transport: joined.transport, world: joined.world,
    members: joined.members, error: joined.error,
  }
  await sleep(2500)
  const statusA = await a.invoke('mc:net:status')
  const statusB = await b.invoke('mc:net:status')
  result.steps.statusA = statusA && { state: statusA.state, members: statusA.members, transport: statusA.transport, world: statusA.world, ports: statusA.ports }
  result.steps.statusB = statusB && { state: statusB.state, members: statusB.members, transport: statusB.transport, world: statusB.world, ports: statusB.ports }

  // Invite errors (short code is intentionally not a credential).
  result.steps.shortCode = await b.expectError('mc:net:join', { ticket: 'MCL-000000', instanceId: '1.20.1' })
  const tampered = invite.ticket.slice(0, -2) + (invite.ticket.endsWith('AA') ? 'BB' : 'AA')
  result.steps.tampered = await b.expectError('mc:net:join', { ticket: tampered, instanceId: '1.20.1' })
  result.steps.incomplete = await b.expectError('mc:net:join', { ticket: 'MCL1.ABC', instanceId: '1.20.1' })

  // Version mismatch: the fake 1.20.4 instance must be rejected before launching.
  result.steps.versionMismatch = await b.expectError('mc:net:join', { ticket: invite.ticket, instanceId: 'qa-1.20.4' })

  // World port + enter world (game launch). Capture argv through the game log.
  const world = await a.invoke('mc:net:setWorldPort', { port: 25566 })
  result.steps.world = { state: world.world, ports: world.ports, members: world.members?.length }
  const gameLog = path.join(mcDir, 'versions', '1.20.1', 'logs', 'latest.log')
  const before = fs.existsSync(gameLog) ? fs.statSync(gameLog).size : 0
  const entered = await b.invoke('mc:net:enterWorld', { instanceId: '1.20.1', accountId: null })
  result.steps.enterWorld = { sessionId: entered.sessionId, server: entered.server }
  let logText = ''
  for (let i = 0; i < 40; i += 1) {
    await sleep(1000)
    if (fs.existsSync(gameLog)) {
      logText = fs.readFileSync(gameLog, 'utf8')
      if (logText.includes('Connecting to') || logText.includes('quickPlay') || logText.includes('Disconnected')) break
    }
  }
  result.steps.enterWorldGameLog = logText.split(/\r?\n/).filter((line) => /Connecting to|Disconnected|quickPlay|Connection refused|SocketException|Lost connection/i.test(line)).slice(-8)
  try { await b.invoke('mc:launch:stop', { sessionId: entered.sessionId }) } catch { /* may already exit */ }
  await sleep(1500)

  // Host close must notify the member (poll up to 6 s).
  await a.invoke('mc:net:leave')
  const closedAt = Date.now()
  let bState = null
  while (Date.now() - closedAt < 6000) {
    const s = await b.invoke('mc:net:status')
    bState = s
    if (!s || s.state === 'closed' || s.error) break
    await sleep(500)
  }
  result.steps.afterClose = { elapsedMs: Date.now() - closedAt, bState: bState && { state: bState.state, error: bState.error } }
  result.steps.rejoinClosed = await b.expectError('mc:net:join', { ticket: invite.ticket, instanceId: '1.20.1' })
  result.steps.netstat = spawnSync('netstat', ['-ano'], { encoding: 'utf8' }).stdout.split(/\r?\n/).filter((line) => line.includes('ESTABLISHED') && (line.includes('127.0.0.1') || line.includes('192.168.'))).slice(0, 12)
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  try { server?.kill() } catch { /* ignore */ }
  b?.close()
  a.close()
  const file = writeResult('P0-6', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    created: result.steps.created && { code: result.steps.created.code, state: result.steps.created.state, transport: result.steps.created.transport },
    joined: result.steps.joined && { state: result.steps.joined.state, members: result.steps.joined.members?.length },
    memberA: result.steps.statusA?.members?.map((m) => ({ name: m.name, role: m.role, pingMs: m.pingMs })),
    errors: {
      short: result.steps.shortCode?.code,
      tampered: result.steps.tampered?.code,
      incomplete: result.steps.incomplete?.code,
      mismatch: result.steps.versionMismatch?.code,
      rejoin: result.steps.rejoinClosed?.code,
    },
    enter: result.steps.enterWorld,
    close: result.steps.afterClose,
    fatal: result.fatal ?? null,
  }, null, 2))
}
