import { HOST_VIP, MAPPED_CIDR, MEMBER_VIP, EASYTIER_VERSION } from './constants'
import { isAllowedLanTargetSync } from './target'

/**
 * Pure EasyTier argument builders. Hard constraints from the t4 PoC:
 *  - always explicit `-l` (never the implicit `0.0.0.0:11010`)
 *  - `--no-tun` for the default no-admin mode
 *  - host maps a dedicated loopback alias `/32`; never `127.0.0.1/32`
 *  - member uses `--no-listener`
 *  - never use `127.0.0.1` as an EasyTier peer (WSAEADDRNOTAVAIL 10049)
 *  - never rely on `--tcp-whitelist` as a security boundary
 */

export interface HostArgsInput {
  networkName: string
  networkSecret: string
  lanIp: string
  peerPort: number
  rpcPort: number
  aliasIp: string
  relayPeers?: string[]
  vip?: string
  disableIpv6?: boolean
}

export interface MemberArgsInput {
  networkName: string
  networkSecret: string
  peer: string
  rpcPort: number
  localWorldPort?: number | null
  localControlPort: number
  worldPort?: number | null
  controlPort: number
  relayPeers?: string[]
  vip?: string
  disableIpv6?: boolean
}

export function isLoopbackHost(host: string): boolean {
  const value = host.trim().toLowerCase()
  return value === 'localhost' || value === '::1' || value === '[::1]' || /^127\./.test(value)
}

export function isWildcardHost(host: string): boolean {
  const value = host.trim().toLowerCase()
  return value === '0.0.0.0' || value === '::' || value === '[::]' || value === '*'
}

export function isPrivateIpv4(host: string): boolean {
  const parts = host.split('.').map((part) => Number(part))
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false
  }
  const [a, b] = parts
  return (
    a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127
  )
}

export function assertDedicatedAlias(aliasIp: string): void {
  const parts = aliasIp.split('.').map((part) => Number(part))
  const valid =
    parts.length === 4 &&
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    parts[0] === 127 &&
    parts[3] >= 2 &&
    parts[3] <= 254
  if (!valid) {
    throw new Error(
      `link: alias ${aliasIp} is not a dedicated loopback alias (expected 127.0.0.2-127.0.0.254)`,
    )
  }
  if (aliasIp === '127.0.0.1') {
    throw new Error('link: mapping 127.0.0.1/32 is forbidden; it exposes every loopback port')
  }
}

export function assertPeerUsable(peer: string): void {
  const match = /^(?:tcp|udp):\/\/([^/:]+|\])?:?(\d+)$/.exec(peer)
  const host = match?.[1] ?? peer
  if (isLoopbackHost(host)) {
    throw new Error(
      `link: ${peer} uses loopback as an EasyTier peer, which fails with WSAEADDRNOTAVAIL (10049)`,
    )
  }
}

export function assertListenerScoped(host: string): void {
  if (isWildcardHost(host)) {
    throw new Error(`link: refusing wildcard listener ${host}; bind a private/loopback address`)
  }
  // t72: VPN adapters (Radmin 26.x, Hamachi 25.x, Tailscale 100.x, ...) are
  // valid local listeners, not only RFC1918 addresses.
  if (!isPrivateIpv4(host) && !isLoopbackHost(host) && !isAllowedLanTargetSync(host)) {
    throw new Error(`link: listener ${host} is not a local/private address`)
  }
}

export function buildHostArgs(input: HostArgsInput): string[] {
  assertDedicatedAlias(input.aliasIp)
  assertListenerScoped(input.lanIp)
  if (!Number.isInteger(input.peerPort) || input.peerPort < 1 || input.peerPort > 65535) {
    throw new Error(`link: invalid peer port ${input.peerPort}`)
  }
  const args = [
    '-i',
    input.vip ?? HOST_VIP,
    '--network-name',
    input.networkName,
    '--no-tun',
    '-n',
    `${input.aliasIp}/32->${MAPPED_CIDR}`,
    '-l',
    `tcp://${input.lanIp}:${input.peerPort}`,
    '-r',
    `127.0.0.1:${input.rpcPort}`,
    '--rpc-portal-whitelist',
    '127.0.0.1/32',
  ]
  if (input.disableIpv6 !== false) args.push('--disable-ipv6')
  for (const peer of input.relayPeers ?? []) {
    assertPeerUsable(peer)
    args.push('-p', peer)
  }
  return args
}

export function buildMemberArgs(input: MemberArgsInput): string[] {
  assertPeerUsable(input.peer)
  const args = [
    '-i',
    input.vip ?? MEMBER_VIP,
    '--network-name',
    input.networkName,
    '--no-tun',
    '--no-listener',
    '-p',
    input.peer,
    '--port-forward',
    `tcp://127.0.0.1:${input.localControlPort}/${MAPPED_CIDR.split('/')[0]}:${input.controlPort}`,
    '-r',
    `127.0.0.1:${input.rpcPort}`,
    '--rpc-portal-whitelist',
    '127.0.0.1/32',
  ]
  if (input.localWorldPort && input.worldPort) {
    args.push(
      '--port-forward',
      `tcp://127.0.0.1:${input.localWorldPort}/${MAPPED_CIDR.split('/')[0]}:${input.worldPort}`,
    )
  }
  if (input.disableIpv6 !== false) args.push('--disable-ipv6')
  for (const peer of input.relayPeers ?? []) {
    assertPeerUsable(peer)
    args.push('-p', peer)
  }
  return args
}

export function buildPortForwardAddArgs(input: {
  rpcPort: number
  localPort: number
  destinationPort: number
}): string[] {
  return [
    '-p',
    `127.0.0.1:${input.rpcPort}`,
    'port-forward',
    'add',
    'tcp',
    `127.0.0.1:${input.localPort}`,
    `${MAPPED_CIDR.split('/')[0]}:${input.destinationPort}`,
  ]
}

export function buildVersionArgs(): string[] {
  return ['--version']
}

/** For tests/diagnostics; keeps the pinned version next to the arg builders. */
export const PINNED_EASYTIER_VERSION = EASYTIER_VERSION
