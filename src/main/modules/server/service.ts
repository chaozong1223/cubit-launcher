import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { AppError } from '@shared/errors'
import type {
  ServerCreateInput,
  ServerInfo,
  ServerLoader,
  ServerState,
  ServerVersion,
} from '@shared/server'
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
  loader: ServerLoader
  loaderVersion: string | null
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
const INSTALLER_TIMEOUT_MS = 10 * 60_000

/** Fabric installer pinned: the meta only lists loader versions, not the tool. */
const FABRIC_INSTALLER = { version: '1.0.1', url: 'https://maven.fabricmc.net/net/fabricmc/fabric-installer/1.0.1/fabric-installer-1.0.1.jar' }
const QUILT_INSTALLER = { version: '0.11.2', url: 'https://maven.quiltmc.org/repository/release/org/quiltmc/quilt-installer/0.11.2/quilt-installer-0.11.2.jar' }

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

/** Loader facts read from a version JSON (id, inheritsFrom, libraries). */
interface VersionLoaderInfo {
  loader: ServerLoader
  loaderVersion: string | null
  mcVersion: string | null
}

function argValue(args: unknown, key: string): string | null {
  if (!Array.isArray(args)) return null
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === key && typeof args[index + 1] === 'string') {
      return args[index + 1] as string
    }
  }
  return null
}

function detectLoader(json: Record<string, unknown>, dirName: string): VersionLoaderInfo {
  const inherits = typeof json.inheritsFrom === 'string' ? json.inheritsFrom : null
  const gameArgs = (json.arguments as { game?: unknown } | undefined)?.game
  // Modern Forge/NeoForge carry their identity in the launch arguments; the
  // libraries only list sub-modules (accesstransformers, eventbus, …), so a
  // library-name scan alone misses every 1.20.1+ profile.
  const neoForgeArg = argValue(gameArgs, '--fml.neoForgeVersion')
  const forgeArg = argValue(gameArgs, '--fml.forgeVersion')
  const mcArg = argValue(gameArgs, '--fml.mcVersion')
  if (neoForgeArg) {
    return { loader: 'neoforge', loaderVersion: neoForgeArg, mcVersion: mcArg ?? inherits }
  }
  if (forgeArg) {
    return { loader: 'forge', loaderVersion: forgeArg, mcVersion: mcArg ?? inherits }
  }

  const libraries = Array.isArray(json.libraries) ? json.libraries : []
  const names = libraries
    .map((entry) => (entry && typeof entry === 'object' ? String((entry as { name?: unknown }).name ?? '') : ''))
    .filter(Boolean)
  const neoForge = names.find((name) => name.startsWith('net.neoforged:neoforge:'))
  if (neoForge) {
    return { loader: 'neoforge', loaderVersion: neoForge.split(':')[2] ?? null, mcVersion: inherits }
  }
  // NeoForge 1.20.1 ships under net.neoforged:forge.
  const neoForgeForge = names.find((name) => name.startsWith('net.neoforged:forge:'))
  if (neoForgeForge) {
    const version = neoForgeForge.split(':')[2] ?? null
    return {
      loader: 'neoforge',
      loaderVersion: version?.includes('-') ? version.slice(version.indexOf('-') + 1) : version,
      mcVersion: inherits,
    }
  }
  const forge = names.find((name) => name.startsWith('net.minecraftforge:forge:'))
  if (forge) {
    const version = forge.split(':')[2] ?? null
    return {
      loader: 'forge',
      loaderVersion: version?.includes('-') ? version.slice(version.indexOf('-') + 1) : version,
      mcVersion: inherits,
    }
  }
  const quilt = names.find((name) => name.startsWith('org.quiltmc:quilt-loader:'))
  if (quilt) return { loader: 'quilt', loaderVersion: quilt.split(':')[2] ?? null, mcVersion: inherits }
  const fabric = names.find((name) => name.startsWith('net.fabricmc:fabric-loader:'))
  if (fabric) return { loader: 'fabric', loaderVersion: fabric.split(':')[2] ?? null, mcVersion: inherits }

  // Last resort: the directory/id pattern `<mc>-<loader>-<version>`.
  const id = typeof json.id === 'string' ? json.id : dirName
  const match = /^(\d+\.\d+(?:\.\d+)?)-(forge|neoforge|fabric|quilt)-(.+)$/i.exec(id)
  if (match) {
    return {
      loader: match[2].toLowerCase() as ServerLoader,
      loaderVersion: match[3],
      mcVersion: inherits ?? match[1],
    }
  }
  return { loader: 'vanilla', loaderVersion: null, mcVersion: id }
}

