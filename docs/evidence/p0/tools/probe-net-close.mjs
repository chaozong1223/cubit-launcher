// t34 P0-6 close-propagation measurement (host leaves while member is connected).
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
const mcDir = path.join(ws, 'mc')
const dataA = path.join(ROOT, '.e2e', 'qa-06-A4')
const dataB = path.join(ROOT, '.e2e', 'qa-06-B4')
for (const dir of [dataA, dataB]) fs.rmSync(dir, { recursive: true, force: true })
const result = {}
const a = await launch({ name: 'P0-6', dataDir: dataA, mcDir, port: 9390 })
const b = await launch({ name: 'P0-6', dataDir: dataB, mcDir, port: 9391 })
try {
  await a.invoke('mc:auth:createOffline', { name: 'HostUser' })
  await b.invoke('mc:auth:createOffline', { name: 'MemberUser' })
  const room = await a.invoke('mc:net:create', { instanceId: '1.20.1', transport: 'lan', consentTunnel: false })
  const invite = await a.invoke('mc:net:copyInvite')
  const joined = await b.invoke('mc:net:join', { ticket: invite.ticket, instanceId: '1.20.1' })
  result.joined = { state: joined.state, members: joined.members.length }
  const t0 = Date.now()
  await a.invoke('mc:net:leave')
  let bState = null
  while (Date.now() - t0 < 6000) {
    bState = await b.invoke('mc:net:status')
    if (!bState || bState.state === 'closed' || bState.state === 'error' || bState.error) break
    await sleep(200)
  }
  result.close = { elapsedMs: Date.now() - t0, state: bState?.state ?? null, code: bState?.error?.code ?? null, message: bState?.error?.message ?? null }
  await b.invoke('mc:net:leave')
  const stale = await b.invoke('mc:net:join', { ticket: invite.ticket, instanceId: '1.20.1' })
  result.stale = { state: stale.state, code: stale.error?.code ?? null, message: stale.error?.message ?? null }
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  b.close()
  a.close()
  const file = writeResult('P0-6', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify(result, null, 2))
}
