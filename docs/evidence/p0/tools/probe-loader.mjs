// t34 P0-1/P1 loader probe: real Fabric/Quilt install (official meta + libraries),
// Forge plan only (installer opt-in), NeoForge no-hash refusal as specified.
import fs from 'node:fs'
import path from 'node:path'
import { launch, newestWorkspace, ROOT, writeResult, sleep } from './cdp-lib.mjs'

const ws = newestWorkspace()
if (!ws) throw new Error('no e2e workspace')
const mcDir = path.join(ws, 'mc')
const dataDir = path.join(ROOT, '.e2e', 'qa-17-data')
fs.rmSync(dataDir, { recursive: true, force: true })
const app = await launch({ name: 'P0-1', dataDir, mcDir, port: 9383 })
const result = { workspace: ws, mcDir, installs: {}, plans: {}, errors: {} }

async function waitJob(jobId, timeoutMs = 600_000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  while (Date.now() < deadline) {
    const status = await app.invoke('mc:loader:status', { jobId })
    last = status
    if (status && ['done', 'failed', 'cancelled'].includes(status.state)) return status
    await sleep(1500)
  }
  return last
}

try {
  const account = await app.invoke('mc:auth:createOffline', { name: 'LoaderUser' })
  result.account = account.id

  for (const type of ['fabric', 'quilt']) {
    const list = await app.invoke('mc:loader:list', { type, mcVersion: '1.20.1', force: false })
    const chosen = list.versions.find((v) => v.stable) ?? list.versions[0]
    const plan = await app.invoke('mc:loader:plan', { type, mcVersion: '1.20.1', loaderVersion: chosen.version })
    const installed = await app.invoke('mc:loader:install', { type, mcVersion: '1.20.1', loaderVersion: chosen.version })
    const status = await waitJob(installed.jobId)
    let verify = null
    let launchPlan = null
    if (status?.state === 'done') {
      verify = await app.invoke('mc:loader:verify', { versionId: installed.versionId })
      launchPlan = await app.invoke('mc:launch:plan', { instanceId: installed.versionId, accountId: account.id, dryRun: true })
    }
    result.installs[type] = {
      listCount: list.versions.length,
      listSource: list.source,
      chosen: chosen.version,
      stable: chosen.stable,
      recommended: chosen.recommended,
      installMethod: plan.method,
      versionId: installed.versionId,
      jobId: installed.jobId,
      finalState: status?.state ?? null,
      finalStage: status?.stage ?? null,
      message: status?.message ?? null,
      verify: verify && {
        chain: verify.chain,
        mainClass: verify.mainClass,
        loader: verify.loader,
        libraries: verify.libraries,
        classpathCount: verify.classpathCount,
        javaMajor: verify.javaMajor,
      },
      launch: launchPlan && {
        javaPath: launchPlan.javaPath,
        javaMajor: launchPlan.javaMajor,
        argc: launchPlan.argv.length,
        mainClass: launchPlan.argv.find((arg) => arg === 'net.minecraft.client.main.Main') ?? null,
        hasParentLibraries: launchPlan.classpath.some((entry) => entry.includes('lwjgl')) || launchPlan.classpath.length > 20,
        placeholders: launchPlan.argv.filter((arg) => arg.includes('${')).length,
      },
      versionJsonExists: fs.existsSync(path.join(mcDir, 'versions', installed.versionId, `${installed.versionId}.json`)),
    }
  }

  // Forge: plan only (opt-in execution). Record the installer/hash evidence.
  const forgeList = await app.invoke('mc:loader:list', { type: 'forge', mcVersion: '1.20.1', force: false })
  const forgePick = forgeList.versions.find((v) => v.recommended) ?? forgeList.versions[0]
  const forgePlan = await app.invoke('mc:loader:plan', { type: 'forge', mcVersion: '1.20.1', loaderVersion: forgePick.version })
  result.plans.forge = {
    listCount: forgeList.versions.length,
    picked: forgePick.version,
    recommended: forgePick.recommended,
    method: forgePlan.method,
    versionId: forgePlan.versionId,
    installer: forgePlan.installer,
    requiredJavaMajor: forgePlan.requiredJavaMajor,
    parentInstalled: forgePlan.parentInstalled,
    warnings: forgePlan.warnings,
    executed: false,
    notExecutedReason: 'opt-in per t34 contract: official maven ~75 KB/s, installer needs ~60 MB more dependencies; execution path covered by fake-ProcessPort tests (docs/05 §P0-1/loader).',
  }

  // NeoForge: no upstream sha1 on this host → default refusal is the expected behaviour.
  const neoList = await app.invoke('mc:loader:list', { type: 'neoforge', mcVersion: '1.20.1', force: false })
  const neoPick = neoList.versions.find((v) => v.recommended) ?? neoList.versions[0]
  const neoPlan = await app.invoke('mc:loader:plan', { type: 'neoforge', mcVersion: '1.20.1', loaderVersion: neoPick.version })
  result.plans.neoforge = {
    listCount: neoList.versions.length,
    picked: neoPick.version,
    method: neoPlan.method,
    versionId: neoPlan.versionId,
    installer: neoPlan.installer,
    hashSource: neoPlan.installer?.hashSource ?? null,
    warnings: neoPlan.warnings,
  }
  result.errors.neoforgeUnverified = await app.expectError('mc:loader:install', {
    type: 'neoforge', mcVersion: '1.20.1', loaderVersion: neoPick.version, allowUnverifiedInstaller: false,
  })
  // Wrong confirmation echo for an installer that does have a hash must also fail.
  if (forgePlan.installer?.sha1) {
    result.errors.forgeConfirmationMismatch = await app.expectError('mc:loader:install', {
      type: 'forge', mcVersion: '1.20.1', loaderVersion: forgePick.version, confirmSha1: null,
    })
  }
  // Parent missing path (flow check with a version that is not installed).
  result.errors.parentMissing = await app.expectError('mc:loader:install', {
    type: 'fabric', mcVersion: '1.7.10', loaderVersion: '0.15.11',
  })
} catch (error) {
  result.fatal = String(error?.stack ?? error)
  try { await app.screenshot('fatal.png') } catch { /* ignore */ }
  process.exitCode = 1
} finally {
  app.close()
  const file = writeResult('P0-1-loaders', result)
  console.log(`RESULT ${file}`)
  console.log(JSON.stringify({
    fabric: result.installs.fabric && { state: result.installs.fabric.finalState, version: result.installs.fabric.versionId, libs: result.installs.fabric.verify?.libraries },
    quilt: result.installs.quilt && { state: result.installs.quilt.finalState, version: result.installs.quilt.versionId, libs: result.installs.quilt.verify?.libraries },
    forgePlan: result.plans.forge && { hashSource: result.plans.forge.installer?.hashSource, version: result.plans.forge.picked },
    neoPlan: result.plans.neoforge && { hashSource: result.plans.neoforge.hashSource },
    errors: Object.fromEntries(Object.entries(result.errors).map(([k, v]) => [k, v?.code])),
    fatal: result.fatal ?? null,
  }, null, 2))
}
