import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { AppError } from '@shared/errors'
import {
  SDK_SCHEMA_VERSION,
  SdkManifestSchema,
  type SdkEntry,
  type SdkList,
  type SdkStartInput,
  type SdkStartResult,
  type SdkStopResult,
} from '@shared/sdk'
import type { ScopedLogger } from '../../kernel/logger'

/**
 * Third-party multiplayer SDK sidecar registry.
 *
 * The directory is user-owned: each SDK is a subdirectory with `manifest.json`
 * (root-level `*.json` manifests are accepted too). A manifest never chooses an
 * arbitrary path or shell command:
 *   - command must be one safe executable basename (no separators/metacharacters,
 *     no shells/interpreters), resolved inside the SDK directory;
 *   - args are validated token-by-token and never passed through a shell;
 *   - optional sha256 must match before the sidecar starts.
 */

const SDK_DIR = 'multiplayer-sdk'
const MAX_MANIFEST_BYTES = 64 * 1024
const DENIED_COMMANDS = new Set([
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wscript.exe',
  'cscript.exe',
  'mshta.exe',
  'rundll32.exe',
  'regsvr32.exe',
  'bash.exe',
  'sh.exe',
  'conhost.exe',
  'explorer.exe',
  'java.exe',
  'javaw.exe',
])

