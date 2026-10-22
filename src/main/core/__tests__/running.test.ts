import { describe, expect, it } from 'vitest'
import { CoreError } from '../errors'
import { commandLineMatchesGameDir, LaunchOrchestrator } from '../launch/orchestrator'
import { toHandlerErrorShape } from '../../kernel/error-shape'
import type { ProcessPort } from '../ports'

function fakePorts(stdout: string): ProcessPort {
  return {
    async exec() {
      return { stdout, stderr: '', code: 0, timedOut: false }
    },
    spawn() {
      throw new Error('not used')
    },
  }
}

describe('running game detection', () => {
  it('detects a Java process whose command line uses the plan gameDir', async () => {
    const orchestrator = new LaunchOrchestrator({
      dataRoot: 'C:/tmp/data',
      mcRoot: 'C:/Games/MC',
      appVersion: 'test',
      platform: 'win32',
      ports: fakePorts(
        'CommandLine=javaw.exe --gameDir "C:\\Games\\MC"\r\nProcessId=4321\r\n\r\n',
      ),
    })
    const found = await (
      orchestrator as unknown as {
        findRunningGameProcess(dir: string): Promise<{ pid: number | null } | null>
      }
    ).findRunningGameProcess('C:/Games/MC')
    expect(found?.pid).toBe(4321)
  })

  it('matches the gameDir in a Java command line, case and slash insensitive', () => {
    expect(
      commandLineMatchesGameDir(
        'javaw.exe -cp ... net.minecraft.client.main.Main --gameDir "C:\\Games\\MC 1.20"',
        'c:/games/mc 1.20/',
      ),
    ).toBe(true)
    expect(
      commandLineMatchesGameDir(
        'java -cp ... net.minecraft.client.main.Main --gameDir /home/user/.minecraft',
        '/home/user/.minecraft/',
      ),
    ).toBe(true)
    expect(
      commandLineMatchesGameDir('java -jar server.jar', 'C:/Games/MC'),
    ).toBe(false)
  })

  it('uses the domain code INSTANCE_ALREADY_RUNNING with a close-game message', () => {
    const error = new CoreError('INSTANCE_ALREADY_RUNNING', {
      details: { instanceId: 'i1' },
    })
    expect(error.code).toBe('INSTANCE_ALREADY_RUNNING')
    expect(error.userMessage).toContain('关闭游戏')
    expect(error.toShape().code).not.toBe('IPC.HANDLER_FAILED')
    expect(toHandlerErrorShape(error).code).toBe('INSTANCE_ALREADY_RUNNING')
  })
})
