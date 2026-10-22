import path from 'node:path'
import type { ProcessPort, SpawnedProcess } from '../../../core/ports'
import { LoaderError } from './errors'

/**
 * Forge/NeoForge installer execution (SEC-EXE-05/-06).
 *
 * - arguments are a fixed whitelist: headless flag, `-jar`, installer, and
 *   `--installClient <mcRoot>`; nothing from a modpack/user string is passed;
 * - `cwd` is a temp directory, never the instance root; the target root is an
 *   absolute argument;
 * - stdout/stderr are parsed line by line into progress; the full tail is kept
 *   for the failure message.
 */

export const INSTALLER_TIMEOUT_MS = 15 * 60 * 1000
export const MAX_LOG_LINES = 400

export interface ParsedInstallerLine {
  currentTask: string | null
  percent: number | null
  error: boolean
}

const TASK_PATTERNS: Array<{ pattern: RegExp; label: (match: RegExpMatchArray) => string }> = [
  { pattern: /^Analyzing\s+(.+?)\s*\.{0,3}$/i, label: (m) => `分析 ${m[1]}` },
  {
    pattern: /^Downloading\s+(?:(\d+)\s+)?(.+?)\s*\.{0,3}$/i,
    label: (m) => (m[1] ? `下载 ${m[1]} 个 ${m[2]}` : `下载 ${m[2]}`),
  },
  { pattern: /^Downloaded\s+(.+?)\s*\.{0,3}$/i, label: (m) => `已下载 ${m[1]}` },
  { pattern: /^Extracting\s+(.+?)\s*\.{0,3}$/i, label: (m) => `解压 ${m[1]}` },
  { pattern: /^Extracted\s+(.+?)\s*\.{0,3}$/i, label: (m) => `已解压 ${m[1]}` },
  { pattern: /^Installing\s+(.+?)\s*\.{0,3}$/i, label: (m) => `安装 ${m[1]}` },
  { pattern: /^Installed\s+(.+?)\s*\.{0,3}$/i, label: (m) => `已安装 ${m[1]}` },
  { pattern: /^Processing\s+(.+?)\s*\.{0,3}$/i, label: (m) => `处理 ${m[1]}` },
  { pattern: /^Building\s+(.+?)\s*\.{0,3}$/i, label: (m) => `构建 ${m[1]}` },
  { pattern: /^Applying\s+(.+?)\s*\.{0,3}$/i, label: (m) => `应用 ${m[1]}` },
  { pattern: /^Copying\s+(.+?)\s*\.{0,3}$/i, label: (m) => `复制 ${m[1]}` },
  { pattern: /^Patching\s+(.+?)\s*\.{0,3}$/i, label: (m) => `修补 ${m[1]}` },
  { pattern: /^Validating\s+(.+?)\s*\.{0,3}$/i, label: (m) => `校验 ${m[1]}` },
  { pattern: /^Starting\s+(.+?)\s*\.{0,3}$/i, label: (m) => `开始 ${m[1]}` },
  { pattern: /^Created\s+(.+?)\s*\.{0,3}$/i, label: (m) => `已创建 ${m[1]}` },
]

const ERROR_PATTERN =
  /(\berrors?\b|\bfailed\b|\bfailure\b|\bfatal\b|could not|cannot|unable to|exception|refused|denied)/i
const BENIGN_PATTERN = /\b0 (?:errors?|failures?)\b/i

/** Pure line parser; exported for tests (docs/01 F09/F10 output shapes). */
export function parseInstallerLine(rawLine: string): ParsedInstallerLine {
  const line = rawLine.trim()
  if (!line) return { currentTask: null, percent: null, error: false }

  let percent: number | null = null
  const percentMatch = /(\d{1,3})\s*%/.exec(line) ?? /\((\d+)\s*\/\s*(\d+)\)/.exec(line)
  if (percentMatch) {
    if (percentMatch.length === 2) {
      percent = Number(percentMatch[1])
    } else {
      const done = Number(percentMatch[1])
      const total = Number(percentMatch[2])
      if (total > 0) percent = Math.round((done / total) * 100)
    }
    if (percent !== null && (!Number.isFinite(percent) || percent < 0 || percent > 100)) {
      percent = null
    }
  }

  // Forge/NeoForge prefix progress lines with `(3/18)`; strip it for the verb
  // match so both `Downloading …` and `(3/18) Downloading …` map to a task.
  const stripped = line.replace(/^[(\[]\s*\d+\s*\/\s*\d+\s*[)\]]\s*/, '')

  let currentTask: string | null = null
  for (const { pattern, label } of TASK_PATTERNS) {
    const match = pattern.exec(stripped)
    if (match) {
      currentTask = label(match)
      break
    }
  }

  const error = ERROR_PATTERN.test(line) && !BENIGN_PATTERN.test(line)
  return { currentTask, percent, error }
}

