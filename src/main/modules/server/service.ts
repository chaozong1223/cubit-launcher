import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { AppError } from '@shared/errors'
import type { ServerCreateInput, ServerInfo, ServerState, ServerVersion } from '@shared/server'
import type { ScopedLogger } from '../../kernel/logger'

export interface ServerServiceOptions {
  dataRoot: string
  mcRoot: string | null
  log: ScopedLogger
  /** Picks a Java runtime for the required major version (injected). */
  resolveJava: (requiredMajor: number | null) => Promise<{ path: string; version: string }>
  now?: () => number
}

interface ServerMeta {
  id: string
  name: string
  versionId: string
  mcVersion: string | null
  port: number
  memoryMb: number
  onlineMode: boolean
  createdAt: number
}

interface Runtime {
  proc: ChildProcess | null
  state: ServerState
  pid: number | null
  logs: string[]
}

const LOG_LIMIT = 2000
const NAME_BUDGET = 32

/** Anything that could escape the servers directory is rejected up front. */
function safeName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new AppError('SERVER.INVALID_NAME', '服务器名称不能为空')
  if (/[\\/:*?"<>|]/.test(trimmed)) {
    throw new AppError('SERVER.INVALID_NAME', '服务器名称不能包含 \\ / : * ? " < > |')
  }
  return trimmed.slice(0, NAME_BUDGET)
}

function serversRoot(dataRoot: string): string {
  return path.join(dataRoot, 'servers')
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function downloadToFile(url: string, target: string, sha1: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { timeout: 30_000, headers: { 'User-Agent': 'mc-launcher' } })
    let settled = false
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }
    request.on('timeout', () => request.destroy(new AppError('SERVER.DOWNLOAD_FAILED', '服务端下载超时')))
    request.on('error', (error) => finish(() => reject(error)))
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        finish(() => reject(new AppError('SERVER.DOWNLOAD_FAILED', `服务端下载失败 HTTP ${response.statusCode}`)))
        return
      }
      const hash = crypto.createHash('sha1')
      const part = `${target}.part`
      const out = fs.createWriteStream(part)
      response.on('data', (chunk: Buffer) => hash.update(chunk))
      response.pipe(out)
      out.on('error', (error) => finish(() => reject(error)))
      out.on('finish', () => {
        const actual = hash.digest('hex')
        if (sha1 && actual.toLowerCase() !== sha1.toLowerCase()) {
          fs.rmSync(part, { force: true })
          finish(() =>
            reject(new AppError('SERVER.DOWNLOAD_FAILED', '服务端 jar 校验失败（sha1 不匹配）')),
          )
          return
        }
        fs.renameSync(part, target)
        finish(() => resolve())
      })
    })
  })
}

export class ServerService {
  private readonly runtimes = new Map<string, Runtime>()
  private readonly listeners = new Set<(info: ServerInfo) => void>()

  constructor(private readonly options: ServerServiceOptions) {}

