import crypto from 'node:crypto'
import { normalizeCode } from './ticket'

/**
 * Six-character room codes.
 *
 * The old invite carried the room secret and the host endpoints inside a long
 * `MCL1.<code>.<payload>.<sig>` string, because a self-contained invite has to.
 * Six characters cannot hold 30+ bytes, so the trick is to make the code the
 * only thing that needs sharing and derive the rest:
 *
 *   network name = `mcl-<code>`
 *   network key  = HMAC-SHA256(RoomCodeSalt, code)   (32 bytes)
 *
 * Both sides compute the same tunnel identity from the code alone, meet through
 * the public EasyTier relays, and the host is always reachable at the fixed
 * mapped IP (`192.168.77.1`) on the agreed Minecraft port. No room registry
 * server is involved.
 *
 * Entropy: 6 Crockford characters = 30 bits (~887M combinations). That is
 * guessable in principle, which is why a code is short-lived (the room dies
 * with the launcher session) and why the tunnel stays private-mode.
 */

/** Fixed salt: changing it invalidates every existing short code. */
const ROOM_CODE_SALT = 'mc-launcher/room-code/v1'

export const SHORT_CODE_LENGTH = 6

/** Minecraft "Open to LAN" port we ask the host to use (Terracotta does the same). */
export const SHORT_CODE_WORLD_PORT = 25565

/** `mcl-XXXXXX`, lowercase — the EasyTier network name both sides must share. */
export function shortCodeNetworkName(code: string): string {
  return `mcl-${code.toLowerCase()}`
}

/**
 * Returns the canonical six-character code, or null when the input is not one.
 * Accepts pasted whitespace and the display form `MCL-XXXXXX`.
 */
export function normalizeShortCode(input: string): string | null {
  // Accept the display form `MCL-XXXXXX` as well as a bare code.
  const stripped = String(input ?? '')
    .trim()
    .replace(/^mcl[-_\s]+/i, '')
  const cleaned = normalizeCode(stripped)
  return cleaned.length === SHORT_CODE_LENGTH ? cleaned : null
}

/** Deterministic room key: the same code always yields the same 32 bytes. */
export function deriveRoomSecret(code: string): Buffer {
  const canonical = normalizeShortCode(code) ?? code.toUpperCase()
  return crypto.createHmac('sha256', ROOM_CODE_SALT).update(canonical).digest()
}
