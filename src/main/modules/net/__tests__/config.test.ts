import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_NET_CONFIG,
  configFile,
  loadNetConfig,
  normalizePublicHost,
  normalizeRelayPeer,
  normalizeRelayPeers,
  saveNetConfig,
} from '../config'

const dirs: string[] = []

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-net-config-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('normalizePublicHost', () => {
  it('accepts an IPv4 literal or a DNS name', () => {
    expect(normalizePublicHost('114.247.65.90')).toBe('114.247.65.90')
    expect(normalizePublicHost('  myhome.example.com ')).toBe('myhome.example.com')
    expect(normalizePublicHost('ddns-12345')).toBe('ddns-12345')
  })

  it('refuses anything that is not a bare host', () => {
    for (const value of [
      'tcp://1.2.3.4',
      '1.2.3.4:25565',
      'https://example.com/path',
      'exa mple.com',
      '.example.com',
      'example..com',
      'a'.repeat(254),
      '',
      42,
      null,
    ]) {
      expect(normalizePublicHost(value)).toBeNull()
    }
  })
})

describe('relay peers', () => {
  it('keeps valid tcp/udp peers and drops junk', () => {
    expect(
      normalizeRelayPeers([
        'tcp://relay.example.com:11010',
        'udp://10.0.0.2:11010',
        'relay.example.com',
        'tcp://relay.example.com:0',
        'tcp://relay.example.com:70000',
        'tcp://a b:11010',
        12,
        'tcp://relay.example.com:11010',
      ]),
    ).toEqual(['tcp://relay.example.com:11010', 'udp://10.0.0.2:11010'])
  })

  it('caps the list at four peers', () => {
    const peers = normalizeRelayPeers(
      Array.from({ length: 8 }, (_, index) => `tcp://relay${index}.example.com:11010`),
    )
    expect(peers).toHaveLength(4)
  })

  it('validates a single peer', () => {
    expect(normalizeRelayPeer('tcp://relay.example.com:11010')).toBe('tcp://relay.example.com:11010')
    expect(normalizeRelayPeer('tcp://relay.example.com:65536')).toBeNull()
    expect(normalizeRelayPeer('https://relay.example.com')).toBeNull()
  })
})

describe('net config file', () => {
  it('returns defaults when the file is missing or unreadable', () => {
    const root = tempRoot()
    expect(loadNetConfig(root)).toEqual(DEFAULT_NET_CONFIG)

    const file = configFile(root)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{ not json', 'utf8')
    expect(loadNetConfig(root)).toEqual(DEFAULT_NET_CONFIG)
  })

  it('round-trips the public address, the probe switch and relays', () => {
    const root = tempRoot()
    saveNetConfig(root, {
      ...DEFAULT_NET_CONFIG,
      publicIp: 'myhome.example.com',
      autoProbe: false,
      relayPeers: ['tcp://relay.example.com:11010'],
      maxMembers: 4,
    })
    expect(loadNetConfig(root)).toMatchObject({
      publicIp: 'myhome.example.com',
      autoProbe: false,
      relayPeers: ['tcp://relay.example.com:11010'],
      maxMembers: 4,
    })
  })

  it('sanitizes junk on write instead of persisting it', () => {
    const root = tempRoot()
    saveNetConfig(root, {
      ...DEFAULT_NET_CONFIG,
      publicIp: 'tcp://1.2.3.4:25565',
      relayPeers: ['nonsense'],
    })
    const saved = JSON.parse(fs.readFileSync(configFile(root), 'utf8')) as {
      publicIp: string | null
      relayPeers: string[]
      autoProbe: boolean
    }
    expect(saved.publicIp).toBeNull()
    expect(saved.relayPeers).toEqual([])
    expect(saved.autoProbe).toBe(true)
  })
})
