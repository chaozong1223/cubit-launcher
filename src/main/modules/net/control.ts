import crypto from 'node:crypto'
import net from 'node:net'
import type { ScopedLogger } from '../../kernel/logger'
import type { RoomMember, WorldInfo } from '@shared/net'
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
} from './constants'
import {
  LinkError,
  helloAuth,
  normalizeCode,
  safeEqual,
  welcomeAuth,
} from './ticket'

export interface ControlMemberInput {
  id: string
  name: string
  mcVersion: string
  loader: string
  path: 'direct' | 'relay'
}

interface HostMember extends RoomMember {
  socket: net.Socket
  lastSeen: number
}

export interface HostControlOptions {
  code: string
  token: Buffer
  hostName: string
  mcVersion: string
  loader: string
  maxMembers: number
  log: ScopedLogger
  heartbeatTimeoutMs?: number
  /** Destroy a socket that has not completed HELLO within this window. */
  handshakeTimeoutMs?: number
  /** Cap concurrent unauthenticated sockets (slowloris / ticket spray). */
  maxUnauthenticated?: number
  onMembers?: (members: RoomMember[]) => void
  onError?: (code: string, message: string) => void
}

export class HostControl {
  private readonly servers: net.Server[] = []
  private readonly sockets = new Set<net.Socket>()
  private readonly unauthenticated = new Set<net.Socket>()
  private readonly memberMap = new Map<string, HostMember>()
  private world: WorldInfo = { port: null, state: 'pending', address: null }
  private sweeper: NodeJS.Timeout | null = null
  private closed = false
  private readonly timeoutMs: number
  private readonly handshakeTimeoutMs: number
  private readonly maxUnauthenticated: number

  constructor(private readonly options: HostControlOptions) {
    this.timeoutMs = options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
    this.handshakeTimeoutMs = Math.max(1_000, options.handshakeTimeoutMs ?? 10_000)
    this.maxUnauthenticated = Math.max(1, options.maxUnauthenticated ?? 32)
    this.sweeper = setInterval(() => this.sweep(), Math.max(200, Math.floor(this.timeoutMs / 3)))
    this.sweeper.unref?.()
  }

  async listen(host: string, port = 0): Promise<number> {
    const server = net.createServer((socket) => this.accept(socket))
    this.servers.push(server)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new LinkError('INTERNAL', 'control listen failed')
    this.options.log.info('room control listening', { host, port: address.port })
    return address.port
  }

  setWorld(world: WorldInfo): void {
    this.world = world
    this.broadcast({ t: 'EVENT', event: 'world', world })
    this.options.onMembers?.(this.snapshot())
  }

  members(): RoomMember[] {
    return this.snapshot()
  }

