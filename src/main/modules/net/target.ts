import { promises as dns } from 'node:dns'
import net from 'node:net'
import os from 'node:os'

/**
 * LAN join target policy (t72).
 *
 * A Minecraft LAN world can live on any interface that the machine can reach:
 * ordinary RFC1918 Wi-Fi/Ethernet, a VPN adapter such as Radmin (26.x),
 * Hamachi (25.x), ZeroTier (10/172/192) or Tailscale (100.64/10), or loopback.
 * The old `isPrivateIpv4` check only knew RFC1918/loopback/CGNAT and rejected
 * Radmin's 26.x, so a discovered world could not be joined.
 *
 * This module deliberately uses `os.networkInterfaces()` instead of a hand
 * maintained VPN range table. A target is allowed when it is:
 *  - loopback (`localhost`, 127/8, ::1),
 *  - RFC1918 or IANA shared address space (100.64/10) — non-public by design,
 *  - on the same IPv4 subnet as one of this host's non-internal interfaces,
 *  - or a hostname whose every resolved address passes the above checks.
 *
 * SSRF guardrails stay strict: wildcard, multicast, link-local (169.254/16),
 * public IPv4, non-loopback IPv6, unresolved/mixed hostnames are rejected.
 * A hostname is resolved once and the returned IP is what the caller launches,
 * which also avoids a DNS-rebinding TOCTOU.
 */

export type NetworkInterfaces = ReturnType<typeof os.networkInterfaces>

export interface LanTargetOptions {
  interfaces?: NetworkInterfaces
  /** Injectable for tests; defaults to dns.promises.lookup(host, {all:true}). */
  lookup?: (host: string) => Promise<Array<{ address: string }>>
  /** Discovery provenance; kept for diagnostics/backward-compatible call sites. */
  source?: 'multicast' | 'local-log' | null
}

function ipv4ToInt(address: string): number | null {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

function maskToInt(mask: string): number | null {
  const value = ipv4ToInt(mask)
  if (value === null) return null
  // A valid IPv4 netmask is a contiguous prefix followed by zeroes.
  const inverted = (~value) >>> 0
  if ((inverted & (inverted + 1)) !== 0) return null
  return value
}

export function isLoopbackTarget(host: string): boolean {
  const value = host.trim().toLowerCase()
  return value === 'localhost' || value === '::1' || value === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(value)
}

export function isWildcardTarget(host: string): boolean {
  const value = host.trim().toLowerCase()
  return value === '0.0.0.0' || value === '::' || value === '[::]' || value === '*'
}

export function isMulticastTarget(host: string): boolean {
  const value = host.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (net.isIP(value) === 4) {
    const first = Number(value.split('.')[0])
    return first >= 224 && first <= 239
  }
  return net.isIP(value) === 6 && value.startsWith('ff')
}

/** RFC1918 plus the IANA shared address space used by Tailscale/CGNAT. */
export function isNonPublicIpv4(address: string): boolean {
  const value = ipv4ToInt(address)
  if (value === null) return false
  return (
    (value >= ipv4ToInt('10.0.0.0')! && value <= ipv4ToInt('10.255.255.255')!) ||
    (value >= ipv4ToInt('172.16.0.0')! && value <= ipv4ToInt('172.31.255.255')!) ||
    (value >= ipv4ToInt('192.168.0.0')! && value <= ipv4ToInt('192.168.255.255')!) ||
    (value >= ipv4ToInt('100.64.0.0')! && value <= ipv4ToInt('100.127.255.255')!)
  )
}

function localSubnets(interfaces: NetworkInterfaces): Array<{ address: number; mask: number }> {
  const subnets: Array<{ address: number; mask: number }> = []
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const family = String(entry.family)
      if (family !== 'IPv4' && family !== '4') continue
      if (entry.internal) continue
      const address = ipv4ToInt(entry.address)
      const mask = maskToInt(entry.netmask)
      if (address !== null && mask !== null) subnets.push({ address, mask })
    }
  }
  return subnets
}

function isOnLocalSubnet(address: string, interfaces: NetworkInterfaces): boolean {
  const value = ipv4ToInt(address)
  if (value === null) return false
  return localSubnets(interfaces).some(
    (subnet) => ((value & subnet.mask) >>> 0) === ((subnet.address & subnet.mask) >>> 0),
  )
}

export function isAllowedIpv4(address: string, interfaces: NetworkInterfaces): boolean {
  if (net.isIP(address) !== 4) return false
  if (isWildcardTarget(address) || isMulticastTarget(address)) return false
  if (isLoopbackTarget(address)) return true
  if (isNonPublicIpv4(address)) return true
  if (isOnLocalSubnet(address, interfaces)) return true
  return false
}

function defaultInterfaces(): NetworkInterfaces {
  try {
    return os.networkInterfaces()
  } catch {
    return {}
  }
}

async function defaultLookup(host: string): Promise<Array<{ address: string }>> {
  const entries = await dns.lookup(host, { all: true, verbatim: true })
  return entries.map((entry) => ({ address: entry.address }))
}

/**
 * Returns the IP the caller should actually launch, or null when the target
 * violates the policy. Hostnames are resolved here; callers must use the
 * returned IP (not the original hostname) to avoid DNS rebinding.
 */
export async function normalizeLanTarget(
  host: string,
  options: LanTargetOptions = {},
): Promise<string | null> {
  const value = host.trim()
  if (!value || isWildcardTarget(value) || isMulticastTarget(value)) return null
  if (isLoopbackTarget(value)) {
    const lower = value.toLowerCase()
    if (lower === 'localhost') return '127.0.0.1'
    const bare = value.replace(/^\[|\]$/g, '')
    if (bare === '::1' || net.isIP(bare) === 4) return bare
    return null
  }

  const interfaces = options.interfaces ?? defaultInterfaces()
  const family = net.isIP(value)
  if (family === 4) return isAllowedIpv4(value, interfaces) ? value : null
  if (family === 6) return null

  // Hostname: every resolved address must pass; mixed public/private is
  // rejected so a round-robin DNS record cannot smuggle an SSRF target.
  let resolved: Array<{ address: string }>
  try {
    resolved = await (options.lookup ?? defaultLookup)(value)
  } catch {
    return null
  }
  if (resolved.length === 0) return null
  const allowed: string[] = []
  for (const entry of resolved) {
    const address = entry.address.replace(/^\[|\]$/g, '')
    const addressFamily = net.isIP(address)
    if (addressFamily === 4 && isAllowedIpv4(address, interfaces)) {
      allowed.push(address)
    } else if (addressFamily === 6 && address === '::1') {
      allowed.push(address)
    } else {
      return null
    }
  }
  return allowed[0] ?? null
}

/** Synchronous IP-only check for call sites that cannot await (diagnostics/UI). */
export function isAllowedLanTargetSync(host: string, options: LanTargetOptions = {}): boolean {
  const value = host.trim()
  if (!value || isWildcardTarget(value) || isMulticastTarget(value)) return false
  if (isLoopbackTarget(value)) return true
  if (net.isIP(value) === 4) return isAllowedIpv4(value, options.interfaces ?? defaultInterfaces())
  return false
}
