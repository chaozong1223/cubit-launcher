// Clean-room room/invite protocol PoC for the launcher's `link` module.
// No third-party dependencies: Node >= 20 (node:crypto Ed25519 + HMAC).
//
// Design goals demonstrated here:
//   * a short human code (6 chars, Crockford Base32) for LAN discovery / display
//   * a full capability ticket that is self-verifying (Ed25519) and carries the
//     EasyTier network secret, endpoints, world port and expiry
//   * strict validation (version, code derivation, signature, expiry, size)
//   * HMAC-authenticated room control channel with nonce + per-message seq
//   * stable error codes shared with docs/04-multiplayer-design.md
import crypto from 'node:crypto'

export const TICKET_VERSION = 1
export const TICKET_PREFIX = 'MCL1'
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
export const MAX_TICKET_BYTES = 2048
export const MAX_CLOCK_SKEW_SECONDS = 300

export const ErrorCodes = Object.freeze({
  INVITE_INVALID: 'INVITE_INVALID',
  INVITE_EXPIRED: 'INVITE_EXPIRED',
  INVITE_INCOMPLETE: 'INVITE_INCOMPLETE',
  TICKET_SIGNATURE_INVALID: 'TICKET_SIGNATURE_INVALID',
  TICKET_MALFORMED: 'TICKET_MALFORMED',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  ROOM_CLOSED: 'ROOM_CLOSED',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
  AUTH_FAILED: 'AUTH_FAILED',
  HEARTBEAT_TIMEOUT: 'HEARTBEAT_TIMEOUT',
  NETWORK_UNREACHABLE: 'NETWORK_UNREACHABLE',
  HOST_LEFT: 'HOST_LEFT',
  TUNNEL_FAILED: 'TUNNEL_FAILED'
})

export class LinkError extends Error {
  constructor (code, message = '', detail = undefined) {
    super(message || code)
    this.code = code
    this.detail = detail
  }
}

