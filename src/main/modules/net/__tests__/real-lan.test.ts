import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { LaunchOrchestrator } from '../../../core/launch/orchestrator'
import { RoomService, type InstancePort, type LaunchPort } from '../room'

/**
 * Opt-in real LAN acceptance (P0-6 L0).
 *
 * Run with:
 *   $env:MCL_REAL_LAN='1'; npx vitest run src/main/modules/net/__tests__/real-lan.test.ts
 *
 * Requires the .e2e 1.20.1 instance + a world save (created by the acceptance
 * workspace), the Windows desktop session, and the helper win.ps1. It starts two
 * real Minecraft clients via the same LaunchOrchestrator used by the launcher,
 * opens the game's LAN world through the pause menu, lets the net module discover
 * the port from the real game log, then joins the second client with the invite
 * ticket and asserts the integrated-server `joined the game` line.
 */

const enabled = process.env.MCL_REAL_LAN === '1'
const root = path.resolve(__dirname, '../../../../..')
const mcRoot = path.join(root, '.e2e', 't61-fresh', 'mc')
const hostData = path.join(root, '.e2e', 't64', 'real-host-data')
const memberData = path.join(root, '.e2e', 't64', 'real-member-data')
const winScript = path.join(root, '.e2e', 't64', 'win.ps1')

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ScopedLogger

const hostAccount = {
  kind: 'offline' as const,
  name: 'T64Host',
  uuid: '11111111-1111-4111-8111-111111111111',
  accessToken: '0',
  userType: 'legacy' as const,
}
const memberAccount = {
  kind: 'offline' as const,
  name: 'T64Member',
  uuid: '22222222-2222-4222-8222-222222222222',
  accessToken: '0',
  userType: 'legacy' as const,
}

const instancePort: InstancePort = {
  get(id: string) {
    if (id === '1.20.1-lan') {
      return { mcVersion: '1.20.1', loader: { type: 'vanilla' }, dirName: '1.20.1-lan' }
    }
    return { mcVersion: '1.20.1', loader: { type: 'vanilla' }, dirName: '1.20.1' }
  },
}

function portFor(orchestrator: LaunchOrchestrator, account: typeof hostAccount): LaunchPort {
  return {
    onEvent(event, listener) {
      orchestrator.on(event, listener)
      return () => orchestrator.off(event, listener)
    },
    start(input) {
      return orchestrator.start({ ...input, accountId: account.name })
    },
    status(instanceId) {
      const status = orchestrator.status(instanceId)
      return { state: status.state, sessionId: status.sessionId }
    },
  }
}

function makeOrchestrator(dataRoot: string): LaunchOrchestrator {
  return new LaunchOrchestrator({
    dataRoot,
    mcRoot,
    appVersion: '0.1.0',
    logger: silentLog,
    resolveAccount: async (accountId) => {
      if (accountId === hostAccount.name) return hostAccount
      if (accountId === memberAccount.name) return memberAccount
      return null
    },
  })
}

function latestLog(dataRoot: string, dirName: string): string | null {
  const dir = path.join(dataRoot, 'logs', 'game', dirName)
  if (!fs.existsSync(dir)) return null
  const files = fs
    .readdirSync(dir)
    .filter((name) => name.endsWith('.log'))
    .map((name) => path.join(dir, name))
    .sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs)
  return files[0] ?? null
}

function readLog(file: string | null): string {
  return file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function runWin(action: string, x = 0, y = 0, out = '', title = 'Minecraft*', newest = false): string {
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', winScript, '-Action', action, '-TitleLike', title]
  if (newest) args.push('-Newest')
  if (action === 'click') args.push('-X', String(x), '-Y', String(y))
  if (out) args.push('-Out', out)
  return execFileSync('powershell.exe', args, { encoding: 'utf8', timeout: 30_000 })
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`timeout waiting for ${label}`)
}

const rooms: RoomService[] = []
const orchestrators: LaunchOrchestrator[] = []

afterAll(async () => {
  for (const room of rooms.splice(0)) {
    try {
      await room.leave()
    } catch {
      // best effort
    }
  }
  for (const orchestrator of orchestrators.splice(0)) {
    try {
      await orchestrator.stopAll()
    } catch {
      // best effort
    }
  }
})

