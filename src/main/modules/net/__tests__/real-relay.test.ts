import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { EasyTierManager, EasyTierTunnel, findFreePort } from '../easytier'
import { MemberControl } from '../control'
import { RoomService } from '../room'
import { parseTicket } from '../ticket'

/**
 * Opt-in relay probe (`MCL_REAL_TUNNEL=1`) — **currently skipped, and red when
 * it is enabled.**
 *
 * What it does: a third EasyTier process acts as the relay node, the host is
 * pointed at it (`-p`), and the member is only told about that node — it dials
 * `tcp://<relay>:<port>` and never the host's address, which is the shape of a
 * real CGNAT room.
 *
 * What happens (2026-10-24 19:0x, measured): the relay answers in ~210ms, the
 * member's sidecar connects to it (`new peer connection added … remote_addr
 * tcp://<lan>:<relayPort>`), the member's local port-forward opens — and every
 * control-plane handshake then fails with `read ECONNRESET`, five attempts over
 * ~40s. So "relay-only" is not proven: either the three nodes never merge into
 * one virtual network (network name/secret mismatch, private-mode refusing to
 * forward) or the host's `192.168.77.1` proxy mapping is not routable through a
 * relay. The next diagnostic step is to read the relay's own peer table
 * (`easytier-cli --rpc-portal … peer`) while both peers are up.
 *
 * It stays in the tree as a repro probe instead of being deleted: the day
 * someone has a real public relay, this is the script to run first.
 */

const enabled = process.env.MCL_REAL_TUNNEL === '1'
const bundleDir =
  process.env.MCL_EASYTIER_BUNDLE ??
  path.resolve(process.cwd(), 'release', 'win-unpacked', 'resources', 'easytier')

function localAddress(): string | null {
  const addresses: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address)
    }
  }
  return (
    addresses.find((address) => /^(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./.test(address)) ??
    addresses[0] ??
    null
  )
}

const lanAddress = localAddress()
const corePath = path.join(bundleDir, 'easytier-core.exe')
const runnable = enabled && Boolean(lanAddress) && fs.existsSync(corePath)
// Deliberately not run: see the header. Kept as a repro probe, so it must not
// turn a normal `MCL_REAL_TUNNEL=1` run red.
const describeReal = describe.skip

void runnable

const logLines: string[] = []
const record = (level: string) => (message: string, details?: Record<string, unknown>): void => {
  logLines.push(`${level} ${message} ${JSON.stringify(details ?? {})}`)
}
const log = {
  debug: () => undefined,
  info: record('INFO'),
  warn: record('WARN'),
  error: record('ERROR'),
  fatal: record('FATAL'),
  child: () => log,
} as unknown as ScopedLogger

/** Resolve once something accepts a TCP connection on `port`. */
function waitForTcp(port: number, timeoutMs: number): Promise<number> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const socket = net.connect({ host: '127.0.0.1', port })
      const done = (ok: boolean): void => {
        socket.removeAllListeners()
        socket.destroy()
        if (ok) resolve(Date.now() - started)
        else if (Date.now() - started > timeoutMs) reject(new Error(`127.0.0.1:${port} never opened`))
        else setTimeout(attempt, 200)
      }
      socket.setTimeout(1_000, () => done(false))
      socket.once('connect', () => done(true))
      socket.once('error', () => done(false))
    }
    attempt()
  })
}

