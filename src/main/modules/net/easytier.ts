import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import type { ScopedLogger } from '../../kernel/logger'
import { nodeFsPort } from '../../core/ports'
import { openZipFile } from '../../core/zip/reader'
import {
  EASYTIER_CLI_SHA256,
  EASYTIER_CORE_SHA256,
  EASYTIER_LICENSE_URL,
  EASYTIER_SOURCE_URL,
  EASYTIER_VERSION,
  EASYTIER_WINTUN_SHA256,
  EASYTIER_ZIP_SHA256,
  EASYTIER_ZIP_URL,
  TUNNEL_START_TIMEOUT_MS,
  TUNNEL_STOP_GRACE_MS,
  HOST_VIP,
} from './constants'
import {
  buildHostArgs,
  buildMemberArgs,
  buildPortForwardAddArgs,
  isWildcardHost,
  type HostArgsInput,
  type MemberArgsInput,
} from './args'
import { LinkError } from './ticket'
import { EASYTIER_LICENSE_TEXT } from './license-text'
import { installerEnvironment } from '../loader/core/installer'

const execFileAsync = promisify(execFile)

/** Minimal surface we need from a spawned sidecar (injectable for tests). */
export interface ChildLike {
  pid?: number
  exitCode: number | null
  kill(signal?: NodeJS.Signals): boolean
  once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): this
  stdout?: NodeJS.ReadableStream | null
  stderr?: NodeJS.ReadableStream | null
}

export type SpawnLike = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; stdio: ('ignore' | 'pipe')[]; env?: NodeJS.ProcessEnv },
) => ChildLike

export interface EasyTierPaths {
  dir: string
  core: string
  cli: string
  wintun: string
  license: string
  manifest: string
}

export interface SidecarHandle {
  role: 'host' | 'member'
  pid: number | null
  rpcPort: number
  peerPort: number | null
  localWorldPort: number | null
  localControlPort: number | null
  /** Absolute path of the pinned easytier-cli.exe (diagnostics / public IP). */
  cliPath: string
  args: string[]
  stop(): Promise<void>
}

export interface EasyTierManagerOptions {
  dataRoot: string
  log: ScopedLogger
  platform?: NodeJS.Platform
  binaryDir?: string
  /** Test seam: directory holding a pre-shipped EasyTier copy. */
  bundledDir?: string
  spawn?: SpawnLike
  fetchFile?: (url: string, destination: string) => Promise<void>
  execFile?: (
    file: string,
    args: string[],
    options?: { timeout?: number; windowsHide?: boolean },
  ) => Promise<{ stdout: string; stderr: string }>
  waitTimeoutMs?: number
  verifyHashes?: boolean
  now?: () => number
}

type HostStartInput = Omit<HostArgsInput, 'peerPort' | 'rpcPort'> & {
  relayPeers?: string[]
}

type MemberStartInput = Omit<MemberArgsInput, 'rpcPort' | 'localControlPort' | 'localWorldPort'> & {
  relayPeers?: string[]
}

export function sidecarEnvironment(networkSecret: string): NodeJS.ProcessEnv {
  // Secret travels through the environment, never argv (N4/H2).
  return { ...installerEnvironment(), ET_NETWORK_SECRET: networkSecret }
}

export function helpSupportsSecretEnv(helpText: string): boolean {
  return /ET_NETWORK_SECRET|--network-secret/i.test(helpText)
}

export interface SidecarNetworkSecretProbe {
  (core: string): Promise<{ stdout: string; stderr: string }>
}

export class EasyTierManager {
  private readonly platform: NodeJS.Platform
  private readonly spawn: SpawnLike
  private readonly fetchFile: (url: string, destination: string) => Promise<void>
  private readonly execFile: (
    file: string,
    args: string[],
    options?: { timeout?: number; windowsHide?: boolean },
  ) => Promise<{ stdout: string; stderr: string }>
  private readonly waitTimeoutMs: number
  private readonly verifyHashes: boolean
  private capabilityChecked = false

  constructor(private readonly options: EasyTierManagerOptions) {
    this.platform = options.platform ?? process.platform
    this.spawn = options.spawn ?? (spawn as unknown as SpawnLike)
    this.fetchFile = options.fetchFile ?? fetchToFile
    this.execFile =
      options.execFile ??
      (async (file, args, execOptions) => {
        const result = (await execFileAsync(file, args, {
          ...execOptions,
          encoding: 'utf8',
        })) as { stdout: string; stderr: string }
        return { stdout: String(result.stdout), stderr: String(result.stderr) }
      })
    this.waitTimeoutMs = options.waitTimeoutMs ?? TUNNEL_START_TIMEOUT_MS
    this.verifyHashes = options.verifyHashes ?? true
  }

