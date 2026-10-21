import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * t11 end-to-end acceptance:
 *   fresh data/mc roots → install vanilla 1.20.1 → offline account →
 *   dry-run checks (offline + authlib-injector) → launch → wait for the main
 *   menu → stop → exit 0.
 *
 * The app is driven through the real renderer IPC bridge (CDP), so this covers
 * preload + kernel IPC + auth + download + launch + Java detection together.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const exe = path.join(root, 'release', 'win-unpacked', 'mc-launcher.exe')
const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'

const warnings = []
const startedAt = Date.now()
let child = null
let cdp = null
let debugPort = 0
// Keeps Node's event loop alive while a long CDP-driven install runs; without
// it an unsettled top-level await can exit silently if the socket is unref'd.
const keepAlive = setInterval(() => undefined, 1000)

function log(message) {
  console.log(`[e2e] ${message}`)
}

function tail(file, lines = 80) {
  try {
    if (!fs.existsSync(file)) return `(missing: ${file})`
    return fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/).slice(-lines).join('\n')
  } catch (error) {
    return `(unreadable: ${String(error)})`
  }
}

function latestMtime(target) {
  try {
    const stat = fs.statSync(target)
    if (!stat.isDirectory()) return stat.mtimeMs
    let latest = stat.mtimeMs
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (['node_modules', 'data', 'out', 'release'].includes(entry.name)) continue
      latest = Math.max(latest, latestMtime(path.join(target, entry.name)))
    }
    return latest
  } catch {
    return 0
  }
}

const runtimeDir = path.join(root, '.e2e', 'runtime')
const runtimeExe = path.join(runtimeDir, 'win-unpacked', 'mc-launcher.exe')

/**
 * Other tasks may run `npm run clean -- --data` / delete `release/` while this
 * long E2E is running. Stage a private copy of the packaged app under `.e2e/`
 * (never touched by clean) and launch that instead.
 */
function ensureRuntime() {
  const sources = [
    path.join(root, 'src'),
    path.join(root, 'electron.vite.config.ts'),
    path.join(root, 'package.json'),
    path.join(root, 'tsconfig.node.json'),
  ]
  const newest = Math.max(...sources.map(latestMtime))
  const releaseMtime = fs.existsSync(exe) ? fs.statSync(exe).mtimeMs : 0
  const stagedMtime = fs.existsSync(runtimeExe) ? fs.statSync(runtimeExe).mtimeMs : 0
  if (stagedMtime > 0 && stagedMtime >= newest && stagedMtime >= releaseMtime) {
    log(`staged runtime is up to date: ${runtimeExe}`)
    return runtimeExe
  }

  if (releaseMtime === 0 || releaseMtime < newest) {
    log('packaging application (build + electron-builder --dir)...')
    // `.cmd` files need a shell on Windows; npm sets npm_execpath to npm-cli.js
    // when this script is started through `npm run`, which spawns directly.
    const npmExecPath = process.env.npm_execpath
    const command = npmExecPath ? process.execPath : npmCmd
    const args = npmExecPath ? [npmExecPath, 'run', 'pack'] : ['run', 'pack']
    const result = spawnSync(command, args, {
      cwd: root,
      stdio: 'inherit',
      windowsHide: true,
      shell: !npmExecPath && process.platform === 'win32',
    })
    if (result.status !== 0 || !fs.existsSync(exe)) {
      throw new Error(
        `pack failed (exit ${result.status}, error ${result.error ? result.error.message : 'none'})`,
      )
    }
  }

  fs.rmSync(runtimeDir, { recursive: true, force: true })
  fs.mkdirSync(runtimeDir, { recursive: true })
  fs.cpSync(path.dirname(exe), path.dirname(runtimeExe), { recursive: true })
  log(`staged packaged runtime: ${runtimeExe}`)
  return runtimeExe
}

