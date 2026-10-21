import crypto from 'node:crypto'
import type { LinkErrorCode } from '@shared/net'
import { LINK_ERROR_MESSAGES } from '@shared/net'

/**
 * Self-verifying invite tickets (docs/04 §6.2).
 *
 * Layout: `MCL1.<code>.<base64url(canonicalJson(payload))>.<base64url(Ed25519 sig)>`
 * The signature covers the prefix + code + payload, so endpoint/port/world data
 * cannot be changed without detection. The room secret is a 256-bit capability
 * and must never be logged.
 */

export const TICKET_VERSION = 1
export const TICKET_PREFIX = 'MCL1'
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const MAX_TICKET_BYTES = 2048
export const MAX_CLOCK_SKEW_SECONDS = 300
export const DEFAULT_TICKET_TTL_SECONDS = 600

export interface TicketEndpoint {
  kind: 'lan' | 'relay'
  host: string
  port: number
}

export interface TicketTunnel {
  provider: 'easytier'
  version: '2.7.0'
  vip: string
  mappedCidr: string
  worldPort: number | null
  controlPort: number
  peerPort: number | null
  lanControlPort: number | null
}

export interface TicketPayload {
  v: 1
  code: string
  roomId: string
  host: { name: string; pub: string }
  net: { name: string; secret: string }
  endpoints: TicketEndpoint[]
  tunnel: TicketTunnel
  mc: { version: string; loader: string }
  max: number
  iat: number
  exp: number
  jti: string
}

export interface ParsedTicket {
  payload: TicketPayload
  code: string
  roomId: Buffer
  publicKey: crypto.KeyObject
  ticket: string
}

export class LinkError extends Error {
  readonly code: LinkErrorCode
  readonly retryable: boolean
  readonly details?: Record<string, unknown>

  constructor(
    code: LinkErrorCode,
    message?: string,
    options: { retryable?: boolean; details?: Record<string, unknown> } = {},
  ) {
    super(message ?? LINK_ERROR_MESSAGES[code] ?? code)
    this.name = 'LinkError'
    this.code = code
    this.retryable = options.retryable ?? false
    this.details = options.details
  }

  /** IPC shape; message is the localized LINK_ERROR_MESSAGES text. */
  toShape(): {
    code: LinkErrorCode
    message: string
    retryable: boolean
    details?: Record<string, unknown>
  } {
    return {
      code: this.code,
      message: LINK_ERROR_MESSAGES[this.code] ?? this.message,
      retryable: this.retryable,
      ...(this.details ? { details: this.details } : {}),
    }
  }
}

// ---------- Crockford Base32 ----------
export function crockfordEncode(buffer: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31]
  return out
}

