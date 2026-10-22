import fs from 'node:fs'
import path from 'node:path'
import { AppError } from '@shared/errors'

/**
 * CurseForge user configuration (docs/02 API-07..22).
 *
 * The key is supplied by the user and only ever lives in the main process:
 *   - stored in `dataRoot/modules/catalog/curseforge.json` with mode 0600;
 *   - sent exclusively as the `x-api-key` header to the configured API host;
 *   - never placed in a URL, log line, error detail or IPC response.
 */

export interface CurseForgeConfig {
  apiKey: string | null
  /** Optional API mirror base (full URL, e.g. `https://cf.example/api/v1`). */
  mirrorBase: string | null
}

export interface CurseForgeConfigView {
  hasApiKey: boolean
  mirrorBase: string | null
}

export const CURSEFORGE_SETTINGS_FILE = path.join('modules', 'catalog', 'curseforge.json')

interface StoredConfig {
  schemaVersion: 1
  apiKey: string | null
  mirrorBase: string | null
}

export function normalizeMirrorBase(
  input: string | null | undefined,
  options: { allowInsecureHosts?: string[] } = {},
): string | null {
  const trimmed = input?.trim() ?? ''
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new AppError('CATALOG.CF_MIRROR_INVALID', 'CurseForge 镜像地址不是合法 URL', {
      details: { hint: '例如 https://cf.example.com/api/v1' },
    })
  }
  const insecure = (options.allowInsecureHosts ?? []).map((host) => host.toLowerCase())
  if (parsed.protocol !== 'https:') {
    if (parsed.protocol !== 'http:' || !insecure.includes(parsed.hostname.toLowerCase())) {
      throw new AppError('CATALOG.CF_MIRROR_INVALID', 'CurseForge 镜像必须使用 HTTPS', {
        details: { protocol: parsed.protocol },
      })
    }
  }
  parsed.hash = ''
  parsed.search = ''
  const normalized = parsed.toString().replace(/\/+$/, '')
  if (normalized === 'https://api.curseforge.com' || normalized === 'https://api.curseforge.com/v1') {
    // The official base is always used first; storing it as a mirror is a no-op.
    return null
  }
  return normalized
}

export function settingsFilePath(dataRoot: string): string {
  return path.join(dataRoot, CURSEFORGE_SETTINGS_FILE)
}

export function loadCurseForgeConfig(dataRoot: string): CurseForgeConfig {
  const stored = loadStoredCurseForgeConfig(dataRoot)
  return { apiKey: stored.apiKey ?? envApiKey(), mirrorBase: stored.mirrorBase }
}

/** Only what is on disk (no environment fallback); used when patching settings. */
export function loadStoredCurseForgeConfig(dataRoot: string): CurseForgeConfig {
  const file = settingsFilePath(dataRoot)
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw) as Partial<StoredConfig>
    const apiKey =
      typeof parsed.apiKey === 'string' && parsed.apiKey.trim().length > 0
        ? parsed.apiKey.trim()
        : null
    let mirrorBase: string | null = null
    try {
      mirrorBase = normalizeMirrorBase(parsed.mirrorBase ?? null)
    } catch {
      mirrorBase = null
    }
    return { apiKey, mirrorBase }
  } catch {
    return { apiKey: null, mirrorBase: null }
  }
}

/** Developer fallback so a local run can use `MCL_CF_API_KEY` (never persisted). */
function envApiKey(): string | null {
  const value = process.env.MCL_CF_API_KEY?.trim()
  return value && value.length > 0 ? value : null
}

export function saveCurseForgeConfig(
  dataRoot: string,
  config: CurseForgeConfig,
): CurseForgeConfig {
  const file = settingsFilePath(dataRoot)
  const stored: StoredConfig = {
    schemaVersion: 1,
    apiKey: config.apiKey && config.apiKey.trim().length > 0 ? config.apiKey.trim() : null,
    mirrorBase: config.mirrorBase,
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    fs.chmodSync(tmp, 0o600)
  } catch {
    /* Windows ACLs already restrict per-user access. */
  }
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.rmSync(file, { force: true })
    fs.renameSync(tmp, file)
  }
  return loadCurseForgeConfig(dataRoot)
}

export function maskCurseForgeConfig(config: CurseForgeConfig): CurseForgeConfigView {
  return {
    hasApiKey: Boolean(config.apiKey && config.apiKey.length > 0),
    mirrorBase: config.mirrorBase,
  }
}