  async close(reason = 'HOST_LEFT'): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = null
    this.broadcast({ t: 'CLOSE', reason })
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    this.memberMap.clear()
    await Promise.all(
      this.servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
            setTimeout(resolve, 500)
          }),
      ),
    )
    this.servers.length = 0
    this.options.onMembers?.([])
  }

  private accept(socket: net.Socket): void {
    if (this.closed) {
      socket.destroy()
      return
    }
    if (this.unauthenticated.size >= this.maxUnauthenticated) {
      this.options.log.warn('rejecting unauthenticated control socket', {
        pending: this.unauthenticated.size,
        limit: this.maxUnauthenticated,
      })
      socket.destroy()
      return
    }
    socket.setEncoding('utf8')
    socket.setNoDelay(true)
    this.sockets.add(socket)
    this.unauthenticated.add(socket)
    let buffer = ''
    let member: HostMember | null = null
    let authenticated = false
    let handshakeTimer: NodeJS.Timeout | null = null

    const clearHandshake = (): void => {
      if (handshakeTimer) clearTimeout(handshakeTimer)
      handshakeTimer = null
      this.unauthenticated.delete(socket)
    }

    const fail = (code: string, message: string): void => {
      clearHandshake()
      this.send(socket, { t: 'ERROR', code, message })
      socket.end()
    }

    handshakeTimer = setTimeout(() => {
      if (authenticated || socket.destroyed) return
      this.options.log.warn('control handshake timeout', { timeoutMs: this.handshakeTimeoutMs })
      fail('AUTH_FAILED', 'handshake timeout')
      socket.destroy()
    }, this.handshakeTimeoutMs)
    handshakeTimer.unref?.()

    socket.on('data', (chunk: string) => {
      buffer += chunk
      if (buffer.length > 64 * 1024) {
        fail('TICKET_MALFORMED', 'control line too large')
        return
      }
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        if (line.trim()) {
          let message: Record<string, unknown>
          try {
            message = JSON.parse(line) as Record<string, unknown>
          } catch {
            fail('TICKET_MALFORMED', 'bad json')
            return
          }
          const error = this.handle(socket, message, {
            get member() {
              return member
            },
            get authenticated() {
              return authenticated
            },
            setMember: (value) => {
              member = value
            },
            setAuthenticated: (value) => {
              authenticated = value
              if (value) clearHandshake()
            },
            fail,
          })
          if (error) {
            fail(error.code, error.message)
            return
          }
          if (authenticated) clearHandshake()
        }
        index = buffer.indexOf('\n')
      }
    })

    socket.on('close', () => {
      clearHandshake()
      this.sockets.delete(socket)
      if (member && this.memberMap.delete(member.id)) {
        this.options.log.info('member left', { memberId: member.id, reason: 'socket_closed' })
        this.broadcastMembers()
      }
    })
    socket.on('error', () => {
      // close handler does the cleanup
    })
  }

  private handle(
    socket: net.Socket,
    message: Record<string, unknown>,
    state: {
      member: HostMember | null
      authenticated: boolean
      setMember: (member: HostMember | null) => void
      setAuthenticated: (value: boolean) => void
      fail: (code: string, message: string) => void
    },
  ): { code: string; message: string } | null {
    const type = message.t
    if (type === 'HELLO') {
      try {
        if (this.closed) throw new LinkError('ROOM_CLOSED', 'room closed')
        if (message.v !== 1) throw new LinkError('INVITE_INVALID', 'protocol version')
        if (typeof message.code !== 'string' || normalizeCode(message.code) !== this.options.code) {
          throw new LinkError('INVITE_INVALID', 'code mismatch')
        }
        if (typeof message.nonce !== 'string' || message.nonce.length === 0 || message.nonce.length > 64) {
          throw new LinkError('AUTH_FAILED', 'nonce')
        }
        const rawMember = message.member as Record<string, unknown> | undefined
        if (
          !rawMember ||
          typeof rawMember.id !== 'string' ||
          typeof rawMember.name !== 'string' ||
          rawMember.name.length === 0 ||
          rawMember.name.length > 32 ||
          typeof rawMember.mcVersion !== 'string' ||
          typeof rawMember.loader !== 'string'
        ) {
          throw new LinkError('AUTH_FAILED', 'member shape')
        }
        const expected = helloAuth(this.options.token, {
          code: this.options.code,
          nonce: message.nonce,
          memberId: rawMember.id,
        })
        if (!safeEqual(expected, String(message.auth ?? ''))) {
          throw new LinkError('AUTH_FAILED', 'bad auth')
        }
        if (rawMember.mcVersion !== this.options.mcVersion) {
          throw new LinkError('VERSION_MISMATCH', `host ${this.options.mcVersion}, member ${rawMember.mcVersion}`)
        }
        if (rawMember.loader !== this.options.loader) {
          throw new LinkError('LOADER_MISMATCH', `host ${this.options.loader}, member ${rawMember.loader}`)
        }
        if (this.memberMap.size >= this.options.maxMembers) {
          throw new LinkError('ROOM_FULL', `max ${this.options.maxMembers}`)
        }
        for (const existing of this.memberMap.values()) {
          if (existing.id === rawMember.id) throw new LinkError('AUTH_FAILED', 'duplicate member id')
        }
        const member: HostMember = {
          id: rawMember.id,
          name: rawMember.name,
          role: 'member',
          mcVersion: rawMember.mcVersion,
          loader: rawMember.loader,
          pingMs: 0,
          pingKnown: false,
          pingLabel: '未知',
          status: 'connected',
          path: rawMember.path === 'relay' ? 'relay' : 'direct',
          socket,
          lastSeen: Date.now(),
        }
        this.memberMap.set(member.id, member)
        state.setMember(member)
        state.setAuthenticated(true)
        this.send(socket, {
          t: 'WELCOME',
          v: 1,
          room: {
            code: this.options.code,
            hostName: this.options.hostName,
            max: this.options.maxMembers,
            mcVersion: this.options.mcVersion,
            loader: this.options.loader,
          },
          members: this.snapshot(),
          world: this.world,
          auth: welcomeAuth(this.options.token, { code: this.options.code, nonce: message.nonce }),
        })
        this.options.log.info('member joined', { memberId: member.id, name: member.name })
        this.broadcastMembers()
        return null
      } catch (error) {
        if (error instanceof LinkError) return { code: error.code, message: error.message }
        return { code: 'AUTH_FAILED', message: error instanceof Error ? error.message : String(error) }
      }
    }

    if (!state.authenticated || !state.member) {
      return { code: 'AUTH_FAILED', message: 'HELLO required' }
    }
    state.member.lastSeen = Date.now()
    if (type === 'PING') {
      this.send(socket, {
        t: 'PONG',
        seq: message.seq ?? null,
        ts: message.ts ?? Date.now(),
        serverTs: Date.now(),
        members: this.snapshot(),
        world: this.world,
      })
      return null
    }
    if (type === 'STATS') {
      const rounded = Math.max(0, Math.round(Number(message.rttMs)))
      if (Number.isFinite(rounded)) {
        state.member.pingMs = rounded
        state.member.pingKnown = true
        state.member.pingLabel = `${rounded} ms`
        this.broadcastMembers()
      }
      return null
    }
    if (type === 'LEAVE') {
      this.memberMap.delete(state.member.id)
      this.options.log.info('member left', { memberId: state.member.id, reason: 'client_leave' })
      this.broadcastMembers()
      socket.end()
      return null
    }
    return { code: 'TICKET_MALFORMED', message: `unknown message ${String(type)}` }
  }

  private sweep(): void {
    if (this.closed) return
    const now = Date.now()
    for (const member of [...this.memberMap.values()]) {
      if (now - member.lastSeen > this.timeoutMs) {
        this.memberMap.delete(member.id)
        this.send(member.socket, { t: 'ERROR', code: 'HEARTBEAT_TIMEOUT', message: 'heartbeat timeout' })
        member.socket.destroy()
        this.options.log.warn('member heartbeat timeout', { memberId: member.id })
        this.broadcastMembers()
        this.options.onError?.('HEARTBEAT_TIMEOUT', 'member heartbeat timeout')
      }
    }
  }

  private snapshot(): RoomMember[] {
    const host: RoomMember = {
      id: 'host',
      name: this.options.hostName,
      role: 'host',
      mcVersion: this.options.mcVersion,
      loader: this.options.loader,
      pingMs: 0,
      pingKnown: true,
      pingLabel: '0 ms',
      status: 'connected',
      path: 'direct',
    }
    const members = [...this.memberMap.values()].map((member) => ({
      id: member.id,
      name: member.name,
      role: member.role,
      mcVersion: member.mcVersion,
      loader: member.loader,
      pingMs: member.pingMs,
      pingKnown: member.pingKnown,
      pingLabel: member.pingLabel,
      status: member.status,
      path: member.path,
    }))
    return [host, ...members]
  }

  private broadcastMembers(): void {
    const members = this.snapshot()
    this.broadcast({ t: 'EVENT', event: 'members', members })
    this.options.onMembers?.(members)
  }

  private broadcast(message: Record<string, unknown>): void {
    for (const member of this.memberMap.values()) this.send(member.socket, message)
  }

  private send(socket: net.Socket, message: Record<string, unknown>): void {
    if (socket.destroyed) return
    try {
      socket.write(`${JSON.stringify(message)}\n`)
    } catch {
      socket.destroy()
    }
  }
}

