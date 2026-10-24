import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { EasyTierManager, EasyTierTunnel } from '../easytier'
import { MemberControl } from '../control'
import { RoomService } from '../room'
import { parseTicket } from '../ticket'

/**
 * Opt-in evidence with the real EasyTier sidecars (`MCL_REAL_TUNNEL=1`).
 *
 * The unit tests fake `TunnelPort`, so they cannot tell whether the pinned
 * binary actually starts, whether the WAN endpoint in the invite is dialable, or
 * whether the member's port-forward reaches the host's control plane. This file
 * spawns two sidecars on one machine and walks that path for real.
 *
 * It also asks `easytier-cli node` for the public address from plain Node — the
 * packaged build returned an empty table there, so running it outside
 * Electron/asar separates "the CLI is broken" from "the asar child-process
 * environment is broken".
 */

const enabled = process.env.MCL_REAL_TUNNEL === '1'
const bundleDir =
  process.env.MCL_EASYTIER_BUNDLE ??
  path.resolve(process.cwd(), 'release', 'win-unpacked', 'resources', 'easytier')

/**
 * EasyTier rejects a loopback peer (`--no-tun` cannot dial 127.0.0.1, it fails
 * with WSAEADDRNOTAVAIL), so the two sidecars have to meet on a real interface
 * address. Prefer RFC1918; fall back to any non-internal IPv4.
 */
function localAddress(): string | null {
  const addresses: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address)
    }
  }
  const privateOne = addresses.find((address) =>
    /^(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(address),
  )
  return privateOne ?? addresses[0] ?? null
}

const lanAddress = localAddress()
const runnable =
  enabled && Boolean(lanAddress) && fs.existsSync(path.join(bundleDir, 'easytier-core.exe'))
const describeReal = runnable ? describe : describe.skip

const logLines: string[] = []

function record(level: string) {
  return (message: string, details?: Record<string, unknown>): void => {
    logLines.push(`${level} ${message} ${JSON.stringify(details ?? {})}`)
  }
}

const log = {
  debug: record('DEBUG'),
  info: record('INFO'),
  warn: record('WARN'),
  error: record('ERROR'),
  fatal: record('FATAL'),
  child: () => log,
} as unknown as ScopedLogger

/** Wait until something accepts a TCP connection on `port`. */
async function waitForListener(port: number, timeoutMs: number): Promise<number> {
  const net = await import('node:net')
  const started = Date.now()
  let lastError = ''
  while (Date.now() - started < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      const done = (value: boolean): void => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(1_000, () => done(false))
      socket.once('connect', () => done(true))
      socket.once('error', (error) => {
        lastError = error.message
        done(false)
      })
    })
    if (ok) return Date.now() - started
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`nothing is listening on 127.0.0.1:${port} after ${timeoutMs}ms (${lastError})`)
}

describeReal('real EasyTier tunnel (opt-in: MCL_REAL_TUNNEL=1)', () => {
  const roots: string[] = []
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch {
        // shutdown is best effort; the sidecars are killed by host.leave()
      }
    }
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it(
    'lets a member reach the host control plane through the invite WAN endpoint',
    async ({ onTestFailed }) => {
      onTestFailed(() => {
        console.log(
          '[real-tunnel] sidecar log:\n' +
            logLines.filter((line) => /sidecar|tunnel|public ip|member/i.test(line)).join('\n'),
        )
      })
      const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-real-tunnel-'))
      const memberRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-real-tunnel-member-'))
      roots.push(hostRoot, memberRoot)

      const host = new RoomService({
        dataRoot: hostRoot,
        log,
        tunnel: new EasyTierTunnel(new EasyTierManager({ dataRoot: hostRoot, log, bundledDir: bundleDir })),
        instance: { get: () => ({ mcVersion: '1.20.1', loader: { type: 'vanilla' } }) },
        lanIp: lanAddress as string,
        aliasIp: '127.0.0.55',
        maxMembers: 4,
        ticketTtlSeconds: 300,
        publicIp: lanAddress,
        autoProbe: false,
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 5_000,
      })
      cleanups.push(async () => {
        await host.leave()
      })

      const created = await host.create({ instanceId: 'a', transport: 'auto', consentTunnel: true })
      expect({ state: created.state, tunnel: created.tunnel.state, log: logLines }).toMatchObject({
        state: 'waiting',
        tunnel: 'up',
      })
      expect(created.ports.peer).toBeGreaterThan(0)
      expect(created.ports.control).toBeGreaterThan(0)

      const invite = await host.copyInvite()
      const payload = parseTicket(invite.ticket).payload
      expect(payload.endpoints[0]).toEqual({
        kind: 'wan',
        host: lanAddress,
        port: created.ports.peer,
      })
      expect(payload.tunnel.controlPort).toBe(created.ports.control)

      const memberTunnel = new EasyTierTunnel(
        new EasyTierManager({ dataRoot: memberRoot, log, bundledDir: bundleDir }),
      )
      await memberTunnel.ensureInstalled()
      const handle = await memberTunnel.startMember({
        networkName: payload.net.name,
        networkSecret: Buffer.from(payload.net.secret, 'base64url').toString('hex'),
        peer: `tcp://${lanAddress}:${created.ports.peer}`,
        controlPort: payload.tunnel.controlPort,
        worldPort: null,
      })
      cleanups.push(async () => {
        await memberTunnel.stop(handle)
      })
      expect(handle.localControlPort).toBeGreaterThan(0)
      const memberArgs = (handle as { args?: string[] }).args ?? []
      console.log('[real-tunnel] member args:', JSON.stringify(memberArgs))
      const listenerAfter = await waitForListener(handle.localControlPort as number, 30_000)
      console.log(`[real-tunnel] member control listener accepted after ${listenerAfter}ms`)

      const control = new MemberControl({
        code: payload.code,
        token: Buffer.from(payload.net.secret, 'base64url'),
        endpoint: { host: '127.0.0.1', port: handle.localControlPort ?? 0 },
        member: {
          id: 'real-member',
          name: '玩家',
          mcVersion: payload.mc.version,
          loader: payload.mc.loader,
          path: 'direct',
        },
        log,
        connectTimeoutMs: 30_000,
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 5_000,
      })
      cleanups.push(async () => {
        await control.leave()
      })
      const welcome = await control.connect()

      expect(welcome.room.code).toBe(payload.code)
      expect(welcome.members.some((member) => member.role === 'host')).toBe(true)
      expect(host.status()?.state).toBe('connected')

      // Same command the packaged build ran with an empty table: does it answer
      // from plain Node, and what does it actually print?
      const probe = await host.probePublicIp()
      console.log('[real-tunnel] public ip probe:', JSON.stringify(probe))
      console.log('[real-tunnel] log:', logLines.filter((line) => /probe|public ip/i.test(line)).join('\n'))

      const hostRpc = /sidecar started \{"role":"host"[^}]*"rpcPort":(\d+)/.exec(
        logLines.join('\n'),
      )?.[1]
      if (hostRpc) {
        const cli = path.join(bundleDir, 'easytier-cli.exe')
        const raw = await new Promise<string>((resolve) => {
          execFile(cli, ['--rpc-portal', `127.0.0.1:${hostRpc}`, 'node'], { timeout: 10_000 }, (error, stdout, stderr) => {
            resolve(
              `exit=${error ? (error as { code?: unknown }).code : 0}\n--- stdout ---\n${String(stdout).slice(0, 4_000)}\n--- stderr ---\n${String(stderr).slice(0, 1_000)}`,
            )
          })
        })
        console.log('[real-tunnel] raw easytier-cli node output:\n' + raw)
      }
    },
    240_000,
  )
})
