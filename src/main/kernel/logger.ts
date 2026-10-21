import fs from 'node:fs'
import path from 'node:path'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'
export type LogFields = Record<string, unknown>

const LEVEL_VALUE: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

const SECRET_KEY = /token|secret|password|cookie|authorization|refresh/i
const USER_PATH = /([A-Za-z]:\\Users\\)([^\\\s]+)/g

/**
 * Node's console writes can throw synchronously (caught below), but a closed
 * pipe also emits an asynchronous `error` event on stdout/stderr. Without an
 * error listener that event becomes an uncaughtException, whose fatal log
 * writes to the same pipe and repeats. Logging is never worth crashing over:
 * install one module-level listener and permanently fall back to file sinks.
 */
let consoleStreamBroken = false

function installConsoleErrorGuards(): void {
  for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') {
      stream.on('error', () => {
        consoleStreamBroken = true
      })
    }
  }
}

installConsoleErrorGuards()

function redactString(value: string): string {
  return value.replace(USER_PATH, '$1<user>')
}

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth-limit]'
  if (typeof value === 'string') {
    if (/^eyJ[A-Za-z0-9_-]+\./.test(value)) return '***'
    return redactString(value)
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '***' : redactValue(child, depth + 1)
    }
    return out
  }
  return value
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '"[unserializable]"'
  }
}

export interface LoggerOptions {
  dataRoot: string
  level?: LogLevel
  console?: boolean
  /** Rotate a sink when the next line would exceed this size. */
  maxBytes?: number
  /** Total files kept per sink, including the current one. */
  maxFiles?: number
  now?: () => Date
}

/**
 * File logger with two sinks required by the architecture:
 *   logs/app-YYYYMMDD.jsonl  (machine readable)
 *   logs/launcher.log        (human readable evidence file)
 *
 * All writes are synchronous: log order stays deterministic and a crash can
 * never lose the line that explains it.
 */
export class Logger {
  readonly logDir: string
  jsonlFile: string
  readonly humanLogFile: string
  private readonly level: LogLevel
  private readonly consoleEnabled: boolean
  private readonly maxBytes: number
  private readonly maxFiles: number
  private readonly now: () => Date
  private currentDay: string
  /**
   * A closed stdout/stderr must never turn logging into a crash source. Once a
   * console write fails (EPIPE/EBADF/destroyed pipe), we permanently fall back
   * to the file sinks for this logger instance.
   */
  private consoleBroken: boolean

  constructor(options: LoggerOptions) {
    this.level = options.level ?? 'info'
    this.consoleEnabled = options.console ?? true
    this.consoleBroken = false
    this.maxBytes = Math.max(512, options.maxBytes ?? 5 * 1024 * 1024)
    this.maxFiles = Math.max(2, options.maxFiles ?? 10)
    this.now = options.now ?? (() => new Date())
    this.logDir = path.join(options.dataRoot, 'logs')
    fs.mkdirSync(this.logDir, { recursive: true })
    this.currentDay = this.dayStamp()
    this.jsonlFile = path.join(this.logDir, `app-${this.currentDay}.jsonl`)
    this.humanLogFile = path.join(this.logDir, 'launcher.log')
    this.pruneDailySinks()
  }

  private pruneDailySinks(): void {
    try {
      const files = fs
        .readdirSync(this.logDir)
        .filter((name) => /^app-\d{8}\.jsonl$/.test(name))
        .sort()
      const excess = files.length - this.maxFiles
      for (let index = 0; index < excess; index += 1) {
        const name = files[index]
        if (path.join(this.logDir, name) === this.jsonlFile) continue
        fs.rmSync(path.join(this.logDir, name), { force: true })
      }
    } catch {
      // Cleanup is best effort; the current sink must still be created.
    }
  }

  private dayStamp(): string {
    return this.now().toISOString().slice(0, 10).replaceAll('-', '')
  }

  /** Date rotation: the JSONL sink follows the UTC day even if the app is open
   * across midnight. The human sink rotates by size below. */
  private refreshDailySink(): void {
    const day = this.dayStamp()
    if (day === this.currentDay) return
    this.currentDay = day
    this.jsonlFile = path.join(this.logDir, `app-${day}.jsonl`)
    this.pruneDailySinks()
  }

