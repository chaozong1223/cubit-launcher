import { describe, expect, it } from 'vitest'
import {
  buildHostArgs,
  buildMemberArgs,
  buildPortForwardAddArgs,
  assertDedicatedAlias,
  assertPeerUsable,
  assertListenerScoped,
} from '../args'

const base = {
  networkName: 'mcl-abc123',
  networkSecret: 'a'.repeat(64),
  lanIp: '10.1.2.3',
  aliasIp: '127.0.0.55',
  peerPort: 11010,
  rpcPort: 15888,
}

describe('EasyTier argument builder', () => {
  it('host: no-TUN, explicit listener, dedicated alias /32 and loopback RPC', () => {
    const args = buildHostArgs(base)
    expect(args).toContain('--no-tun')
    expect(args).toContain('-l')
    expect(args[args.indexOf('-l') + 1]).toBe('tcp://10.1.2.3:11010')
    expect(args[args.indexOf('-n') + 1]).toBe('127.0.0.55/32->192.168.77.1/32')
    expect(args[args.indexOf('-r') + 1]).toBe('127.0.0.1:15888')
    expect(args).toContain('--rpc-portal-whitelist')
    expect(args).not.toContain('--tcp-whitelist')
    expect(args.join(' ')).not.toContain('0.0.0.0')
    expect(args.join(' ')).not.toContain('--network-secret')
    expect(args.join(' ')).not.toContain(base.networkSecret)
  })

  it('host: refuses the whole 127.0.0.1/32 alias and wildcard listeners', () => {
    expect(() => assertDedicatedAlias('127.0.0.1')).toThrow()
    expect(() => assertDedicatedAlias('192.168.1.5')).toThrow()
    expect(() => assertListenerScoped('0.0.0.0')).toThrow()
    expect(() => buildHostArgs({ ...base, aliasIp: '127.0.0.1' })).toThrow()
    expect(() => buildHostArgs({ ...base, lanIp: '0.0.0.0' })).toThrow()
  })

  it('member: no listener, real host peer and two local forwards', () => {
    const args = buildMemberArgs({
      networkName: 'mcl-abc123',
      networkSecret: 'b'.repeat(64),
      peer: 'tcp://10.1.2.3:11010',
      rpcPort: 15889,
      localWorldPort: 50001,
      localControlPort: 50002,
      worldPort: 25565,
      controlPort: 25998,
    })
    expect(args).toContain('--no-tun')
    expect(args).toContain('--no-listener')
    expect(args[args.indexOf('-p') + 1]).toBe('tcp://10.1.2.3:11010')
    expect(args).toContain('tcp://127.0.0.1:50001/192.168.77.1:25565')
    expect(args).toContain('tcp://127.0.0.1:50002/192.168.77.1:25998')
    expect(args.join(' ')).not.toContain('0.0.0.0')
    expect(args.join(' ')).not.toContain('--network-secret')
  })

  it('rejects loopback peers (10049) and port-forward helper uses loopback RPC', () => {
    expect(() => assertPeerUsable('tcp://127.0.0.1:11010')).toThrow()
    expect(() => assertPeerUsable('tcp://localhost:11010')).toThrow()
    expect(() =>
      buildMemberArgs({
        networkName: 'n',
        networkSecret: 's',
        peer: 'tcp://127.0.0.1:11010',
        rpcPort: 1,
        localControlPort: 2,
        controlPort: 3,
      }),
    ).toThrow()
    const add = buildPortForwardAddArgs({ rpcPort: 15889, localPort: 50001, destinationPort: 25565 })
    expect(add).toEqual([
      '-p',
      '127.0.0.1:15889',
      'port-forward',
      'add',
      'tcp',
      '127.0.0.1:50001',
      '192.168.77.1:25565',
    ])
  })
})
