import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import type {
  ManualGuide,
  NetSettings,
  NetSettingsUpdate,
  PublicIpProbe,
  RoomInfo,
  RoomMember,
  RoomState,
  TestRelayInput,
  TestRelayOutput,
  Transport,
  TunnelState,
  WorldInfo,
} from '@shared/net'
import { LINK_ERROR_MESSAGES } from '@shared/net'
import type { ScopedLogger } from '../../kernel/logger'
import {
  DEFAULT_CONTROL_PORT,
  EASYTIER_VERSION,
  HOST_VIP,
  MAPPED_CIDR,
  MAX_MEMBERS,
  TICKET_TTL_SECONDS,
  HEARTBEAT_TIMEOUT_MS,
} from './constants'
import {
  createRoomIdentity,
  issueTicket,
  normalizeCode,
  parseTicket,
  shortInvite,
  type IssuedTicket,
  type RoomIdentity,
  type TicketEndpoint,
  type TicketPayload,
} from './ticket'
import { LinkError } from './ticket'
import {
  loadNetConfig,
  normalizePublicHost,
  normalizeRelayPeer,
  normalizeRelayPeers,
  saveNetConfig,
} from './config'
import { probePublicIpv4, testRelayTcp, type PublicIpResult } from './publicip'
import { HostControl, MemberControl, type MemberWelcome } from './control'
import { LanWorldDiscovery } from './discovery'
import type { TunnelHandle, TunnelPort } from './easytier'
import type { LanWorldsInput, LanWorldsOutput, JoinLanWorldInput } from '@shared/net'
import { isLoopbackHost, isPrivateIpv4, isWildcardHost } from './args'
import { normalizeLanTarget, isAllowedLanTargetSync, type NetworkInterfaces } from './target'

/** Structural ports so room.ts can be tested without Electron or real EasyTier. */
export interface LaunchPort {
  onEvent(
    event: 'output' | 'exited' | 'status' | 'stage',
    listener: (payload: unknown) => void,
  ): () => void
  start(input: {
    instanceId: string
    accountId: string | null
    server: { host: string; port: number } | null
  }): Promise<{ sessionId: string }>
  status(instanceId: string): { state: string; sessionId: string | null }
}

export interface InstancePort {
  get(id: string): { mcVersion: string | null; loader: { type: string }; dirName?: string | null }
}

export interface RoomServiceOptions {
  dataRoot: string
  log: ScopedLogger
  launch?: LaunchPort | null
  instance?: InstancePort | null
  tunnel?: TunnelPort | null
  lanIp?: string
  aliasIp?: string
  maxMembers?: number
  ticketTtlSeconds?: number
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  relayPeers?: string[]
  /** Hand-typed WAN address; wins over whatever the probe finds. */
  publicIp?: string | null
  /** Whether the host may probe for a public address at all. */
  autoProbe?: boolean
  /** Test seam: replaces the EasyTier CLI / IP-echo probe. */
  probe?: (input: { cliPath: string | null; rpcPort: number | null }) => Promise<PublicIpResult>
  directProbeTimeoutMs?: number
  reconnectDelayMs?: number
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  randomId?: () => string
  onSnapshot?: (info: RoomInfo) => void
  /** Test seam: defaults to os.networkInterfaces() in target.ts. */
  networkInterfaces?: () => NetworkInterfaces
  lookupHost?: (host: string) => Promise<Array<{ address: string }>>
}

interface JoinTarget {
  host: string
  port: number
}

export class RoomService {
  private role: 'host' | 'member' | null = null
  private state: RoomState = 'idle'
  private transport: Transport = 'none'
  private identity: RoomIdentity | null = null
  private ticket: IssuedTicket | null = null
  private parsed: TicketPayload | null = null
  private hostControl: HostControl | null = null
  private memberControl: MemberControl | null = null
  private tunnelHandle: TunnelHandle | null = null
  private tunnelState: TunnelState = 'idle'
  private world: WorldInfo = { port: null, state: 'pending', address: null }
  private members: RoomMember[] = []
  private error: LinkError | null = null
  private manual: ManualGuide | null = null
  private tunnelFailure: LinkError | null = null
  private lanControlPort: number | null = null
  private aliasControlPort: number | null = null
  private peerPort: number | null = null
  /**
   * Address published as the invite's WAN endpoint. Either the hand-typed
   * address or the last probe result; see `effectivePublicIp()`.
   */
  private manualPublicIp: string | null = null
  private detectedPublicIp: string | null = null
  private probeDetail: string | null = null
  private autoProbe = true
  /** In-flight probe, so a manual "probe now" cannot stack with the startup one. */
  private probing: Promise<PublicIpProbe> | null = null
  private localWorldPort: number | null = null
  private localControlPort: number | null = null
  private joinTarget: JoinTarget | null = null
  private instanceId: string | null = null
  private launchUnsubscribers: Array<() => void> = []
  private worldForwardReady = false
  private memberEndpoint: { host: string; port: number } | null = null
  private reconnectAttempts = 0
  private closing = false
  private roomTimer: NodeJS.Timeout | null = null
  private worldPoll: NodeJS.Timeout | null = null
  private readonly discovery: LanWorldDiscovery
  private readonly eventListeners = new Map<string, Set<(payload: unknown) => void>>()
  private relayPeers: string[]
  private readonly lanIp: string
  private readonly aliasIp: string
  private readonly maxMembers: number
  private readonly ticketTtlSeconds: number
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly directProbeTimeoutMs: number
  private readonly reconnectDelayMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly randomId: () => string

  constructor(private readonly options: RoomServiceOptions) {
    this.relayPeers = normalizeRelayPeers(options.relayPeers ?? [])
    this.manualPublicIp = normalizePublicHost(options.publicIp ?? null)
    this.autoProbe = options.autoProbe !== false
    this.lanIp = options.lanIp ?? pickLanIp()
    this.aliasIp = options.aliasIp ?? pickAliasIp()
    this.maxMembers = Math.min(8, Math.max(2, options.maxMembers ?? MAX_MEMBERS))
    this.ticketTtlSeconds = options.ticketTtlSeconds ?? TICKET_TTL_SECONDS
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? 5_000
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
    this.directProbeTimeoutMs = options.directProbeTimeoutMs ?? 1_200
    this.reconnectDelayMs = options.reconnectDelayMs ?? 1_000
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.randomId = options.randomId ?? (() => crypto.randomBytes(6).toString('hex'))
    this.discovery = new LanWorldDiscovery({ dataRoot: options.dataRoot, log: options.log, now: this.now })
  }