// ---------- Crockford Base32 ----------
export function crockfordEncode (buffer) {
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

export function crockfordDecode (text) {
  const norm = String(text).toUpperCase().replace(/[IL]/g, '1').replace(/O/g, '0').replace(/-/g, '')
  let bits = 0
  let value = 0
  const out = []
  for (const ch of norm) {
    const idx = CROCKFORD.indexOf(ch)
    if (idx < 0) throw new LinkError(ErrorCodes.TICKET_MALFORMED, `bad base32 char ${ch}`)
    value = (value << 5) | idx
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export function normalizeCode (code) {
  return String(code ?? '').toUpperCase().replace(/[^0-9A-HJKMNP-TV-Z]/g, '')
}

export function deriveCode (roomId) {
  return crockfordEncode(crypto.createHash('sha256').update(roomId).digest()).slice(0, 6)
}

// ---------- canonical JSON ----------
export function canonicalJson (value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

// ---------- room identity + ticket ----------
export function createHostIdentity ({ hostName = 'host', mcVersion = '1.20.1', loader = 'vanilla', maxMembers = 8 } = {}) {
  const roomId = crypto.randomBytes(16)
  const code = deriveCode(roomId)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const pubJwk = publicKey.export({ format: 'jwk' })
  const netSecret = crypto.randomBytes(32)
  const token = netSecret // one 256-bit capability secret: EasyTier network secret == room auth token
  return {
    roomId,
    code,
    publicKey,
    privateKey,
    token,
    identity: {
      hostName,
      roomId: roomId.toString('base64url'),
      code,
      hostPub: pubJwk.x,
      network: { name: `mcl-${code.toLowerCase()}`, secret: netSecret.toString('base64url') },
      mc: { version: mcVersion, loader },
      maxMembers
    }
  }
}

export function issueTicket (identity, { endpoints, tunnel, now = Math.floor(Date.now() / 1000), ttlSeconds = 600 } = {}) {
  const payload = {
    v: TICKET_VERSION,
    code: identity.code,
    roomId: identity.identity.roomId,
    host: { name: identity.identity.hostName, pub: identity.identity.hostPub },
    net: identity.identity.network,
    endpoints: endpoints ?? [{ kind: 'lan', host: '127.0.0.1', port: 25999 }],
    tunnel: tunnel ?? { provider: 'easytier', version: '2.7.0', vip: '10.144.144.1', mappedCidr: '192.168.77.1/32', worldPort: 25565, controlPort: 25998 },
    mc: identity.identity.mc,
    max: identity.identity.maxMembers,
    iat: now,
    exp: now + ttlSeconds,
    jti: crypto.randomBytes(8).toString('base64url')
  }
  const body = Buffer.from(canonicalJson(payload), 'utf8')
  if (body.length > MAX_TICKET_BYTES) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'ticket too large')
  const signed = `${TICKET_PREFIX}.${payload.code}.${body.toString('base64url')}`
  const sig = crypto.sign(null, Buffer.from(signed, 'utf8'), identity.privateKey).toString('base64url')
  return { ticket: `${signed}.${sig}`, payload, body }
}

export function parseTicket (ticket, { now = Math.floor(Date.now() / 1000), expectedCode = undefined } = {}) {
  if (typeof ticket !== 'string' || ticket.length > 4096) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'ticket shape')
  const parts = ticket.trim().split('.')
  if (parts.length !== 4 || parts[0] !== TICKET_PREFIX) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'ticket prefix/parts')
  const [, code, bodyB64, sigB64] = parts
  if (!/^[0-9A-HJKMNP-TV-Z]{6}$/.test(code)) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'bad short code')
  if (!/^[A-Za-z0-9_-]+$/.test(bodyB64) || !/^[A-Za-z0-9_-]+$/.test(sigB64)) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'bad base64url')
  const body = Buffer.from(bodyB64, 'base64url')
  if (body.length === 0 || body.length > MAX_TICKET_BYTES) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'ticket body size')
  let payload
  try { payload = JSON.parse(body.toString('utf8')) } catch (err) { throw new LinkError(ErrorCodes.TICKET_MALFORMED, `json: ${err.message}`) }
  if (payload.v !== TICKET_VERSION) throw new LinkError(ErrorCodes.INVITE_INVALID, `unsupported ticket version ${payload.v}`)
  if (payload.code !== code) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'code mismatch')
  if (expectedCode && normalizeCode(expectedCode) !== code) throw new LinkError(ErrorCodes.INVITE_INVALID, 'code mismatch')
  let roomId
  try { roomId = Buffer.from(payload.roomId, 'base64url') } catch { throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'roomId') }
  if (roomId.length !== 16) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'roomId length')
  if (deriveCode(roomId) !== code) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'code is not derived from roomId')
  const signed = `${TICKET_PREFIX}.${code}.${bodyB64}`
  let publicKey
  try { publicKey = crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: payload.host.pub }, format: 'jwk' }) } catch { throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'host pub') }
  const ok = crypto.verify(null, Buffer.from(signed, 'utf8'), publicKey, Buffer.from(sigB64, 'base64url'))
  if (!ok) throw new LinkError(ErrorCodes.TICKET_SIGNATURE_INVALID, 'signature verification failed')
  if (!Number.isInteger(payload.exp) || payload.exp < now - MAX_CLOCK_SKEW_SECONDS) throw new LinkError(ErrorCodes.INVITE_EXPIRED, 'ticket expired')
  if (payload.iat > now + MAX_CLOCK_SKEW_SECONDS) throw new LinkError(ErrorCodes.INVITE_INVALID, 'ticket issued in the future')
  if (!payload.net || !/^[A-Za-z0-9_-]{43}$/.test(payload.net.secret ?? '')) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'net secret')
  if (!Array.isArray(payload.endpoints) || payload.endpoints.length === 0) throw new LinkError(ErrorCodes.TICKET_MALFORMED, 'endpoints')
  return { payload, code, roomId, publicKey, ticket }
}

// ---------- control channel auth ----------
export function hmac (token, text) {
  return crypto.createHmac('sha256', token).update(text, 'utf8').digest('base64url')
}

export function safeEqual (a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

export function helloAuth (token, { code, nonce, memberId }) {
  return hmac(token, `HELLO|${code}|${nonce}|${memberId}`)
}

export function welcomeAuth (token, { code, nonce }) {
  return hmac(token, `WELCOME|${code}|${nonce}`)
}

export function shortInvite (code) {
  return `MCL-${normalizeCode(code)}`
}
