import fs from 'node:fs'
import path from 'node:path'

/** Optional per-machine link config (`dataRoot/modules/net/config.json`). */
export interface NetModuleConfig {
  relayPeers: string[]
  maxMembers: number
  lanIp: string | null
  aliasIp: string | null
  describe: string
  /**
   * Address the host publishes as the invite's WAN endpoint. Either an IPv4
   * literal or a DNS name (DDNS); null means "whatever the probe finds".
   * A probe can be wrong or empty — a CGNAT address, no STUN answer, a failed
   * sidecar CLI — so the hand-typed value always wins (docs/12 §4).
   */
  publicIp: string | null
  /** Whether the launcher may ask EasyTier / an IP echo service at all. */
  autoProbe: boolean
}

export const DEFAULT_NET_CONFIG: NetModuleConfig = {
  relayPeers: [],
  maxMembers: 8,
  lanIp: null,
  aliasIp: null,
  describe: 'mc-launcher link module',
  publicIp: null,
  autoProbe: true,
}

export function configFile(dataRoot: string): string {
  return path.join(dataRoot, 'modules', 'net', 'config.json')
}

export function loadNetConfig(dataRoot: string): NetModuleConfig {
  const file = configFile(dataRoot)
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_NET_CONFIG }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<NetModuleConfig>
    return sanitize({ ...DEFAULT_NET_CONFIG, ...raw })
  } catch {
    return { ...DEFAULT_NET_CONFIG }
  }
}

export function saveNetConfig(dataRoot: string, config: NetModuleConfig): void {
  const file = configFile(dataRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify(sanitize(config), null, 2), 'utf8')
  fs.renameSync(temp, file)
}

/**
 * Loopback / wildcard addresses are never a usable WAN endpoint: EasyTier
 * refuses a loopback peer (WSAEADDRNOTAVAIL 10049), so saving one here would
 * produce an invite that can never be joined. Reject it at the door instead of
 * letting the member fail with a confusing error.
 */
function isLoopbackOrWildcard(host: string): boolean {
  const value = host.toLowerCase()
  return (
    value === 'localhost' ||
    value === '0.0.0.0' ||
    value === '::' ||
    value === '::1' ||
    value === '[::1]' ||
    /^127\./.test(value)
  )
}

/**
 * An address the WAN endpoint may publish: an IPv4 literal or a DNS name.
 * Anything with a scheme, port, path or whitespace is refused here — the string
 * ends up inside a signed invite, so it must stay a bare host.
 */
export function normalizePublicHost(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const host = value.trim()
  if (host.length === 0 || host.length > 253) return null
  if (!/^[A-Za-z0-9.-]+$/.test(host)) return null
  if (host.startsWith('.') || host.endsWith('.') || host.includes('..')) return null
  if (isLoopbackOrWildcard(host)) return null
  // A bare IPv4 must actually be one; a name needs at least one label.
  const labels = host.split('.')
  if (labels.some((label) => label.length === 0 || label.length > 63)) return null
  return host
}

/** `tcp://host:port` or `udp://host:port`, which is what EasyTier accepts. */
export function normalizeRelayPeer(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const peer = value.trim()
  if (!/^(?:tcp|udp):\/\/[^\s/:]+:\d{1,5}$/.test(peer)) return null
  const port = Number(peer.slice(peer.lastIndexOf(':') + 1))
  return port >= 1 && port <= 65_535 ? peer : null
}

export function normalizeRelayPeers(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const peers: string[] = []
  for (const entry of value) {
    const peer = normalizeRelayPeer(entry)
    if (peer && !peers.includes(peer)) peers.push(peer)
    if (peers.length === 4) break
  }
  return peers
}

function sanitize(config: NetModuleConfig): NetModuleConfig {
  const maxMembers =
    Number.isInteger(config.maxMembers) && config.maxMembers >= 2 && config.maxMembers <= 8
      ? config.maxMembers
      : 8
  return {
    relayPeers: normalizeRelayPeers(config.relayPeers),
    maxMembers,
    lanIp: typeof config.lanIp === 'string' && config.lanIp.length > 0 ? config.lanIp : null,
    aliasIp: typeof config.aliasIp === 'string' && config.aliasIp.length > 0 ? config.aliasIp : null,
    describe: typeof config.describe === 'string' ? config.describe.slice(0, 120) : 'mc-launcher link module',
    publicIp: normalizePublicHost(config.publicIp),
    autoProbe: config.autoProbe !== false,
  }
}