export function crockfordDecode(text: string): Buffer {
  const normalized = String(text)
    .toUpperCase()
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
    .replace(/-/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const char of normalized) {
    const index = CROCKFORD.indexOf(char)
    if (index < 0) throw new LinkError('TICKET_MALFORMED', `bad base32 char ${char}`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function normalizeCode(code: string): string {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[^0-9A-HJKMNP-TV-Z]/g, '')
}

export function deriveCode(roomId: Buffer): string {
  return crockfordEncode(crypto.createHash('sha256').update(roomId).digest()).slice(0, 6)
}

export function shortInvite(code: string): string {
  return `MCL-${normalizeCode(code)}`
}

// ---------- canonical JSON ----------
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`
}

// ---------- identity / ticket ----------
export interface RoomIdentity {
  roomId: Buffer
  code: string
  publicKey: crypto.KeyObject
  privateKey: crypto.KeyObject
  netSecret: Buffer
  hostPub: string
  hostName: string
  mc: { version: string; loader: string }
  maxMembers: number
}

export interface CreateIdentityInput {
  hostName: string
  mcVersion: string
  loader: string
  maxMembers: number
}

export function createRoomIdentity(input: CreateIdentityInput): RoomIdentity {
  const roomId = crypto.randomBytes(16)
  const code = deriveCode(roomId)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const jwk = publicKey.export({ format: 'jwk' }) as crypto.JsonWebKey
  if (!jwk.x) throw new LinkError('INTERNAL', 'failed to export host public key')
  const netSecret = crypto.randomBytes(32)
  return {
    roomId,
    code,
    publicKey,
    privateKey,
    netSecret,
    hostPub: jwk.x,
    hostName: input.hostName,
    mc: { version: input.mcVersion, loader: input.loader },
    maxMembers: Math.min(8, Math.max(2, input.maxMembers)),
  }
}

export interface IssueTicketInput {
  identity: RoomIdentity
  endpoints: TicketEndpoint[]
  tunnel: TicketTunnel
  ttlSeconds?: number
  now?: number
}

export interface IssuedTicket {
  ticket: string
  payload: TicketPayload
}

export function issueTicket(input: IssueTicketInput): IssuedTicket {
  const now = input.now ?? Math.floor(Date.now() / 1000)
  const payload: TicketPayload = {
    v: TICKET_VERSION,
    code: input.identity.code,
    roomId: input.identity.roomId.toString('base64url'),
    host: { name: input.identity.hostName, pub: input.identity.hostPub },
    net: {
      name: `mcl-${input.identity.code.toLowerCase()}`,
      secret: input.identity.netSecret.toString('base64url'),
    },
    endpoints: input.endpoints,
    tunnel: input.tunnel,
    mc: input.identity.mc,
    max: input.identity.maxMembers,
    iat: now,
    exp: now + (input.ttlSeconds ?? DEFAULT_TICKET_TTL_SECONDS),
    jti: crypto.randomBytes(8).toString('base64url'),
  }
  const body = Buffer.from(canonicalJson(payload), 'utf8')
  if (body.length > MAX_TICKET_BYTES) throw new LinkError('TICKET_MALFORMED', 'ticket too large')
  const signed = `${TICKET_PREFIX}.${payload.code}.${body.toString('base64url')}`
  const signature = crypto.sign(null, Buffer.from(signed, 'utf8'), input.identity.privateKey)
  return { ticket: `${signed}.${signature.toString('base64url')}`, payload }
}

export interface ParseTicketOptions {
  now?: number
  expectedCode?: string
}

export function parseTicket(ticket: string, options: ParseTicketOptions = {}): ParsedTicket {
  if (typeof ticket !== 'string' || ticket.length === 0 || ticket.length > 4096) {
    throw new LinkError('TICKET_MALFORMED', 'ticket shape')
  }
  const parts = ticket.trim().split('.')
  if (parts.length !== 4 || parts[0] !== TICKET_PREFIX) {
    throw new LinkError('TICKET_MALFORMED', 'ticket prefix/parts')
  }
  const [, code, bodyB64, signatureB64] = parts
  if (!/^[0-9A-HJKMNP-TV-Z]{6}$/.test(code)) {
    throw new LinkError('TICKET_MALFORMED', 'bad short code')
  }
  if (!/^[A-Za-z0-9_-]+$/.test(bodyB64) || !/^[A-Za-z0-9_-]+$/.test(signatureB64)) {
    throw new LinkError('TICKET_MALFORMED', 'bad base64url')
  }
  const body = Buffer.from(bodyB64, 'base64url')
  if (body.length === 0 || body.length > MAX_TICKET_BYTES) {
    throw new LinkError('TICKET_MALFORMED', 'ticket body size')
  }

  let payload: TicketPayload
  try {
    payload = JSON.parse(body.toString('utf8')) as TicketPayload
  } catch (error) {
    throw new LinkError('TICKET_MALFORMED', `json: ${error instanceof Error ? error.message : String(error)}`)
  }
  validatePayloadShape(payload, code)
  if (options.expectedCode && normalizeCode(options.expectedCode) !== code) {
    throw new LinkError('INVITE_INVALID', 'code mismatch')
  }

  const roomId = Buffer.from(payload.roomId, 'base64url')
  if (roomId.length !== 16) throw new LinkError('TICKET_MALFORMED', 'roomId length')
  if (deriveCode(roomId) !== code) {
    throw new LinkError('TICKET_MALFORMED', 'code is not derived from roomId')
  }

  let publicKey: crypto.KeyObject
  try {
    publicKey = crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: payload.host.pub },
      format: 'jwk',
    })
  } catch {
    throw new LinkError('TICKET_MALFORMED', 'host pub')
  }
  const signed = `${TICKET_PREFIX}.${code}.${bodyB64}`
  const valid = crypto.verify(
    null,
    Buffer.from(signed, 'utf8'),
    publicKey,
    Buffer.from(signatureB64, 'base64url'),
  )
  if (!valid) throw new LinkError('TICKET_SIGNATURE_INVALID', 'signature verification failed')

  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (!Number.isInteger(payload.exp) || payload.exp < now - MAX_CLOCK_SKEW_SECONDS) {
    throw new LinkError('INVITE_EXPIRED', 'ticket expired')
  }
  if (!Number.isInteger(payload.iat) || payload.iat > now + MAX_CLOCK_SKEW_SECONDS) {
    throw new LinkError('INVITE_INVALID', 'ticket issued in the future')
  }
  return { payload, code, roomId, publicKey, ticket }
}

function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535
}

function isPrivateOrLoopback(host: string): boolean {
  if (host === 'localhost' || host === '::1' || host === '[::1]') return true
  const parts = host.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map(Number)
  if (octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) return false
  const [a, b] = octets
  return (
    a === 127 ||
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
  )
}

function validatePayloadShape(payload: TicketPayload, code: string): void {
  if (!payload || typeof payload !== 'object') throw new LinkError('TICKET_MALFORMED', 'payload')
  if (payload.v !== TICKET_VERSION) throw new LinkError('INVITE_INVALID', 'unsupported ticket version')
  if (payload.code !== code) throw new LinkError('TICKET_MALFORMED', 'code mismatch')
  if (typeof payload.roomId !== 'string' || !/^[A-Za-z0-9_-]{22}$/.test(payload.roomId)) {
    throw new LinkError('TICKET_MALFORMED', 'roomId')
  }
  if (!payload.host || typeof payload.host.name !== 'string' || typeof payload.host.pub !== 'string') {
    throw new LinkError('TICKET_MALFORMED', 'host')
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(payload.host.pub)) throw new LinkError('TICKET_MALFORMED', 'host pub length')
  if (!payload.net || typeof payload.net.name !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(payload.net.secret)) {
    throw new LinkError('TICKET_MALFORMED', 'net secret')
  }
  if (!Array.isArray(payload.endpoints) || payload.endpoints.length === 0 || payload.endpoints.length > 4) {
    throw new LinkError('TICKET_MALFORMED', 'endpoints')
  }
  for (const endpoint of payload.endpoints) {
    if (!endpoint || (endpoint.kind !== 'lan' && endpoint.kind !== 'relay')) {
      throw new LinkError('TICKET_MALFORMED', 'endpoint kind')
    }
    if (typeof endpoint.host !== 'string' || endpoint.host.length === 0 || endpoint.host.length > 255) {
      throw new LinkError('TICKET_MALFORMED', 'endpoint host')
    }
    if (endpoint.kind === 'lan' && !isPrivateOrLoopback(endpoint.host)) {
      throw new LinkError('TICKET_MALFORMED', 'LAN endpoint must be a private/loopback IP literal')
    }
    if (!isPort(endpoint.port)) throw new LinkError('TICKET_MALFORMED', 'endpoint port')
  }
  const tunnel = payload.tunnel
  if (!tunnel || tunnel.provider !== 'easytier' || tunnel.version !== '2.7.0') {
    throw new LinkError('TICKET_MALFORMED', 'tunnel provider/version')
  }
  if (typeof tunnel.vip !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(tunnel.vip)) {
    throw new LinkError('TICKET_MALFORMED', 'tunnel vip')
  }
  if (typeof tunnel.mappedCidr !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}\/32$/.test(tunnel.mappedCidr)) {
    throw new LinkError('TICKET_MALFORMED', 'tunnel mappedCidr')
  }
  if (tunnel.worldPort !== null && !isPort(tunnel.worldPort)) {
    throw new LinkError('TICKET_MALFORMED', 'tunnel worldPort')
  }
  if (!isPort(tunnel.controlPort)) throw new LinkError('TICKET_MALFORMED', 'tunnel controlPort')
  if (tunnel.peerPort !== null && !isPort(tunnel.peerPort)) {
    throw new LinkError('TICKET_MALFORMED', 'tunnel peerPort')
  }
  if (tunnel.lanControlPort !== null && !isPort(tunnel.lanControlPort)) {
    throw new LinkError('TICKET_MALFORMED', 'tunnel lanControlPort')
  }
  if (!payload.mc || typeof payload.mc.version !== 'string' || typeof payload.mc.loader !== 'string') {
    throw new LinkError('TICKET_MALFORMED', 'mc')
  }
  if (!Number.isInteger(payload.max) || payload.max < 2 || payload.max > 8) {
    throw new LinkError('TICKET_MALFORMED', 'max')
  }
  if (typeof payload.jti !== 'string' || payload.jti.length < 8 || payload.jti.length > 32) {
    throw new LinkError('TICKET_MALFORMED', 'jti')
  }
}

// ---------- control-channel auth ----------
export function hmac(token: Buffer, text: string): string {
  return crypto.createHmac('sha256', token).update(text, 'utf8').digest('base64url')
}

export function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

export function helloAuth(
  token: Buffer,
  input: { code: string; nonce: string; memberId: string },
): string {
  return hmac(token, `HELLO|${input.code}|${input.nonce}|${input.memberId}`)
}

export function welcomeAuth(token: Buffer, input: { code: string; nonce: string }): string {
  return hmac(token, `WELCOME|${input.code}|${input.nonce}`)
}
