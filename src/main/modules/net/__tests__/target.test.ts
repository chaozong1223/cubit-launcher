import { describe, expect, it } from 'vitest'
import type { NetworkInterfaces } from '../target'
import { normalizeLanTarget } from '../target'

const interfaces = {
  Ethernet: [
    {
      address: '192.168.1.5',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:01',
      internal: false,
      cidr: '192.168.1.5/24',
    },
  ],
  Radmin: [
    {
      address: '26.125.118.58',
      netmask: '255.255.255.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:02',
      internal: false,
      cidr: '26.125.118.58/24',
    },
  ],
  Tailscale: [
    {
      address: '100.101.102.103',
      netmask: '255.255.255.255',
      family: 'IPv4',
      mac: '00:00:00:00:00:03',
      internal: false,
      cidr: '100.101.102.103/32',
    },
  ],
  Hamachi: [
    {
      address: '25.1.2.3',
      netmask: '255.0.0.0',
      family: 'IPv4',
      mac: '00:00:00:00:00:04',
      internal: false,
      cidr: '25.1.2.3/8',
    },
  ],
} as unknown as NetworkInterfaces

describe('LAN target policy (t72)', () => {
  it('allows a Radmin VPN peer in the same local /24', async () => {
    await expect(normalizeLanTarget('26.125.118.57', { interfaces })).resolves.toBe('26.125.118.57')
  })

  it('allows 100.x Tailscale/CGNAT and RFC1918 peers', async () => {
    await expect(normalizeLanTarget('100.101.102.104', { interfaces })).resolves.toBe('100.101.102.104')
    await expect(normalizeLanTarget('10.1.2.3', { interfaces })).resolves.toBe('10.1.2.3')
    await expect(normalizeLanTarget('172.16.5.4', { interfaces })).resolves.toBe('172.16.5.4')
    await expect(normalizeLanTarget('192.168.1.9', { interfaces })).resolves.toBe('192.168.1.9')
  })

  it('allows loopback/localhost and normalizes it to 127.0.0.1', async () => {
    await expect(normalizeLanTarget('localhost', { interfaces })).resolves.toBe('127.0.0.1')
    await expect(normalizeLanTarget('127.0.0.1', { interfaces })).resolves.toBe('127.0.0.1')
    await expect(normalizeLanTarget('::1', { interfaces })).resolves.toBe('::1')
  })

  it('rejects public, wildcard, multicast and link-local targets', async () => {
    await expect(normalizeLanTarget('8.8.8.8', { interfaces })).resolves.toBeNull()
    await expect(normalizeLanTarget('1.1.1.1', { interfaces })).resolves.toBeNull()
    await expect(normalizeLanTarget('0.0.0.0', { interfaces })).resolves.toBeNull()
    await expect(normalizeLanTarget('*', { interfaces })).resolves.toBeNull()
    await expect(normalizeLanTarget('224.0.2.60', { interfaces })).resolves.toBeNull()
    await expect(normalizeLanTarget('239.1.2.3', { interfaces })).resolves.toBeNull()
    await expect(normalizeLanTarget('169.254.169.254', { interfaces })).resolves.toBeNull()
  })

  it('rejects hostnames that resolve to public addresses or mixed results', async () => {
    await expect(
      normalizeLanTarget('public.example', {
        interfaces,
        lookup: async () => [{ address: '8.8.8.8' }],
      }),
    ).resolves.toBeNull()
    await expect(
      normalizeLanTarget('mixed.example', {
        interfaces,
        lookup: async () => [{ address: '192.168.1.9' }, { address: '8.8.8.8' }],
      }),
    ).resolves.toBeNull()
    await expect(
      normalizeLanTarget('lan.example', {
        interfaces,
        lookup: async () => [{ address: '192.168.1.9' }],
      }),
    ).resolves.toBe('192.168.1.9')
  })
})