  status(): RoomInfo | null {
    return this.role ? this.snapshot() : null
  }

  /** Contract event stream (t20 auto-wires these to `mc:net:evt:*`). */
  onEvent(event: string, listener: (payload: unknown) => void): () => void {
    const listeners = this.eventListeners.get(event) ?? new Set()
    listeners.add(listener)
    this.eventListeners.set(event, listeners)
    return () => listeners.delete(listener)
  }

  private fire(event: string, payload: unknown): void {
    for (const listener of this.eventListeners.get(event) ?? []) {
      try {
        listener(payload)
      } catch {
        // a broken UI listener must not break the room
      }
    }
  }

  async create(input: {
    instanceId: string
    transport: 'lan' | 'auto'
    consentTunnel: boolean
  }): Promise<RoomInfo> {
    if (this.role) {
      if (this.role === 'member' && this.state === 'error') {
        await this.leave()
      } else {
        return this.busySnapshot()
      }
    }
    this.role = 'host'
    this.state = 'creating'
    this.instanceId = input.instanceId
    this.closing = false
    this.error = null
    this.world = { port: null, state: 'pending', address: null }
    this.members = []
    this.tunnelState = 'idle'
    this.transport = 'none'
    this.ticket = null
    this.parsed = null
    this.tunnelHandle = null
    this.lanControlPort = null
    this.aliasControlPort = null
    this.peerPort = null
    this.worldForwardReady = false
    this.manual = null
    this.tunnelFailure = null

    const instance = this.lookupInstance(input.instanceId)
    this.identity = createRoomIdentity({
      hostName: '房主',
      mcVersion: instance?.mcVersion ?? 'unknown',
      loader: instance?.loader ?? 'unknown',
      maxMembers: this.maxMembers,
    })
    this.members = [this.hostMember()]

    try {
      if (
        isWildcardHost(this.lanIp) ||
        (!isPrivateIpv4(this.lanIp) && !isLoopbackHost(this.lanIp) && !isAllowedLanTargetSync(this.lanIp))
      ) {
        throw new LinkError('INTERNAL', `refusing to bind room control on ${this.lanIp}`)
      }
      this.hostControl = new HostControl({
        code: this.identity.code,
        token: this.identity.netSecret,
        hostName: this.identity.hostName,
        mcVersion: this.identity.mc.version,
        loader: this.identity.mc.loader,
        maxMembers: this.maxMembers,
        log: this.options.log,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        onMembers: (members) => {
          this.members = members
          this.state = members.some((member) => member.role === 'member') ? 'connected' : 'waiting'
          this.emit()
        },
        onError: (code, message) => {
          this.options.log.warn('room control error', { code, message })
        },
      })
      this.lanControlPort = await this.hostControl.listen(this.lanIp, 0)

      if (input.transport === 'auto' && input.consentTunnel) {
        await this.startHostTunnel()
      }
      this.ticket = this.issueCurrentTicket()
      this.state = 'waiting'
      this.transport = (this.tunnelState as TunnelState) === 'up' ? 'p2p' : 'lan'
      this.watchLaunch(input.instanceId)
      this.startWorldPoll(instance?.dirName ?? null)
      this.roomTimer = setTimeout(() => { void this.leave() }, 12 * 60 * 60 * 1000)
      this.roomTimer.unref?.()
      this.emit()
      return this.snapshot()
    } catch (error) {
      await this.cleanupHost()
      this.state = 'error'
      this.error = this.localize(toLinkError(error, 'ROOM_NOT_FOUND'))
      this.emit()
      return this.snapshot()
    }
  }

  async join(input: { ticket: string; instanceId: string | null }): Promise<RoomInfo> {
    if (this.role) {
      if (this.role === 'member' && this.state === 'error') {
        await this.leave()
      } else {
        return this.busySnapshot()
      }
    }
    this.role = 'member'
    this.state = 'connecting'
    this.closing = false
    this.error = null
    this.transport = 'none'
    this.reconnectAttempts = 0
    this.members = []
    this.world = { port: null, state: 'pending', address: null }
    this.tunnelState = 'idle'
    this.tunnelHandle = null
    this.localWorldPort = null
    this.localControlPort = null
    this.joinTarget = null
    this.memberEndpoint = null
    this.worldForwardReady = false
    this.manual = null
    this.tunnelFailure = null

    try {
      if (/^MCL-[0-9A-HJKMNP-TV-Z]{6}$/i.test(input.ticket.trim())) {
        throw new LinkError(
          'INVITE_INCOMPLETE',
          '6 位房间号只用于同一局域网发现；请复制完整邀请码',
        )
      }
      const parsed = parseTicket(input.ticket)
      this.parsed = parsed.payload
      this.ticket = { ticket: parsed.ticket, payload: parsed.payload }
      this.instanceId = input.instanceId
      this.assertInstanceCompatible(parsed.payload, input.instanceId)
      this.identity = null
      if (parsed.payload.tunnel.worldPort) {
        this.world = {
          port: parsed.payload.tunnel.worldPort,
          state: 'open',
          address: null,
        }
      }

      const direct = parsed.payload.endpoints.find((endpoint) => endpoint.kind === 'lan') ?? null
      if (direct) {
        const welcome = await this.tryDirectControl(direct, parsed.payload, input.instanceId)
        if (welcome) {
          this.transport = 'lan'
          this.error = null
          this.manual = null
          this.memberEndpoint = { host: direct.host, port: direct.port }
          this.applyWelcome(welcome)
          this.state = 'connected'
          this.emit()
          return this.snapshot()
        }
      }

      const hasTunnelPath = Boolean(
        parsed.payload.tunnel.peerPort ||
          parsed.payload.endpoints.some((endpoint) => endpoint.kind === 'relay') ||
          this.relayPeers.length > 0,
      )
      if (hasTunnelPath) {
        const tunnelResult = await this.tryTunnel(parsed.payload)
        if (tunnelResult) {
          this.applyWelcome(tunnelResult)
          this.state = 'connected'
          this.emit()
          return this.snapshot()
        }
      }

      if (direct && !hasTunnelPath) {
        return this.networkFailure(
          '无法连接到房主：房间可能已关闭、邀请码已过期，或双方不在同一网络。',
        )
      }

      const tunnelFailure = this.tunnelFailure as LinkError | null
      if (tunnelFailure) {
        return this.manualFallback(tunnelFailure.code, tunnelFailure.message)
      }

      return this.manualFallback(
        'PORT_MAPPING_REQUIRED',
        '当前网络无法自动建立连接，请按手动端口映射指引操作，或配置一个可达的中继节点。',
      )
    } catch (error) {
      const link = this.localize(toLinkError(error, 'INVITE_INVALID'))
      this.state = 'error'
      this.error = link
      this.emit()
      return this.snapshot()
    }
  }

