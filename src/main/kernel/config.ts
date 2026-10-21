import fs from 'node:fs'
import path from 'node:path'
import { z } from 'zod'

export const ConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  app: z
    .object({
      theme: z.enum(['system', 'light', 'dark']).default('system'),
      window: z
        .object({
          width: z.number().int().min(800).default(1280),
          height: z.number().int().min(600).default(800),
        })
        .default({ width: 1280, height: 800 }),
    })
    .default({ theme: 'system', window: { width: 1280, height: 800 } }),
  paths: z
    .object({
      minecraftRoot: z.string().nullable().default(null),
    })
    .default({ minecraftRoot: null }),
  lastRunAt: z.number().nullable().default(null),
})

export type AppConfig = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG: AppConfig = {
  schemaVersion: 1,
  app: { theme: 'system', window: { width: 1280, height: 800 } },
  paths: { minecraftRoot: null },
  lastRunAt: null,
}

export interface LoadedConfig {
  config: AppConfig
  file: string
  recovered: boolean
  /** Legacy `dataRoot`/`dataDir` value found in an old config; never trusted. */
  legacyDataRoot: string | null
  legacyDataRootMissing: boolean
}

const LEGACY_WARNED = new Set<string>()

function legacyDataRootFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const paths = record.paths && typeof record.paths === 'object'
    ? (record.paths as Record<string, unknown>)
    : null
  for (const candidate of [paths?.dataRoot, paths?.dataDir, record.dataRoot, record.dataDir]) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim()
  }
  return null
}

function appendLegacyWarning(dataRoot: string): void {
  const logs = path.join(dataRoot, 'logs')
  const file = path.join(logs, 'launcher.log')
  try {
    fs.mkdirSync(logs, { recursive: true })
    fs.appendFileSync(
      file,
      `${new Date().toISOString()} WARN  [config] legacy data root missing; using portable data root\n`,
      'utf8',
    )
  } catch {
    // The normal logger will open the same directory; never let migration logging fail boot.
  }
}

function atomicWrite(file: string, contents: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(tmp, contents, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch {
    // Windows may refuse to replace an open file; remove the old file first.
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* best effort */
    }
    fs.renameSync(tmp, file)
  }
}

export function saveConfig(file: string, config: AppConfig): void {
  atomicWrite(file, `${JSON.stringify(config, null, 2)}\n`)
}

/**
 * Loads config.json, falling back to defaults on any validation error.
 * A corrupt file is preserved as config.corrupt-<timestamp>.json.
 */
export function loadConfig(dataRoot: string): LoadedConfig {
  const file = path.join(dataRoot, 'config.json')
  fs.mkdirSync(dataRoot, { recursive: true })

  let raw: unknown = null
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      raw = null
    }
  }

  const legacyDataRoot = legacyDataRootFrom(raw)
  const legacyResolved = legacyDataRoot
    ? (path.isAbsolute(legacyDataRoot)
      ? path.normalize(legacyDataRoot)
      : path.resolve(path.dirname(file), legacyDataRoot))
    : null
  const legacyDataRootMissing = Boolean(legacyResolved && !fs.existsSync(legacyResolved))
  if (legacyDataRootMissing && !LEGACY_WARNED.has(file)) {
    LEGACY_WARNED.add(file)
    appendLegacyWarning(dataRoot)
  }

  const parsed = ConfigSchema.safeParse(raw)
  if (parsed.success && raw !== null) {
    return { config: parsed.data, file, recovered: false, legacyDataRoot, legacyDataRootMissing }
  }

  if (raw !== null) {
    try {
      fs.renameSync(file, path.join(dataRoot, `config.corrupt-${Date.now()}.json`))
    } catch {
      /* keep going with defaults */
    }
  }

  const config: AppConfig = {
    ...DEFAULT_CONFIG,
    lastRunAt: Date.now(),
  }
  saveConfig(file, config)
  return { config, file, recovered: raw !== null, legacyDataRoot, legacyDataRootMissing }
}