  paths(): EasyTierPaths {
    const dir =
      this.options.binaryDir ??
      path.join(this.options.dataRoot, 'modules', 'net', 'easytier', EASYTIER_VERSION)
    return {
      dir,
      core: path.join(dir, 'easytier-core.exe'),
      cli: path.join(dir, 'easytier-cli.exe'),
      wintun: path.join(dir, 'wintun.dll'),
      license: path.join(dir, 'LICENSE-LGPL-3.0.txt'),
      manifest: path.join(dir, 'manifest.json'),
    }
  }

  /** Returns true when the pinned, hash-verified sidecar is ready. */
  async ensureInstalled(): Promise<EasyTierPaths> {
    const paths = this.paths()
    if (this.isComplete(paths) && (await this.hashesValid(paths))) {
      this.writeManifest(paths, 'present')
      return paths
    }
    // Prefer the copy shipped inside the app: downloading from GitHub fails on
    // machines whose TLS chain cannot verify, and the room then silently falls
    // back to LAN — which is exactly what breaks cross-network play.
    const bundled = this.bundledDir()
    if (bundled) {
      try {
        await this.installFromBundle(bundled, paths)
        this.writeManifest(paths, 'bundled')
        this.options.log.info('EasyTier installed from bundled copy', { dir: bundled })
        return paths
      } catch (error) {
        this.options.log.warn('bundled EasyTier copy unusable, falling back to download', {
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    if (!this.options.fetchFile && this.platform !== 'win32') {
      throw new LinkError('TUNNEL_START_FAILED', 'EasyTier runtime install is only implemented for Windows in this MVP')
    }
    await this.install(paths)
    return paths
  }

  /** `<resources>/easytier` in a packaged app; overridable for tests. */
  private bundledDir(): string | null {
    const candidates = [
      this.options.bundledDir,
      process.resourcesPath ? path.join(process.resourcesPath, 'easytier') : null,
    ].filter((entry): entry is string => Boolean(entry))
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(path.join(candidate!, 'easytier-core.exe'))) return candidate!
      } catch {
        /* try the next candidate */
      }
    }
    return null
  }

  private bundledPaths(dir: string): EasyTierPaths {
    return {
      dir,
      core: path.join(dir, 'easytier-core.exe'),
      cli: path.join(dir, 'easytier-cli.exe'),
      wintun: path.join(dir, 'wintun.dll'),
      license: path.join(dir, 'LICENSE-LGPL-3.0.txt'),
      manifest: path.join(dir, 'manifest.json'),
    }
  }

  private async installFromBundle(bundled: string, paths: EasyTierPaths): Promise<void> {
    const from = this.bundledPaths(bundled)
    await fs.promises.mkdir(paths.dir, { recursive: true })
    for (const [name, source] of [
      ['easytier-core.exe', from.core],
      ['easytier-cli.exe', from.cli],
      ['wintun.dll', from.wintun],
      // easytier-core statically imports Packet.dll (WinPcap/Npcap shim). Without
      // it Windows fails the process with 0xC0000135 (STATUS_DLL_NOT_FOUND) and
      // the capability probe reports TUNNEL_START_FAILED.
      ['Packet.dll', path.join(bundled, 'Packet.dll')],
      ['WinDivert64.sys', path.join(bundled, 'WinDivert64.sys')],
      ['LICENSE-LGPL-3.0.txt', from.license],
    ] as const) {
      if (!fs.existsSync(source)) continue
      await fs.promises.copyFile(source, path.join(paths.dir, name))
    }
    if (!(await this.hashesValid(paths))) {
      throw new LinkError('TUNNEL_START_FAILED', 'bundled EasyTier copy failed its hash check')
    }
  }

  private isComplete(paths: EasyTierPaths): boolean {
    return fs.existsSync(paths.core) && fs.existsSync(paths.cli) && fs.existsSync(paths.wintun)
  }

  private async hashesValid(paths: EasyTierPaths): Promise<boolean> {
    if (!this.verifyHashes) return true
    return (
      (await sha256(paths.core)) === EASYTIER_CORE_SHA256 &&
      (await sha256(paths.cli)) === EASYTIER_CLI_SHA256 &&
      (await sha256(paths.wintun)) === EASYTIER_WINTUN_SHA256
    )
  }

  private async install(paths: EasyTierPaths): Promise<void> {
    const tmpDir = path.join(this.options.dataRoot, 'tmp')
    fs.mkdirSync(tmpDir, { recursive: true })
    fs.mkdirSync(paths.dir, { recursive: true })
    const zip = path.join(tmpDir, `easytier-${EASYTIER_VERSION}.zip`)
    this.options.log.info('downloading EasyTier 2.7.0 (LGPL-3.0)', {
      url: EASYTIER_ZIP_URL,
      expectedSha256: EASYTIER_ZIP_SHA256,
    })
    try {
      await this.fetchFile(EASYTIER_ZIP_URL, zip)
    } catch (error) {
      throw new LinkError('TUNNEL_DOWNLOAD_FAILED', `download failed: ${messageOf(error)}`, {
        retryable: true,
      })
    }
    const zipHash = await sha256(zip)
    if (zipHash !== EASYTIER_ZIP_SHA256) {
      safeUnlink(zip)
      throw new LinkError(
        'TUNNEL_HASH_MISMATCH',
        `EasyTier zip hash mismatch: ${zipHash}`,
      )
    }

    try {
      const archive = openZipFile(nodeFsPort(), zip)
      for (const [name, expected] of [
        ['easytier-core.exe', EASYTIER_CORE_SHA256],
        ['easytier-cli.exe', EASYTIER_CLI_SHA256],
        ['wintun.dll', EASYTIER_WINTUN_SHA256],
      ] as const) {
        const entry = archive.entries.find((candidate) => candidate.name.endsWith(`/${name}`) || candidate.name === name)
        if (!entry) throw new LinkError('TUNNEL_DOWNLOAD_FAILED', `archive is missing ${name}`)
        const bytes = archive.readEntry(entry)
        const target = path.join(paths.dir, name)
        fs.writeFileSync(target, bytes)
        const actual = crypto.createHash('sha256').update(bytes).digest('hex')
        if (this.verifyHashes && actual !== expected) {
          throw new LinkError('TUNNEL_HASH_MISMATCH', `${name} hash mismatch`)
        }
      }
    } catch (error) {
      if (error instanceof LinkError) throw error
      throw new LinkError('TUNNEL_DOWNLOAD_FAILED', `extract failed: ${messageOf(error)}`)
    } finally {
      safeUnlink(zip)
    }

    fs.writeFileSync(paths.license, EASYTIER_LICENSE_TEXT, 'utf8')
    this.writeManifest(paths, 'downloaded')
    this.options.log.info('EasyTier installed', {
      version: EASYTIER_VERSION,
      dir: paths.dir,
      source: EASYTIER_SOURCE_URL,
      license: EASYTIER_LICENSE_URL,
    })
  }

  private writeManifest(paths: EasyTierPaths, source: string): void {
    const manifest = {
      version: EASYTIER_VERSION,
      source,
      url: EASYTIER_ZIP_URL,
      sourceUrl: EASYTIER_SOURCE_URL,
      license: EASYTIER_LICENSE_URL,
      zipSha256: EASYTIER_ZIP_SHA256,
      hashes: {
        core: EASYTIER_CORE_SHA256,
        cli: EASYTIER_CLI_SHA256,
        wintun: EASYTIER_WINTUN_SHA256,
      },
      installedAt: new Date(this.options.now?.() ?? Date.now()).toISOString(),
    }
    fs.writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2), 'utf8')
  }

  private async assertSecretEnvSupport(core: string): Promise<void> {
    if (this.capabilityChecked) return
    let result: { stdout: string; stderr: string }
    try {
      result = await this.execFile(core, ['--help'], {
        timeout: 3_000,
        windowsHide: true,
      })
    } catch (error) {
      throw new LinkError('TUNNEL_START_FAILED', `EasyTier capability probe failed: ${messageOf(error)}`, {
        retryable: false,
        details: { reason: 'capability_probe_failed', version: EASYTIER_VERSION },
      })
    }
    const help = `${result.stdout}\n${result.stderr}`
    if (!helpSupportsSecretEnv(help)) {
      // Fail closed: if this build cannot accept the secret via env, both peers
      // would silently join with an empty secret (fail-open). Refuse to start.
      throw new LinkError(
        'TUNNEL_START_FAILED',
        `EasyTier ${EASYTIER_VERSION} does not advertise ET_NETWORK_SECRET`,
        {
          retryable: false,
          details: { reason: 'secret_env_unsupported', version: EASYTIER_VERSION },
        },
      )
    }
    this.capabilityChecked = true
    this.options.log.info('EasyTier secret env capability verified', {
      version: EASYTIER_VERSION,
    })
  }

  async startHost(input: HostStartInput): Promise<SidecarHandle> {
    const paths = await this.ensureInstalled()
    await this.assertSecretEnvSupport(paths.core)
    const lanIp = input.lanIp
    if (isWildcardHost(lanIp)) throw new LinkError('TUNNEL_START_FAILED', 'wildcard listener')
    const peerPort = await findFreePort(lanIp)
    const rpcPort = await findFreePort('127.0.0.1')
    const args = buildHostArgs({ ...input, peerPort, rpcPort })
    return this.start('host', paths.core, args, {
      rpcPort,
      peerPort,
      localWorldPort: null,
      localControlPort: null,
    }, input.networkSecret)
  }

  async startMember(input: MemberStartInput): Promise<SidecarHandle> {
    const paths = await this.ensureInstalled()
    await this.assertSecretEnvSupport(paths.core)
    const rpcPort = await findFreePort('127.0.0.1')
    const localWorldPort = await findFreePort('127.0.0.1')
    const localControlPort = await findFreePort('127.0.0.1')
    const args = buildMemberArgs({
      ...input,
      rpcPort,
      localWorldPort,
      localControlPort,
    })
    return this.start('member', paths.core, args, {
      rpcPort,
      peerPort: null,
      localWorldPort,
      localControlPort,
    }, input.networkSecret)
  }

  private async start(
    role: 'host' | 'member',
    core: string,
    args: string[],
    ports: Pick<SidecarHandle, 'rpcPort' | 'peerPort' | 'localWorldPort' | 'localControlPort'>,
    networkSecret: string,
  ): Promise<SidecarHandle> {
    const child = this.spawn(core, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Secret goes through the environment, never argv (process list). The
      // rest of the environment is an explicit loader/launcher allow-list.
      env: sidecarEnvironment(networkSecret),
    })
    const prefix = role === 'host' ? 'host' : 'member'
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = redact(chunk.toString())
      this.options.log.debug(`sidecar ${prefix}`, { line: text })
      // EasyTier writes its failures to stdout, not stderr. Surface the important
      // ones at warning level, otherwise a failed TUN is invisible in the log.
      const important = text
        .split('\n')
        .filter((line) => /ERROR|WARN|tun|adapter|wintun/i.test(line))
        .join('\n')
        .trim()
      if (important.length > 0) {
        this.options.log.warn(`sidecar ${prefix} diagnostic`, { line: important.slice(0, 800) })
      }
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      this.options.log.warn(`sidecar ${prefix}`, { line: redact(chunk.toString()) })
    })
    const stopped = new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
    })
    try {
      await waitForPort('127.0.0.1', ports.rpcPort, this.waitTimeoutMs)
    } catch (error) {
      await killChild(child, this.platform)
      throw new LinkError('TUNNEL_START_FAILED', `sidecar RPC did not start: ${messageOf(error)}`, {
        retryable: true,
      })
    }
    this.options.log.info('sidecar started', { role, pid: child.pid ?? null, rpcPort: ports.rpcPort })

    // NOTE: do NOT probe for a 10.144.x adapter here. This tunnel runs with
    // `--no-tun` (subnet proxy + port forward) by design, so the adapter never
    // exists — checking for it rejected every healthy room.

    return {
      role,
      pid: child.pid ?? null,
      ...ports,
      cliPath: this.paths().cli,
      args,
      stop: async () => {
        await killChild(child, this.platform)
        await Promise.race([
          stopped,
          new Promise<void>((resolve) => setTimeout(resolve, TUNNEL_STOP_GRACE_MS)),
        ])
        this.options.log.info('sidecar stopped', { role, pid: child.pid ?? null })
      },
    }
  }

  async addPortForward(handle: SidecarHandle, localPort: number, destinationPort: number): Promise<void> {
    if (handle.role !== 'member') throw new LinkError('INTERNAL', 'port-forward is member-only')
    const paths = this.paths()
    try {
      await this.execFile(paths.cli, buildPortForwardAddArgs({
        rpcPort: handle.rpcPort,
        localPort,
        destinationPort,
      }))
    } catch (error) {
      throw new LinkError('TUNNEL_FAILED', `port-forward add failed: ${messageOf(error)}`, {
        retryable: true,
      })
    }
  }

  async stop(handle: SidecarHandle): Promise<void> {
    await handle.stop()
  }
}