function findFreePort(start = 9345) {
  return new Promise((resolve, reject) => {
    let port = start
    const attempt = () => {
      const server = net.createServer()
      server.once('error', () => {
        server.close()
        port += 1
        if (port > start + 30) reject(new Error('no free port'))
        else attempt()
      })
      server.listen(port, '127.0.0.1', () => {
        server.close(() => resolve(port))
      })
    }
    attempt()
  })
}

function killTree() {
  if (child && child.exitCode === null && child.pid) {
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    } catch {
      /* best effort */
    }
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function findPageTarget(port) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find(
        (target) => target.type === 'page' && String(target.url).startsWith('app://mc-launcher'),
      )
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* not ready */
    }
    if (child?.exitCode !== null && child?.exitCode !== undefined) break
    await sleep(250)
  }
  return null
}

function connectCdp(url) {
  const socket = new WebSocket(url)
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
  socket.onclose = () => {
    for (const entry of pending.values()) {
      entry.reject(new Error('CDP socket closed'))
    }
    pending.clear()
  }
  const ready = new Promise((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = (event) => reject(new Error(`websocket error: ${String(event?.message ?? '')}`))
  })
  return {
    ready,
    send(method, params = {}) {
      const id = (nextId += 1)
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })
    },
    close() {
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    },
  }
}

async function evaluateOnce(expression, timeout = 1_800_000) {
  if (!cdp) throw new Error('CDP socket closed')
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
    timeout,
  })
  if (result.exceptionDetails) {
    throw new Error(`renderer evaluation failed: ${JSON.stringify(result.exceptionDetails)}`)
  }
  return result.result?.value
}

async function reconnectCdp() {
  const target = await findPageTarget(debugPort)
  if (!target) throw new Error('renderer page target is gone')
  cdp = connectCdp(target.webSocketDebuggerUrl)
  await cdp.ready
  for (let i = 0; i < 150; i += 1) {
    const probe = await evaluateOnce("typeof window.mc !== 'undefined'", 5_000).catch(() => false)
    if (probe === true) return
    await sleep(100)
  }
  throw new Error('window.mc bridge did not come back after reconnect')
}

/** Long installs occasionally lose the DevTools socket; reattach and retry. */
async function evaluate(expression, timeout = 1_800_000) {
  try {
    return await evaluateOnce(expression, timeout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/CDP socket closed|not open|WebSocket/.test(message)) throw error
    cdp = null
    log('CDP socket closed; reconnecting to the renderer ...')
    await sleep(1000)
    await reconnectCdp()
    return evaluateOnce(expression, timeout)
  }
}

const setupExpression = String.raw`(async () => {
  const raw = async (channel, payload) => window.mc.invoke(channel, payload)
  const invoke = async (channel, payload) => {
    const result = await raw(channel, payload)
    if (!result || !result.ok) {
      const error = result && result.error ? result.error : { code: 'NO_RESULT', message: 'no Result envelope' }
      throw new Error(channel + ' failed: ' + error.code + ' ' + error.message + ' ' + JSON.stringify(error.details || {}))
    }
    return result.data
  }

  const out = {}
  try {
    await invoke('mc:auth:beginDeviceCode')
    out.microsoftMissingConfig = 'UNEXPECTED_OK'
  } catch (error) {
    out.microsoftMissingConfig = String(error && error.message ? error.message : error)
  }

  out.offline = await invoke('mc:auth:createOffline', { name: 'TestUser' })
  out.authlibInfo = await invoke('mc:auth:ensureAuthlib')
  out.authlib = await invoke('mc:auth:createAuthlib', {
    name: 'TestUser',
    server: 'https://littleskin.cn/api/yggdrasil',
  })
  const install = await invoke('mc:download:install', { versionId: '1.20.1' })
  out.install = {
    jobId: install.jobId,
    files: install.plan.files,
    bytes: install.plan.bytes,
    missingFiles: install.plan.missingFiles,
    missingBytes: install.plan.missingBytes,
  }
  return JSON.stringify(out)
})()`

