import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { RoomService, parseWorldPort, type InstancePort, type LaunchPort } from '../room'
import { issueTicket, createRoomIdentity, parseTicket, LinkError } from '../ticket'
import { HostControl } from '../control'
import type { TunnelPort } from '../easytier'
import type { TicketTunnel } from '../ticket'

const dirs: string[] = []
const rooms: RoomService[] = []

afterEach(async () => {
  for (const room of rooms.splice(0)) {
    try {
      await room.leave()
    } catch {
      // ignore
    }
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ScopedLogger

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-net-'))
  dirs.push(dir)
  return dir
}

class FakeLaunch implements LaunchPort {
  starts: Array<{ instanceId: string; accountId: string | null; server: { host: string; port: number } | null }> = []
  private listeners = new Map<string, Set<(payload: unknown) => void>>()

  onEvent(event: string, listener: (payload: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return () => set.delete(listener)
  }

  emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload)
  }

  async start(input: {
    instanceId: string
    accountId: string | null
    server: { host: string; port: number } | null
  }): Promise<{ sessionId: string }> {
    this.starts.push(input)
    return { sessionId: 'session-1' }
  }

  status(): { state: string; sessionId: string | null } {
    return { state: 'running', sessionId: 'session-1' }
  }
}

function instances(overrides: Record<string, string> = {}): InstancePort {
  return {
    get(id: string) {
      return {
        mcVersion: overrides[id] ?? '1.20.1',
        loader: { type: 'vanilla' },
      }
    },
  }
}

function makeRoom(options: {
  launch?: LaunchPort
  instance?: InstancePort
  tunnel?: TunnelPort | null
  maxMembers?: number
  dataRoot?: string
} = {}): RoomService {
  const room = new RoomService({
    dataRoot: options.dataRoot ?? tempRoot(),
    log: silentLog,
    launch: options.launch ?? new FakeLaunch(),
    instance: options.instance ?? instances(),
    tunnel: options.tunnel ?? null,
    lanIp: '127.0.0.1',
    aliasIp: '127.0.0.55',
    maxMembers: options.maxMembers ?? 2,
    ticketTtlSeconds: 60,
    heartbeatIntervalMs: 100,
    heartbeatTimeoutMs: 1_000,
    directProbeTimeoutMs: 500,
    reconnectDelayMs: 10,
    sleep: async () => undefined,
  })
  rooms.push(room)
  return room
}

function waitFor(condition: () => boolean, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const tick = (): void => {
      if (condition()) return resolve()
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'))
      setTimeout(tick, 20)
    }
    tick()
  })
}

const tunnel: TicketTunnel = {
  provider: 'easytier',
  version: '2.7.0',
  vip: '10.144.144.1',
  mappedCidr: '192.168.77.1/32',
  worldPort: 25565,
  controlPort: 25998,
  peerPort: 11010,
  lanControlPort: 25999,
}