/** Inputs the room service needs; keeps EasyTier details out of room.ts. */
export interface TunnelStartHostInput {
  networkName: string
  networkSecret: string
  lanIp: string
  aliasIp: string
  relayPeers?: string[]
}

export interface TunnelStartMemberInput {
  networkName: string
  networkSecret: string
  peer: string
  controlPort: number
  worldPort?: number | null
  relayPeers?: string[]
}

export interface TunnelHandle {
  pid: number | null
  rpcPort: number
  peerPort: number | null
  localWorldPort: number | null
  localControlPort: number | null
  /** Absolute path of the pinned easytier-cli.exe (diagnostics / public IP). */
  cliPath?: string
}

export interface TunnelPort {
  ensureInstalled(): Promise<unknown>
  startHost(input: TunnelStartHostInput): Promise<TunnelHandle>
  startMember(input: TunnelStartMemberInput): Promise<TunnelHandle>
  addPortForward(handle: TunnelHandle, localPort: number, destinationPort: number): Promise<void>
  stop(handle: TunnelHandle): Promise<void>
}

/** Thin adapter from the room service to the concrete EasyTier manager. */
export class EasyTierTunnel implements TunnelPort {
  constructor(private readonly manager: EasyTierManager) {}

  ensureInstalled(): Promise<unknown> {
    return this.manager.ensureInstalled()
  }

