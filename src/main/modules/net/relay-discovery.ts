import https from 'node:https'
import type { ScopedLogger } from '../../kernel/logger'

/**
 * Relay-node discovery.
 *
 * Measured 2026-11-05: the relays Terracotta (陶瓦联机) ships in
 * `src/easytier/publics.rs` are ordinary EasyTier peers — no account, no
 * signature. Two of them are plain hostnames (`public.easytier.top`,
 * `public2.easytier.cn`) that do NOT resolve on some CN networks (ENOTFOUND
 * here), while the two `etnode.zkitefly.eu.org` endpoints answer with a
 * `tcp://IP:PORT` line that connects fine (38 ms measured).
 *
 * So the working recipe is: ask the HTTP endpoint for the current relay, then
 * hand that peer to the EasyTier sidecar. The endpoint is what makes it survive
 * DNS failure, which is exactly why the old static-peer setup kept failing.
 *
 * Discovery is best-effort: a dead endpoint, an empty body or a timeout never
 * blocks a launch — the room simply falls back to the static peers.
 */

export const DISCOVERY_NODE_URLS = [
  'https://etnode.zkitefly.eu.org/node1',
  'https://etnode.zkitefly.eu.org/node2',
] as const

/**
 * Reserved fallbacks. They are behind DNS names that may not resolve on every
 * network, so they are only appended when discovery found nothing.
 */
export const STATIC_RELAY_PEERS = [
  'tcp://public.easytier.top:11010',
  'tcp://public2.easytier.cn:54321',
] as const

/** Keep the peer list small: every extra peer is a connection attempt. */
export const MAX_RELAY_PEERS = 4

const DEFAULT_TIMEOUT_MS = 2_500
const DEFAULT_TTL_MS = 10 * 60_000

export interface RelayDiscoveryOptions {
  /** Injected for tests; defaults to an https GET with a hard timeout. */
  fetchText?: (url: string, timeoutMs: number) => Promise<string | null>
  timeoutMs?: number
  ttlMs?: number
  log?: ScopedLogger
  now?: () => number
}

/** A relay endpoint answers with one `tcp://host:port` line (or nothing). */
export function parseRelayNodeResponse(body: string): string | null {
  const line = body.trim().split(/\r?\n/)[0]?.trim() ?? ''
  if (!line) return null
  // hostname or IPv4, optional port; reject anything with a path/space.
  if (!/^(?:tcp|udp):\/\/[^\s/:]+(?::\d{1,5})?$/.test(line)) return null
  const port = /:(\d{1,5})$/.exec(line)
  if (port) {
    const value = Number(port[1])
    if (!Number.isInteger(value) || value < 1 || value > 65535) return null
  }
  return line
}

export function mergeRelayPeers(
  ...lists: Array<readonly string[] | undefined>
): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const list of lists) {
    for (const peer of list ?? []) {
      const trimmed = peer.trim()
      if (!trimmed || seen.has(trimmed)) continue
      seen.add(trimmed)
      merged.push(trimmed)
      if (merged.length >= MAX_RELAY_PEERS) return merged
    }
  }
  return merged
}

function httpsGetText(url: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: string | null): void => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const request = https.get(
      url,
      { headers: { 'User-Agent': 'mc-launcher' }, timeout: timeoutMs },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          finish(null)
          return
        }
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          if (body.length < 4_096) body += chunk
        })
        response.on('end', () => finish(body))
        response.on('error', () => finish(null))
      },
    )
    request.on('timeout', () => {
      request.destroy()
      finish(null)
    })
    request.on('error', () => finish(null))
  })
}

let cache: { peers: string[]; expiresAt: number } | null = null

/** Test hook: forget the cached peers. */
export function resetRelayDiscoveryCache(): void {
  cache = null
}

/**
 * Resolve the relay peers to hand to EasyTier: discovered nodes first, then
 * whatever the user configured. Returns `staticPeers` when discovery yields
 * nothing, and never throws.
 */
export async function discoverRelayPeers(
  userPeers: readonly string[],
  options: RelayDiscoveryOptions = {},
): Promise<string[]> {
  const now = options.now ?? Date.now
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const fetchText = options.fetchText ?? httpsGetText

  if (cache && cache.expiresAt > now()) {
    return mergeRelayPeers(cache.peers, userPeers)
  }

  const found: string[] = []
  try {
    const bodies = await Promise.all(
      DISCOVERY_NODE_URLS.map((url) =>
        fetchText(url, timeoutMs).catch(() => null),
      ),
    )
    for (const body of bodies) {
      const peer = body ? parseRelayNodeResponse(body) : null
      if (peer && !found.includes(peer)) found.push(peer)
    }
  } catch (error) {
    options.log?.warn('relay discovery failed', {
      message: error instanceof Error ? error.message : String(error),
    })
  }

  const resolved = found.length > 0 ? found : [...STATIC_RELAY_PEERS]
  if (resolved.length > 0) {
    cache = { peers: resolved, expiresAt: now() + ttlMs }
  }
  if (options.log) {
    options.log.info('relay peers resolved', {
      discovered: found.length,
      source: found.length > 0 ? 'discovery' : 'static',
      peers: resolved.length,
    })
  }
  return mergeRelayPeers(resolved, userPeers)
}
