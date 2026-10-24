import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import { EventEmitter } from 'node:events'

/**
 * Tiny capability ports for the launch kernel.
 *
 * `service.ts` wiring uses the Node implementations; unit tests can inject a
 * fake process port (recorded argv, canned `-XshowSettings` output) without
 * spawning anything. File access is synchronous on purpose: version JSON and
 * native extraction are small, bounded reads, and synchronous calls keep the
 * launch sequence deterministic.
 */
export interface FsFileStat {
  size: number
  mtimeMs: number
  isFile(): boolean
  isDirectory(): boolean
}

export interface FsPort {
  exists(target: string): boolean
  stat(target: string): FsFileStat | null
  readDir(target: string): string[]
  readText(target: string): string
  readBytes(target: string): Buffer
  realpath(target: string): string
  mkdirp(target: string): void
  writeTextAtomic(target: string, contents: string): void
  writeText(target: string, contents: string): void
  writeBytes(target: string, contents: Buffer): void
  appendText(target: string, contents: string): void
  rename(from: string, to: string): void
  remove(target: string): void
  copyFile(from: string, to: string): void
  createWriteStream(target: string): Writable
  tmpdir(): string
}

export interface ExecOptions {
  timeoutMs?: number
  cwd?: string
  env?: NodeJS.ProcessEnv
  maxBuffer?: number
}

export interface ExecResult {
  stdout: string
  stderr: string
  code: number | null
  timedOut: boolean
  /** 'ENOENT' when the executable itself is missing. */
  spawnErrorCode?: string
  errorMessage?: string
}

export interface SpawnedProcess extends EventEmitter {
  readonly pid?: number
  readonly stdout: Readable | null
  readonly stderr: Readable | null
  readonly stdin: Writable | null
  kill(signal?: NodeJS.Signals | number): boolean
}

export interface SpawnOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  windowsHide?: boolean
  /** Give the child its own process group so it survives the parent. */
  detached?: boolean
}

export interface ProcessPort {
  exec(file: string, args: string[], options?: ExecOptions): Promise<ExecResult>
  spawn(file: string, args: string[], options?: SpawnOptions): SpawnedProcess
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/** Synchronous, conservative file port backed by node:fs. */
export function nodeFsPort(): FsPort {
  return {
    exists(target) {
      try {
        return fs.existsSync(target)
      } catch {
        return false
      }
    },
    stat(target) {
      try {
        return fs.statSync(target)
      } catch {
        return null
      }
    },
    readDir(target) {
      try {
        return fs
          .readdirSync(target, { withFileTypes: true })
          .map((entry) => entry.name)
      } catch {
        return []
      }
    },
    readText(target) {
      return stripBom(fs.readFileSync(target, 'utf8'))
    },
    readBytes(target) {
      return fs.readFileSync(target)
    },
    realpath(target) {
      try {
        return fs.realpathSync.native(target)
      } catch {
        return path.resolve(target)
      }
    },
    mkdirp(target) {
      fs.mkdirSync(target, { recursive: true })
    },
    writeTextAtomic(target, contents) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const tmp = `${target}.tmp-${process.pid}-${Date.now()}`
      fs.writeFileSync(tmp, contents, 'utf8')
      try {
        fs.renameSync(tmp, target)
      } catch {
        // Windows refuses to replace a file another process has open.
        try {
          fs.rmSync(target, { force: true })
        } catch {
          /* best effort */
        }
        fs.renameSync(tmp, target)
      }
    },
    writeText(target, contents) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents, 'utf8')
    },
    writeBytes(target, contents) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, contents)
    },
    appendText(target, contents) {
      fs.appendFileSync(target, contents, 'utf8')
    },
    rename(from, to) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      try {
        fs.renameSync(from, to)
      } catch {
        try {
          fs.rmSync(to, { force: true })
        } catch {
          /* best effort */
        }
        fs.renameSync(from, to)
      }
    },
    remove(target) {
      fs.rmSync(target, { recursive: true, force: true })
    },
    copyFile(from, to) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
    },
    createWriteStream(target) {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      return fs.createWriteStream(target, { flags: 'a', encoding: 'utf8' })
    },
    tmpdir() {
      return fs.mkdtempSync(path.join(process.env.TEMP ?? process.env.TMP ?? '.', 'mcl-'))
    },
  }
}

/** Executes a process without a shell. Never rejects; inspect the result. */
export function nodeProcessPort(): ProcessPort {
  return {
    exec(file, args, options = {}) {
      return new Promise<ExecResult>((resolve) => {
        let stdout = ''
        let stderr = ''
        let timedOut = false

        const child = execFile(
          file,
          args,
          {
            cwd: options.cwd,
            env: options.env ?? process.env,
            timeout: options.timeoutMs,
            maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
            windowsHide: true,
            encoding: 'utf8',
          },
          (error, out, err) => {
            stdout = typeof out === 'string' ? out : stdout
            stderr = typeof err === 'string' ? err : stderr
            const errorCode = (error as NodeJS.ErrnoException | null)?.code
            if (error) {
              timedOut = Boolean((error as NodeJS.ErrnoException & { killed?: boolean }).killed)
            }
            resolve({
              stdout,
              stderr,
              code: typeof errorCode === 'number' ? errorCode : error ? null : 0,
              timedOut,
              ...(errorCode === 'ENOENT' ? { spawnErrorCode: 'ENOENT' } : {}),
              ...(error ? { errorMessage: error.message } : {}),
            })
          },
        )

        child.stdout?.on('data', (chunk: Buffer | string) => {
          stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk: Buffer | string) => {
          stderr += chunk.toString()
        })
      })
    },

    spawn(file, args, options = {}) {
      return spawn(file, args, {
        shell: false,
        cwd: options.cwd,
        env: options.env ?? process.env,
        windowsHide: options.windowsHide ?? true,
        // The game must outlive the launcher: a detached child gets its own
        // process group, so quitting (or crashing) the launcher does not take
        // Minecraft down with it. stdout/stderr stay piped, so the log view
        // keeps working while the launcher is open.
        detached: options.detached ?? false,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    },
  }
}
