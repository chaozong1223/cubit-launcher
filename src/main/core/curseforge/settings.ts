import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { AppError } from '@shared/errors'

/**
 * CurseForge user configuration (docs/02 API-07..22, SEC-AUTH-01/02/03/05).
 *
 * The key is supplied by the user and only ever lives in the main process:
 *   - encrypted with Electron safeStorage (`encryptStringAsync`) and written as
 *     base64 in `apiKeyEnc` (mode 0600 + Windows ACL: current user only);
 *   - when secure storage is unavailable the key is kept in memory for this
 *     session only — never written as plaintext — and the UI capability flags
 *     report `secureStorageAvailable:false, persisted:false`;
 *   - sent exclusively as the `x-api-key` header to the configured API host;
 *   - never placed in a URL, log line, error detail or IPC response.
 */

export interface CurseForgeConfig {
  apiKey: string | null
  /** Optional API mirror base (full URL, e.g. `https://cf.example/api/v1`). */
  mirrorBase: string | null
}

export interface CurseForgeConfigState extends CurseForgeConfig {
  /** True only when safeStorage is available and the backend is not basic_text. */
  secureStorageAvailable: boolean
  /** True when the current key is encrypted on disk (not just in memory). */
  persisted: boolean
  encryptedOnDisk: boolean
  migrated: boolean
  plaintextRemoved: boolean
  decryptFailed: boolean
}

export interface CurseForgeConfigView {
  hasApiKey: boolean
  mirrorBase: string | null
  secureStorageAvailable: boolean
  persisted: boolean
}

export const CURSEFORGE_SETTINGS_FILE = path.join('modules', 'catalog', 'curseforge.json')

/** Injectable so the store can be unit-tested without Electron. */
export interface CurseForgeCipher {
  readonly available: boolean
  /** Diagnostic name only (`dpapi`, `gnome_libsecret`, ...). Never a secret. */
  readonly backend: string
  encrypt(plain: string): Promise<Buffer>
  decrypt(encrypted: Buffer): Promise<{ plain: string; shouldReEncrypt: boolean }>
}

export interface CurseForgeStoreLogger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface CurseForgeStoreOptions {
  /** Override the process-wide cipher (tests); `null` forces unavailable. */
  cipher?: CurseForgeCipher | null
  log?: CurseForgeStoreLogger
  /** Test seam; `null` disables ACL hardening. */
  restrictAcl?: ((file: string) => void) | null
  /** Keep an existing ciphertext when only the mirror changes (key unreadable). */
  preserveEncryptedKey?: boolean
  env?: NodeJS.ProcessEnv
}

interface StoredConfig {
  schemaVersion: 1 | 2
  /** Legacy plaintext field; migrated away on the next load. */
  apiKey?: string | null
  /** base64(safeStorage.encryptStringAsync(key)). */
  apiKeyEnc?: string | null
  mirrorBase?: string | null
}

const EMPTY_STATE: CurseForgeConfigState = {
  apiKey: null,
  mirrorBase: null,
  secureStorageAvailable: false,
  persisted: false,
  encryptedOnDisk: false,
  migrated: false,
  plaintextRemoved: false,
  decryptFailed: false,
}

let configuredCipher: CurseForgeCipher | null = null
/** Session-only keys when secure storage is unavailable (one per data root). */
const sessionKeys = new Map<string, string>()

export function configureCurseForgeCipher(cipher: CurseForgeCipher | null): void {
  configuredCipher = cipher
}

export function getCurseForgeCipher(): CurseForgeCipher | null {
  return configuredCipher
}

/** Tests / logout: drop session-only keys (optionally one data root). */
export function clearCurseForgeSession(dataRoot?: string): void {
  if (dataRoot === undefined) sessionKeys.clear()
  else sessionKeys.delete(path.resolve(dataRoot))
}

function cipherFor(options: CurseForgeStoreOptions): CurseForgeCipher | null {
  if (options.cipher !== undefined) return options.cipher
  return configuredCipher
}

