import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  DownloadSettingsSchema,
  type DownloadSettings,
  type DownloadSettingsPatch,
} from '@shared/download'
import { DownloadError } from './errors'
import { ensureDir, writeTextAtomic } from './fs-atomic'
import { buildUserAgent } from './sources'

/**
 * Module-owned settings + paths.
 *
 * The kernel `config.json` is frozen and generic; docs/03 §8 puts
 * download-specific knobs in `dataRoot/modules/download/`. That directory is
 * also where the manifest cache and the cross-process job lock live, so a
 * portable install keeps everything under one root.
 */

export const DOWNLOAD_MODULE_DIR = 'download'
// A Minecraft install is dominated by many SMALL files on ONE host, so the
// per-host cap — not the global one — decides throughput. The official CDN and
// BMCLAPI both serve 8 parallel GETs fine; 429s back off and retry.
export const DEFAULT_CONCURRENCY = 16
export const MAX_CONCURRENCY = 32
export const DEFAULT_PER_HOST_CONCURRENCY = 8
export const DEFAULT_MAX_RETRIES = 3

export function moduleDirectory(dataRoot: string): string {
  return path.join(dataRoot, 'modules', DOWNLOAD_MODULE_DIR)
}

export function moduleCacheDirectory(dataRoot: string): string {
  return path.join(moduleDirectory(dataRoot), 'cache')
}

export function moduleSettingsFile(dataRoot: string): string {
  return path.join(moduleDirectory(dataRoot), 'settings.json')
}

/** `dataRoot/tmp/` is the module's declared lock/temp area (docs/03 §6.3). */
export function moduleLockFile(dataRoot: string, mcRoot: string): string {
  const digest = createHash('sha1').update(path.resolve(mcRoot).toLowerCase()).digest('hex')
  return path.join(dataRoot, 'tmp', `download-${digest.slice(0, 12)}.lock`)
}

export function defaultUserAgent(version: string): string {
  return buildUserAgent({ version })
}

export function defaultDownloadSettings(version = '0.1.0'): DownloadSettings {
  return {
    concurrency: DEFAULT_CONCURRENCY,
    perHostConcurrency: DEFAULT_PER_HOST_CONCURRENCY,
    maxRetries: DEFAULT_MAX_RETRIES,
    sourcePreference: 'auto',
    mirrorEnabled: true,
    downloadEnabled: true,
    speedLimitBytesPerSec: 0,
    extraRedirectHosts: [],
    userAgent: defaultUserAgent(version),
  }
}

export interface SettingsLogger {
  warn(message: string, fields?: Record<string, unknown>): void
  info?(message: string, fields?: Record<string, unknown>): void
}

export interface LoadSettingsOptions {
  version?: string
  log?: SettingsLogger
}

function sanitize(settings: DownloadSettings, version: string): DownloadSettings {
  return {
    ...settings,
    concurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(settings.concurrency))),
    perHostConcurrency: Math.min(MAX_CONCURRENCY, Math.max(1, Math.round(settings.perHostConcurrency))),
    maxRetries: Math.max(0, Math.round(settings.maxRetries)),
    extraRedirectHosts: settings.extraRedirectHosts
      .map((host) => host.trim().toLowerCase())
      .filter((host) => host.length > 0),
    userAgent: settings.userAgent.trim() || defaultUserAgent(version),
  }
}

/**
 * Reads settings, falling back to defaults on any validation problem. A corrupt
 * file is preserved next to the good one so the user's edits are not silently
 * destroyed.
 */
export function loadDownloadSettings(
  dataRoot: string,
  options: LoadSettingsOptions = {},
): DownloadSettings {
  const version = options.version ?? '0.1.0'
  const file = moduleSettingsFile(dataRoot)
  const fallback = defaultDownloadSettings(version)
  let raw: unknown = null
  try {
    if (!fs.existsSync(file)) return fallback
    const text = fs.readFileSync(file, 'utf8')
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (error) {
    options.log?.warn('download settings unreadable; using defaults', {
      file,
      message: error instanceof Error ? error.message : String(error),
    })
    return fallback
  }

  const parsed = DownloadSettingsSchema.safeParse(raw)
  if (!parsed.success) {
    options.log?.warn('download settings invalid; using defaults', {
      file,
      issues: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join('.')),
    })
    return fallback
  }
  return sanitize(parsed.data, version)
}

export async function saveDownloadSettings(
  dataRoot: string,
  settings: DownloadSettings,
): Promise<void> {
  await ensureDir(moduleDirectory(dataRoot))
  await writeTextAtomic(moduleSettingsFile(dataRoot), `${JSON.stringify(settings, null, 2)}\n`)
}

export function mergeDownloadSettings(
  current: DownloadSettings,
  patch: DownloadSettingsPatch,
  version = '0.1.0',
): DownloadSettings {
  const merged = { ...current, ...patch }
  const parsed = DownloadSettingsSchema.safeParse(merged)
  if (!parsed.success) {
    throw new DownloadError('DOWNLOAD.SETTINGS_INVALID', {
      message: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      details: { issues: parsed.error.issues.slice(0, 10).map((issue) => issue.message) },
    })
  }
  return sanitize(parsed.data, version)
}

/** Convenience for tests and the service: absolute path helpers. */
export function downloadPaths(dataRoot: string): {
  moduleDir: string
  cacheDir: string
  settingsFile: string
} {
  return {
    moduleDir: moduleDirectory(dataRoot),
    cacheDir: moduleCacheDirectory(dataRoot),
    settingsFile: moduleSettingsFile(dataRoot),
  }
}