const planExpression = String.raw`(async () => {
  const invoke = async (channel, payload) => {
    const result = await window.mc.invoke(channel, payload)
    if (!result || !result.ok) {
      const error = result && result.error ? result.error : { code: 'NO_RESULT', message: 'no Result envelope' }
      throw new Error(channel + ' failed: ' + error.code + ' ' + error.message + ' ' + JSON.stringify(error.details || {}))
    }
    return result.data
  }
  const out = {}
  const offlinePlan = await invoke('mc:launch:plan', {
    instanceId: '1.20.1',
    accountId: window.__e2eOfflineId,
    dryRun: true,
  })
  out.offlinePlan = {
    javaPath: offlinePlan.javaPath,
    javaMajor: offlinePlan.javaMajor,
    argc: offlinePlan.argv.length,
    hasUser: offlinePlan.argv.includes('--username') && offlinePlan.argv.includes('TestUser'),
    hasOfflineToken: offlinePlan.argv.includes('--accessToken') && offlinePlan.argv.includes('0'),
    warnings: offlinePlan.warnings.length,
  }
  const authlibPlan = await invoke('mc:launch:plan', {
    instanceId: '1.20.1',
    accountId: window.__e2eAuthlibId,
    dryRun: true,
  })
  out.authlibAgent = authlibPlan.argv.find((arg) => arg.startsWith('-javaagent:')) || null
  out.authlibInjected = Boolean(out.authlibAgent && out.authlibAgent.includes('authlib-injector'))
  if (!out.authlibInjected) throw new Error('authlib -javaagent was not injected into the launch plan')
  const started = await invoke('mc:launch:start', {
    instanceId: '1.20.1',
    accountId: window.__e2eOfflineId,
  })
  out.sessionId = started.sessionId
  return JSON.stringify(out)
})()`

async function readLaunchStatus(instanceId = '1.20.1') {
  try {
    const value = await evaluate(
      `window.mc.invoke('mc:launch:status', { instanceId: ${JSON.stringify(instanceId)} }).then((r) => JSON.stringify(r))`,
      30_000,
    )
    return JSON.parse(value)
  } catch {
    return null
  }
}

async function readReport(instanceId = '1.20.1') {
  try {
    const value = await evaluate(
      `window.mc.invoke('mc:launch:lastReport', { instanceId: ${JSON.stringify(instanceId)} }).then((r) => JSON.stringify(r))`,
      30_000,
    )
    return JSON.parse(value)
  } catch {
    return null
  }
}