function versionFile(mcRoot: string, dirName: string): string {
  return path.join(mcRoot, 'versions', dirName, `${dirName}.json`)
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

  /**
   * Versions that can become a server:
   *  - vanilla: `<mcRoot>/versions/<id>/<id>.json` carries `downloads.server`;
   *  - loader: the JSON inherits a base version and lists the loader library,
   *    which is enough to run the loader installer with `--installServer`.
   * Pack directories that merely copy a version JSON are still excluded unless
   * they are a loader profile (they would silently run the base version).
   */
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
    const VERSION_ID = /^\d+\.\d+(?:\.\d+)?(?:[-_].+)?$/
    for (const dirName of entries) {
      const json = readJson<Record<string, unknown>>(versionFile(mcRoot, dirName))
      if (!json) continue
      const info = detectLoader(json, dirName)
      if (info.loader === 'vanilla') {
        // Only real version ids: a renamed copy would download the base server.
        if (!VERSION_ID.test(String(json.id ?? ''))) continue
        const downloads = json.downloads as { server?: { url?: string } } | undefined
        if (!downloads?.server?.url) continue
        out.push({ id: dirName, mcVersion: String(json.id ?? dirName), loader: 'vanilla', loaderVersion: null })
        continue
      }
      // Loader profile: needs mcVersion + loaderVersion for the installer URL.
      const mcVersion = info.mcVersion ?? null
      if (!mcVersion || !info.loaderVersion) continue
      out.push({
        id: dirName,
        mcVersion,
        loader: info.loader,
        loaderVersion: info.loaderVersion,
      })
    }
    return out
  }

  async create(input: ServerCreateInput): Promise<ServerInfo> {
    const name = safeName(input.name)
    const mcRoot = this.options.mcRoot
    if (!mcRoot) throw new AppError('SERVER.NO_MC_ROOT', '还没有选择 .minecraft 目录')
    const json = readJson<Record<string, unknown>>(versionFile(mcRoot, input.versionId))
    if (!json) throw new AppError('SERVER.VERSION_MISSING', `找不到版本 ${input.versionId} 的 JSON`)
    const info = detectLoader(json, input.versionId)
    const downloads = json.downloads as { server?: { url?: string; sha1?: string } } | undefined
    const serverUrl = downloads?.server?.url ?? null
    if (info.loader === 'vanilla' && !serverUrl) {
      throw new AppError(
        'SERVER.NOT_SUPPORTED',
        `版本 ${input.versionId} 没有可直接下载的服务端，也不是受支持的加载器版本`,
      )
    }

    const id = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`
    const dir = path.join(serversRoot(this.options.dataRoot), id)
    fs.mkdirSync(dir, { recursive: true })

    if (info.loader === 'vanilla') {
      const jar = path.join(dir, 'server.jar')
      this.options.log.info('server download started', { id, url: serverUrl })
      await downloadToFile(serverUrl as string, jar, downloads?.server?.sha1 ?? null)
    } else {
      await this.installLoaderServer(dir, info, json)
    }

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
      mcVersion: info.mcVersion ?? (typeof json.id === 'string' ? json.id : input.versionId),
      loader: info.loader,
      loaderVersion: info.loaderVersion,
      port: input.port,
      memoryMb: input.memoryMb,
      onlineMode: input.onlineMode,
      createdAt: (this.options.now ?? Date.now)(),
    }
    fs.writeFileSync(path.join(dir, 'server.json'), JSON.stringify(meta, null, 2), 'utf8')
    this.options.log.info('server created', {
      id,
      versionId: input.versionId,
      loader: info.loader,
      loaderVersion: info.loaderVersion,
    })
    return this.toInfo(meta, dir)
  }

  /** Runs the loader installer with `--installServer` (Fabric/Quilt use their own flags). */
  private async installLoaderServer(
    dir: string,
    info: VersionLoaderInfo,
    json: Record<string, unknown>,
  ): Promise<void> {
    const mcVersion = info.mcVersion
    const loaderVersion = info.loaderVersion
    if (!mcVersion || !loaderVersion) {
      throw new AppError('SERVER.NOT_SUPPORTED', '无法从版本 JSON 推断出 MC 版本或加载器版本')
    }
    const java = await this.options.resolveJava(this.requiredJava(info.mcVersion))
    const installerJar = path.join(dir, 'installer.jar')

    if (info.loader === 'forge' || info.loader === 'neoforge') {
      const url = this.loaderInstallerUrl(info.loader, mcVersion, loaderVersion)
      this.options.log.info('server installer download', { loader: info.loader, url })
      await downloadToFile(url, installerJar, null)
      await this.runInstaller(java.path, dir, ['-jar', installerJar, '--installServer', dir])
      return
    }
    if (info.loader === 'fabric') {
      await downloadToFile(FABRIC_INSTALLER.url, installerJar, null)
      await this.runInstaller(java.path, dir, [
        '-jar',
        installerJar,
        'server',
        '-mcversion',
        mcVersion,
        '-loader',
        loaderVersion,
        '-downloadMinecraft',
      ])
      return
    }
    if (info.loader === 'quilt') {
      await downloadToFile(QUILT_INSTALLER.url, installerJar, null)
      await this.runInstaller(java.path, dir, [
        '-jar',
        installerJar,
        'install',
        'server',
        mcVersion,
        loaderVersion,
        `--install-dir=${dir}`,
      ])
      return
    }
    throw new AppError('SERVER.NOT_SUPPORTED', `不支持的加载器：${String(info.loader)}`)
  }

  private loaderInstallerUrl(loader: ServerLoader, mcVersion: string, loaderVersion: string): string {
    if (loader === 'forge') {
      const combined = `${mcVersion}-${loaderVersion}`
      return `https://maven.minecraftforge.net/net/minecraftforge/forge/${combined}/forge-${combined}-installer.jar`
    }
    if (loader === 'neoforge') {
      // 1.20.1 ships under net.neoforged:forge with the mc version prefix;
      // 1.20.2+ uses the standalone artifact and the loader version alone.
      if (mcVersion === '1.20.1') {
        const combined = `${mcVersion}-${loaderVersion}`
        return `https://maven.neoforged.net/releases/net/neoforged/forge/${combined}/forge-${combined}-installer.jar`
      }
      return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${loaderVersion}/neoforge-${loaderVersion}-installer.jar`
    }
    throw new AppError('SERVER.NOT_SUPPORTED', `不支持的加载器：${loader}`)
  }

  private runInstaller(javaPath: string, cwd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(javaPath, args, { cwd, windowsHide: true })
      let output = ''
      const collect = (chunk: Buffer | string): void => {
        output += String(chunk)
        if (output.length > 20_000) output = output.slice(-20_000)
      }
      proc.stdout?.on('data', collect)
      proc.stderr?.on('data', collect)
      const timer = setTimeout(() => {
        proc.kill()
        reject(new AppError('SERVER.INSTALL_FAILED', '加载器安装超时（10 分钟）'))
      }, INSTALLER_TIMEOUT_MS)
      proc.once('error', (error) => {
        clearTimeout(timer)
        reject(new AppError('SERVER.INSTALL_FAILED', `安装器启动失败：${error.message}`))
      })
      proc.once('exit', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new AppError('SERVER.INSTALL_FAILED', `安装器退出码 ${code}：${output.slice(-800)}`))
      })
    })
  }

  async start(id: string): Promise<ServerInfo> {
    const found = this.readonlyById(id)
    if (!found) throw new AppError('SERVER.NOT_FOUND', '服务器不存在')
    const runtime = this.runtime(id)
    if (runtime.state === 'running' || runtime.state === 'starting') {
      return this.toInfo(found.meta, found.dir)
    }

    const java = await this.options.resolveJava(this.requiredJava(found.meta.mcVersion))
    const command = this.startCommand(found.meta, found.dir, java.path)
    if (!command) {
      throw new AppError('SERVER.JAR_MISSING', '服务端文件不完整（loader 安装产物缺失），请删除后重新创建')
    }

    runtime.state = 'starting'
    this.emit(this.toInfo(found.meta, found.dir))

    const proc = spawn(command.file, command.args, {
      cwd: found.dir,
      windowsHide: true,
      ...(command.env ? { env: { ...process.env, ...command.env } } : {}),
    })
    runtime.proc = proc
    runtime.pid = proc.pid ?? null
    runtime.logs = []
    this.appendLog(runtime, `# ${command.file} ${command.args.join(' ')}`)
    this.appendLog(runtime, `# Java ${java.version}: ${java.path}`)

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
      this.appendLog(runtime, `# 服务端已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
      this.emit(this.toInfo(found.meta, found.dir))
    })

    return this.toInfo(found.meta, found.dir)
  }

  /** Command that boots this server, or null when the install artifacts are gone. */
  private startCommand(
    meta: ServerMeta,
    dir: string,
    javaPath: string,
  ): { file: string; args: string[]; env?: Record<string, string> } | null {
    if (meta.loader === 'vanilla') {
      const jar = path.join(dir, 'server.jar')
      if (!fs.existsSync(jar)) return null
      return { file: javaPath, args: [`-Xmx${meta.memoryMb}M`, '-jar', 'server.jar', 'nogui'] }
    }
    if (meta.loader === 'fabric') {
      const jar = fs.existsSync(path.join(dir, 'fabric-server-launch.jar'))
        ? 'fabric-server-launch.jar'
        : null
      if (!jar) return null
      return { file: javaPath, args: [`-Xmx${meta.memoryMb}M`, '-jar', jar, 'nogui'] }
    }
    if (meta.loader === 'quilt') {
      const jar = fs.existsSync(path.join(dir, 'quilt-server-launch.jar'))
        ? 'quilt-server-launch.jar'
        : null
      if (!jar) return null
      return { file: javaPath, args: [`-Xmx${meta.memoryMb}M`, '-jar', jar, 'nogui'] }
    }
    // Forge / NeoForge: the installer writes run.bat (Windows) or run.sh and the
    // @arg files next to libraries/. Running the script keeps its JVM wiring.
    if (process.platform === 'win32') {
      const bat = path.join(dir, 'run.bat')
      if (!fs.existsSync(bat)) return null
      // The generated script resolves `java` from JAVA_HOME/PATH; point it at the
      // runtime we picked instead of whatever the machine happens to have.
      return {
        file: 'cmd.exe',
        args: ['/c', 'run.bat', 'nogui'],
        env: { JAVA_HOME: path.dirname(path.dirname(javaPath)) },
      }
    }
    const sh = path.join(dir, 'run.sh')
    if (!fs.existsSync(sh)) return null
    return {
      file: 'sh',
      args: [sh, 'nogui'],
      env: { JAVA_HOME: path.dirname(path.dirname(javaPath)) },
    }
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
  private requiredJava(versionId: string | null): number | null {
    const mcRoot = this.options.mcRoot
    if (!mcRoot || !versionId) return null
    const json = readJson<{ javaVersion?: { majorVersion?: number } }>(versionFile(mcRoot, versionId))
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
