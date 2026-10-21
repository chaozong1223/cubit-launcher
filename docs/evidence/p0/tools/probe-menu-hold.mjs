// t34: start the packaged app detached, ask it to launch 1.20.1 offline, then
// exit without killing it so external capture can photograph the game window.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { APP, ROOT, sleep } from './cdp-lib.mjs'

const ws = path.join(ROOT, '.e2e', 'e2e-install-H2EdGy')
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ws, 'data')
const port = 9395
const gameLog = path.join(mcDir, 'versions', '1.20.1', 'logs', 'latest.log')
if (fs.existsSync(gameLog)) fs.renameSync(gameLog, `${gameLog}.before-t34-hold-${Date.now()}`)
const env = { ...process.env, MCL_DATA_DIR: dataDir, MCL_MC_DIR: mcDir, MCL_E2E: '1' }
delete env.ELECTRON_RUN_AS_NODE
delete env.MCL_SMOKE
delete env.MCL_QA_WS
const child = spawn(APP, [`--remote-debugging-port=${port}`, '--no-sandbox'], { cwd: ROOT, env, stdio: 'ignore', detached: true, windowsHide: false })
child.unref()

let target = null
for (let i = 0; i < 300 && !target; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
    target = list.find((t) => t.type === 'page' && String(t.url).startsWith('app://mc-launcher'))
  } catch { /* not ready */ }
  if (!target) await sleep(200)
}
if (!target) throw new Error('no renderer target')
const wsock = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { wsock.onopen = resolve; wsock.onerror = reject })
let id = 0
const pending = new Map()
wsock.onmessage = (event) => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (entry) { pending.delete(message.id); entry(message) }
}
const evaluate = (expression) => new Promise((resolve, reject) => {
  const my = (id += 1)
  const timer = setTimeout(() => reject(new Error('evaluate timeout')), 30_000)
  pending.set(my, (message) => {
    clearTimeout(timer)
    if (message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.result.exceptionDetails)))
    else resolve(message.result?.result?.value)
  })
  wsock.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 60_000 } }))
})
const invoke = async (channel, payload) => {
  const expression = payload === undefined
    ? `window.mc.invoke(${JSON.stringify(channel)}).then((r)=>JSON.stringify(r))`
    : `window.mc.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)}).then((r)=>JSON.stringify(r))`
  const result = JSON.parse(await evaluate(expression))
  if (!result?.ok) throw new Error(`${channel}: ${JSON.stringify(result?.error)}`)
  return result.data
}
for (let i = 0; i < 100; i += 1) {
  if (await evaluate("typeof window.mc !== 'undefined'")) break
  await sleep(100)
}
await invoke('mc:instance:update', { id: '1.20.1', patch: { window: { width: 1280, height: 720, fullscreen: false }, memory: { minMb: 1024, maxMb: 4096 }, jvmArgs: [] } })
const accounts = await invoke('mc:auth:list')
let account = accounts.accounts.find((a) => a.kind === 'offline' && a.name === 'TestUser')
if (!account) account = await invoke('mc:auth:createOffline', { name: 'TestUser' })
const started = await invoke('mc:launch:start', { instanceId: '1.20.1', accountId: account.id })
console.log(JSON.stringify({ pid: child.pid, port, sessionId: started.sessionId, account: account.name }))
// Do NOT kill the app; close only this inspector socket.
try { wsock.close() } catch { /* ignore */ }
process.exit(0)