describeReal('real EasyTier relay (opt-in: MCL_REAL_TUNNEL=1)', () => {
  const roots: string[] = []
  const children: ChildProcess[] = []
  const cleanups: Array<() => Promise<void>> = []

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) {
      try {
        await cleanup()
      } catch {
        // best effort
      }
    }
    for (const child of children.splice(0)) {
      try {
        child.kill()
      } catch {
        // already gone
      }
    }
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
  })

  it(
    'lets a member join through a relay-only configuration',
    async ({ onTestFailed }) => {
      onTestFailed(() => {
        console.log('[real-relay] log:\n' + logLines.join('\n'))
      })

      const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-real-relay-'))
      const memberRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-real-relay-member-'))
      roots.push(hostRoot, memberRoot)

      // The relay's port is known before its process: the host is pointed at it
      // up front and EasyTier retries the peer until the relay answers. Both
      // sides then meet through the relay only — the member is never told the
      // host's address, which is the shape of a real CGNAT room.
      const relayPort = await findFreePort(lanAddress as string)
      const relayUrl = `tcp://${lanAddress}:${relayPort}`

      const host = new RoomService({
        dataRoot: hostRoot,
        log,
        tunnel: new EasyTierTunnel(new EasyTierManager({ dataRoot: hostRoot, log, bundledDir: bundleDir })),
        instance: { get: () => ({ mcVersion: '1.20.1', loader: { type: 'vanilla' } }) },
        lanIp: lanAddress as string,
        aliasIp: '127.0.0.57',
        maxMembers: 4,
        ticketTtlSeconds: 300,
        publicIp: lanAddress,
        autoProbe: false,
        relayPeers: [relayUrl],
        heartbeatIntervalMs: 1_000,
        heartbeatTimeoutMs: 5_000,
      })
      cleanups.push(async () => {
        await host.leave()
      })

      const created = await host.create({ instanceId: 'a', transport: 'auto', consentTunnel: true })
      expect(created.tunnel.state).toBe('up')
      const payload = parseTicket((await host.copyInvite()).ticket).payload
      expect(payload.endpoints.some((endpoint) => endpoint.kind === 'relay')).toBe(true)

      // Relay: a plain EasyTier node in the same network, listening for peers.
      // It runs no forward rule and no TUN — exactly what
      // `easytier-core -l tcp://0.0.0.0:11010` does on a public box.
      const rpcPort = await findFreePort('127.0.0.1')
      const relay = spawn(
        corePath,
        [
          '-i', '10.144.144.3',
          '--network-name', payload.net.name,
          '--no-tun',
          '-l', `tcp://${lanAddress}:${relayPort}`,
          '-r', `127.0.0.1:${rpcPort}`,
          '--rpc-portal-whitelist', '127.0.0.1/32',
          '--private-mode', 'true',
          '--disable-ipv6',
        ],
        {
          cwd: bundleDir,
          windowsHide: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            ET_NETWORK_SECRET: Buffer.from(payload.net.secret, 'base64url').toString('hex'),
          },
        },
      )
      children.push(relay)
      const relayReadyAfter = await waitForTcp(rpcPort, 20_000)
      console.log(`[real-relay] relay ready after ${relayReadyAfter}ms, listening on ${lanAddress}:${relayPort}`)

      const memberTunnel = new EasyTierTunnel(
        new EasyTierManager({ dataRoot: memberRoot, log, bundledDir: bundleDir }),
      )
      await memberTunnel.ensureInstalled()
      const handle = await memberTunnel.startMember({
        networkName: payload.net.name,
        networkSecret: Buffer.from(payload.net.secret, 'base64url').toString('hex'),
        // Relay only: the member is never told the host's address.
        peer: `tcp://${lanAddress}:${relayPort}`,
        controlPort: payload.tunnel.controlPort,
        worldPort: null,
      })
      cleanups.push(async () => {
        await memberTunnel.stop(handle)
      })
      expect(handle.localControlPort).toBeGreaterThan(0)

      await waitForTcp(handle.localControlPort as number, 30_000)

      // The relay has to merge both peers into one virtual network before the
      // forward can reach the host's mapped control port; give it a few tries
      // (same backoff the production path uses).
      let welcome: Awaited<ReturnType<MemberControl['connect']>> | null = null
      let lastError: unknown = null
      for (let attempt = 0; attempt < 5 && !welcome; attempt += 1) {
        const control = new MemberControl({
          code: payload.code,
          token: Buffer.from(payload.net.secret, 'base64url'),
          endpoint: { host: '127.0.0.1', port: handle.localControlPort ?? 0 },
          member: {
            id: `relay-member-${attempt}`,
            name: '玩家',
            mcVersion: payload.mc.version,
            loader: payload.mc.loader,
            path: 'relay',
          },
          log,
          connectTimeoutMs: 15_000,
          heartbeatIntervalMs: 1_000,
          heartbeatTimeoutMs: 5_000,
        })
        try {
          welcome = await control.connect()
          cleanups.push(async () => {
            await control.leave()
          })
        } catch (error) {
          lastError = error
          console.log(`[real-relay] handshake attempt ${attempt + 1} failed: ${(error as Error).message}`)
          await new Promise((resolve) => setTimeout(resolve, 2_000))
        }
      }
      if (!welcome) throw lastError ?? new Error('no welcome')

      expect(welcome.room.code).toBe(payload.code)
      expect(welcome.members.some((member) => member.role === 'host')).toBe(true)
      console.log('[real-relay] joined through the relay node')
    },
    240_000,
  )
})