describe.skipIf(!enabled)('real 1.20.1 LAN world end-to-end', () => {
  it(
    'discovers Open-to-LAN port and lets the invited member join the integrated server',
    async () => {
      if (!fs.existsSync(path.join(mcRoot, 'versions', '1.20.1-lan', '1.20.1-lan.json'))) {
        throw new Error(`missing acceptance instance at ${mcRoot}`)
      }
      fs.rmSync(hostData, { recursive: true, force: true })
      fs.rmSync(memberData, { recursive: true, force: true })
      fs.mkdirSync(hostData, { recursive: true })
      fs.mkdirSync(memberData, { recursive: true })

      const hostOrchestrator = makeOrchestrator(hostData)
      const memberOrchestrator = makeOrchestrator(memberData)
      orchestrators.push(hostOrchestrator, memberOrchestrator)

      const host = new RoomService({
        dataRoot: hostData,
        log: silentLog,
        launch: portFor(hostOrchestrator, hostAccount),
        instance: instancePort,
        lanIp: '127.0.0.1',
        aliasIp: '127.0.0.55',
        maxMembers: 8,
        ticketTtlSeconds: 600,
        heartbeatIntervalMs: 500,
        heartbeatTimeoutMs: 15_000,
      })
      rooms.push(host)
      const created = await host.create({
        instanceId: '1.20.1-lan',
        transport: 'lan',
        consentTunnel: false,
      })
      expect(created.state).toBe('waiting')
      expect(created.members[0]).toMatchObject({ role: 'host', pingMs: 0 })

      const plan = await hostOrchestrator.plan({
        instanceId: '1.20.1-lan',
        accountId: hostAccount.name,
        server: null,
        dryRun: true,
      })
      expect(plan.argv).toContain('--quickPlaySingleplayer')
      expect(plan.argv).toContain('t64lan')

      const hostOptions = path.join(mcRoot, 'versions', '1.20.1-lan', 'options.txt')
      if (fs.existsSync(hostOptions)) {
        fs.writeFileSync(
          hostOptions,
          fs.readFileSync(hostOptions, 'utf8').replace(/^pauseOnLostFocus:.*$/m, 'pauseOnLostFocus:false'),
          'utf8',
        )
      }
      await hostOrchestrator.start({
        instanceId: '1.20.1-lan',
        accountId: hostAccount.name,
        server: null,
      })

      const hostLog = () => latestLog(hostData, '1.20.1-lan')
      const hostLoaded = (): boolean => {
        const text = readLog(hostLog())
        return text.includes(`${hostAccount.name} joined the game`) || text.includes(`${hostAccount.name}[local:`)
      }
      await waitFor(hostLoaded, 120_000, 'host world/player load')
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      runWin('escape')
      await new Promise((resolve) => setTimeout(resolve, 1_200))
      runWin('shot', 0, 0, path.join(root, '.e2e', 't64', 't64-host-pause.png'))
      runWin('click', 805, 484)
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      runWin('shot', 0, 0, path.join(root, '.e2e', 't64', 't64-host-lanscreen.png'))
      runWin('click', 405, 670)
      await new Promise((resolve) => setTimeout(resolve, 2_000))
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (readLog(hostLog()).includes('Started serving')) break
        runWin('click', 405, 670)
        await new Promise((resolve) => setTimeout(resolve, 2_000))
      }

      await waitFor(
        () => (host.status()?.world.port ?? 0) > 0,
        30_000,
        'net module to discover the LAN world port',
      )
      const port = host.status()?.world.port
      expect(port).toBeGreaterThan(0)
      const hostLogText = readLog(hostLog())
      expect(hostLogText).toContain(`Started serving on ${port}`)
      // Starting a LAN world leaves the host on the Game Menu in this client;
      // resume it so the integrated server ticks while the member connects.
      runWin('click', 640, 262)
      await new Promise((resolve) => setTimeout(resolve, 1_200))

      const invite = await host.copyInvite()
      const member = new RoomService({
        dataRoot: memberData,
        log: silentLog,
        launch: portFor(memberOrchestrator, memberAccount),
        instance: instancePort,
        lanIp: '127.0.0.1',
        aliasIp: '127.0.0.55',
        maxMembers: 8,
        ticketTtlSeconds: 600,
        heartbeatIntervalMs: 500,
        heartbeatTimeoutMs: 15_000,
      })
      rooms.push(member)
      const joined = await member.join({ ticket: invite.ticket, instanceId: '1.20.1' })
      expect(joined.state).toBe('connected')
      expect(joined.members.map((entry) => entry.role).sort()).toEqual(['host', 'member'])

      const memberOptions = path.join(mcRoot, 'versions', '1.20.1', 'options.txt')
      const hostOptionsText = fs.existsSync(hostOptions) ? fs.readFileSync(hostOptions, 'utf8') : ''
      let memberOptionsText = hostOptionsText
        .replace(/^pauseOnLostFocus:.*$/m, 'pauseOnLostFocus:false')
        .replace(/^skipMultiplayerWarning:.*$/m, 'skipMultiplayerWarning:true')
        .replace(/^fullscreen:.*$/m, 'fullscreen:false')
      if (!/^skipMultiplayerWarning:/m.test(memberOptionsText)) {
        memberOptionsText = `${memberOptionsText.trimEnd()}\nskipMultiplayerWarning:true\n`
      }
      fs.writeFileSync(memberOptions, memberOptionsText, 'utf8')

      // Offline accounts cannot join a vanilla LAN world via Direct Connect:
      // the integrated server answers "Invalid session". The vanilla LAN
      // browser path explicitly allows offline players ("Failed to verify
      // username but will let them in anyway"), so drive that real path.
      await memberOrchestrator.start({
        instanceId: '1.20.1',
        accountId: memberAccount.name,
        server: null,
      })
      await waitFor(
        () => readLog(latestLog(memberData, '1.20.1')).includes('Sound engine started'),
        120_000,
        'member main menu',
      )
      runWin('shot', 0, 0, path.join(root, '.e2e', 't64', 't64-member-menu.png'), 'Minecraft 1.20.1')
      runWin('click', 648, 459, '', 'Minecraft 1.20.1')
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      runWin('shot', 0, 0, path.join(root, '.e2e', 't64', 't64-member-lanlist.png'), 'Minecraft 1.20.1')
      runWin('click', 450, 300, '', 'Minecraft 1.20.1')
      await new Promise((resolve) => setTimeout(resolve, 700))
      runWin('click', 330, 615, '', 'Minecraft 1.20.1')

      await waitFor(
        () =>
          readLog(hostLog()).includes(`${memberAccount.name}[`) ||
          readLog(hostLog()).includes(`${memberAccount.name} joined the game`),
        60_000,
        'member to join the integrated server via the LAN list',
      )
      const memberLog = latestLog(memberData, '1.20.1')
      const hostJoinedLine =
        readLog(hostLog())
          .split('\n')
          .find((line) => line.includes(`${memberAccount.name}[`)) ??
        readLog(hostLog())
          .split('\n')
          .find((line) => line.includes(`${memberAccount.name} joined the game`)) ??
        ''
      const inWorldShot = path.join(root, '.e2e', 't64', 't64-member-in-world.png')
      await new Promise((resolve) => setTimeout(resolve, 1_500))
      runWin('shot', 0, 0, inWorldShot, 'Minecraft*', true)

      const evidence = {
        at: new Date().toISOString(),
        invite: { code: invite.code, length: invite.ticket.length },
        host: {
          instanceId: '1.20.1-lan',
          argvHasQuickPlaySingleplayer: plan.argv.includes('--quickPlaySingleplayer'),
          worldLog: hostLog(),
          discoveredPort: port,
          startedServing: `Started serving on ${port}`,
          memberJoined: hostJoinedLine,
          offlineLooseAuth: readLog(hostLog()).includes('Failed to verify username but will let them in anyway'),
        },
        member: {
          instanceId: '1.20.1',
          log: memberLog,
          joinedVia: 'vanilla LAN browser (offline session bypass)',
          directConnectNote:
            'Direct Connect / enterWorld quickPlayMultiplayer is rejected by vanilla 1.20.1 for offline accounts (login failed: invalid session)',
        },
        screenshot: inWorldShot,
      }
      fs.writeFileSync(
        path.join(root, '.e2e', 't64', 'real-lan-result.json'),
        `${JSON.stringify(evidence, null, 2)}\n`,
        'utf8',
      )
    },
    300_000,
  )
})


