// Minimal CDP driver shared by the t34 acceptance probes.
// Runs the packaged app (release/win-unpacked or .e2e/runtime) with an isolated
// data dir, drives real IPC through window.mc, and captures renderer screenshots.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const ROOT = 'D:\\DSH-工作文件\\mc-launcher'
export const APP = process.env.MCL_QA_APP
  ? path.resolve(process.env.MCL_QA_APP)
  : path.join(ROOT, '.e2e', 'runtime', 'win-unpacked', 'mc-launcher.exe')
export const OUT = path.join(ROOT, 'docs', 'evidence', 'p0')

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export function newestWorkspace() {
  if (process.env.MCL_QA_WS) return path.resolve(process.env.MCL_QA_WS)
  const base = path.join(ROOT, '.e2e')
  const dirs = fs
    .readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('e2e-install-'))
    .map((entry) => path.join(base, entry.name))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
  return dirs[0] ?? null
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl)
    const pending = new Map()
    let nextId = 0
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data)
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    }
    socket.onerror = (event) => reject(new Error(`ws error ${String(event?.message ?? '')}`))
    socket.onopen = () => resolve({
      send(method, params = {}) {
        const id = (nextId += 1)
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej })
          socket.send(JSON.stringify({ id, method, params }))
        })
      },
      close() { try { socket.close() } catch { /* ignore */ } },
    })
  })
}

async function findTarget(port, deadlineMs = 45_000) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((t) => t.type === 'page' && String(t.url).startsWith('app://mc-launcher'))
      if (page?.webSocketDebuggerUrl) return page
    } catch { /* not ready */ }
    await sleep(200)
  }
  return null
}

/**
 * @param {{name: string, dataDir: string, mcDir?: string|null, port: number, env?: Record<string,string>, timeoutMs?: number}} options
 */
export async function launch(options) {
  fs.mkdirSync(options.dataDir, { recursive: true })
  const env = { ...process.env, MCL_DATA_DIR: options.dataDir, MCL_E2E: '1', ...(options.env ?? {}) }
  if (options.mcDir) env.MCL_MC_DIR = options.mcDir
  else delete env.MCL_MC_DIR
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MCL_SMOKE
  const outDir = path.join(OUT, options.name)
  fs.mkdirSync(outDir, { recursive: true })
  const child = spawn(APP, [`--remote-debugging-port=${options.port}`, '--no-sandbox'], {
    cwd: ROOT,
    env,
    stdio: 'ignore',
    windowsHide: false,
  })
  const target = await findTarget(options.port, options.timeoutMs ?? 60_000)
  if (!target) {
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
    throw new Error(`no renderer target on port ${options.port}`)
  }
  const cdp = await connect(target.webSocketDebuggerUrl)
  let sessionId = null

  const evaluate = async (expression, timeout = 180_000) => {
    const reply = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, timeout })
    if (reply.exceptionDetails) {
      throw new Error(`renderer exception: ${JSON.stringify(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails)}`)
    }
    return reply.result?.value
  }

  const invokeRaw = async (channel, payload = undefined) => {
    const expr = payload === undefined
      ? `window.mc.invoke(${JSON.stringify(channel)}).then((r) => JSON.stringify(r))`
      : `window.mc.invoke(${JSON.stringify(channel)}, ${JSON.stringify(payload)}).then((r) => JSON.stringify(r))`
    return JSON.parse(await evaluate(expr))
  }
  const invoke = async (channel, payload = undefined) => {
    const result = await invokeRaw(channel, payload)
    if (!result?.ok) throw new Error(`${channel} -> ${JSON.stringify(result?.error ?? result)}`)
    return result.data
  }
  const expectError = async (channel, payload = undefined) => {
    const result = await invokeRaw(channel, payload)
    if (result?.ok) throw new Error(`${channel} unexpectedly succeeded`)
    return result.error
  }
  const screenshot = async (file) => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    const target = path.join(outDir, file)
    fs.writeFileSync(target, Buffer.from(shot.data, 'base64'))
    return target
  }
  const goto = async (hash, waitMs = 900) => {
    await evaluate(`location.hash = ${JSON.stringify(hash)}; 'ok'`)
    await sleep(waitMs)
  }
  const text = () => evaluate("document.body.innerText")
  const close = () => {
    try { cdp.close() } catch { /* ignore */ }
    try { spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { /* ignore */ }
  }

  // Wait for the preload bridge.
  for (let i = 0; i < 200; i += 1) {
    if (await evaluate("typeof window.mc !== 'undefined' && typeof window.mc.invoke === 'function'")) break
    await sleep(100)
  }
  return { child, send: cdp.send, evaluate, invoke, invokeRaw, expectError, screenshot, goto, text, close, outDir, dataDir: options.dataDir }
}

export function writeResult(name, value) {
  const dir = path.join(OUT, name)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'result.json')
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  return file
}
