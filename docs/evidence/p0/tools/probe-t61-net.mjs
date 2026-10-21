// t61 B5: two-process room lifecycle, host-first member list/ping, LAN discovery
// empty state, invite errors and close propagation on the current build.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataA = path.join(ROOT, '.e2e', 't61-net-A')
const dataB = path.join(ROOT, '.e2e', 't61-net-B')
for (const d of [dataA, dataB]) fs.rmSync(d, { recursive: true, force: true })
const result = {}
const a = await launch({ name: 't61', dataDir: dataA, mcDir, port: 9522 })
const b = await launch({ name: 't61', dataDir: dataB, mcDir, port: 9523 })
const join = async (ticket) => {
  const room = await b.invoke('mc:net:join', { ticket, instanceId: '1.20.1' })
  return { state: room.state, code: room.error?.code ?? null, message: room.error?.message ?? null }
}
try {
  await a.invoke('mc:auth:createOffline', { name: 'T61Host' })
  await b.invoke('mc:auth:createOffline', { name: 'T61Member' })
  const room = await a.invoke('mc:net:create', { instanceId: '1.20.1', transport: 'lan', consentTunnel: false })
  const invite = await a.invoke('mc:net:copyInvite')
  result.created = { code: room.code, state: room.state, transport: room.transport, controlPort: room.ports.control }
  result.joined = await join(invite.ticket)
  await sleep(7000)
  const stA = await a.invoke('mc:net:status')
  const stB = await b.invoke('mc:net:status')
  result.membersA = stA?.members
  result.membersB = stB?.members
  result.hostA = stA?.host
  await a.goto('#/link', 1500)
  result.hostScreenshot = await a.screenshot('net-host-room.png')
  await b.goto('#/link', 1500)
  result.memberScreenshot = await b.screenshot('net-member-room.png')
  result.lanWorlds = await a.invoke('mc:net:lanWorlds', { timeoutMs: 1200 })
  result.lanText = (await a.text()).split('\n').map((s) => s.trim()).filter((l) => /局域网|没有发现|扫描/.test(l)).slice(0, 8)

  await b.invoke('mc:net:leave')
  result.shortCode = await join('MCL-000000')
  const tampered = invite.ticket.slice(0, -2) + (invite.ticket.endsWith('AA') ? 'BB' : 'AA')
  result.tampered = await join(tampered)
  result.incomplete = await join('MCL1.ABC')
  await b.invoke('mc:net:leave')
  result.rejoin = await join(invite.ticket)
  await a.invoke('mc:net:leave')
  const t0 = Date.now()
  let closed = null
  while (Date.now() - t0 < 6000) {
    closed = await b.invoke('mc:net:status')
    if (!closed || closed.state === 'closed' || closed.state === 'error' || closed.error) break
    await sleep(300)
  }
  result.close = { elapsedMs: Date.now() - t0, state: closed?.state ?? null, code: closed?.error?.code ?? null }
  await b.invoke('mc:net:leave')
  result.stale = await join(invite.ticket)
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  b.close()
  a.close()
  const file = writeResult('t61', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    created: result.created,
    joined: result.joined,
    membersA: result.membersA,
    membersB: result.membersB,
    lanWorlds: result.lanWorlds?.worlds?.length,
    lanText: result.lanText,
    errors: { short: result.shortCode, tampered: result.tampered, incomplete: result.incomplete, rejoin: result.rejoin, stale: result.stale },
    close: result.close,
    fatal: result.fatal ?? null,
  }, null, 2))
}