  onChanged(listener: (info: ServerInfo) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(info: ServerInfo): void {
    for (const listener of this.listeners) {
      try {
        listener(info)
      } catch {
        // UI callbacks must never break the server process handling.
      }
    }
  }

  private runtime(id: string): Runtime {
    let runtime = this.runtimes.get(id)
    if (!runtime) {
      runtime = { proc: null, state: 'stopped', pid: null, logs: [] }
      this.runtimes.set(id, runtime)
    }
    return runtime
  }

  private readonlyById(id: string): { meta: ServerMeta; dir: string } | null {
    if (/[\\/]/.test(id)) return null
    const dir = path.join(serversRoot(this.options.dataRoot), id)
    const meta = readJson<ServerMeta>(path.join(dir, 'server.json'))
    return meta ? { meta, dir } : null
  }

  list(): ServerInfo[] {
    const root = serversRoot(this.options.dataRoot)
    let entries: string[] = []
    try {
      entries = fs.readdirSync(root)
    } catch {
      return []
    }
    const out: ServerInfo[] = []
    for (const id of entries) {
      const found = this.readonlyById(id)
      if (!found) continue
      out.push(this.toInfo(found.meta, found.dir))
    }
    return out.sort((a, b) => b.createdAt - a.createdAt)
  }

  private toInfo(meta: ServerMeta, dir: string): ServerInfo {
    const runtime = this.runtime(meta.id)
    return {
      id: meta.id,
      name: meta.name,
      versionId: meta.versionId,
      mcVersion: meta.mcVersion,
      port: meta.port,
      memoryMb: meta.memoryMb,
      onlineMode: meta.onlineMode,
      state: runtime.state,
      pid: runtime.pid,
      dir,
      createdAt: meta.createdAt,
    }
  }

  /** Versions whose JSON carries a downloadable server jar (vanilla and friends). */
  versions(): ServerVersion[] {
    const mcRoot = this.options.mcRoot
    if (!mcRoot) return []
    const versionsDir = path.join(mcRoot, 'versions')
    let entries: string[] = []
    try {
      entries = fs.readdirSync(versionsDir)
    } catch {
      return []
    }
    const out: ServerVersion[] = []
    // A server jar is tied to a Minecraft version, so only plain version ids
    // (1.20.1, 26.3-snapshot-7…) belong here. A modpack directory is a full
    // copy of such a JSON with a renaming id; it would download the *base*
    // server and silently run the wrong version.
    const VERSION_ID = /^\d+\.\d+(?:\.\d+)?(?:[-_].+)?$/
    for (const dirName of entries) {
      const json = readJson<Record<string, unknown>>(path.join(versionsDir, dirName, `${dirName}.json`))
      if (!json) continue
      if (typeof json.inheritsFrom === 'string') continue
      const versionId = typeof json.id === 'string' ? json.id : dirName
      if (!VERSION_ID.test(versionId)) continue
      const downloads = json.downloads as { server?: { url?: string } } | undefined
      if (!downloads?.server?.url) continue
      out.push({ id: dirName, mcVersion: versionId, loader: 'vanilla' })
    }
    return out
  }

  async create(input: ServerCreateInput): Promise<ServerInfo> {
    const name = safeName(input.name)
    const mcRoot = this.options.mcRoot
    if (!mcRoot) throw new AppError('SERVER.NO_MC_ROOT', '还没有选择 .minecraft 目录')
    const versionJson = path.join(mcRoot, 'versions', input.versionId, `${input.versionId}.json`)
    const json = readJson<Record<string, unknown>>(versionJson)
    if (!json) throw new AppError('SERVER.VERSION_MISSING', `找不到版本 ${input.versionId} 的 JSON`)
    const downloads = json.downloads as { server?: { url?: string; sha1?: string } } | undefined
    const serverUrl = downloads?.server?.url
    if (!serverUrl) {
      throw new AppError(
        'SERVER.NOT_SUPPORTED',
        `版本 ${input.versionId} 没有可直接下载的服务端（Forge/Fabric 需要安装器），暂时不能一键开服`,
      )
    }

    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
    const dir = path.join(serversRoot(this.options.dataRoot), id)
    fs.mkdirSync(dir, { recursive: true })

    const jar = path.join(dir, 'server.jar')
    this.options.log.info('server download started', { id, url: serverUrl })
    await downloadToFile(serverUrl, jar, downloads?.server?.sha1 ?? null)

    // The user ticked the EULA box in the UI; we never accept it implicitly.
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n', 'utf8')
    fs.writeFileSync(
      path.join(dir, 'server.properties'),
      [
        `server-port=${input.port}`,
        `online-mode=${input.onlineMode}`,
        'max-players=20',
        `motd=${name}`,
        'enable-command-block=true',
        '',
      ].join('\n'),
      'utf8',
    )
    const meta: ServerMeta = {
      id,
      name,
      versionId: input.versionId,
      mcVersion: typeof json.id === 'string' ? json.id : input.versionId,
      port: input.port,
      memoryMb: input.memoryMb,
      onlineMode: input.onlineMode,
      createdAt: (this.options.now ?? Date.now)(),
    }
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(meta, null, 2), 'utf8')
    this.options.log.info('server created', { id, versionId: input.versionId })
    return this.toInfo(meta, dir)
  }

