import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  EasyTierManager,
  helpSupportsSecretEnv,
  sidecarEnvironment,
} from '../easytier'
import { buildHostArgs, buildMemberArgs } from '../args'
import { EASYTIER_ZIP_SHA256 } from '../constants'
import type { ScopedLogger } from '../../../kernel/logger'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ScopedLogger

describe('EasyTier runtime install gate', () => {
  it('rejects a downloaded archive whose SHA-256 does not match the pinned release', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-et-'))
    roots.push(dataRoot)
    const manager = new EasyTierManager({
      dataRoot,
      log: silentLog,
      platform: 'win32',
      fetchFile: async (_url, destination) => {
        fs.writeFileSync(destination, 'not the pinned EasyTier archive', 'utf8')
      },
    })
    await expect(manager.ensureInstalled()).rejects.toMatchObject({
      code: 'TUNNEL_HASH_MISMATCH',
    })
    expect(EASYTIER_ZIP_SHA256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses existing binaries that fail the pinned core hash', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-et-'))
    roots.push(dataRoot)
    const dir = path.join(dataRoot, 'modules', 'net', 'easytier', '2.7.0')
    fs.mkdirSync(dir, { recursive: true })
    for (const name of ['easytier-core.exe', 'easytier-cli.exe', 'wintun.dll']) {
      fs.writeFileSync(path.join(dir, name), 'wrong', 'utf8')
    }
    const manager = new EasyTierManager({
      dataRoot,
      log: silentLog,
      platform: 'win32',
      // A no-op fetch keeps the test deterministic: the install path will fail
      // the zip hash before it could ever execute anything.
      fetchFile: async (_url, destination) => fs.writeFileSync(destination, 'bad', 'utf8'),
    })
    await expect(manager.ensureInstalled()).rejects.toMatchObject({
      code: 'TUNNEL_HASH_MISMATCH',
    })
  })

  it('sends the network secret only through the sidecar environment, never argv', () => {
    const secret = 's'.repeat(64)
    const env = sidecarEnvironment(secret)
    expect(env.ET_NETWORK_SECRET).toBe(secret)
    expect(env).not.toHaveProperty('MCL_CF_API_KEY')
    const host = buildHostArgs({
      networkName: 'mcl-abc123',
      networkSecret: secret,
      lanIp: '10.1.2.3',
      aliasIp: '127.0.0.55',
      peerPort: 11010,
      rpcPort: 15888,
    })
    const member = buildMemberArgs({
      networkName: 'mcl-abc123',
      networkSecret: secret,
      peer: 'tcp://10.1.2.3:11010',
      rpcPort: 15889,
      localWorldPort: 50001,
      localControlPort: 50002,
      worldPort: 25565,
      controlPort: 25998,
    })
    expect(host.join(' ')).not.toContain(secret)
    expect(member.join(' ')).not.toContain(secret)
    expect(host.join(' ')).not.toContain('--network-secret')
    expect(member.join(' ')).not.toContain('--network-secret')
  })

  it('treats the pinned --help excerpt as proof of ET_NETWORK_SECRET support', () => {
    const help = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'easytier-core-help-2.7.0.txt'),
      'utf8',
    )
    expect(help).toContain('[env: ET_NETWORK_SECRET=]')
    expect(helpSupportsSecretEnv(help)).toBe(true)
    expect(helpSupportsSecretEnv('--network-name only')).toBe(false)
  })

  it('fails closed when the installed core does not advertise ET_NETWORK_SECRET', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-et-probe-'))
    roots.push(dir)
    for (const name of ['easytier-core.exe', 'easytier-cli.exe', 'wintun.dll']) {
      fs.writeFileSync(path.join(dir, name), 'stub', 'utf8')
    }
    const manager = new EasyTierManager({
      dataRoot: dir,
      log: silentLog,
      platform: 'win32',
      binaryDir: dir,
      verifyHashes: false,
      execFile: async () => ({ stdout: 'no secret env support', stderr: '' }),
    })
    await expect(
      manager.startHost({
        networkName: 'mcl-abc123',
        networkSecret: 's'.repeat(64),
        lanIp: '10.1.2.3',
        aliasIp: '127.0.0.55',
      }),
    ).rejects.toMatchObject({
      code: 'TUNNEL_START_FAILED',
      details: { reason: 'secret_env_unsupported' },
    })
  })
})