describe('RoomService LAN flow', () => {
  it('creates a room, copies a full ticket, joins, updates the world and enters it', async () => {
    const launch = new FakeLaunch()
    const host = makeRoom({ launch })
    const created = await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    expect(created.state).toBe('waiting')
    expect(created.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)
    expect(created.invite).toBe(`MCL-${created.code}`)
    expect(created.tunnel.state).toBe('idle')
    expect(created.ports.control).toBeGreaterThan(0)

    const invite = await host.copyInvite()
    expect(invite.ticket.startsWith('MCL1.')).toBe(true)
    expect(invite.code).toBe(created.code)
    expect(parseTicket(invite.ticket).payload.code).toBe(created.code)

    const member = makeRoom({ launch })
    const joined = await member.join({ ticket: invite.ticket, instanceId: 'b' })
    expect(joined.state).toBe('connected')
    expect(joined.transport).toBe('lan')
    expect(joined.members).toHaveLength(2)
    expect(joined.members[0]).toMatchObject({ role: 'host', pingMs: 0 })
    expect(joined.members[1]).toMatchObject({ role: 'member' })
    expect(host.status()?.members).toHaveLength(2)
    await waitFor(
      () =>
        host
          .status()
          ?.members.some((member) => member.role === 'member' && member.pingKnown) === true,
    )
    const hostSideMember = host.status()?.members.find((member) => member.role === 'member')
    expect(hostSideMember?.pingMs).not.toBeNull()
    expect(hostSideMember?.pingLabel).toMatch(/ms$/)

    await host.setWorldPort({ port: 25565 })
    await waitFor(() => member.status()?.world.port === 25565)
    expect(host.status()?.world.state).toBe('open')
    expect(parseTicket((await host.copyInvite()).ticket).payload.tunnel.worldPort).toBe(25565)

    const entered = await member.enterWorld({ instanceId: 'b', accountId: null })
    expect(entered.sessionId).toBe('session-1')
    expect(entered.server).toEqual({ host: '127.0.0.1', port: 25565 })
    expect(launch.starts[0]).toEqual({
      instanceId: 'b',
      accountId: null,
      server: { host: '127.0.0.1', port: 25565 },
    })
  })

  it('lists a local LAN world through the contract method', async () => {
    const dataRoot = tempRoot()
    const gameDir = path.join(dataRoot, 'logs', 'game', '1.20.1')
    fs.mkdirSync(gameDir, { recursive: true })
    fs.writeFileSync(
      path.join(gameDir, '20261021-201500.log'),
      '[20:15:00] [Server thread/INFO]: Started serving on 51234\n',
      'utf8',
    )
    const member = makeRoom({ dataRoot })
    const result = await member.lanWorlds({ timeoutMs: 300 })
    expect(result.reason).toBeNull()
    expect(result.worlds).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ host: '127.0.0.1', port: 51234, source: 'local-log' }),
      ]),
    )
  })

  it('returns a readable reason when no LAN world is discoverable', async () => {
    const member = makeRoom()
    const result = await member.lanWorlds({ timeoutMs: 150 })
    expect(result.worlds).toEqual([])
    expect(result.reason).toContain('未发现局域网世界')
  })

  it('joins a discovered LAN world with a real launch server argument', async () => {
    const launch = new FakeLaunch()
    const member = makeRoom({ launch })
    const result = await member.joinLanWorld({
      worldId: 'local:1.20.1:51234',
      host: '127.0.0.1',
      port: 51234,
      instanceId: 'b',
      accountId: null,
    })
    expect(result.server).toEqual({ host: '127.0.0.1', port: 51234 })
    expect(launch.starts[0]).toMatchObject({
      instanceId: 'b',
      accountId: null,
      server: { host: '127.0.0.1', port: 51234 },
    })
  })

  it('joins a LAN world advertised on a Radmin VPN 26.x subnet', async () => {
    const launch = new FakeLaunch()
    const member = new RoomService({
      dataRoot: tempRoot(),
      log: silentLog,
      launch,
      instance: instances(),
      lanIp: '127.0.0.1',
      networkInterfaces: () =>
        ({
          Radmin: [
            {
              address: '26.125.118.58',
              netmask: '255.255.255.0',
              family: 'IPv4',
              internal: false,
              cidr: '26.125.118.58/24',
              mac: '00:00:00:00:00:02',
            },
          ],
        }) as never,
    })
    rooms.push(member)
    const result = await member.joinLanWorld({
      worldId: 'lan:26.125.118.57:51234',
      host: '26.125.118.57',
      port: 51234,
      instanceId: 'b',
      accountId: null,
    })
    expect(result.server).toEqual({ host: '26.125.118.57', port: 51234 })
    expect(launch.starts[0].server).toEqual({ host: '26.125.118.57', port: 51234 })
  })

  it('rejects public LAN host addresses (SSRF guard)', async () => {
    const member = makeRoom()
    await expect(
      member.joinLanWorld({
        worldId: 'lan:8.8.8.8:51234',
        host: '8.8.8.8',
        port: 51234,
        instanceId: 'b',
        accountId: null,
      }),
    ).rejects.toMatchObject({ code: 'INVITE_INVALID' })
  })

  it('distinguishes a stale invite after the host closed from a manual-mapping failure', async () => {
    const host = makeRoom()
    await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    const invite = await host.copyInvite()
    await host.leave()
    const member = makeRoom()
    const joined = await member.join({ ticket: invite.ticket, instanceId: 'a' })
    expect(joined.state).toBe('error')
    expect(joined.error?.code).toBe('NETWORK_UNREACHABLE')
    expect(joined.transport).toBe('none')
  })

  it('returns distinct localized errors for tampered, expired and mismatched invites', async () => {
    const host = makeRoom()
    await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    const invite = await host.copyInvite()

    const [prefix, code, payload, signature] = invite.ticket.split('.')
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      tunnel: { worldPort: number }
    }
    decoded.tunnel.worldPort = 25566
    const tampered = `${prefix}.${code}.${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`
    const tamperedMember = makeRoom()
    const tamperedResult = await tamperedMember.join({ ticket: tampered, instanceId: 'a' })
    expect(tamperedResult.error).toMatchObject({
      code: 'TICKET_SIGNATURE_INVALID',
      message: '邀请码被修改，无法验证',
    })

    const identity = createRoomIdentity({
      hostName: 'host',
      mcVersion: '1.20.1',
      loader: 'vanilla',
      maxMembers: 4,
    })
    const expired = issueTicket({
      identity,
      endpoints: [{ kind: 'lan', host: '127.0.0.1', port: 1 }],
      tunnel,
      now: 1_700_000_000,
      ttlSeconds: 1,
    })
    const expiredMember = makeRoom()
    const expiredResult = await expiredMember.join({ ticket: expired.ticket, instanceId: null })
    expect(expiredResult.error).toMatchObject({
      code: 'INVITE_EXPIRED',
      message: '邀请码已过期，请让房主重新生成',
    })

    const mismatchMember = makeRoom({ instance: instances({ b: '1.20.4' }) })
    const mismatchResult = await mismatchMember.join({ ticket: invite.ticket, instanceId: 'b' })
    expect(mismatchResult.error).toMatchObject({
      code: 'VERSION_MISMATCH',
      message: '双方游戏版本不一致，暂时不能加入',
    })
  })

  it('enters the world through the member tunnel control plane', async () => {
    const identity = createRoomIdentity({
      hostName: 'tunnel-host',
      mcVersion: '1.20.1',
      loader: 'vanilla',
      maxMembers: 4,
    })
    const hostControl = new HostControl({
      code: identity.code,
      token: identity.netSecret,
      hostName: identity.hostName,
      mcVersion: identity.mc.version,
      loader: identity.mc.loader,
      maxMembers: 4,
      log: silentLog,
      heartbeatTimeoutMs: 2_000,
    })
    const controlPort = await hostControl.listen('127.0.0.1')
    hostControl.setWorld({ port: 25565, state: 'open', address: null })
    const issued = issueTicket({
      identity,
      endpoints: [{ kind: 'lan', host: '10.255.255.1', port: 1 }],
      tunnel: {
        provider: 'easytier',
        version: '2.7.0',
        vip: '10.144.144.1',
        mappedCidr: '192.168.77.1/32',
        worldPort: 25565,
        controlPort,
        peerPort: 11010,
        lanControlPort: null,
      },
      ttlSeconds: 60,
    })
    const tunnelPort: TunnelPort = {
      ensureInstalled: async () => undefined,
      startHost: async () => ({ pid: null, rpcPort: 1, peerPort: null, localWorldPort: null, localControlPort: null }),
      startMember: async () => ({
        pid: null,
        rpcPort: 2,
        peerPort: null,
        localWorldPort: 60_001,
        localControlPort: controlPort,
      }),
      addPortForward: async () => undefined,
      stop: async () => undefined,
    }
    const launch = new FakeLaunch()
    const member = makeRoom({ tunnel: tunnelPort, launch })
    const joined = await member.join({ ticket: issued.ticket, instanceId: 'b' })
    expect(joined.state).toBe('connected')
    expect(joined.transport).toBe('p2p')
    expect(joined.members[0]).toMatchObject({ role: 'host' })
    const entered = await member.enterWorld({ instanceId: 'b', accountId: null })
    expect(entered.server).toEqual({ host: '127.0.0.1', port: 60_001 })
    expect(launch.starts[0].server).toEqual({ host: '127.0.0.1', port: 60_001 })
    await hostControl.close()
  })

  it('rejoins with an old invite after host close and returns a distinct network error', async () => {
    const host = makeRoom()
    await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    const invite = await host.copyInvite()
    const member = makeRoom()
    expect((await member.join({ ticket: invite.ticket, instanceId: 'a' })).state).toBe('connected')
    await host.leave()
    await waitFor(() => member.status()?.state === 'error')
    const rejoin = await member.join({ ticket: invite.ticket, instanceId: 'a' })
    expect(rejoin.state).toBe('error')
    expect(rejoin.error?.code).toBe('NETWORK_UNREACHABLE')
  })

  it('rejects a short 6-char code as the only credential', async () => {
    const host = makeRoom()
    const created = await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    const member = makeRoom()
    const joined = await member.join({ ticket: created.invite, instanceId: 'a' })
    expect(joined.state).toBe('error')
    expect(joined.error?.code).toBe('INVITE_INCOMPLETE')
  })

  it('notifies the member when the host closes and ends in a readable error', async () => {
    const host = makeRoom()
    const created = await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    const invite = await host.copyInvite()
    const member = makeRoom()
    expect((await member.join({ ticket: invite.ticket, instanceId: 'b' })).state).toBe('connected')
    expect(created.state).toBe('waiting')

    await host.leave()
    await waitFor(() => member.status()?.state === 'error')
    expect(['ROOM_CLOSED', 'NETWORK_UNREACHABLE']).toContain(member.status()?.error?.code)
  })

  it('rejects a version mismatch before joining', async () => {
    const host = makeRoom()
    await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    const invite = await host.copyInvite()
    const member = makeRoom({ instance: instances({ b: '1.20.4' }) })
    const joined = await member.join({ ticket: invite.ticket, instanceId: 'b' })
    expect(joined.state).toBe('error')
    expect(joined.error?.code).toBe('VERSION_MISMATCH')
  })
})

