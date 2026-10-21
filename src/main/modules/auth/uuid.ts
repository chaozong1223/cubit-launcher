import crypto from 'node:crypto'

/**
 * Standard offline UUID: MD5("OfflinePlayer:" + name), formatted as a v3 UUID.
 * TestUser → 097d3392-865a-3f3c-8b4a-da1c3473466c (docs/01 A2.1).
 */
export function offlineUuid(name: string): string {
  const bytes = crypto
    .createHash('md5')
    .update(`OfflinePlayer:${name}`, 'utf8')
    .digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x30 // version 3
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 variant
  const hex = bytes.toString('hex')
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-')
}

export function validOfflineName(name: string): boolean {
  return /^[A-Za-z0-9_]{3,16}$/.test(name)
}
