// t34 P0-4 probe: real dry-run argv for auto/custom memory, window/fullscreen,
// extra JVM args, managed-arg rejection, A/B isolation and Java error paths.
// Uses the workspace installed by scripts/e2e-install-launch.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult } from './cdp-lib.mjs'

const ws = newestWorkspace()
if (!ws) throw new Error('no e2e workspace')
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 'qa-04-data')
fs.rmSync(dataDir, { recursive: true, force: true })

// P0-6 fixture from 01 §5.7 step 1 (also reused by the net probe).
const bDir = path.join(mcDir, 'versions', '1.20.1-b')
if (!fs.existsSync(bDir)) {
  fs.cpSync(path.join(mcDir, 'versions', '1.20.1'), bDir, { recursive: true })
  const jsonPath = path.join(bDir, '1.20.1.json')
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  json.id = '1.20.1-b'
  fs.writeFileSync(path.join(bDir, '1.20.1-b.json'), JSON.stringify(json), 'utf8')
  fs.rmSync(jsonPath)
  fs.renameSync(path.join(bDir, '1.20.1.jar'), path.join(bDir, '1.20.1-b.jar'))
}

const app = await launch({ name: 'P0-4', dataDir, mcDir, port: 9381 })
const result = { workspace: ws, mcDir, dataDir, plans: {}, errors: {} }

function analyse(plan) {
  const argv = plan.argv
  const count = (arg) => argv.filter((item) => item === arg).length
  const xmx = argv.filter((item) => /^-Xmx\d+[mMgG]$/.test(item))
  const width = argv.indexOf('--width')
  const height = argv.indexOf('--height')
  return {
    javaPath: plan.javaPath,
    javaMajor: plan.javaMajor,
    argc: argv.length,
    xmx,
    xmxCount: xmx.length,
    xms: argv.filter((item) => /^-Xms\d+m$/.test(item)),
    width: width >= 0 ? argv[width + 1] : null,
    height: height >= 0 ? argv[height + 1] : null,
    widthCount: count('--width'),
    heightCount: count('--height'),
    fullscreen: count('--fullscreen'),
    g1: [
      '-XX:+UnlockExperimentalVMOptions',
      '-XX:+UseG1GC',
      '-XX:G1NewSizePercent=20',
      '-XX:G1ReservePercent=20',
      '-XX:G1HeapRegionSize=32M',
      '-XX:MaxGCPauseMillis=50',
      '-XX:+PerfDisableSharedMem',
      '-XX:MinHeapFreeRatio=25',
      '-XX:MaxHeapFreeRatio=40',
      '-Dlog4j2.formatMsgNoLookups=true',
    ].filter((flag) => argv.includes(flag)),
    encoding: argv.filter((item) => item.startsWith('-Dstdout.encoding=') || item.startsWith('-Dstderr.encoding=') || item.startsWith('-Dfile.encoding=')),
    natives: argv.filter((item) => item.startsWith('-Djava.library.path=') || item.startsWith('-Djna.tmpdir=') || item.startsWith('-Dorg.lwjgl.system.SharedLibraryExtractPath=') || item.startsWith('-Dio.netty.native.workdir=')),
    brand: argv.filter((item) => item.startsWith('-Dminecraft.launcher.')),
    custom: argv.filter((item) => item.startsWith('-Dmcl.acceptance=')),
    placeholders: argv.filter((item) => item.includes('${')),
    username: argv.includes('--username') ? argv[argv.indexOf('--username') + 1] : null,
    accessToken: argv.includes('--accessToken') ? argv[argv.indexOf('--accessToken') + 1] : null,
    userType: argv.includes('--userType') ? argv[argv.indexOf('--userType') + 1] : null,
    uuid: argv.includes('--uuid') ? argv[argv.indexOf('--uuid') + 1] : null,
    gameDir: argv.includes('--gameDir') ? argv[argv.indexOf('--gameDir') + 1] : null,
    assetsDir: argv.includes('--assetsDir') ? argv[argv.indexOf('--assetsDir') + 1] : null,
    assetIndex: argv.includes('--assetIndex') ? argv[argv.indexOf('--assetIndex') + 1] : null,
    mainClass: argv.find((item) => item === 'net.minecraft.client.main.Main') ?? null,
    argv,
  }
}