describe('RoomService fallback and helpers', () => {
  it('creates a host with the tunnel enabled and exposes its peer/control ports', async () => {
    const calls: string[] = []
    let stopCalls = 0
    const fakeTunnel: TunnelPort = {
      ensureInstalled: async () => {
        calls.push('install')
      },
      startHost: async (input) => {
        calls.push(`host:${input.aliasIp}:${input.lanIp}`)
        return { pid: 41_001, rpcPort: 41_001, peerPort: 41_002, localWorldPort: null, localControlPort: null }
      },
      startMember: async () => ({ pid: 41_002, rpcPort: 1, peerPort: null, localWorldPort: null, localControlPort: null }),
      addPortForward: async () => undefined,
      stop: async () => {
        stopCalls += 1
      },
    }
    const host = makeRoom({ tunnel: fakeTunnel })
    const created = await host.create({ instanceId: 'a', transport: 'auto', consentTunnel: true })
    expect(created.state).toBe('waiting')
    expect(created.tunnel.state).toBe('up')
    expect(created.transport).toBe('p2p')
    expect(created.ports.peer).toBe(41_002)
    expect(created.ports.control).toBeGreaterThan(0)
    const parsed = parseTicket((await host.copyInvite()).ticket).payload
    expect(parsed.tunnel.peerPort).toBe(41_002)
    expect(parsed.tunnel.controlPort).toBe(created.ports.control)
    expect(calls).toEqual(['install', 'host:127.0.0.55:127.0.0.1'])
    await host.dispose()
    expect(stopCalls).toBe(1)
  })

  it('keeps the LAN room available when the tunnel cannot start', async () => {
    const host = makeRoom({ tunnel: null })
    const created = await host.create({ instanceId: 'a', transport: 'auto', consentTunnel: true })
    expect(created.state).toBe('waiting')
    expect(created.transport).toBe('lan')
    expect(created.tunnel.state).toBe('failed')
    expect(created.error?.code).toBe('TUNNEL_START_FAILED')
    expect(created.invite).toMatch(/^MCL-/)
  })

  it('can create a new room after leaving the previous one', async () => {
    const host = makeRoom()
    const first = await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    expect(first.state).toBe('waiting')
    await host.leave()
    expect(host.status()).toBeNull()
    const second = await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    expect(second.state).toBe('waiting')
    expect(second.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{6}$/)
  })

  it('emits contract events for state/members/world', async () => {
    const host = makeRoom()
    const events: string[] = []
    host.onEvent('state', () => events.push('state'))
    host.onEvent('members', () => events.push('members'))
    host.onEvent('world', () => events.push('world'))
    await host.create({ instanceId: 'a', transport: 'lan', consentTunnel: false })
    await host.setWorldPort({ port: 25565 })
    expect(events).toContain('state')
    expect(events).toContain('world')
  })

  it('falls back to a manual mapping guide when the tunnel cannot start', async () => {
    const identity = createRoomIdentity({
      hostName: 'host',
      mcVersion: '1.20.1',
      loader: 'vanilla',
      maxMembers: 4,
    })
    const issued = issueTicket({
      identity,
      endpoints: [{ kind: 'lan', host: '10.255.255.1', port: 1 }],
      tunnel,
      ttlSeconds: 60,
    })
    const failingTunnel: TunnelPort = {
      ensureInstalled: async () => undefined,
      startHost: async () => {
        throw new LinkError('TUNNEL_START_FAILED', 'not used')
      },
      startMember: async () => {
        throw new LinkError('TUNNEL_START_FAILED', 'no sidecar')
      },
      addPortForward: async () => undefined,
      stop: async () => undefined,
    }
    const member = makeRoom({ tunnel: failingTunnel })
    const joined = await member.join({ ticket: issued.ticket, instanceId: null })
    expect(joined.state).toBe('error')
    expect(joined.transport).toBe('manual')
    expect(joined.error?.code).toBe('PORT_MAPPING_REQUIRED')
    expect(joined.error?.retryable).toBe(true)
    expect(joined.manual?.steps.length).toBeGreaterThan(2)
  })

  it('parses the vanilla LAN world log lines', () => {
    expect(parseWorldPort('[12:00:00] [Server thread/INFO]: Started serving on 51234')).toBe(51234)
    expect(parseWorldPort('[12:00:00] [Render thread/INFO]: Local game hosted on port 25565')).toBe(25565)
    expect(parseWorldPort('Starting Minecraft server on *:25565')).toBe(25565)
    expect(parseWorldPort('no port here')).toBeNull()
  })
})