export interface MemberControlOptions {
  code: string
  token: Buffer
  endpoint: { host: string; port: number }
  member: ControlMemberInput
  log: ScopedLogger
  heartbeatIntervalMs?: number
  heartbeatTimeoutMs?: number
  connectTimeoutMs?: number
  onMembers?: (members: RoomMember[]) => void
  onWorld?: (world: WorldInfo) => void
  onClosed?: (error: LinkError) => void
}

export interface MemberWelcome {
  room: {
    code: string
    hostName: string
    max: number
    mcVersion: string
    loader: string
  }
  members: RoomMember[]
  world: WorldInfo
}

export class MemberControl {
  private socket: net.Socket | null = null
  private interval: NodeJS.Timeout | null = null
  private lastPong = 0
  private pingSentAt = 0
  private lastRttMs: number | null = null
  private closed = false
  private welcomed = false

  constructor(private readonly options: MemberControlOptions) {}

  async connect(): Promise<MemberWelcome> {
    const timeoutMs = this.options.connectTimeoutMs ?? 5000
    return new Promise<MemberWelcome>((resolve, reject) => {
      const socket = net.createConnection(this.options.endpoint)
      this.socket = socket
      socket.setEncoding('utf8')
      socket.setNoDelay(true)
      let buffer = ''
      let settled = false
      const nonce = crypto.randomBytes(16).toString('base64url')
      const settle = (error: LinkError | null, value?: MemberWelcome): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) {
          this.closed = true
          socket.destroy()
          reject(error)
        } else if (value) {
          resolve(value)
        }
      }
      const timer = setTimeout(() => {
        settle(new LinkError('NETWORK_UNREACHABLE', 'control connect timeout', { retryable: true }))
      }, timeoutMs)

      socket.once('connect', () => {
        this.lastPong = Date.now()
        socket.write(
          `${JSON.stringify({
            t: 'HELLO',
            v: 1,
            code: this.options.code,
            nonce,
            member: this.options.member,
            auth: helloAuth(this.options.token, {
              code: this.options.code,
              nonce,
              memberId: this.options.member.id,
            }),
          })}\n`,
        )
      })

      socket.on('data', (chunk: string) => {
        buffer += chunk
        if (buffer.length > 64 * 1024) {
          settle(new LinkError('TICKET_MALFORMED', 'control line too large'))
          return
        }
        let index = buffer.indexOf('\n')
        while (index >= 0) {
          const line = buffer.slice(0, index)
          buffer = buffer.slice(index + 1)
          if (line.trim()) {
            let message: Record<string, unknown>
            try {
              message = JSON.parse(line) as Record<string, unknown>
            } catch {
              settle(new LinkError('TICKET_MALFORMED', 'bad json from host'))
              return
            }
            const error = this.handle(message, nonce, settle)
            if (error) {
              settle(error)
              return
            }
          }
          index = buffer.indexOf('\n')
        }
      })

      socket.on('timeout', () => {
        if (!this.welcomed) settle(new LinkError('NETWORK_UNREACHABLE', 'control timeout', { retryable: true }))
      })
      socket.on('error', (error) => {
        if (!this.welcomed) {
          settle(new LinkError('NETWORK_UNREACHABLE', error.message, { retryable: true }))
        } else {
          this.notifyClosed(new LinkError('NETWORK_UNREACHABLE', error.message, { retryable: true }))
        }
      })
      socket.on('close', () => {
        this.clearTimer()
        if (!this.closed && this.welcomed) {
          this.notifyClosed(new LinkError('HEARTBEAT_TIMEOUT', 'host connection lost', { retryable: true }))
        } else if (!settled) {
          settle(new LinkError('NETWORK_UNREACHABLE', 'control connection closed', { retryable: true }))
        }
      })
    })
  }

  private handle(
    message: Record<string, unknown>,
    nonce: string,
    settle: (error: LinkError | null, value?: MemberWelcome) => void,
  ): LinkError | null {
    const type = message.t
    if (type === 'WELCOME') {
      const expected = welcomeAuth(this.options.token, { code: this.options.code, nonce })
      if (!safeEqual(expected, String(message.auth ?? ''))) {
        return new LinkError('AUTH_FAILED', 'welcome auth failed')
      }
      const room = message.room as MemberWelcome['room'] | undefined
      if (!room || room.code !== this.options.code) {
        return new LinkError('INVITE_INVALID', 'welcome code mismatch')
      }
      const members = Array.isArray(message.members) ? (message.members as RoomMember[]) : []
      const world = normalizeWorld(message.world)
      this.welcomed = true
      this.options.onMembers?.(members)
      this.options.onWorld?.(world)
      this.startHeartbeat()
      settle(null, { room, members, world })
      return null
    }
    if (type === 'PONG') {
      this.lastPong = Date.now()
      if (this.pingSentAt > 0) {
        this.lastRttMs = Math.max(0, Date.now() - this.pingSentAt)
        this.pingSentAt = 0
        try {
          this.socket?.write(`${JSON.stringify({ t: 'STATS', rttMs: this.lastRttMs })}\n`)
        } catch {
          // the next heartbeat/close handler reports the failure
        }
      }
      if (Array.isArray(message.members)) this.options.onMembers?.(message.members as RoomMember[])
      this.options.onWorld?.(normalizeWorld(message.world))
      return null
    }
    if (type === 'EVENT') {
      if (message.event === 'members' && Array.isArray(message.members)) {
        this.options.onMembers?.(message.members as RoomMember[])
      }
      if (message.event === 'world') this.options.onWorld?.(normalizeWorld(message.world))
      return null
    }
    if (type === 'CLOSE') {
      const reason = String(message.reason ?? 'ROOM_CLOSED')
      const error = new LinkError('ROOM_CLOSED', `room closed: ${reason}`)
      this.closed = true
      this.clearTimer()
      this.socket?.destroy()
      this.options.onClosed?.(error)
      return error
    }
    if (type === 'ERROR') {
      const code = typeof message.code === 'string' ? message.code : 'AUTH_FAILED'
      return new LinkError(code as LinkError['code'], String(message.message ?? code))
    }
    return new LinkError('TICKET_MALFORMED', `unknown message ${String(type)}`)
  }

  private sendPing(): void {
    this.pingSentAt = Date.now()
    try {
      this.socket?.write(`${JSON.stringify({ t: 'PING', seq: this.pingSentAt, ts: this.pingSentAt, rttMs: this.lastRttMs })}\n`)
    } catch {
      this.notifyClosed(new LinkError('NETWORK_UNREACHABLE', 'ping failed', { retryable: true }))
    }
  }

  private startHeartbeat(): void {
    this.clearTimer()
    const interval = this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS
    const timeout = this.options.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS
    this.sendPing()
    this.interval = setInterval(() => {
      if (Date.now() - this.lastPong > timeout) {
        this.notifyClosed(new LinkError('HEARTBEAT_TIMEOUT', 'no PONG from host', { retryable: true }))
        this.socket?.destroy()
        return
      }
      try {
        this.socket?.write(`${JSON.stringify({ t: 'PING', seq: Date.now(), ts: Date.now() })}\n`)
      } catch {
        this.notifyClosed(new LinkError('NETWORK_UNREACHABLE', 'ping failed', { retryable: true }))
      }
    }, interval)
    this.interval.unref?.()
  }

  async leave(): Promise<void> {
    this.closed = true
    this.clearTimer()
    try {
      this.socket?.write(`${JSON.stringify({ t: 'LEAVE' })}\n`)
    } catch {
      // ignore
    }
    this.socket?.destroy()
    this.socket = null
  }

  private notifyClosed(error: LinkError): void {
    if (this.closed) return
    this.closed = true
    this.clearTimer()
    this.options.onClosed?.(error)
  }

  private clearTimer(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
  }
}

export function normalizeWorld(value: unknown): WorldInfo {
  const raw = (value ?? {}) as Record<string, unknown>
  const port = typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0 ? raw.port : null
  const state = raw.state === 'open' || raw.state === 'closed' ? raw.state : 'pending'
  const address = typeof raw.address === 'string' ? raw.address : null
  return { port, state, address }
}