try {
  const account = await app.invoke('mc:auth:createOffline', { name: 'ArgsUser' })
  const instances = await app.invoke('mc:instance:list')
  result.instances = instances.map((item) => ({ id: item.id, state: item.state, mcVersion: item.mcVersion }))
  const a = '1.20.1'
  const b = '1.20.1-b'

  // 1) auto memory + default window.
  result.plans.auto = analyse(await app.invoke('mc:launch:plan', { instanceId: a, accountId: account.id, dryRun: true }))

  // 2) custom 4096 + 1280x720 windowed.
  await app.invoke('mc:instance:update', { id: a, patch: { memory: { minMb: 1024, maxMb: 4096 }, window: { width: 1280, height: 720, fullscreen: false } } })
  result.plans.custom4096 = analyse(await app.invoke('mc:launch:plan', { instanceId: a, accountId: account.id, dryRun: true }))

  // 3) fullscreen on.
  await app.invoke('mc:instance:update', { id: a, patch: { window: { width: 1280, height: 720, fullscreen: true } } })
  result.plans.fullscreen = analyse(await app.invoke('mc:launch:plan', { instanceId: a, accountId: account.id, dryRun: true }))

  // 4) extra JVM arg accepted; managed -Xmx rejected.
  await app.invoke('mc:instance:update', { id: a, patch: { jvmArgs: ['-Dmcl.acceptance=1'] } })
  result.plans.extraArg = analyse(await app.invoke('mc:launch:plan', { instanceId: a, accountId: account.id, dryRun: true }))
  await app.invoke('mc:instance:update', { id: a, patch: { jvmArgs: ['-Xmx2G'] } })
  result.errors.managedXmx = await app.expectError('mc:launch:plan', { instanceId: a, accountId: account.id, dryRun: true })
  await app.invoke('mc:instance:update', { id: a, patch: { jvmArgs: [] } })

  // 5) A/B isolation: B custom 2048 vs A 4096.
  await app.invoke('mc:instance:update', { id: b, patch: { memory: { minMb: 1024, maxMb: 2048 }, window: { width: 854, height: 480, fullscreen: false } } })
  result.plans.a4096 = analyse(await app.invoke('mc:launch:plan', { instanceId: a, accountId: account.id, dryRun: true }))
  result.plans.b2048 = analyse(await app.invoke('mc:launch:plan', { instanceId: b, accountId: account.id, dryRun: true }))

  // 6) dry-run artifact written to disk.
  const dryRunCandidates = [
    path.join(dataDir, 'logs', 'dry-run.json'),
    path.join(dataDir, 'logs', 'launch-dry-run.json'),
  ]
  result.dryRunFiles = dryRunCandidates.map((file) => ({ file, exists: fs.existsSync(file), bytes: fs.existsSync(file) ? fs.statSync(file).size : 0 }))
  result.dryRunLogs = fs.existsSync(path.join(dataDir, 'logs')) ? fs.readdirSync(path.join(dataDir, 'logs')) : []

  // 7) Java missing / invalid paths.
  await app.invoke('mc:instance:update', { id: a, patch: { java: { mode: 'path', value: 'C:\\no-such-dir\\java.exe' } } })
  result.errors.javaMissing = await app.expectError('mc:launch:plan', { instanceId: a, accountId: account.id, dryRun: true })
  await app.invoke('mc:instance:update', { id: a, patch: { java: { mode: 'path', value: 'C:\\Windows\\System32\\cmd.exe' } } })
  result.errors.javaInvalid = await app.expectError('mc:launch:plan', { instanceId: a, accountId: account.id, dryRun: true })
  await app.invoke('mc:instance:update', { id: a, patch: { java: { mode: 'auto', value: null } } })
  result.javaRestored = await app.invoke('mc:java:match', { versionId: a })

  result.account = account
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-4', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    auto: result.plans.auto && { xmx: result.plans.auto.xmx, width: result.plans.auto.width, height: result.plans.auto.height, fullscreen: result.plans.auto.fullscreen },
    custom: result.plans.custom4096 && { xmx: result.plans.custom4096.xmx, natives: result.plans.custom4096.natives.length, placeholders: result.plans.custom4096.placeholders.length },
    fullscreen: result.plans.fullscreen && result.plans.fullscreen.fullscreen,
    errors: Object.fromEntries(Object.entries(result.errors).map(([k, v]) => [k, v?.code])),
    fatal: result.fatal ?? null,
  }, null, 2))
}
