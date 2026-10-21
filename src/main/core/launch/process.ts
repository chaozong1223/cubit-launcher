import path from 'node:path'
import type { CrashHint } from '@shared/launch'
import { CoreError } from '../errors'
import {
  nodeFsPort,
  nodeProcessPort,
  type FsPort,
  type ProcessPort,
  type SpawnedProcess,
} from '../ports'
import { detectCrashHints } from './hints'

export type LaunchStream = 'stdout' | 'stderr' | 'system'
export type LaunchClassification = 'normal' | 'crashed' | 'suspect' | 'killed'

export interface LaunchLine {
  stream: LaunchStream
  text: string
  at: number
}

export interface LaunchExit {
  sessionId: string
  instanceId: string
  exitCode: number | null
  signal: string | null
  startedAt: number
  exitedAt: number
  durationMs: number
  classification: LaunchClassification
  crashHints: CrashHint[]
  logFile: string
  lastLines: string[]
  sawMenu: boolean
}

export interface StartLaunchProcessOptions {
  sessionId: string
  instanceId: string
  javaPath: string
  argv: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  logFile: string
  /** Text encoding of the child's stdout/stderr (GBK on code page 936). */
  encoding?: string
  fs?: FsPort
  ports?: ProcessPort
  now?: () => number
  killGraceMs?: number
  /** Marker that proves the game reached the main menu (R5.4). */
  menuMarker?: string
  /** Extra header lines written before the first game line. */
  headerLines?: string[]
}

export interface LaunchProcessHandle {
  readonly sessionId: string
  readonly pid: number | undefined
  readonly logFile: string
  waitForExit(): Promise<LaunchExit>
  stop(): Promise<void>
  onLine(listener: (line: LaunchLine) => void): () => void
  writeStdin(text: string): void
  isRunning(): boolean
}

const MAX_LINE_LENGTH = 64 * 1024
const RING_SIZE = 200
const REPORT_LINES = 100

/**
 * Splits decoded text into lines. `\r` at a chunk boundary is held until the
 * next chunk so `\r\n` never produces an empty line.
 */
export class LineSplitter {
  private buffer = ''

  constructor(private readonly maxLineLength: number = MAX_LINE_LENGTH) {}

  feed(chunk: string): string[] {
    this.buffer += chunk
    const lines: string[] = []
    let start = 0

    for (let index = 0; index < this.buffer.length; index += 1) {
      const character = this.buffer[index]
      if (character === '\n') {
        lines.push(this.buffer.slice(start, index))
        start = index + 1
        continue
      }
      if (character === '\r') {
        if (index + 1 === this.buffer.length) break // wait for a possible \n
        lines.push(this.buffer.slice(start, index))
        if (this.buffer[index + 1] === '\n') index += 1
        start = index + 1
      }
    }

    this.buffer = this.buffer.slice(start)

    while (this.buffer.length > this.maxLineLength) {
      lines.push(this.buffer.slice(0, this.maxLineLength))
      this.buffer = this.buffer.slice(this.maxLineLength)
    }

    return lines
  }

  flush(): string | null {
    const rest = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer
    this.buffer = ''
    return rest.length > 0 ? rest : null
  }
}

function classifyExit(
  exitCode: number | null,
  signal: string | null,
  sawMenu: boolean,
  durationMs: number,
  killedByUser: boolean,
): LaunchClassification {
  if (killedByUser) return 'killed'
  if (signal !== null) return 'killed'
  if (exitCode !== 0) return 'crashed'
  if (!sawMenu && durationMs < 30_000) return 'suspect'
  return 'normal'
}

function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      },
    )
  })
}

/**
 * Starts Java and streams merged stdout/stderr line by line.
 *
 * - the raw transcript goes to `logFile` with a stream marker (R5.2);
 * - listeners get every line as soon as it is decoded;
 * - `waitForExit()` resolves with exit code, signal, duration and crash hints.
 */