export interface InstallerRunOptions {
  ports: ProcessPort
  javaPath: string
  jarPath: string
  mcRoot: string
  workDir: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  signal?: AbortSignal
  onLine?: (line: string, stream: 'stdout' | 'stderr') => void
  onParsed?: (parsed: ParsedInstallerLine, line: string, stream: 'stdout' | 'stderr') => void
}

export interface InstallerRunResult {
  exitCode: number | null
  signal: string | null
  durationMs: number
  lines: string[]
  stderrTail: string[]
  errorLines: string[]
  timedOut: boolean
  cancelled: boolean
  errorCode: string | null
}

const ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROCESSOR_ARCHITECTURE',
  'JAVA_HOME',
] as const

export function installerEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of ENV_KEYS) {
    if (env[key] !== undefined) out[key] = env[key]
  }
  return out
}

/** Whitelisted argv; never derived from user/pack input (SEC-EXE-06). */
export function installerArguments(jarPath: string, mcRoot: string): string[] {
  return ['-Djava.awt.headless=true', '-jar', jarPath, '--installClient', mcRoot]
}

class LineSplitter {
  private buffer = ''

  feed(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    let start = 0
    for (let index = 0; index < this.buffer.length; index += 1) {
      const character = this.buffer[index]
      if (character === '\n') {
        lines.push(this.buffer.slice(start, index))
        start = index + 1
      } else if (character === '\r') {
        if (index + 1 === this.buffer.length) break
        lines.push(this.buffer.slice(start, index))
        if (this.buffer[index + 1] === '\n') index += 1
        start = index + 1
      }
    }
    this.buffer = this.buffer.slice(start)
    while (this.buffer.length > 8192) {
      lines.push(this.buffer.slice(0, 8192))
      this.buffer = this.buffer.slice(8192)
    }
    return lines
  }

  flush(): string | null {
    const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
    this.buffer = ''
    return rest.length > 0 ? rest : null
  }
}

/**
 * One streaming UTF-8 decoder per stream (R1/H13).
 *
 * A fresh `TextDecoder` per chunk cannot be correct: a 3-byte Chinese character
 * split across two `data` events becomes two replacement characters, which is
 * exactly the "garbled installer log" reported on Chinese Windows. `stream:true`
 * keeps the incomplete tail inside the decoder until the next chunk, and
 * `flush()` emits/escapes whatever is left once the process has exited.
 */
function createChunkDecoder(): { decode(chunk: Buffer | string): string; flush(): string } {
  const decoder = new TextDecoder('utf-8', { fatal: false })
  return {
    decode(chunk) {
      return typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    },
    flush() {
      return decoder.decode()
    },
  }
}