const SAFE_COMMAND = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SHELL_META = /[&|;<>`$"'{}[\]*?~^\r\n\0]/

function sidecarEnvironment(): NodeJS.ProcessEnv {
  // Never hand the launcher's full environment (and its secrets) to a
  // third-party sidecar; keep only what Windows processes normally need.
  const allowed = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'USERPROFILE',
    'HOMEDRIVE',
    'HOMEPATH',
    'LOCALAPPDATA',
    'APPDATA',
    'COMSPEC',
    'NUMBER_OF_PROCESSORS',
    'PROCESSOR_ARCHITECTURE',
    'OS',
  ]
  const env: NodeJS.ProcessEnv = {}
  for (const key of allowed) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

function shellSafe(value: string): boolean {
  return !SHELL_META.test(value) && !value.includes('\0')
}

function validateArgs(args: string[]): string[] {
  for (const arg of args) {
    if (!shellSafe(arg)) {
      throw new Error(`参数包含 shell 元字符: ${arg}`)
    }
  }
  return args
}

function validateCommand(command: string): string {
  if (!SAFE_COMMAND.test(command) || command.includes('/') || command.includes('\\')) {
    throw new Error(`命令不在白名单字符集内: ${command}`)
  }
  const lower = command.toLowerCase()
  if (DENIED_COMMANDS.has(lower)) {
    throw new Error(`命令被拒绝（shell/解释器不可作为 sidecar）: ${command}`)
  }
  if (!lower.endsWith('.exe')) {
    throw new Error(`命令必须是 .exe 可执行文件: ${command}`)
  }
  return command
}

function inside(parent: string, target: string): boolean {
  const root = path.resolve(parent)
  const resolved = path.resolve(target)
  return resolved === root || resolved.startsWith(`${root}${path.sep}`)
}

async function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = fs.createReadStream(file)
    stream.on('error', reject)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

interface LoadedSdk {
  id: string
  name: string
  version: string
  command: string
  args: string[]
  directory: string
  manifestPath: string
  executable: string
  sha256: string | null
}

interface RunningSdk {
  child: ChildProcess
  pid: number
  startedAt: number
  command: string
}

export interface SdkServiceOptions {
  dataRoot: string
  log: ScopedLogger
  now?: () => number
  directory?: string
  /** Test seam; production opens the folder through Electron shell. */
  openPath?: (target: string) => Promise<string> | string
  /** Test seam. */
  spawnImpl?: typeof spawn
}

export class SdkService {
  private readonly log: ScopedLogger
  private readonly now: () => number
  private readonly directory: string
  private readonly running = new Map<string, RunningSdk>()
  /** Ids whose async validation/spawn is in flight (concurrent start guard). */
  private readonly starting = new Set<string>()
  private readonly spawnImpl: typeof spawn

  constructor(private readonly options: SdkServiceOptions) {
    this.log = options.log
    this.now = options.now ?? Date.now
    this.directory = options.directory ?? path.join(options.dataRoot, SDK_DIR)
    this.spawnImpl = options.spawnImpl ?? spawn
  }

  private ensureDirectory(): string {
    fs.mkdirSync(this.directory, { recursive: true })
    return this.directory
  }

  private async validateEntry(
    manifestPath: string,
    directory: string,
    expectedId: string | null,
  ): Promise<
    | { ok: true; sdk: LoadedSdk }
    | { ok: false; errors: string[] }
  > {
    const errors: string[] = []
    let raw: string
    try {
      const stat = await fsp.stat(manifestPath)
      if (!stat.isFile()) return { ok: false, errors: ['清单不是文件'] }
      if (stat.size > MAX_MANIFEST_BYTES) return { ok: false, errors: ['清单超过 64 KB'] }
      raw = await fsp.readFile(manifestPath, 'utf8')
    } catch {
      return { ok: false, errors: ['清单不可读取'] }
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return { ok: false, errors: ['清单不是有效 JSON'] }
    }
    const parsed = SdkManifestSchema.safeParse(json)
    if (!parsed.success) {
      return {
        ok: false,
        errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || 'manifest'}: ${issue.message}`),
      }
    }
    const manifest = parsed.data
    if (expectedId !== null && manifest.id !== expectedId) {
      errors.push(`id 必须与目录名一致（目录 ${expectedId}，清单 ${manifest.id}）`)
    }
    if (manifest.schemaVersion !== SDK_SCHEMA_VERSION) {
      errors.push(`不支持的 schemaVersion: ${manifest.schemaVersion}`)
    }
    let command: string
    try {
      command = validateCommand(manifest.command)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
      command = manifest.command
    }
    try {
      validateArgs(manifest.args)
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
    const executable = path.resolve(directory, command)
    if (!inside(directory, executable)) {
      errors.push('可执行文件路径越界')
    }
    let executableOk = false
    try {
      const lstat = await fsp.lstat(executable)
      if (lstat.isSymbolicLink()) errors.push('可执行文件不能是符号链接')
      else if (!lstat.isFile()) errors.push('可执行文件不存在或不是普通文件')
      else executableOk = true
    } catch {
      errors.push(`找不到可执行文件: ${command}`)
    }
    if (manifest.sha256 && executableOk) {
      try {
        const actual = await sha256File(executable)
        if (actual.toLowerCase() !== manifest.sha256.toLowerCase()) {
          errors.push('SHA-256 不匹配')
        }
      } catch {
        errors.push('无法计算可执行文件 SHA-256')
      }
    }
    if (errors.length > 0) return { ok: false, errors }
    return {
      ok: true,
      sdk: {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        command,
        args: manifest.args,
        directory,
        manifestPath,
        executable,
        sha256: manifest.sha256 ?? null,
      },
    }
  }

  private candidates(): Array<{ manifestPath: string; directory: string; expectedId: string | null }> {
    const root = this.ensureDirectory()
    const result: Array<{ manifestPath: string; directory: string; expectedId: string | null }> = []
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const manifest = path.join(root, entry.name, 'manifest.json')
        if (fs.existsSync(manifest)) {
          result.push({ manifestPath: manifest, directory: path.join(root, entry.name), expectedId: entry.name })
        }
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) {
        result.push({ manifestPath: path.join(root, entry.name), directory: root, expectedId: null })
      }
    }
    return result.sort((a, b) => a.manifestPath.localeCompare(b.manifestPath))
  }

  private entryOf(sdk: LoadedSdk): SdkEntry {
    const running = this.running.get(sdk.id)
    return {
      id: sdk.id,
      name: sdk.name,
      version: sdk.version,
      command: sdk.command,
      directory: sdk.directory,
      manifestPath: sdk.manifestPath,
      valid: true,
      errors: [],
      hashVerified: Boolean(sdk.sha256),
      running: Boolean(running),
      pid: running?.pid ?? null,
    }
  }

  async list(): Promise<SdkList> {
    const directory = this.ensureDirectory()
    const entries: SdkEntry[] = []
    const rejected: Array<{ path: string; errors: string[] }> = []
    const seen = new Set<string>()
    for (const candidate of this.candidates()) {
      const validated = await this.validateEntry(
        candidate.manifestPath,
        candidate.directory,
        candidate.expectedId,
      )
      if (!validated.ok) {
        rejected.push({ path: candidate.manifestPath, errors: validated.errors })
        continue
      }
      if (seen.has(validated.sdk.id)) {
        rejected.push({ path: candidate.manifestPath, errors: ['id 重复'] })
        continue
      }
      seen.add(validated.sdk.id)
      entries.push(this.entryOf(validated.sdk))
    }
    return { directory, entries, rejected }
  }

  async start(input: SdkStartInput): Promise<SdkStartResult> {
    // Claim the id synchronously: `list()`/hash validation are async, so two
    // concurrent start calls would both pass a later "already running" check and
    // spawn two sidecars (one of them would be orphaned).
    if (this.running.has(input.id) || this.starting.has(input.id)) {
      throw new AppError('SDK.ALREADY_RUNNING', '这个 SDK sidecar 已经在运行', {
        details: { id: input.id },
      })
    }
    this.starting.add(input.id)
    try {
      const list = await this.list()
      const entry = list.entries.find((item) => item.id === input.id)
      if (!entry) {
        const rejected = list.rejected.find((item) => item.path.includes(input.id))
        throw new AppError(
          'SDK.NOT_FOUND',
          rejected ? `SDK 未通过校验: ${rejected.errors.join('；')}` : `找不到 SDK: ${input.id}`,
          { details: { id: input.id } },
        )
      }
      if (entry.running) {
        throw new AppError('SDK.ALREADY_RUNNING', '这个 SDK sidecar 已经在运行', {
          details: { id: input.id, pid: entry.pid },
        })
      }
      // Re-validate immediately before spawning: a manifest/file may have changed.
      const validated = await this.validateEntry(
        entry.manifestPath,
        entry.directory,
        entry.directory === this.directory ? null : path.basename(entry.directory),
      )
      if (!validated.ok) {
        throw new AppError('SDK.INVALID_MANIFEST', `SDK 未通过校验: ${validated.errors.join('；')}`, {
          details: { id: input.id },
        })
      }
      let extraArgs: string[]
      try {
        extraArgs = validateArgs(input.args ?? [])
      } catch (error) {
        throw new AppError('SDK.INVALID_ARGS', error instanceof Error ? error.message : String(error))
      }
      const argv = [...validated.sdk.args, ...extraArgs]
      let child: ChildProcess
      try {
        child = this.spawnImpl(validated.sdk.executable, argv, {
          cwd: validated.sdk.directory,
          windowsHide: true,
          stdio: 'ignore',
          shell: false,
          env: sidecarEnvironment(),
        })
      } catch {
        throw new AppError('SDK.START_FAILED', 'SDK sidecar 启动失败')
      }
      if (typeof child.pid !== 'number' || child.pid <= 0) {
        throw new AppError('SDK.START_FAILED', 'SDK sidecar 启动失败（没有 PID）')
      }
      const startedAt = this.now()
      child.on('exit', () => {
        if (this.running.get(validated.sdk.id)?.child === child) {
          this.running.delete(validated.sdk.id)
        }
        this.log.info('sdk sidecar exited', { id: validated.sdk.id })
      })
      child.on('error', () => {
        if (this.running.get(validated.sdk.id)?.child === child) {
          this.running.delete(validated.sdk.id)
        }
      })
      this.running.set(validated.sdk.id, {
        child,
        pid: child.pid,
        startedAt,
        command: validated.sdk.command,
      })
      this.log.info('sdk sidecar started', {
        id: validated.sdk.id,
        pid: child.pid,
        command: validated.sdk.command,
        args: argv.length,
      })
      return { id: validated.sdk.id, pid: child.pid, startedAt, command: validated.sdk.command }
    } finally {
      this.starting.delete(input.id)
    }
  }

  stop(input: { id: string }): SdkStopResult {
    const running = this.running.get(input.id)
    if (!running) return { id: input.id, stopped: false }
    try {
      running.child.kill()
    } catch {
      /* already gone */
    }
    this.running.delete(input.id)
    this.log.info('sdk sidecar stop requested', { id: input.id, pid: running.pid })
    return { id: input.id, stopped: true }
  }

  /**
   * Last-resort shutdown (app quit / process exit): kill every tracked sidecar.
   *
   * A sidecar is a child of the launcher, not a detached process; if the
   * launcher exits without killing it, it keeps running and holding its port.
   * Synchronous on purpose — async cleanup cannot run after `exit`.
   */
  disposeSync(): number {
    let killed = 0
    for (const [id, running] of [...this.running]) {
      try {
        running.child.kill()
        killed += 1
        this.log.info('sdk sidecar killed at shutdown', { id, pid: running.pid })
      } catch {
        this.log.warn('sdk sidecar kill at shutdown failed', { id, pid: running.pid })
      }
      this.running.delete(id)
    }
    this.starting.clear()
    return killed
  }

  /** Test/ops view of the tracked sidecars (ids only, no child handles). */
  runningIds(): string[] {
    return [...this.running.keys()]
  }

  async openFolder(): Promise<{ path: string; opened: boolean }> {
    const folder = this.ensureDirectory()
    if (!this.options.openPath) return { path: folder, opened: false }
    try {
      await this.options.openPath(folder)
      return { path: folder, opened: true }
    } catch {
      return { path: folder, opened: false }
    }
  }
}

export function createSdkService(options: SdkServiceOptions): SdkService {
  return new SdkService(options)
}