export function startLaunchProcess(options: StartLaunchProcessOptions): LaunchProcessHandle {
  const fs = options.fs ?? nodeFsPort()
  const ports = options.ports ?? nodeProcessPort()
  const now = options.now ?? Date.now
  const marker = options.menuMarker ?? 'Sound engine started'
  const listeners = new Set<(line: LaunchLine) => void>()
  const ring: string[] = []
  let sawMenu = false
  let killedByUser = false
  let exited = false
  let exitResolved = false

  fs.mkdirp(path.dirname(options.logFile))
  const logStream = fs.createWriteStream(options.logFile)
  logStream.on('error', () => {
    /* a logging failure must never take the game down */
  })

  const writeLine = (stream: LaunchStream, text: string): void => {
    const at = now()
    const line: LaunchLine = { stream, text, at }
    ring.push(text)
    if (ring.length > RING_SIZE) ring.shift()
    if (text.includes(marker)) sawMenu = true
    for (const listener of listeners) {
      try {
        listener(line)
      } catch {
        /* listener errors are isolated */
      }
    }
    try {
      logStream.write(`[${stream}] ${text}\n`)
    } catch {
      /* ignore */
    }
  }

  const header = [
    `# mc-launcher session ${options.sessionId}`,
    `# started ${new Date(now()).toISOString()}`,
    `# java ${options.javaPath}`,
    `# cwd ${options.cwd}`,
    ...(options.headerLines ?? []),
  ]
  for (const line of header) writeLine('system', line)

  let decoder: InstanceType<typeof TextDecoder>
  try {
    decoder = new TextDecoder(options.encoding ?? 'utf-8', { fatal: false })
  } catch {
    decoder = new TextDecoder('utf-8')
    writeLine('system', `unsupported log encoding "${options.encoding}", falling back to utf-8`)
  }

  const splitters: Record<'stdout' | 'stderr', LineSplitter> = {
    stdout: new LineSplitter(),
    stderr: new LineSplitter(),
  }

  const consume = (stream: 'stdout' | 'stderr', chunk: Buffer | string): void => {
    const text = decoder.decode(
      typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
      { stream: true },
    )
    for (const line of splitters[stream].feed(text)) writeLine(stream, line)
  }

  const flushStreams = (): void => {
    const tail = decoder.decode()
    if (tail.length > 0) {
      for (const line of splitters.stdout.feed(tail)) writeLine('stdout', line)
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      const rest = splitters[stream].flush()
      if (rest !== null) writeLine(stream, rest)
    }
  }

  let child: SpawnedProcess
  try {
    child = ports.spawn(options.javaPath, options.argv, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
    })
  } catch (error) {
    const coreError = new CoreError('PROCESS.SPAWN_FAILED', {
      message: `spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      details: { javaPath: options.javaPath },
      cause: error,
    })
    try {
      logStream.end(`[system] ${coreError.message}\n`)
    } catch {
      /* ignore */
    }
    throw coreError
  }

  let spawnError: Error | null = null
  const startedAt = now()

  const exitPromise = new Promise<LaunchExit>((resolve, reject) => {
    const finalize = (exitCode: number | null, signal: string | null): void => {
      if (exitResolved) return
      exitResolved = true
      exited = true
      flushStreams()
      const exitedAt = now()
      const durationMs = Math.max(0, exitedAt - startedAt)
      const classification = classifyExit(exitCode, signal, sawMenu, durationMs, killedByUser)
      const crashHints =
        classification === 'normal' ? [] : detectCrashHints(ring.slice(-RING_SIZE))
      const exit: LaunchExit = {
        sessionId: options.sessionId,
        instanceId: options.instanceId,
        exitCode,
        signal,
        startedAt,
        exitedAt,
        durationMs,
        classification,
        crashHints,
        logFile: options.logFile,
        lastLines: ring.slice(-REPORT_LINES),
        sawMenu,
      }
      const summary = `[system] exited code=${exitCode ?? 'null'} signal=${signal ?? 'null'} durationMs=${durationMs} classification=${classification}`
      const settle = (): void => {
        if (spawnError) {
          reject(
            new CoreError('PROCESS.SPAWN_FAILED', {
              message: `failed to start Java: ${spawnError.message}`,
              details: { javaPath: options.javaPath },
              cause: spawnError,
            }),
          )
        } else {
          resolve(exit)
        }
      }
      // Resolve only after the transcript is flushed so callers can read the
      // file immediately (acceptance evidence does exactly that).
      try {
        logStream.end(`${summary}\n`, settle)
      } catch {
        settle()
      }
      setTimeout(settle, 500)
    }

    child.on('error', (error: Error) => {
      spawnError = error
    })
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      finalize(code, signal)
    })
    // `close` is authoritative (all stdio flushed). This fallback only prevents
    // a hung promise if a platform ever omits `close`.
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      setTimeout(() => finalize(code, signal), 2_000)
    })
  })
  // A rejected exit promise is observed by callers; avoid unhandled rejection
  // during the brief window before `waitForExit` is called.
  exitPromise.catch(() => undefined)

  child.stdout?.on('data', (chunk: Buffer) => consume('stdout', chunk))
  child.stderr?.on('data', (chunk: Buffer) => consume('stderr', chunk))

  return {
    sessionId: options.sessionId,
    pid: child.pid,
    logFile: options.logFile,
    waitForExit: () => exitPromise,
    async stop(): Promise<void> {
      if (exited) return
      killedByUser = true
      try {
        child.stdin?.write('stop\n')
      } catch {
        /* stdin may be closed already */
      }

      const finishedEarly = await waitWithTimeout(exitPromise, options.killGraceMs ?? 5_000)
      if (finishedEarly || exited) return

      try {
        child.kill()
      } catch {
        /* already gone */
      }
      const afterTerm = await waitWithTimeout(exitPromise, 3_000)
      if (afterTerm || exited) return

      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
      await waitWithTimeout(exitPromise, 2_000)
    },
    onLine(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    writeStdin(text) {
      try {
        child.stdin?.write(text)
      } catch {
        /* ignore */
      }
    },
    isRunning() {
      return !exited
    },
  }
}

export { classifyExit }