  startHost(input: TunnelStartHostInput): Promise<TunnelHandle> {
    return this.manager.startHost(input)
  }

  startMember(input: TunnelStartMemberInput): Promise<TunnelHandle> {
    return this.manager.startMember(input)
  }

  async addPortForward(handle: TunnelHandle, localPort: number, destinationPort: number): Promise<void> {
    await this.manager.addPortForward(handle as SidecarHandle, localPort, destinationPort)
  }

  async stop(handle: TunnelHandle): Promise<void> {
    await this.manager.stop(handle as SidecarHandle)
  }
}

// ---------- helpers ----------
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function safeUnlink(file: string): void {
  try {
    fs.unlinkSync(file)
  } catch {
    // best effort
  }
}

async function sha256(file: string): Promise<string> {
  return crypto.createHash('sha256').update(await fs.promises.readFile(file)).digest('hex')
}

export async function findFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, host, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => {
        if (port > 0) resolve(port)
        else reject(new Error('failed to allocate a port'))
      })
    })
  })
}

export async function waitForPort(host: string, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port })
      const finish = (value: boolean): void => {
        socket.removeAllListeners()
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(500)
      socket.once('connect', () => finish(true))
      socket.once('timeout', () => finish(false))
      socket.once('error', () => finish(false))
    })
    if (ok) return
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error(`port ${host}:${port} did not open within ${timeoutMs}ms`)
}