  private rotate(file: string, incomingBytes: number): void {
    try {
      if (!fs.existsSync(file)) return
      const size = fs.statSync(file).size
      if (size === 0 || size + incomingBytes <= this.maxBytes) return
      // Keep current + .1 .. .(maxFiles-1), deleting the oldest first.
      const oldest = `${file}.${this.maxFiles - 1}`
      try {
        fs.rmSync(oldest, { force: true })
      } catch {
        /* best effort */
      }
      for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
        const source = `${file}.${index}`
        if (!fs.existsSync(source)) continue
        try {
          fs.renameSync(source, `${file}.${index + 1}`)
        } catch {
          /* keep going; the current sink is more important */
        }
      }
      fs.renameSync(file, `${file}.1`)
    } catch {
      // Rotation must never prevent the log line itself from being written.
    }
  }

  child(scope: string): ScopedLogger {
    return new ScopedLogger(this, scope)
  }

  /**
   * Console is a convenience sink, never a correctness dependency. Test
   * harnesses close the packaged app's stdout pipe; an unguarded console write
   * then throws EPIPE, the global uncaught handler logs fatal, and that write
   * can throw again (the fatal loop). Swallow the write failure and keep the
   * append-only file sinks going.
   */
  private safeConsole(level: LogLevel, line: string): void {
    if (!this.consoleEnabled || this.consoleBroken || consoleStreamBroken) return
    try {
      const stream = level === 'error' || level === 'fatal' ? process.stderr : process.stdout
      if (stream.destroyed || stream.writableEnded) {
        this.consoleBroken = true
        return
      }
      if (level === 'error' || level === 'fatal') console.error(line)
      else console.log(line)
    } catch {
      // EPIPE, EBADF, a test double, or a closed pipe: console is gone.
      // File output below is independent and has already been attempted.
      this.consoleBroken = true
      consoleStreamBroken = true
    }
  }

  log(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
    if (LEVEL_VALUE[level] < LEVEL_VALUE[this.level]) return
    this.refreshDailySink()
    const timestamp = this.now().toISOString()
    const safeFields = fields ? (redactValue(fields) as LogFields) : undefined
    const record = {
      ts: timestamp,
      level,
      scope,
      msg: redactString(message),
      ...(safeFields ?? {}),
    }
    const jsonLine = `${safeJson(record)}\n`
    this.rotate(this.jsonlFile, Buffer.byteLength(jsonLine))
    try {
      fs.appendFileSync(this.jsonlFile, jsonLine, 'utf8')
    } catch (error) {
      this.safeConsole('error', `[logger] jsonl write failed: ${String(error)}`)
    }

    const humanFields = safeFields && Object.keys(safeFields).length > 0 ? ` ${safeJson(safeFields)}` : ''
    const line = `${timestamp} ${level.toUpperCase().padEnd(5)} [${scope}] ${redactString(message)}${humanFields}`
    this.rotate(this.humanLogFile, Buffer.byteLength(`${line}\n`))
    try {
      fs.appendFileSync(this.humanLogFile, `${line}\n`, 'utf8')
    } catch (error) {
      this.safeConsole('error', `[logger] human write failed: ${String(error)}`)
    }

    this.safeConsole(level, line)
  }

  trace(scope: string, message: string, fields?: LogFields): void {
    this.log('trace', scope, message, fields)
  }

  debug(scope: string, message: string, fields?: LogFields): void {
    this.log('debug', scope, message, fields)
  }

  info(scope: string, message: string, fields?: LogFields): void {
    this.log('info', scope, message, fields)
  }

  warn(scope: string, message: string, fields?: LogFields): void {
    this.log('warn', scope, message, fields)
  }

  error(scope: string, message: string, fields?: LogFields): void {
    this.log('error', scope, message, fields)
  }

  fatal(scope: string, message: string, fields?: LogFields): void {
    this.log('fatal', scope, message, fields)
  }
}

export class ScopedLogger {
  constructor(
    private readonly logger: Logger,
    private readonly scope: string,
  ) {}

  trace(message: string, fields?: LogFields): void {
    this.logger.trace(this.scope, message, fields)
  }

  debug(message: string, fields?: LogFields): void {
    this.logger.debug(this.scope, message, fields)
  }

  info(message: string, fields?: LogFields): void {
    this.logger.info(this.scope, message, fields)
  }

  warn(message: string, fields?: LogFields): void {
    this.logger.warn(this.scope, message, fields)
  }

  error(message: string, fields?: LogFields): void {
    this.logger.error(this.scope, message, fields)
  }

  fatal(message: string, fields?: LogFields): void {
    this.logger.fatal(this.scope, message, fields)
  }
}