function envApiKey(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.MCL_CF_API_KEY?.trim()
  return value && value.length > 0 ? value : null
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

/**
 * Best-effort Windows ACL hardening: remove inherited ACEs and grant only the
 * current user. POSIX gets 0600 via the write mode. Failures are non-fatal: the
 * file is still 0600 / inside the per-user profile.
 */
function restrictToCurrentUser(file: string): void {
  try {
    fs.chmodSync(file, 0o600)
  } catch {
    /* Windows ignores POSIX bits; handled by icacls below. */
  }
  if (process.platform !== 'win32') return
  const user = process.env.USERNAME ?? os.userInfo().username
  if (!user) return
  try {
    execFileSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:F`], {
      stdio: 'ignore',
      windowsHide: true,
    })
  } catch {
    /* ACL hardening is defense-in-depth; never fail the settings save. */
  }
}

function readStoredFile(file: string): { stored: StoredConfig | null; raw: string | null } {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { stored: null, raw }
    }
    const record = parsed as Record<string, unknown>
    return {
      stored: {
        schemaVersion: record.schemaVersion === 1 ? 1 : 2,
        apiKey: typeof record.apiKey === 'string' ? record.apiKey : null,
        apiKeyEnc: typeof record.apiKeyEnc === 'string' ? record.apiKeyEnc : null,
        mirrorBase: typeof record.mirrorBase === 'string' ? record.mirrorBase : null,
      },
      raw,
    }
  } catch {
    return { stored: null, raw: null }
  }
}

async function writeStoredFile(
  dataRoot: string,
  stored: StoredConfig,
  options: CurseForgeStoreOptions,
): Promise<void> {
  const file = settingsFilePath(dataRoot)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fsp.writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  })
  try {
    await fsp.chmod(tmp, 0o600)
  } catch {
    /* see restrictToCurrentUser */
  }
  try {
    await fsp.rename(tmp, file)
  } catch {
    await fsp.rm(file, { force: true })
    await fsp.rename(tmp, file)
  }
  const restrict = options.restrictAcl === undefined ? restrictToCurrentUser : options.restrictAcl
  if (restrict) {
    try {
      restrict(file)
    } catch {
      /* best effort */
    }
  }
}

function safeMirror(mirrorBase: string | null | undefined): string | null {
  try {
    return normalizeMirrorBase(mirrorBase ?? null)
  } catch {
    return null
  }
}

async function loadStored(
  dataRoot: string,
  options: CurseForgeStoreOptions,
  includeEnv: boolean,
): Promise<CurseForgeConfigState> {
  const root = path.resolve(dataRoot)
  const cipher = cipherFor(options)
  const log = options.log
  const file = settingsFilePath(root)
  const { stored } = readStoredFile(file)
  const sessionKey = sessionKeys.get(root) ?? null
  const secureStorageAvailable = Boolean(cipher?.available)
  let apiKey: string | null = sessionKey
  let mirrorBase = safeMirror(stored?.mirrorBase)
  let persisted = false
  let encryptedOnDisk = false
  let migrated = false
  let plaintextRemoved = false
  let decryptFailed = false

  if (stored?.apiKeyEnc) {
    encryptedOnDisk = true
    if (!cipher?.available) {
      apiKey = sessionKey
    } else if (apiKey === null) {
      try {
        const decrypted = await cipher.decrypt(Buffer.from(stored.apiKeyEnc, 'base64'))
        apiKey = decrypted.plain
        persisted = true
        if (decrypted.shouldReEncrypt) {
          try {
            const encrypted = await cipher.encrypt(decrypted.plain)
            await writeStoredFile(
              root,
              { schemaVersion: 2, apiKeyEnc: encrypted.toString('base64'), mirrorBase },
              options,
            )
          } catch {
            /* keep the old ciphertext; it is still readable this session */
          }
        }
      } catch (error) {
        decryptFailed = true
        log?.warn('curseforge key decrypt failed; please re-enter it', {
          reason: error instanceof Error ? error.message : String(error),
        })
      }
    } else {
      // A session key takes precedence (e.g. secure storage became unavailable).
      persisted = false
    }
  }

  if (stored?.apiKey && stored.apiKey.trim().length > 0) {
    const plaintext = stored.apiKey.trim()
    apiKey = plaintext
    if (cipher?.available) {
      try {
        const encrypted = await cipher.encrypt(plaintext)
        await writeStoredFile(
          root,
          { schemaVersion: 2, apiKeyEnc: encrypted.toString('base64'), mirrorBase },
          options,
        )
        encryptedOnDisk = true
        persisted = true
        migrated = true
        sessionKeys.delete(root)
        log?.info('curseforge key migrated to encrypted storage', {})
      } catch {
        // Encryption failed: keep the session key and remove the plaintext file.
        sessionKeys.set(root, plaintext)
        await writeStoredFile(root, { schemaVersion: 2, mirrorBase }, options).catch(() => undefined)
        plaintextRemoved = true
        log?.warn('curseforge plaintext key removed; secure storage unavailable', {})
      }
    } else {
      sessionKeys.set(root, plaintext)
      await writeStoredFile(root, { schemaVersion: 2, mirrorBase }, options).catch(() => undefined)
      plaintextRemoved = true
      log?.warn('curseforge plaintext key removed; secure storage unavailable', {})
    }
  }

  if (apiKey === null && includeEnv) {
    apiKey = envApiKey(options.env)
  }
  return {
    ...EMPTY_STATE,
    apiKey,
    mirrorBase,
    secureStorageAvailable,
    persisted,
    encryptedOnDisk,
    migrated,
    plaintextRemoved,
    decryptFailed,
  }
}

/** Loads the stored config (no env fallback); used before patching settings. */
export async function loadStoredCurseForgeConfig(
  dataRoot: string,
  options: CurseForgeStoreOptions = {},
): Promise<CurseForgeConfigState> {
  return loadStored(dataRoot, options, false)
}

/** Loads the effective config (stored key or `MCL_CF_API_KEY`). */
export async function loadCurseForgeConfig(
  dataRoot: string,
  options: CurseForgeStoreOptions = {},
): Promise<CurseForgeConfigState> {
  return loadStored(dataRoot, options, true)
}

/**
 * Persists the key encrypted when possible; otherwise keeps it in memory only.
 * Never writes `apiKey` in plaintext.
 */
export async function saveCurseForgeConfig(
  dataRoot: string,
  config: CurseForgeConfig,
  options: CurseForgeStoreOptions = {},
): Promise<CurseForgeConfigState> {
  const root = path.resolve(dataRoot)
  const cipher = cipherFor(options)
  const log = options.log
  const apiKey = config.apiKey && config.apiKey.trim().length > 0 ? config.apiKey.trim() : null
  const mirrorBase = safeMirror(config.mirrorBase)
  let persisted = false
  let encryptedOnDisk = false
  const existingCiphertext =
    options.preserveEncryptedKey === true && !apiKey ? readStoredFile(root).stored?.apiKeyEnc : null

  if (apiKey && cipher?.available) {
    try {
      const encrypted = await cipher.encrypt(apiKey)
      await writeStoredFile(
        root,
        { schemaVersion: 2, apiKeyEnc: encrypted.toString('base64'), mirrorBase },
        options,
      )
      sessionKeys.delete(root)
      persisted = true
      encryptedOnDisk = true
    } catch {
      // Do not silently downgrade to plaintext: keep the session key only.
      await writeStoredFile(root, { schemaVersion: 2, mirrorBase }, options)
      sessionKeys.set(root, apiKey)
      log?.warn('curseforge key not persisted: encryption failed', {})
    }
  } else if (existingCiphertext) {
    // Mirror-only edit while the key cannot be decrypted in this session:
    // never destroy the existing ciphertext.
    await writeStoredFile(
      root,
      { schemaVersion: 2, apiKeyEnc: existingCiphertext, mirrorBase },
      options,
    )
    encryptedOnDisk = true
  } else {
    await writeStoredFile(root, { schemaVersion: 2, mirrorBase }, options)
    if (apiKey) {
      sessionKeys.set(root, apiKey)
      log?.warn('curseforge key kept in memory only: secure storage unavailable', {})
    } else {
      sessionKeys.delete(root)
    }
  }

  return {
    ...EMPTY_STATE,
    apiKey,
    mirrorBase,
    secureStorageAvailable: Boolean(cipher?.available),
    persisted,
    encryptedOnDisk,
    migrated: false,
    plaintextRemoved: false,
    decryptFailed: false,
  }
}

export function maskCurseForgeConfig(
  config: Pick<
    CurseForgeConfigState,
    'apiKey' | 'mirrorBase' | 'secureStorageAvailable' | 'persisted'
  >,
): CurseForgeConfigView {
  return {
    hasApiKey: Boolean(config.apiKey && config.apiKey.length > 0),
    mirrorBase: config.mirrorBase,
    secureStorageAvailable: config.secureStorageAvailable,
    persisted: config.persisted,
  }
}