  async start(id: string): Promise<ServerInfo> {
    const found = this.readonlyById(id)
    if (!found) throw new AppError('SERVER.NOT_FOUND', '服务器不存在')
    const runtime = this.runtime(id)
    if (runtime.state === 'running' || runtime.state === 'starting') {
      return this.toInfo(found.meta, found.dir)
    }

    const java = await this.options.resolveJava(this.requiredJava(found.meta.versionId))
    const jar = path.join(found.dir, 'server.jar')
    if (!fs.existsSync(jar)) throw new AppError('SERVER.JAR_MISSING', 'server.jar 丢失，请删除后重新创建')

    const args = [`-Xmx${found.meta.memoryMb}M`, '-jar', 'server.jar', 'nogui']
    runtime.state = 'starting'
    this.emit(this.toInfo(found.meta, found.dir))

    const proc = spawn(java.path, args, { cwd: found.dir, windowsHide: true })
    runtime.proc = proc
    runtime.pid = proc.pid ?? null
    runtime.logs = []
    this.appendLog(runtime, `# 使用 Java ${java.version}: ${java.path}`)

    const onLine = (line: string): void => {
      this.appendLog(runtime, line)
      if (/Done \(|For help, type/i.test(line) && runtime.state !== 'running') {
        runtime.state = 'running'
        this.emit(this.toInfo(found.meta, found.dir))
      }
    }
    this.pipeLines(proc.stdout, onLine)
    this.pipeLines(proc.stderr, onLine)

    proc.once('exit', (code, signal) => {
      runtime.proc = null
      runtime.pid = null
      runtime.state = code === 0 ? 'stopped' : 'crashed'
      this.appendLog(
        runtime,
        `# 服务端已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`,
      )
      this.emit(this.toInfo(found.meta, found.dir))
    })

    return this.toInfo(found.meta, found.dir)
  }

  async stop(id: string): Promise<ServerInfo> {
    const found = this.readonlyById(id)
    if (!found) throw new AppError('SERVER.NOT_FOUND', '服务器不存在')
    const runtime = this.runtime(id)
    if (!runtime.proc) return this.toInfo(found.meta, found.dir)
    runtime.state = 'stopping'
    this.emit(this.toInfo(found.meta, found.dir))
    try {
      runtime.proc.stdin?.write('stop\n')
    } catch {
      // stdin may already be gone; the kill below still applies.
    }
    const proc = runtime.proc
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (runtime.proc === proc) proc.kill()
        resolve()
      }, 15_000)
      proc.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    return this.toInfo(found.meta, found.dir)
  }

  command(id: string, command: string): { ok: boolean } {
    const runtime = this.runtimes.get(id)
    if (!runtime?.proc?.stdin) return { ok: false }
    runtime.proc.stdin.write(`${command}\n`)
    this.appendLog(runtime, `> ${command}`)
    return { ok: true }
  }

  logs(id: string, lines = 200): string[] {
    const runtime = this.runtimes.get(id)
    if (!runtime) return []
    return runtime.logs.slice(-lines)
  }

  async remove(id: string): Promise<{ ok: boolean }> {
    const found = this.readonlyById(id)
    if (!found) return { ok: false }
    await this.stop(id)
    fs.rmSync(found.dir, { recursive: true, force: true })
    this.runtimes.delete(id)
    return { ok: true }
  }

  status(id: string): ServerInfo | null {
    const found = this.readonlyById(id)
    return found ? this.toInfo(found.meta, found.dir) : null
  }

  /** Reads the required Java major from the version JSON; 17 when unknown. */
  private requiredJava(versionId: string): number | null {
    const mcRoot = this.options.mcRoot
    if (!mcRoot) return null
    const json = readJson<{ javaVersion?: { majorVersion?: number } }>(
      path.join(mcRoot, 'versions', versionId, `${versionId}.json`),
    )
    const major = json?.javaVersion?.majorVersion
    return typeof major === 'number' ? major : null
  }

  private pipeLines(stream: NodeJS.ReadableStream | null, onLine: (line: string) => void): void {
    if (!stream) return
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '')
        buffer = buffer.slice(index + 1)
        if (line) onLine(line)
        index = buffer.indexOf('\n')
      }
      if (buffer.length > 8_000) {
        onLine(buffer)
        buffer = ''
      }
    })
  }

  private appendLog(runtime: Runtime, line: string): void {
    runtime.logs.push(line)
    if (runtime.logs.length > LOG_LIMIT) runtime.logs.splice(0, runtime.logs.length - LOG_LIMIT)
  }
}