async function killChild(child: ChildLike, platform: NodeJS.Platform): Promise<void> {
  if (!child.pid) {
    child.kill('SIGTERM')
    return
  }
  if (platform === 'win32') {
    try {
      await execFileAsync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 3_000,
        windowsHide: true,
      })
      return
    } catch {
      // fall through to kill
    }
  }
  try {
    child.kill('SIGTERM')
  } catch {
    // already gone
  }
}

function redact(line: string): string {
  return line
    .replace(/MCL1\.[0-9A-HJKMNP-TV-Z]{6}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, 'MCL1.<redacted>')
    .replace(/("?network_secret"?\s*[:=]\s*"?)[A-Za-z0-9_-]{16,}("?)/gi, '$1<redacted>$2')
}

/** Default downloader with redirects; tests inject a fake. */
async function fetchToFile(url: string, destination: string): Promise<void> {
  const https = await import('node:https')
  const http = await import('node:http')
  await new Promise<void>((resolve, reject) => {
    const visit = (target: string, redirects: number): void => {
      if (redirects > 5) {
        reject(new Error('too many redirects'))
        return
      }
      const client = target.startsWith('https:') ? https : http
      const request = client.get(
        target,
        { headers: { 'user-agent': 'mc-launcher/0.1' } },
        (response) => {
          const status = response.statusCode ?? 0
          if (status >= 300 && status < 400 && response.headers.location) {
            response.resume()
            visit(new URL(response.headers.location, target).toString(), redirects + 1)
            return
          }
          if (status !== 200) {
            response.resume()
            reject(new Error(`HTTP ${status} for ${target}`))
            return
          }
          const stream = fs.createWriteStream(destination)
          response.pipe(stream)
          stream.once('finish', () => stream.close(() => resolve()))
          stream.once('error', reject)
        },
      )
      request.once('error', reject)
      request.setTimeout(60_000, () => request.destroy(new Error('download timeout')))
    }
    visit(url, 0)
  })
}