async function main() {
  const runtimeExecutable = ensureRuntime()
  // A resumed workspace is still a fresh root created by this script: it lets a
  // long 1.20.1 download continue after an interrupted run without starting
  // from zero. Normal acceptance runs omit the env var.
  const reuseWorkspace = process.env.MCL_E2E_WORKSPACE
    ? path.resolve(process.env.MCL_E2E_WORKSPACE)
    : null
  const runsRoot = path.join(root, '.e2e')
  fs.mkdirSync(runsRoot, { recursive: true })
  const workspace =
    reuseWorkspace ?? fs.mkdtempSync(path.join(runsRoot, 'e2e-install-'))
  const dataDir = path.join(workspace, 'data')
  const mcDir = path.join(workspace, 'mc')
  fs.mkdirSync(dataDir, { recursive: true })
  fs.mkdirSync(mcDir, { recursive: true })
  const launcherLog = path.join(dataDir, 'logs', 'launcher.log')
  const gameLog = path.join(mcDir, 'versions', '1.20.1', 'logs', 'latest.log')
  const resultFile = path.join(workspace, 'e2e-result.json')

  log(`workspace: ${workspace}`)
  log(`dataRoot:  ${dataDir}`)
  log(`mcRoot:    ${mcDir}`)

  const port = await findFreePort()
  debugPort = port
  const env = { ...process.env, MCL_DATA_DIR: dataDir, MCL_MC_DIR: mcDir, MCL_E2E: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.MCL_SMOKE
  delete env.MCL_MS_CLIENT_ID
  delete env.MCL_MS_TENANT

  const electronFlags = [`--remote-debugging-port=${port}`, '--no-sandbox']
  // The DSH harness cannot initialise Chromium's OS sandbox; GPU stays on
  // unless explicitly disabled because a software-only compositor can crash
  // when the Java game creates its own OpenGL window.
  if (process.env.MCL_E2E_DISABLE_GPU === '1') {
    electronFlags.push('--disable-gpu', '--disable-software-rasterizer')
  }

  child = spawn(runtimeExecutable, electronFlags, { env, stdio: 'ignore', windowsHide: false })
  log(`launched app pid=${child.pid} port=${port} flags=${electronFlags.join(' ')}`)

  child.on('exit', (code, signal) => {
    log(`app process exited code=${code} signal=${signal}`)
  })

  const target = await findPageTarget(port)
  if (!target) throw new Error('no renderer page target (remote debugging not ready)')
  cdp = connectCdp(target.webSocketDebuggerUrl)
  await cdp.ready

  const bridgeDeadline = Date.now() + 30_000
  let bridgeReady = false
  while (Date.now() < bridgeDeadline) {
    const probe = await cdp.send('Runtime.evaluate', {
      expression: "typeof window.mc !== 'undefined' && typeof window.mc.invoke === 'function'",
      returnByValue: true,
    })
    if (probe.result?.value === true) {
      bridgeReady = true
      break
    }
    await sleep(100)
  }
  if (!bridgeReady) throw new Error('window.mc bridge was not exposed')

  log('creating accounts, downloading authlib-injector, starting install ...')
  const setup = JSON.parse(await evaluate(setupExpression, 120_000))
  log(`install job: ${setup.install.jobId} (${setup.install.files} files, ${setup.install.bytes} bytes)`)
  log(`offline account: ${setup.offline.id}`)
  await evaluate(
    `window.__e2eOfflineId = ${JSON.stringify(setup.offline.id)}; window.__e2eAuthlibId = ${JSON.stringify(setup.authlib.id)}; 'ok'`,
    30_000,
  )

  let status = null
  const installDeadline = Date.now() + 20 * 60_000
  let lastLogAt = 0
  while (Date.now() < installDeadline) {
    const value = await evaluate(
      `window.mc.invoke('mc:download:status', { jobId: ${JSON.stringify(setup.install.jobId)} }).then((r) => JSON.stringify(r))`,
      30_000,
    )
    const envelope = JSON.parse(value)
    if (!envelope.ok) {
      throw new Error(`download.status failed: ${JSON.stringify(envelope.error)}`)
    }
    status = envelope.data
    if (status && Date.now() - lastLogAt > 20_000) {
      lastLogAt = Date.now()
      log(`install progress: ${status.done}/${status.total} (${status.state})`)
    }
    if (status && (status.state === 'done' || status.state === 'failed' || status.state === 'cancelled')) {
      break
    }
    await sleep(2000)
  }
  if (!status || status.state !== 'done') {
    throw new Error(`install did not finish: ${JSON.stringify(status)}`)
  }
  log(`install done: ${JSON.stringify({ state: status.state, done: status.done, total: status.total })}`)

  const plan = JSON.parse(await evaluate(planExpression, 120_000))
  log(`offline plan: java ${plan.offlinePlan.javaMajor}, argc ${plan.offlinePlan.argc}`)
  log(`authlib injection: ${plan.authlibAgent}`)
  if (!setup.microsoftMissingConfig.includes('MS_CLIENT_ID_MISSING')) {
    throw new Error(`missing client id was not reported honestly: ${setup.microsoftMissingConfig}`)
  }
  if (!plan.authlibInjected) throw new Error('authlib injection missing')
  if (!plan.offlinePlan.hasUser || !plan.offlinePlan.hasOfflineToken) {
    throw new Error(`offline argv is incomplete: ${JSON.stringify(plan.offlinePlan)}`)
  }

  log(`waiting for the main menu (game log: ${gameLog}) ...`)
  const menuDeadline = Date.now() + 300_000
  let menuFound = false
  let sawUser = false
  let lastStatus = null
  while (Date.now() < menuDeadline) {
    if (fs.existsSync(gameLog)) {
      const text = fs.readFileSync(gameLog, 'utf8')
      sawUser = sawUser || text.includes('Setting user: TestUser')
      if (sawUser && text.includes('Sound engine started')) {
        menuFound = true
        break
      }
    }
    lastStatus = await readLaunchStatus()
    if (lastStatus && lastStatus.ok && lastStatus.data && lastStatus.data.state === 'crashed') {
      throw new Error(`game crashed before the main menu: ${JSON.stringify(lastStatus.data)}`)
    }
    await sleep(1500)
  }

  if (!menuFound) {
    const report = await readReport()
    throw new Error(
      `main menu not reached within 300s; status=${JSON.stringify(lastStatus)}; report=${JSON.stringify(report)}`,
    )
  }
  log('main menu reached; stopping the game ...')

  try {
    await evaluate(
      `window.mc.invoke('mc:launch:stop', { sessionId: ${JSON.stringify(plan.sessionId)} }).then((r) => JSON.stringify(r))`,
      60_000,
    )
  } catch (error) {
    warnings.push(`launch.stop failed: ${String(error)}`)
  }
  await sleep(3000)

  const finalStatus = await readLaunchStatus()
  const evidence = {
    ok: true,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    workspace,
    install: setup.install,
    installState: { state: status.state, done: status.done, total: status.total },
    offlineAccount: {
      id: setup.offline.id,
      name: setup.offline.name,
      uuid: setup.offline.uuid,
    },
    offlinePlan: plan.offlinePlan,
    authlib: {
      info: setup.authlibInfo,
      accountId: setup.authlib.id,
      javaagent: plan.authlibAgent,
      injected: plan.authlibInjected,
    },
    microsoftMissingConfig: setup.microsoftMissingConfig,
    sessionId: plan.sessionId,
    mainMenu: { found: true, settingUser: sawUser },
    finalStatus,
    warnings,
    launcherLog,
    gameLog,
  }
  fs.writeFileSync(resultFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8')
  log('E2E PASS')
  log(`result: ${resultFile}`)
  log(`launcher.log: ${launcherLog}`)
  log(`game log: ${gameLog}`)
}

try {
  await main()
  process.exitCode = 0
} catch (error) {
  console.error(`[e2e] FAIL: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  let workspaceDir = process.env.MCL_E2E_WORKSPACE
    ? path.resolve(process.env.MCL_E2E_WORKSPACE)
    : null
  try {
    if (!workspaceDir) {
      workspaceDir =
        fs
          .readdirSync(path.join(root, '.e2e'), { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name.startsWith('e2e-install-'))
          .map((entry) => path.join(root, '.e2e', entry.name))
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0] ?? null
    }
    if (workspaceDir) {
      console.error('--- launcher.log (tail) ---')
      console.error(tail(path.join(workspaceDir, 'data', 'logs', 'launcher.log')))
      console.error('--- game latest.log (tail) ---')
      console.error(tail(path.join(workspaceDir, 'mc', 'versions', '1.20.1', 'logs', 'latest.log')))
    }
  } catch {
    /* best effort */
  }

  // A renderer/GPU crash can close the launcher while a long 1.20.1 download is
  // running. The install is resumable, so retry in the same fresh E2E root
  // instead of failing the whole acceptance run.
  const retryCount = Number(process.env.MCL_E2E_RETRY ?? '0')
  if (retryCount < 2 && workspaceDir) {
    console.error(`[e2e] retrying in ${workspaceDir} (retry ${retryCount + 1}/2) ...`)
    killTree()
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        MCL_E2E_WORKSPACE: workspaceDir,
        MCL_E2E_RETRY: String(retryCount + 1),
      },
    })
    process.exitCode = result.status ?? 1
  } else {
    process.exitCode = 1
  }
} finally {
  clearInterval(keepAlive)
  try {
    cdp?.close()
  } catch {
    /* ignore */
  }
  killTree()
}
