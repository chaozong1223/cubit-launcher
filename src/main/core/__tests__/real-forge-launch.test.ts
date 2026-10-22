import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LaunchOrchestrator } from '../launch/orchestrator'

const MC_ROOT = 'E:\\MC\\.minecraft'
const INSTANCE = '[神道传说]GodRoad-人类群星闪耀时'
const hasReal = fs.existsSync(path.join(MC_ROOT, 'versions', INSTANCE, `${INSTANCE}.json`))

describe.skipIf(!hasReal)('real Forge launch', () => {
  it('reaches the main menu with intact add-opens/add-exports arguments', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-forge-launch-'))
    const orchestrator = new LaunchOrchestrator({
      dataRoot,
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
    let menu = false
    const lines: string[] = []
    const onOutput = (payload: unknown): void => {
      const line = (payload as { line?: string }).line ?? ''
      lines.push(line)
      if (/Sound engine started|OpenAL initialized|Setting user:/i.test(line)) menu = true
    }
    orchestrator.on('output', onOutput)
    const off = (): void => {
      orchestrator.off('output', onOutput)
    }
    let sessionId: string | null = null
    try {
      const started = await orchestrator.start({ instanceId: INSTANCE, accountId: 'offline' })
      sessionId = started.sessionId
      const deadline = Date.now() + 180_000
      while (!menu && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1_000))
      }
      console.log(
        JSON.stringify(
          {
            dataRoot,
            sessionId,
            menu,
            tail: lines.slice(-20),
            status: orchestrator.status(INSTANCE),
          },
          null,
          2,
        ),
      )
      expect(menu).toBe(true)
      expect(orchestrator.status(INSTANCE).state).toBe('running')
    } finally {
      off()
      if (sessionId) await orchestrator.stop(sessionId)
    }
  }, 240_000)
})
