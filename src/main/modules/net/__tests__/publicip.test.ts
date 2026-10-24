import { describe, expect, it, vi } from 'vitest'
import {
  IP_ECHO_URLS,
  parseCliNodeOutput,
  parseIpEcho,
  parseUdpStunType,
  probePublicIpv4,
  testRelayTcp,
  type CliResult,
} from '../publicip'

const silentLog = { info: () => undefined, warn: () => undefined }

function cliResult(stdout: string, overrides: Partial<CliResult> = {}): CliResult {
  return { stdout, stderr: '', code: 0, error: null, ...overrides }
}

describe('parseCliNodeOutput', () => {
  it('reads every public address EasyTier printed', () => {
    const table = [
      '============================================================',
      ' ipv4: 10.144.144.1/24  | Public IPv4               | 114.247.65.90',
      ' ipv4: 192.168.77.1/32  | Public IPv4               | 219.143.23.90',
      '                        | Public IPv6               | 240e:3b3:2f00::1',
    ].join('\n')
    expect(parseCliNodeOutput(table)).toEqual(['114.247.65.90', '219.143.23.90'])
  })

  it('accepts the colon form and de-duplicates', () => {
    expect(parseCliNodeOutput('Public IPv4: 1.2.3.4\nPublic IPv4 | 1.2.3.4')).toEqual(['1.2.3.4'])
  })

  it('returns nothing for an empty table (the packaged-build failure mode)', () => {
    expect(parseCliNodeOutput('')).toEqual([])
    expect(parseCliNodeOutput('no node info\n')).toEqual([])
    expect(parseCliNodeOutput('Public IPv4 | not-an-ip')).toEqual([])
  })
})

describe('parseUdpStunType', () => {
  it('reads the STUN state that explains a missing Public IPv4 row', () => {
    // Real `easytier-cli node` output from a host whose UDP mapping never
    // resolved: no Public IPv4 row at all, only this.
    const table = [
      '| Virtual IP     | 10.144.144.1/24                      |',
      '| UDP Stun Type  | Unknown                              |',
      '| Interface IPv4 | 10.91.60.10                          |',
      '| Listener 1     | tcp://10.91.60.10:51459              |',
    ].join('\n')
    expect(parseUdpStunType(table)).toBe('Unknown')
    expect(parseCliNodeOutput(table)).toEqual([])
    expect(parseUdpStunType('Public IPv4 | 1.2.3.4')).toBeNull()
  })
})

describe('parseIpEcho', () => {
  it('accepts a bare address and an ip= payload', () => {
    expect(parseIpEcho(' 114.247.65.90\n')).toBe('114.247.65.90')
    expect(parseIpEcho('ip=219.143.23.90')).toBe('219.143.23.90')
  })

  it('reads the sentence forms of 3322 / oray / ipip', () => {
    // ip.3322.net answers bare; the other two wrap the address.
    expect(parseIpEcho('Current IP Address: 219.143.23.90\n')).toBe('219.143.23.90')
    expect(parseIpEcho('当前 IP：219.143.23.90  来自于：中国 北京 北京')).toBe('219.143.23.90')
  })

  it('rejects HTML, JSON, out-of-range quads and multi-address pages', () => {
    expect(parseIpEcho('<html>blocked</html>')).toBeNull()
    expect(parseIpEcho('{"ip":"1.2.3.4"}')).toBeNull()
    expect(parseIpEcho('999.1.1.1')).toBeNull()
    expect(parseIpEcho('1.2.3.4 and 5.6.7.8')).toBeNull()
    expect(parseIpEcho('x'.repeat(500))).toBeNull()
  })
})

describe('probePublicIpv4', () => {
  it('prefers the EasyTier CLI answer', async () => {
    const fetchText = vi.fn(async () => '1.1.1.1')
    const result = await probePublicIpv4({
      log: silentLog,
      cliPath: 'C:/easytier/easytier-cli.exe',
      rpcPort: 1234,
      runCli: async () => cliResult('Public IPv4 | 114.247.65.90'),
      fetchText,
    })
    expect(result).toMatchObject({ ip: '114.247.65.90', source: 'cli' })
    expect(fetchText).not.toHaveBeenCalled()
  })

  it('falls back to the HTTPS echo when the CLI prints an empty table', async () => {
    const result = await probePublicIpv4({
      log: silentLog,
      cliPath: 'C:/easytier/easytier-cli.exe',
      rpcPort: 1234,
      runCli: async () => cliResult(''),
      fetchText: async (url) => {
        if (url === IP_ECHO_URLS[0]) throw new Error('timeout')
        return '219.143.23.90'
      },
    })
    expect(result).toMatchObject({ ip: '219.143.23.90', source: 'echo' })
  })

  it('reports every failed source instead of failing silently', async () => {
    const result = await probePublicIpv4({
      log: silentLog,
      cliPath: 'C:/easytier/easytier-cli.exe',
      rpcPort: 1234,
      runCli: async () => cliResult('', { code: 1, error: 'Command failed' }),
      fetchText: async () => {
        throw new Error('offline')
      },
    })
    expect(result.ip).toBeNull()
    expect(result.source).toBe('none')
    expect(result.detail).toContain('easytier-cli')
    expect(result.detail).toContain(IP_ECHO_URLS[0])
    expect(result.detail).toContain('offline')
  })

  it('flags a CGNAT address instead of claiming it is reachable', async () => {
    const result = await probePublicIpv4({
      log: silentLog,
      fetchText: async () => '100.64.12.9\n',
    })
    expect(result.ip).toBe('100.64.12.9')
    expect(result.detail).toContain('CGNAT')
  })
})

describe('testRelayTcp', () => {
  it('measures a successful handshake', async () => {
    const result = await testRelayTcp('tcp://relay.example.com:11010', {
      connect: async () => undefined,
    })
    expect(result.ok).toBe(true)
    expect(result.rttMs).not.toBeNull()
  })

  it('reports the connect error', async () => {
    const result = await testRelayTcp('tcp://relay.example.com:11010', {
      connect: async () => {
        throw new Error('ECONNREFUSED')
      },
    })
    expect(result).toMatchObject({ ok: false, rttMs: null })
    expect(result.detail).toContain('ECONNREFUSED')
  })

  it('rejects a peer without a scheme or port', async () => {
    expect((await testRelayTcp('relay.example.com')).ok).toBe(false)
    expect((await testRelayTcp('tcp://relay.example.com')).ok).toBe(false)
  })

  it('does not pretend a udp relay is unreachable', async () => {
    const result = await testRelayTcp('udp://relay.example.com:11010')
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('TCP')
  })
})
