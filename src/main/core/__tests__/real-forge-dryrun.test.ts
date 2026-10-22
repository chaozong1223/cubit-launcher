import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LaunchOrchestrator } from '../launch/orchestrator'

const MC_ROOT = 'E:\\MC\\.minecraft'
const INSTANCE = '[神道传说]GodRoad-人类群星闪耀时'
const hasReal = fs.existsSync(path.join(MC_ROOT, 'versions', INSTANCE))

describe.skipIf(!hasReal)('real Forge dry-run arguments', () => {
  it('keeps add-exports/add-opens flag/value pairs intact', async () => {
    const orchestrator = new LaunchOrchestrator({
      dataRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-forge-dry-')),
      mcRoot: MC_ROOT,
      appVersion: 'test',
      resolveAccount: async () => ({
        kind: 'offline',
        name: 'TestUser',
        uuid: '097d3392-865a-3f3c-8b4a-da1c3473466c',
        accessToken: '0',
        userType: 'legacy',
      }),
    })
    const plan = await orchestrator.plan({ instanceId: INSTANCE, accountId: 'x', dryRun: true })
    const selected = plan.argv.filter(
      (arg) =>
        arg === '--add-opens' ||
        arg === '--add-exports' ||
        arg.includes('java.base/') ||
        arg.includes('jdk.naming.dns/'),
    )
    console.log(JSON.stringify({ selected, mainClass: plan.argv.indexOf('cpw.mods.bootstraplauncher.BootstrapLauncher') }, null, 2))
    expect(selected).toEqual([
      '--add-opens',
      'java.base/java.util.jar=cpw.mods.securejarhandler',
      '--add-opens',
      'java.base/java.lang.invoke=cpw.mods.securejarhandler',
      '--add-exports',
      'java.base/sun.security.util=cpw.mods.securejarhandler',
      '--add-exports',
      'jdk.naming.dns/com.sun.jndi.dns=java.naming',
    ])
    expect(plan.argv).toContain('--add-exports')
    expect(plan.argv).not.toContain('java.base.java.lang.invoke=cpw.mods.securejarhandler')
  }, 60_000)
})