export async function runInstaller(options: InstallerRunOptions): Promise<InstallerRunResult> {
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? INSTALLER_TIMEOUT_MS
  const lines: string[] = []
  const stderrTail: string[] = []
  const errorLines: string[] = []
  let timedOut = false
  let cancelled = false
  let child: SpawnedProcess | null = null
  let errorCode: string | null = null

  const record = (line: string, stream: 'stdout' | 'stderr') => {
    if (!line.trim()) return
    lines.push(stream === 'stderr' ? `[stderr] ${line}` : line)
    if (lines.length > MAX_LOG_LINES) lines.splice(0, lines.length - MAX_LOG_LINES)
    if (stream === 'stderr') {
      stderrTail.push(line)
      if (stderrTail.length > 60) stderrTail.shift()
    }
    options.onLine?.(line, stream)
    const parsed = parseInstallerLine(line)
    if (parsed.error) {
      errorLines.push(line)
      if (errorLines.length > 40) errorLines.shift()
    }
    options.onParsed?.(parsed, line, stream)
  }

  try {
    child = options.ports.spawn(options.javaPath, installerArguments(options.jarPath, options.mcRoot), {
      cwd: options.workDir,
      env: installerEnvironment(options.env),
      windowsHide: true,
    })
  } catch (error) {
    throw new LoaderError('LOADER.INSTALLER_FAILED', {
      message: `cannot start installer: ${error instanceof Error ? error.message : String(error)}`,
      cause: error,
    })
  }

  const timer = setTimeout(() => {
    timedOut = true
    try {
      child?.kill()
    } catch {
      /* process may already be gone */
    }
  }, timeoutMs)

  const onAbort = () => {
    cancelled = true
    try {
      child?.kill()
    } catch {
      /* ignore */
    }
  }
  if (options.signal) {
    if (options.signal.aborted) onAbort()
    else options.signal.addEventListener('abort', onAbort, { once: true })
  }

  const stdoutSplitter = new LineSplitter()
  const stderrSplitter = new LineSplitter()
  const stdoutDecoder = createChunkDecoder()
  const stderrDecoder = createChunkDecoder()

  child.stdout?.on('data', (chunk: Buffer | string) => {
    for (const line of stdoutSplitter.feed(stdoutDecoder.decode(chunk))) record(line, 'stdout')
  })
  child.stderr?.on('data', (chunk: Buffer | string) => {
    for (const line of stderrSplitter.feed(stderrDecoder.decode(chunk))) record(line, 'stderr')
  })

  const exit = await new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    let settled = false
    const finish = (code: number | null, signal: string | null) => {
      if (settled) return
      settled = true
      resolve({ code, signal })
    }
    child?.once('exit', (code: number | null, signal: NodeJS.Signals | null) =>
      finish(code, signal ?? null),
    )
    child?.once('error', (error: Error) => {
      errorCode = (error as NodeJS.ErrnoException).code ?? 'SPAWN_ERROR'
      record(`process error: ${error.message}`, 'stderr')
      finish(null, null)
    })
  })

  clearTimeout(timer)
  if (options.signal) options.signal.removeEventListener('abort', onAbort)
  // Give the last stream chunks a tick to land after `exit`; only then can the
  // decoder/splitter flush safely (a chunk that arrives later must still be
  // decoded as part of the same stream, not after a premature decoder flush).
  await new Promise((resolve) => setTimeout(resolve, 30))

  // Flush the decoders first: a trailing incomplete multi-byte sequence must be
  // released before the line splitters emit their last partial line.
  const stdoutDecoderTail = stdoutDecoder.flush()
  if (stdoutDecoderTail) {
    for (const line of stdoutSplitter.feed(stdoutDecoderTail)) record(line, 'stdout')
  }
  const stderrDecoderTail = stderrDecoder.flush()
  if (stderrDecoderTail) {
    for (const line of stderrSplitter.feed(stderrDecoderTail)) record(line, 'stderr')
  }
  const flushLine = stdoutSplitter.flush()
  if (flushLine) record(flushLine, 'stdout')
  const flushErr = stderrSplitter.flush()
  if (flushErr) record(flushErr, 'stderr')

  return {
    exitCode: exit.code,
    signal: exit.signal,
    durationMs: Date.now() - startedAt,
    lines,
    stderrTail,
    errorLines,
    timedOut,
    cancelled,
    errorCode,
  }
}

export function formatInstallerFailure(result: InstallerRunResult): string {
  const tail = [...result.errorLines, ...result.stderrTail].slice(-8)
  const detail = tail.length > 0 ? tail.join(' | ') : result.lines.slice(-8).join(' | ')
  if (result.timedOut) return `installer timed out after ${Math.round(result.durationMs / 1000)}s`
  if (result.errorCode) return `installer could not start (${result.errorCode})`
  return `installer exited with code ${result.exitCode}${result.signal ? ` (${result.signal})` : ''}${
    detail ? `: ${detail}` : ''
  }`
}

export interface DetectedVersion {
  versionId: string
  dirName: string
  jsonPath: string
}

/** Finds the version directory the installer created (set difference on disk). */
export function detectInstalledVersion(
  fs: { exists(target: string): boolean; readDir(target: string): string[]; stat(target: string): { isDirectory(): boolean } | null; readText(target: string): string },
  mcRoot: string,
  before: string[],
  expectedId: string,
  mcVersion: string,
): DetectedVersion | null {
  const versionsDir = path.join(mcRoot, 'versions')
  const beforeSet = new Set(before)
  const candidates: DetectedVersion[] = []
  for (const dirName of fs.readDir(versionsDir)) {
    if (beforeSet.has(dirName)) continue
    const dir = path.join(versionsDir, dirName)
    if (!fs.stat(dir)?.isDirectory()) continue
    const jsonPath = path.join(dir, `${dirName}.json`)
    if (!fs.exists(jsonPath)) continue
    try {
      const json = JSON.parse(fs.readText(jsonPath)) as { id?: unknown; inheritsFrom?: unknown }
      candidates.push({ versionId: typeof json.id === 'string' ? json.id : dirName, dirName, jsonPath })
    } catch {
      /* ignore unparsable leftovers; rollback will remove them */
    }
  }
  if (candidates.length === 0) return null
  return (
    candidates.find((candidate) => candidate.dirName === expectedId) ??
    candidates.find((candidate) => candidate.versionId === expectedId) ??
    candidates.find((candidate) => {
      try {
        const json = JSON.parse(fs.readText(candidate.jsonPath)) as { inheritsFrom?: unknown }
        return json.inheritsFrom === mcVersion
      } catch {
        return false
      }
    }) ??
    candidates[0]
  )
}