  async leave(): Promise<{ ok: boolean }> {
    if (!this.role) return { ok: false }
    this.closing = true
    this.state = 'closing'
    this.emit()
    try {
      if (this.role === 'host') await this.cleanupHost()
      else await this.cleanupMember()
    } finally {
      this.closing = false
      this.state = 'closed'
      this.transport = 'none'
      this.members = []
      this.emit()
      this.role = null
      this.ticket = null
      this.parsed = null
      this.identity = null
      this.instanceId = null
      this.joinTarget = null
      this.manual = null
    }
    return { ok: true }
  }

  async dispose(): Promise<void> {
    await this.leave()
  }

  /** Last-resort shutdown from `will-quit`; async leave() could no longer run. */
  disposeSync(): void {
    const pid = this.tunnelHandle?.pid
    this.tunnelHandle = null
    if (!pid) return
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 3_000,
        })
      } else {
        process.kill(pid, 'SIGKILL')
      }
    } catch {
      // Process may already be gone.
    }
  }

  async copyInvite(): Promise<{ code: string; ticket: string; expiresAt: number }> {
    if (!this.ticket) {
      throw new LinkError('ROOM_NOT_FOUND', 'no active room')
    }
    if (this.ticket.payload.exp * 1000 <= this.now()) {
      if (this.role === 'host' && this.identity) {
        this.ticket = this.issueCurrentTicket()
      } else {
        throw new LinkError('INVITE_EXPIRED', 'invite expired; ask the host again')
      }
    }
    const payload = this.ticket.payload
    return {
      code: payload.code,
      ticket: this.ticket.ticket,
      expiresAt: payload.exp * 1000,
    }
  }

  async setWorldPort(input: { port: number }): Promise<RoomInfo> {
    if (!this.role) throw new LinkError('ROOM_NOT_FOUND', 'no active room')
    if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) {
      throw new LinkError('WORLD_NOT_FOUND', 'invalid world port')
    }
    this.world = {
      port: input.port,
      state: 'open',
      address: this.role === 'host' ? `${this.lanIp}:${input.port}` : `127.0.0.1:${this.localWorldPort ?? input.port}`,
    }
    if (this.role === 'host') {
      this.hostControl?.setWorld(this.world)
      if (this.identity) {
        this.ticket = this.issueCurrentTicket()
      }
      if (this.members.some((member) => member.role === 'member')) this.state = 'connected'
    } else {
      if (
        this.tunnelHandle &&
        this.localWorldPort &&
        this.localControlPort &&
        !this.worldForwardReady
      ) {
        try {
          this.worldForwardReady = true
          await this.options.tunnel?.addPortForward(this.tunnelHandle, this.localWorldPort, input.port)
        } catch (error) {
          this.error = toLinkError(error, 'TUNNEL_FAILED')
          this.state = 'error'
          this.emit()
          return this.snapshot()
        }
      }
      this.joinTarget = this.localWorldPort
        ? { host: '127.0.0.1', port: this.localWorldPort }
        : this.joinTarget
      this.state = this.members.some((member) => member.role === 'member')
        ? 'connected'
        : this.state
    }
    this.emit()
    return this.snapshot()
  }

  async enterWorld(input: {
    instanceId: string | null
    accountId: string | null
  }): Promise<{ sessionId: string; server: { host: string; port: number } }> {
    if (!this.role || this.state !== 'connected') {
      throw new LinkError('NETWORK_UNREACHABLE', 'room is not connected', { retryable: true })
    }
    const resolvedServer = this.resolveJoinTarget()
    if (!resolvedServer) throw new LinkError('WORLD_NOT_FOUND', 'LAN world port is not known yet', { retryable: true })
    const targetHost = await normalizeLanTarget(resolvedServer.host, {
      interfaces: this.options.networkInterfaces?.(),
      lookup: this.options.lookupHost,
    })
    if (!targetHost) {
      throw new LinkError(
        'INVITE_INVALID',
        `LAN world host is not a local/LAN address: ${resolvedServer.host}`,
      )
    }
    const server = { host: targetHost, port: resolvedServer.port }
    if (!this.options.launch) throw new LinkError('LAUNCH_FAILED', 'launch service is not available')
    const instanceId = input.instanceId ?? this.instanceId
    if (!instanceId) throw new LinkError('LAUNCH_FAILED', 'instance is not selected')
    try {
      const started = await this.options.launch.start({
        instanceId,
        accountId: input.accountId,
        server,
      })
      return { sessionId: started.sessionId, server }
    } catch (error) {
      throw new LinkError('LAUNCH_FAILED', `failed to start game: ${messageOf(error)}`)
    }
  }

  async diagnose(): Promise<{ json: string }> {
    const payload = this.ticket?.payload ?? null
    return {
      json: JSON.stringify(
        {
          role: this.role,
          state: this.state,
          transport: this.transport,
          tunnelState: this.tunnelState,
          world: this.world,
          members: this.members.length,
          error: this.error ? { code: this.error.code, message: this.error.message } : null,
          ports: {
            lanControl: this.lanControlPort,
            aliasControl: this.aliasControlPort,
            peer: this.peerPort,
            localWorld: this.localWorldPort,
            localControl: this.localControlPort,
          },
          publicIp: {
            effective: this.effectivePublicIp(),
            manual: this.manualPublicIp,
            detected: this.detectedPublicIp,
            autoProbe: this.autoProbe,
            detail: this.probeDetail,
          },
          relayPeers: this.relayPeers,
          ticket: payload
            ? {
                code: payload.code,
                host: payload.host.name,
                mc: payload.mc,
                exp: payload.exp,
                endpoints: payload.endpoints.map((endpoint) => ({
                  kind: endpoint.kind,
                  port: endpoint.port,
                })),
              }
            : null,
          platform: process.platform,
          version: EASYTIER_VERSION,
        },
        null,
        2,
      ),
    }
  }

  async lanWorlds(input: LanWorldsInput = { timeoutMs: 1_500 }): Promise<LanWorldsOutput> {
    const worlds = await this.discovery.discover(input.timeoutMs ?? 1_500)
    const reason =
      worlds.length > 0
        ? null
        : '未发现局域网世界：请确认游戏内已执行「对局域网开放」且日志含 Started serving on <port>；组播 224.0.2.60:4445 也无响应。'
    this.fire('lanWorlds', { worlds, reason })
    return { worlds, reason }
  }

  async joinLanWorld(input: JoinLanWorldInput): Promise<{
    sessionId: string
    server: { host: string; port: number }
  }> {
    const source = input.worldId.startsWith('local:')
      ? 'local-log'
      : input.worldId.startsWith('lan:')
        ? 'multicast'
        : null
    const targetHost = await normalizeLanTarget(input.host, {
      source,
      interfaces: this.options.networkInterfaces?.(),
      lookup: this.options.lookupHost,
    })
    if (!targetHost) {
      throw new LinkError(
        'INVITE_INVALID',
        `LAN world host is not a local/LAN address: ${input.host}`,
      )
    }
    if (!this.options.launch) throw new LinkError('LAUNCH_FAILED', 'launch service is not available')
    const server = { host: targetHost, port: input.port }
    try {
      const started = await this.options.launch.start({
        instanceId: input.instanceId,
        accountId: input.accountId,
        server,
      })
      this.joinTarget = server
      return { sessionId: started.sessionId, server }
    } catch (error) {
      throw new LinkError('LAUNCH_FAILED', `failed to start game: ${messageOf(error)}`)
    }
  }

  // ---------- host tunnel ----------

  /** The address the invite publishes: the user's own value wins. */
  private effectivePublicIp(): string | null {
    return this.manualPublicIp ?? this.detectedPublicIp
  }

  /**
   * Ask EasyTier / an IP echo service where this machine sits on the internet.
   * Never throws; the reason lands in `probeDetail` so the settings page can
   * explain an empty result instead of silently downgrading the invite to
   * LAN-only (docs/12 §4).
   */
  async probePublicIp(): Promise<PublicIpProbe> {
    if (this.probing) return this.probing
    const handle = this.tunnelHandle
    const deps = {
      log: this.options.log,
      cliPath: handle?.cliPath ?? null,
      rpcPort: handle?.rpcPort ?? null,
    }
    this.probing = (this.options.probe ? this.options.probe(deps) : probePublicIpv4(deps))
      .then((result) => {
        this.detectedPublicIp = result.ip
        this.probeDetail =
          this.manualPublicIp && result.ip
            ? `已探测到 ${result.ip}，但手动填写的地址优先`
            : result.detail
        if (this.role === 'host' && this.identity) {
          this.ticket = this.issueCurrentTicket()
          this.emit()
        }
        this.options.log.info('public ip resolved', {
          ip: result.ip,
          source: result.source,
          effective: this.effectivePublicIp(),
        })
        return { ip: result.ip, detail: this.probeDetail }
      })
      .finally(() => {
        this.probing = null
      })
    return this.probing
  }

  private async startHostTunnel(): Promise<void> {
    if (!this.identity) return
    const tunnel = this.options.tunnel
    if (!tunnel) {
      this.tunnelState = 'failed'
      this.error = new LinkError('TUNNEL_START_FAILED', 'tunnel is not available in this build')
      return
    }
    this.tunnelState = 'downloading'
    this.emit()
    try {
      await tunnel.ensureInstalled()
      this.tunnelState = 'starting'
      this.emit()
      const handle = await tunnel.startHost({
        networkName: `mcl-${this.identity.code.toLowerCase()}`,
        networkSecret: this.identity.netSecret.toString('hex'),
        lanIp: this.lanIp,
        aliasIp: this.aliasIp,
        relayPeers: this.relayPeers,
      })
      this.tunnelHandle = handle
      this.peerPort = handle.peerPort
      this.aliasControlPort = await this.hostControl!.listen(this.aliasIp, 0)
      this.tunnelState = 'up'
      // EasyTier already performed STUN; ask it for the address a remote peer
      // would dial. Without a WAN endpoint the invite only works on the LAN.
      if (this.manualPublicIp) {
        this.probeDetail = '使用手动填写的公网地址'
      } else if (this.autoProbe) {
        await this.probePublicIp()
      } else {
        this.probeDetail = '自动探测已关闭，邀请码只含局域网地址'
      }
      this.options.log.info('host tunnel ready', {
        peerPort: handle.peerPort,
        alias: this.aliasIp,
        publicIp: this.effectivePublicIp(),
        manualPublicIp: this.manualPublicIp,
        relayPeers: this.relayPeers.length,
      })
    } catch (error) {
      if (this.tunnelHandle) await this.stopTunnel()
      this.tunnelState = 'failed'
      this.error = toLinkError(error, 'TUNNEL_FAILED')
      this.options.log.warn('host tunnel failed; room stays on LAN', {
        code: this.error.code,
        message: this.error.message,
      })
    }
  }

  // ---------- settings ----------

  settings(): NetSettings {
    const effective = this.effectivePublicIp()
    return {
      manualPublicIp: this.manualPublicIp,
      detectedPublicIp: this.detectedPublicIp,
      effectivePublicIp: effective,
      manual: Boolean(this.manualPublicIp),
      autoProbe: this.autoProbe,
      relayPeers: [...this.relayPeers],
      maxMembers: this.maxMembers,
      lanIp: this.lanIp,
      wanPort: this.peerPort,
      probeDetail: this.probeDetail,
    }
  }

  /**
   * Persist a settings patch to `dataRoot/modules/net/config.json` and apply it
   * to the live room: the next invite carries the new WAN endpoint / relays.
   */
  async updateSettings(input: NetSettingsUpdate): Promise<NetSettings> {
    const next = loadNetConfig(this.options.dataRoot)
    if (input.manualPublicIp !== undefined) {
      const typed = input.manualPublicIp.trim()
      if (typed.length === 0) {
        next.publicIp = null
      } else {
        const host = normalizePublicHost(typed)
        if (!host) {
          throw new LinkError(
            'INVITE_INVALID',
            '公网地址只接受公网 IPv4 或域名（不要带协议/端口/路径，也不能是本机回环地址）',
          )
        }
        next.publicIp = host
      }
    }
    if (input.autoProbe !== undefined) next.autoProbe = input.autoProbe
    if (input.relayPeers !== undefined) {
      const peers: string[] = []
      for (const raw of input.relayPeers) {
        if (raw.trim().length === 0) continue
        const peer = normalizeRelayPeer(raw)
        if (!peer) {
          throw new LinkError('INVITE_INVALID', `中继地址格式应为 tcp://host:port：${raw.trim()}`)
        }
        if (!peers.includes(peer)) peers.push(peer)
      }
      next.relayPeers = peers.slice(0, 4)
    }
    saveNetConfig(this.options.dataRoot, next)

    this.manualPublicIp = next.publicIp
    this.autoProbe = next.autoProbe
    this.relayPeers = next.relayPeers
    if (this.manualPublicIp) {
      this.probeDetail = '使用手动填写的公网地址'
    } else if (this.detectedPublicIp) {
      this.probeDetail = `使用自动探测结果 ${this.detectedPublicIp}`
    } else {
      this.probeDetail = this.autoProbe ? null : '自动探测已关闭，邀请码只含局域网地址'
    }
    if (this.role === 'host' && this.identity) {
      this.ticket = this.issueCurrentTicket()
    }
    this.emit()
    this.options.log.info('link settings updated', {
      manualPublicIp: this.manualPublicIp,
      autoProbe: this.autoProbe,
      relayPeers: this.relayPeers.length,
    })
    return this.settings()
  }

  /** Is this relay actually listening? EasyTier relays are plain TCP. */
  async testRelay(input: TestRelayInput): Promise<TestRelayOutput> {
    const peer = normalizeRelayPeer(input.peer)
    if (!peer) {
      return { ok: false, rttMs: null, detail: '中继地址格式应为 tcp://host:port' }
    }
    return testRelayTcp(peer)
  }

  private issueCurrentTicket(): IssuedTicket {
    if (!this.identity) throw new LinkError('INTERNAL', 'no room identity')
    const endpoints: TicketEndpoint[] = []
    // Public endpoint FIRST: a peer on another network can only reach us through
    // it. The LAN entry alone made every cross-network invite unusable.
    const publicIp = this.effectivePublicIp()
    if (publicIp && this.peerPort) {
      endpoints.push({ kind: 'wan', host: publicIp, port: this.peerPort })
    }
    if (this.lanControlPort) {
      endpoints.push({ kind: 'lan', host: this.lanIp, port: this.lanControlPort })
    }
    for (const relay of this.relayPeers) {
      const parsed = /^(?:tcp|udp):\/\/([^/:]+):(\d+)$/.exec(relay)
      if (parsed) endpoints.push({ kind: 'relay', host: parsed[1], port: Number(parsed[2]) })
    }
    return issueTicket({
      identity: this.identity,
      endpoints,
      ttlSeconds: this.ticketTtlSeconds,
      tunnel: {
        provider: 'easytier',
        version: '2.7.0',
        vip: HOST_VIP,
        mappedCidr: MAPPED_CIDR,
        worldPort: this.world.port,
        controlPort: this.aliasControlPort ?? this.lanControlPort ?? DEFAULT_CONTROL_PORT,
        peerPort: this.peerPort,
        lanControlPort: this.lanControlPort,
      },
    })
  }

  // ---------- member ----------
  private async tryDirectControl(
    endpoint: TicketEndpoint,
    payload: TicketPayload,
    instanceId: string | null,
  ): Promise<MemberWelcome | null> {
    const control = new MemberControl({
      code: payload.code,
      token: Buffer.from(payload.net.secret, 'base64url'),
      endpoint: { host: endpoint.host, port: endpoint.port },
      member: this.memberIdentity(payload),
      log: this.options.log,
      heartbeatIntervalMs: this.heartbeatIntervalMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      connectTimeoutMs: this.directProbeTimeoutMs,
      onMembers: (members) => {
        this.members = members
        this.emit()
      },
      onWorld: (world) => this.handleWorld(world),
      onClosed: (error) => void this.handleMemberClosed(error),
    })
    try {
      const welcome = await control.connect()
      this.memberControl = control
      this.instanceId = instanceId ?? this.instanceId
      return welcome
    } catch (error) {
      try {
        await control.leave()
      } catch {
        // ignore
      }
      if (
        error instanceof LinkError &&
        ['VERSION_MISMATCH', 'LOADER_MISMATCH', 'ROOM_FULL', 'AUTH_FAILED', 'INVITE_EXPIRED'].includes(error.code)
      ) {
        throw error
      }
      return null
    }
  }

  private async tryTunnel(payload: TicketPayload): Promise<MemberWelcome | null> {
    if (!this.options.tunnel) {
      this.tunnelFailure = new LinkError(
        'TUNNEL_FAILED',
        '当前版本不支持自动隧道，请使用局域网或手动端口映射。',
      )
      return null
    }
    const candidates = this.tunnelPeers(payload)
    if (candidates.length === 0) {
      this.tunnelFailure = new LinkError(
        'RELAY_REQUIRED',
        '没有可用的直连或中继地址，请让房主配置中继或使用手动端口映射。',
      )
      return null
    }
    let lastError: LinkError | null = null
    for (const candidate of candidates) {
      const outcome = await this.tryTunnelPeer(payload, candidate)
      if ('welcome' in outcome) return outcome.welcome
      lastError = outcome.error
      this.options.log.info('tunnel candidate failed; trying the next one', {
        peer: candidate.peer,
        via: candidate.via,
        code: outcome.error.code,
      })
    }
    const cause = lastError ?? new LinkError('TUNNEL_FAILED', '自动隧道未能建立')
    this.tunnelFailure =
      cause.code === 'NETWORK_UNREACHABLE' || cause.code === 'ROOM_CLOSED'
        ? cause
        : new LinkError(
            'PORT_MAPPING_REQUIRED',
            '自动隧道不可用。请让房主配置中继节点，或按手动端口映射指引操作。',
            { retryable: true },
          )
    return null
  }

  /**
   * One tunnel attempt against one peer.
   *
   * The host may publish a WAN endpoint (hand-typed address or probe result), a
   * LAN endpoint, or a relay — and the member must be able to use all three. The
   * v0.1.0 code only read the LAN endpoint, so a cross-network invite could be
   * issued but never joined.
   */
  private async tryTunnelPeer(
    payload: TicketPayload,
    candidate: { peer: string; via: 'wan' | 'lan' | 'relay' },
  ): Promise<{ welcome: MemberWelcome } | { error: LinkError }> {
    const tunnel = this.options.tunnel
    if (!tunnel) {
      return {
        error: new LinkError('TUNNEL_FAILED', '当前版本不支持自动隧道，请使用局域网或手动端口映射。'),
      }
    }
    this.tunnelState = 'starting'
    this.emit()
    try {
      await tunnel.ensureInstalled()
      const handle = await tunnel.startMember({
        networkName: payload.net.name,
        networkSecret: Buffer.from(payload.net.secret, 'base64url').toString('hex'),
        peer: candidate.peer,
        controlPort: payload.tunnel.controlPort,
        worldPort: payload.tunnel.worldPort,
        relayPeers: this.relayPeers,
      })
      this.tunnelHandle = handle
      this.localWorldPort = handle.localWorldPort
      this.localControlPort = handle.localControlPort
      const welcome = await this.connectMemberControl(payload, handle.localControlPort ?? 0)
      this.memberEndpoint = { host: '127.0.0.1', port: handle.localControlPort ?? 0 }
      this.transport = candidate.via === 'relay' ? 'relay' : 'p2p'
      this.tunnelState = 'up'
      this.error = null
      this.manual = null
      this.reconnectAttempts = 0
      this.worldForwardReady = Boolean(payload.tunnel.worldPort)
      return { welcome }
    } catch (error) {
      await this.stopTunnel()
      this.tunnelState = 'failed'
      const cause = toLinkError(error, 'TUNNEL_FAILED')
      this.error = cause
      this.options.log.warn('member tunnel failed', {
        peer: candidate.peer,
        via: candidate.via,
        code: cause.code,
        message: cause.message,
      })
      return { error: cause }
    }
  }

  /**
   * Handshake with the member's local control plane, retrying while the sidecar
   * is still bringing its port-forward up.
   *
   * `startMember` returns as soon as the RPC portal answers; the local
   * port-forward listener follows ~250ms later (measured with real sidecars,
   * docs/13). A single connect therefore lost the race and reported
   * `NETWORK_UNREACHABLE` for a tunnel that was in fact fine.
   */
  private async connectMemberControl(payload: TicketPayload, port: number): Promise<MemberWelcome> {
    const attempts = 4
    let lastError: unknown = null
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const control = new MemberControl({
        code: payload.code,
        token: Buffer.from(payload.net.secret, 'base64url'),
        endpoint: { host: '127.0.0.1', port },
        member: this.memberIdentity(payload),
        log: this.options.log,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        onMembers: (members) => {
          this.members = members
          this.emit()
        },
        onWorld: (world) => this.handleWorld(world),
        onClosed: (error) => void this.handleMemberClosed(error),
      })
      try {
        const welcome = await control.connect()
        this.memberControl = control
        return welcome
      } catch (error) {
        lastError = error
        try {
          await control.leave()
        } catch {
          // socket already gone
        }
        // A rejected handshake (version/loader/auth/full room) will not get
        // better by waiting.
        if (
          error instanceof LinkError &&
          !['NETWORK_UNREACHABLE', 'HEARTBEAT_TIMEOUT'].includes(error.code)
        ) {
          throw error
        }
        if (attempt === attempts - 1) break
        this.options.log.info('member control not ready yet; retrying', {
          attempt: attempt + 1,
          port,
          code: error instanceof LinkError ? error.code : 'unknown',
        })
        await this.sleep(400 + attempt * 400)
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new LinkError('NETWORK_UNREACHABLE', 'control plane did not answer', { retryable: true })
  }

  /**
   * Every address worth dialling, best first: a direct WAN endpoint, then the
   * LAN one, then relays (the invite's own relay first, then the ones this
   * machine configured).
   */
  private tunnelPeers(payload: TicketPayload): Array<{ peer: string; via: 'wan' | 'lan' | 'relay' }> {
    const peers: Array<{ peer: string; via: 'wan' | 'lan' | 'relay' }> = []
    const push = (peer: string, via: 'wan' | 'lan' | 'relay'): void => {
      if (!peers.some((candidate) => candidate.peer === peer)) peers.push({ peer, via })
    }
    if (payload.tunnel.peerPort) {
      const wan = payload.endpoints.find((endpoint) => endpoint.kind === 'wan')
      if (wan) push(`tcp://${wan.host}:${payload.tunnel.peerPort}`, 'wan')
      const lan = payload.endpoints.find((endpoint) => endpoint.kind === 'lan')
      if (lan && !isLoopbackHost(lan.host)) {
        push(`tcp://${lan.host}:${payload.tunnel.peerPort}`, 'lan')
      }
    }
    const relay = payload.endpoints.find((endpoint) => endpoint.kind === 'relay')
    if (relay) push(`tcp://${relay.host}:${relay.port}`, 'relay')
    for (const configured of this.relayTicketEndpoints()) {
      push(`tcp://${configured.host}:${configured.port}`, 'relay')
    }
    return peers
  }

  private relayTicketEndpoints(): TicketEndpoint[] {
    return this.relayPeers.flatMap((relay) => {
      const match = /^(?:tcp|udp):\/\/([^/:]+):(\d+)$/.exec(relay)
      return match ? [{ kind: 'relay' as const, host: match[1], port: Number(match[2]) }] : []
    })
  }

  private memberIdentity(payload: TicketPayload): {
    id: string
    name: string
    mcVersion: string
    loader: string
    path: 'direct' | 'relay'
  } {
    return {
      id: this.randomId(),
      name: '玩家',
      mcVersion: payload.mc.version,
      loader: payload.mc.loader,
      path: this.transport === 'relay' ? 'relay' : 'direct',
    }
  }

  private applyWelcome(welcome: MemberWelcome): void {
    this.members = welcome.members
    this.handleWorld(welcome.world)
    this.joinTarget = this.resolveJoinTarget()
    if (this.world.port && this.localWorldPort && this.tunnelHandle && !this.worldForwardReady) {
      this.worldForwardReady = true
      void this.options.tunnel
        ?.addPortForward(this.tunnelHandle, this.localWorldPort, this.world.port)
        .catch((error: unknown) => {
          this.error = toLinkError(error, 'TUNNEL_FAILED')
          this.options.log.warn('world port forward failed', { code: this.error.code })
        })
    }
  }

  private handleWorld(world: WorldInfo): void {
    this.world = world
    if (
      world.port &&
      this.role === 'member' &&
      this.tunnelHandle &&
      this.localWorldPort &&
      !this.worldForwardReady
    ) {
      this.worldForwardReady = true
      void this.options.tunnel
        ?.addPortForward(this.tunnelHandle, this.localWorldPort, world.port)
        .catch((error: unknown) => {
          this.error = toLinkError(error, 'TUNNEL_FAILED')
          this.options.log.warn('late world port forward failed', { code: this.error.code })
        })
    }
    if (world.port && this.role === 'member') {
      this.joinTarget = this.localWorldPort
        ? { host: '127.0.0.1', port: this.localWorldPort }
        : this.memberEndpoint?.port
          ? { host: this.memberEndpoint.host, port: world.port }
          : this.joinTarget
    } else if (!world.port && world.state === 'closed') {
      this.joinTarget = null
    }
    this.emit()
  }

  private resolveJoinTarget(): JoinTarget | null {
    if (this.joinTarget) return this.joinTarget
    if (!this.world.port) return null
    if (this.role === 'member') {
      if (this.localWorldPort) return { host: '127.0.0.1', port: this.localWorldPort }
      const endpoint = this.parsed?.endpoints.find((candidate) => candidate.kind === 'lan')
      return endpoint ? { host: endpoint.host, port: this.world.port } : null
    }
    return { host: this.lanIp, port: this.world.port }
  }

  private async handleMemberClosed(error: LinkError): Promise<void> {
    if (this.closing || this.role !== 'member' || this.state === 'error') return
    if (this.reconnectAttempts >= 1) {
      this.state = 'error'
      this.error = error
      this.markMemberStatus('disconnected')
      this.emit()
      return
    }
    this.reconnectAttempts += 1
    this.options.log.warn('member connection lost; reconnecting once', { code: error.code })
    this.state = 'connecting'
    this.markMemberStatus('reconnecting')
    this.emit()
    await this.sleep(this.reconnectDelayMs)
    const endpoint = this.memberEndpoint
    if (!endpoint || !this.parsed) {
      this.state = 'error'
      this.error = error
      this.markMemberStatus('disconnected')
      this.emit()
      return
    }
    try {
      const control = new MemberControl({
        code: this.parsed.code,
        token: Buffer.from(this.parsed.net.secret, 'base64url'),
        endpoint,
        member: this.memberIdentity(this.parsed),
        log: this.options.log,
        heartbeatIntervalMs: this.heartbeatIntervalMs,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        onMembers: (members) => {
          this.members = members
          this.emit()
        },
        onWorld: (world) => this.handleWorld(world),
        onClosed: (next) => void this.handleMemberClosed(next),
      })
      const welcome = await control.connect()
      this.memberControl = control
      this.applyWelcome(welcome)
      this.state = 'connected'
      this.error = null
      this.emit()
    } catch {
      this.state = 'error'
      this.error = error
      this.markMemberStatus('disconnected')
      this.emit()
    }
  }

  private markMemberStatus(status: RoomMember['status']): void {
    this.members = this.members.map((member) =>
      member.role === 'member' ? { ...member, status } : member,
    )
  }

  private networkFailure(message: string): RoomInfo {
    this.state = 'error'
    this.transport = 'none'
    this.error = new LinkError('NETWORK_UNREACHABLE', message, { retryable: true })
    this.manual = null
    this.emit()
    return this.snapshot()
  }

  private manualFallback(code: LinkError['code'], message: string): RoomInfo {
    if (this.role !== 'member') return this.snapshot()
    this.state = 'error'
    this.transport = 'manual'
    this.error = new LinkError(code, message, { retryable: true })
    this.manual = this.manualGuide(message)
    this.emit()
    return this.snapshot()
  }

  private localize(error: LinkError): LinkError {
    const message = LINK_ERROR_MESSAGES[error.code]
    return message
      ? new LinkError(error.code, message, { retryable: error.retryable, details: error.details })
      : error
  }

  // ---------- lifecycle ----------
  private startWorldPoll(instanceDir: string | null): void {
    this.stopWorldPoll()
    const tick = (): void => {
      try {
        if (this.options.launch && this.instanceId) {
          const status = this.options.launch.status(this.instanceId)
          if (status.state !== 'running' && status.state !== 'spawn') return
        }
        const worlds = this.discovery.localWorlds()
        const world = instanceDir
          ? worlds.find((candidate) => candidate.id.startsWith(`local:${instanceDir}:`))
          : worlds[0]
        if (world && (this.world.port !== world.port || this.world.state !== 'open')) {
          void this.setWorldPort({ port: world.port })
        }
      } catch (error) {
        this.options.log.debug('LAN world poll failed', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    tick()
    this.worldPoll = setInterval(tick, 2_000)
    this.worldPoll.unref?.()
  }

  private stopWorldPoll(): void {
    if (this.worldPoll) clearInterval(this.worldPoll)
    this.worldPoll = null
  }

  private watchLaunch(instanceId: string): void {
    if (!this.options.launch || this.launchUnsubscribers.length > 0) return
    this.launchUnsubscribers.push(this.options.launch.onEvent('output', (raw) => {
      const event = raw as { line?: unknown } | null
      if (!event || typeof event.line !== 'string') return
      const port = parseWorldPort(event.line)
      if (port) {
        if (this.world.port !== port || this.world.state !== 'open') {
          void this.setWorldPort({ port })
        }
      }
    }))
    this.launchUnsubscribers.push(this.options.launch.onEvent('exited', (raw) => {
      const event = raw as { instanceId?: unknown; sessionId?: unknown } | null
      if (!event) return
      if (typeof event.instanceId === 'string' && event.instanceId !== instanceId) return
      this.world = { port: null, state: 'closed', address: null }
      this.emit()
    }))
    this.options.log.info('watching launch output for LAN world', { instanceId })
  }

  private async cleanupHost(): Promise<void> {
    this.stopWorldPoll()
    if (this.roomTimer) clearTimeout(this.roomTimer)
    this.roomTimer = null
    for (const unsubscribe of this.launchUnsubscribers.splice(0)) unsubscribe()
    await this.hostControl?.close('HOST_LEFT')
    this.hostControl = null
    await this.stopTunnel()
    this.lanControlPort = null
    this.aliasControlPort = null
    this.peerPort = null
    this.members = []
  }

  private async cleanupMember(): Promise<void> {
    if (this.roomTimer) clearTimeout(this.roomTimer)
    this.roomTimer = null
    await this.memberControl?.leave()
    this.memberControl = null
    await this.stopTunnel()
    this.localWorldPort = null
    this.localControlPort = null
    this.memberEndpoint = null
    this.members = []
  }

  private async stopTunnel(): Promise<void> {
    if (!this.tunnelHandle) return
    const handle = this.tunnelHandle
    this.tunnelHandle = null
    this.tunnelState = 'stopped'
    try {
      await this.options.tunnel?.stop(handle)
    } catch {
      // best effort
    }
  }

  private assertInstanceCompatible(payload: TicketPayload, instanceId: string | null): void {
    if (!instanceId) return
    const instance = this.lookupInstance(instanceId)
    if (!instance) return
    if (
      instance.mcVersion &&
      payload.mc.version !== 'unknown' &&
      instance.mcVersion !== payload.mc.version
    ) {
      throw new LinkError('VERSION_MISMATCH', `host ${payload.mc.version}, local ${instance.mcVersion}`)
    }
    if (
      instance.loader &&
      payload.mc.loader !== 'unknown' &&
      instance.loader !== payload.mc.loader
    ) {
      throw new LinkError('LOADER_MISMATCH', `host ${payload.mc.loader}, local ${instance.loader}`)
    }
  }

  private lookupInstance(
    instanceId: string,
  ): { mcVersion: string | null; loader: string; dirName: string | null } | null {
    try {
      const instance = this.options.instance?.get(instanceId)
      if (!instance) return null
      return {
        mcVersion: instance.mcVersion,
        loader: instance.loader.type,
        dirName: instance.dirName ?? null,
      }
    } catch {
      return null
    }
  }

  private manualGuide(reason: string): ManualGuide {
    const port = this.world.port ?? 25565
    return {
      reason,
      steps: [
        '确认房主已在游戏内“对局域网开放”，并看到聊天栏的端口提示。',
        '同一局域网：把房主的内网 IP 和端口填到“多人游戏 → 直接连接”。',
        `跨网：在路由器把 TCP ${port} 转发到房主的内网 IP；本启动器不会自动修改路由器或防火墙。`,
        'Windows 防火墙：允许 javaw.exe 的“专用网络”入站，或临时关闭后重试。',
        '仍无法直连：配置一个自备的 EasyTier/frp 中继节点，或使用外部联机工具。',
      ],
    }
  }

  private busySnapshot(): RoomInfo {
    return {
      ...this.snapshot(),
      error: {
        code: 'ROOM_CLOSED',
        message: '请先离开当前房间，再创建或加入新的房间',
        retryable: false,
      },
    }
  }

  private hostMember(): RoomMember {
    return {
      id: 'host',
      name: this.identity?.hostName ?? '房主',
      role: 'host',
      mcVersion: this.identity?.mc.version ?? 'unknown',
      loader: this.identity?.mc.loader ?? 'unknown',
      pingMs: 0,
      pingKnown: true,
      pingLabel: '0 ms',
      status: 'connected',
      path: 'direct',
    }
  }

  private snapshot(): RoomInfo {
    const payload = this.ticket?.payload ?? this.parsed
    const code = payload ? normalizeCode(payload.code) : '000000'
    const host = payload
      ? { name: payload.host.name, mcVersion: payload.mc.version, loader: payload.mc.loader }
      : { name: '房主', mcVersion: 'unknown', loader: 'unknown' }
    return {
      code,
      invite: shortInvite(code),
      state: this.state,
      transport: this.transport,
      tunnel: {
        state: this.tunnelState,
        version: this.tunnelState === 'idle' ? null : EASYTIER_VERSION,
        relay: this.transport === 'relay' || this.relayPeers.length > 0,
      },
      world: this.world,
      ports: {
        control: this.aliasControlPort ?? this.lanControlPort,
        world: this.world.port,
        peer: this.peerPort,
        localWorld: this.localWorldPort,
      },
      manual: this.manual,
      members: this.members,
      host,
      maxMembers: this.maxMembers,
      expiresAt: payload ? payload.exp * 1000 : null,
      error: this.error
        ? { code: this.error.code, message: this.error.message, retryable: this.error.retryable }
        : null,
    }
  }

  private emit(): void {
    const info = this.snapshot()
    try {
      this.options.onSnapshot?.(info)
    } catch {
      // never let a UI callback break the room
    }
    this.fire('state', { state: info.state, code: info.code, error: info.error })
    this.fire('members', info.members)
    this.fire('world', info.world)
    if (info.error) this.fire('error', info.error)
  }
}

// ---------- helpers ----------
export function parseWorldPort(line: string): number | null {
  const patterns = [
    /Started serving on\s+(\d{1,5})/i,
    /Local game hosted on port\s+(\d{1,5})/i,
    /Starting Minecraft server on\s+[^\s:]*:(\d{1,5})/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(line)
    if (match) {
      const port = Number(match[1])
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
    }
  }
  return null
}

export function pickLanIp(): string {
  try {
    const interfaces = os.networkInterfaces()
    const fallback: string[] = []
    for (const entries of Object.values(interfaces)) {
      for (const entry of entries ?? []) {
        if (entry.family !== 'IPv4' || entry.internal) continue
        if (isPrivate(entry.address)) return entry.address
        // t72: VPN-only machines (Radmin/Hamachi/ZeroTier) still need a
        // listener; use the first non-internal IPv4 if no RFC1918 exists.
        fallback.push(entry.address)
      }
    }
    if (fallback.length > 0) return fallback[0]
  } catch {
    // fall through
  }
  return '127.0.0.1'
}

export function pickAliasIp(): string {
  const bytes = crypto.randomBytes(1)[0]
  return `127.0.0.${2 + (bytes % 253)}`
}

function isPrivate(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
}

function toLinkError(error: unknown, fallback: LinkError['code']): LinkError {
  if (error instanceof LinkError) return error
  return new LinkError(fallback, messageOf(error), { retryable: true })
}
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
