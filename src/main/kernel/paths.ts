import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'

/** Windows extended-length prefix. No-op on other platforms. */
export function winLongPath(target: string): string {
  if (process.platform !== 'win32') return target
  if (target.startsWith('\\\\?\\')) return target
  const absolute = path.resolve(target)
  if (absolute.length < 248) return absolute
  if (absolute.startsWith('\\\\')) return `\\\\?\\UNC\\${absolute.slice(2)}`
  return `\\\\?\\${absolute}`
}

/** Preflight Windows legacy path limits before writing natives/logs. */
export function assertPathBudget(target: string, label: string, maxLength = 240): void {
  if (process.platform !== 'win32') return
  const normalized = path.resolve(target)
  if (normalized.length <= maxLength) return
  throw new AppError('LAUNCH.PATH_TOO_LONG', `${label}路径过长（${normalized.length} > ${maxLength}）`, {
    details: {
      label,
      path: normalized,
      length: normalized.length,
      maxLength,
      hint: '请把游戏目录移到更短的路径（例如 D:\\MC），或缩短实例名后重试。',
    },
  })
}

export type DataRootSource = 'cli' | 'env' | 'portable' | 'user' | 'default'

export interface BootPathInput {
  argv: readonly string[]
  env: NodeJS.ProcessEnv
  cwd: string
  exeDir: string
  appDataDir: string
  isPackaged: boolean
}

export interface DataRootResolution {
  dataRoot: string
  portable: boolean
  source: DataRootSource
}

export interface BootPaths extends DataRootResolution {
  mcRoot: string | null
  configFile: string
  logDir: string
  logFile: string
  humanLogFile: string
  sessionData: string
  cache: string
  temp: string
  crashDumps: string
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on'])
const FALSY = new Set(['0', 'false', 'no', 'off'])

/**
 * Explicit paths stay explicit. Relative paths are anchored to the install
 * directory for packaged builds (portable copy semantics), and to the source
 * working directory in development. Never use `process.cwd()` for a packaged
 * shortcut: Explorer can choose an unrelated start-in directory.
 */
function resolveExplicit(input: Pick<BootPathInput, 'cwd' | 'exeDir' | 'isPackaged'>, value: string): string {
  if (path.isAbsolute(value)) return path.normalize(value)
  return path.resolve(input.isPackaged ? input.exeDir : input.cwd, value)
}

/** Supports both `--name value` and `--name=value`. */
export function argValue(argv: readonly string[], name: string): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === name) {
      const next = argv[i + 1]
      if (next && !next.startsWith('-')) return next
      return undefined
    }
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1)
      return value.length > 0 ? value : undefined
    }
  }
  return undefined
}

function firstFlag(env: NodeJS.ProcessEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name]
    if (value !== undefined && value !== '') return value
  }
  return undefined
}

/**
 * dataRoot priority (architecture §7.4):
 *   --data-dir / MCL_DATA_DIR → portable flag → default.
 * Packaged builds default to `<exeDir>/data` (portable). Dev uses `<cwd>/data`
 * so the Electron binary inside node_modules is never polluted.
 */
export function resolveDataRoot(input: BootPathInput): DataRootResolution {
  const cliData = argValue(input.argv, '--data-dir')
  if (cliData) {
    return { dataRoot: resolveExplicit(input, cliData), portable: false, source: 'cli' }
  }

  const envData = input.env.MCL_DATA_DIR
  if (envData) {
    return { dataRoot: resolveExplicit(input, envData), portable: false, source: 'env' }
  }

  const baseDir = input.isPackaged ? input.exeDir : input.cwd
  const portableFlag = firstFlag(input.env, ['MCL_PORTABLE', 'MC_LAUNCHER_PORTABLE'])
  if (portableFlag !== undefined) {
    if (FALSY.has(portableFlag.toLowerCase())) {
      return {
        dataRoot: path.resolve(input.appDataDir, 'mc-launcher'),
        portable: false,
        source: 'user',
      }
    }
    if (TRUTHY.has(portableFlag.toLowerCase())) {
      return { dataRoot: path.resolve(baseDir, 'data'), portable: true, source: 'portable' }
    }
  }

  return { dataRoot: path.resolve(baseDir, 'data'), portable: true, source: 'default' }
}

export function resolveMcRoot(
  input: Pick<BootPathInput, 'argv' | 'env' | 'cwd'>,
  configured: string | null | undefined,
): string | null {
  const cliMc = argValue(input.argv, '--mc-dir')
  if (cliMc) return path.resolve(input.cwd, cliMc)

  const envMc = input.env.MCL_MC_DIR
  if (envMc) return path.resolve(input.cwd, envMc)

  if (configured && configured.trim().length > 0) {
    return path.isAbsolute(configured) ? path.normalize(configured) : path.resolve(input.cwd, configured)
  }
  return null
}

export function buildPaths(
  data: DataRootResolution,
  mcRoot: string | null,
): BootPaths {
  const logDir = path.join(data.dataRoot, 'logs')
  return {
    ...data,
    mcRoot,
    configFile: path.join(data.dataRoot, 'config.json'),
    logDir,
    logFile: path.join(logDir, 'app.log'),
    humanLogFile: path.join(logDir, 'launcher.log'),
    sessionData: path.join(data.dataRoot, 'session'),
    cache: path.join(data.dataRoot, 'cache'),
    temp: path.join(data.dataRoot, 'tmp'),
    crashDumps: path.join(data.dataRoot, 'crashDumps'),
  }
}

/** Creates a directory and returns whether it is writable by this process. */
export function ensureWritableDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.accessSync(dir, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** True only when `candidate` is strictly inside `root` (no prefix tricks). */
export function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate))
  return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
}

export function assertInside(root: string, candidate: string): string {
  const resolved = path.resolve(candidate)
  if (!isInside(root, resolved) && resolved !== path.resolve(root)) {
    throw new Error(`path escapes root: ${candidate}`)
  }
  return resolved
}
