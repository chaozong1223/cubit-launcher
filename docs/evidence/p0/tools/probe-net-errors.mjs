// t34 P0-6 follow-up: invite/version error states, member list/ping and room UI.
// `mc:net:join` reports failures as a RoomInfo with state=error (not an IPC error),
// so each case leaves the room before the next attempt.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
if (!ws) throw new Error('no e2e workspace')
const mcDir = path.join(ws, 'mc')
const dataA = path.join(ROOT, '.e2e', 'qa-06-A3')
const dataB = path.join(ROOT, '.e2e', 'qa-06-B3')
for (const dir of [dataA, dataB]) fs.rmSync(dir, { recursive: true, force: true })
const result = { workspace: ws, steps: {} }
const a = await launch({ name: 'P0-6', dataDir: dataA, mcDir, port: 9388 })
const b = await launch({ name: 'P0-6', dataDir: dataB, mcDir, port: 9389 })

const joinState = async (ticket, instanceId) => {
  const room = await b.invoke('mc:net:join', { ticket, instanceId })
  const out = { state: room.state, code: room.error?.code ?? null, message: room.error?.message ?? null }
  if (room.state !== 'connected') await b.invoke('mc:net:leave')
  return out
}

try {
  await a.invoke('mc:auth:createOffline', { name: 'HostUser' })
  await b.invoke('mc:auth:createOffline', { name: 'MemberUser' })
  const room = await a.invoke('mc:net:create', { instanceId: '1.20.1', transport: 'lan', consentTunnel: false })
  const invite = await a.invoke('mc:net:copyInvite')
  result.steps.room = { code: room.code, invite: room.invite, state: room.state }

  result.steps.goodJoin = await joinState(invite.ticket, '1.20.1')
  await sleep(7000)
  const stA = await a.invoke('mc:net:status')
  const stB = await b.invoke('mc:net:status')
  result.steps.membersA = stA.members
  result.steps.membersB = stB.members
  result.steps.hostA = stA.host

  await a.goto('#/link', 1500)
  result.steps.hostScreenshot = await a.screenshot('link-host-room.png')
  await b.goto('#/link', 1500)
  result.steps.memberScreenshot = await b.screenshot('link-member-room.png')

  await b.invoke('mc:net:leave')
  result.steps.shortCode = await joinState('MCL-000000', '1.20.1')
  const tampered = invite.ticket.slice(0, -2) + (invite.ticket.endsWith('AA') ? 'BB' : 'AA')
  result.steps.tampered = await joinState(tampered, '1.20.1')
  result.steps.incomplete = await joinState('MCL1.ABC', '1.20.1')
  result.steps.qaInstance = await b.invoke('mc:instance:get', { id: 'qa-1.20.4' })
  result.steps.real1204 = await b.invoke('mc:instance:get', { id: '1.20.4' })
  result.steps.versionMismatch = await joinState(invite.ticket, '1.20.4')

  await a.invoke('mc:net:leave')
  const t0 = Date.now()
  let bState = null
  while (Date.now() - t0 < 6000) {
    bState = await b.invoke('mc:net:status')
    if (!bState || bState.state === 'closed' || bState.state === 'error' || bState.error) break
    await sleep(300)
  }
  result.steps.close = { elapsedMs: Date.now() - t0, state: bState?.state ?? null, code: bState?.error?.code ?? null }
  await b.invoke('mc:net:leave')
  result.steps.rejoinClosed = await joinState(invite.ticket, '1.20.1')
  result.steps.statusAfter = await b.invoke('mc:net:status')
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  b.close()
  a.close()
  const file = writeResult('P0-6', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    room: result.steps.room,
    goodJoin: result.steps.goodJoin,
    membersA: result.steps.membersA,
    membersB: result.steps.membersB,
    errors: {
      short: result.steps.shortCode,
      tampered: result.steps.tampered,
      incomplete: result.steps.incomplete,
      mismatch: result.steps.versionMismatch,
      rejoinClosed: result.steps.rejoinClosed,
    },
    close: result.steps.close,
    fatal: result.fatal ?? null,
  }, null, 2))
}
