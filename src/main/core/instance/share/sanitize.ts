import path from 'node:path'

/**
 * Secret scrubbing for share-pack export (docs/02 red line, handoff §5.1):
 * a pack must never contain `accessToken` / `refreshToken` / cookies or other
 * credential material. Files known to be credential stores are skipped, and
 * every text/JSON file that can be shared is scanned and redacted in place.
 *
 * The redaction record intentionally stores only paths and field names — never
 * the secret values — so it is safe to log and to embed in the pack manifest.
 */

export interface ShareRedaction {
  /** Archive-relative path (`game/config/x.json`, `instance/instance.json`). */
  path: string
  action: 'redacted' | 'skipped'
  /** Redacted field paths / header names; never values. */
  fields: string[]
}

const DENIED_BASENAMES = new Set([
  'launcher_accounts.json',
  'launcher_profiles.json',
  'launcher_accounts_microsoft_store.json',
  'accounts.json',
  'usercache.json',
  'realms_persistence.json',
  'servers.dat',
  'session.lock',
])

const DENIED_SEGMENTS = new Set(['logs', 'crash-reports', 'screenshots', '.mixin.out'])

const TEXT_EXTENSIONS = new Set([
  '.json',
  '.json5',
  '.hjson',
  '.toml',
  '.yaml',
  '.yml',
  '.txt',
  '.cfg',
  '.conf',
  '.ini',
  '.properties',
  '.xml',
  '.mcmeta',
  '.lang',
  '.env',
  '.sh',
  '.bat',
  '.cmd',
  '.ps1',
])

/** Upper bound for content scanning; bigger files are binary payloads. */
export const MAX_SCAN_BYTES = 4 * 1024 * 1024

/** `accessToken`, `access_token`, `refresh-token`, `clientToken`, `token`, … */
const SENSITIVE_KEY =
  /^(?:(?:access|refresh|client|id|session|auth)[_-]?)?token$|^cookies?$|^password$|^passwd$|^secret$|^authorization$/i

const TEXT_PATTERNS: Array<{ label: string; pattern: RegExp; replace: string }> = [
  {
    label: 'token-json-field',
    pattern: /("(?:[A-Za-z0-9_.-]*[_-])?(?:access|refresh|client|id|session|auth)?[_-]?token"\s*:\s*")[^"]*(")/gi,
    replace: '$1<redacted>$2',
  },
  {
    label: 'credential-json-field',
    pattern: /("(?:cookie|cookies|password|passwd|secret|authorization)"\s*:\s*")[^"]*(")/gi,
    replace: '$1<redacted>$2',
  },
  {
    label: 'cookie-header',
    pattern: /^(\s*(?:set-)?cookie\s*[:=]\s*).+$/gim,
    replace: '$1<redacted>',
  },
  {
    label: 'token-assignment',
    pattern: /^(\s*[A-Za-z0-9_.-]*(?:access|refresh|client|id|session|auth)?[_-]?token\s*[=:]\s*).+$/gim,
    replace: '$1<redacted>',
  },
  {
    label: 'credential-assignment',
    pattern: /^(\s*(?:password|passwd|secret|authorization)\s*[=:]\s*).+$/gim,
    replace: '$1<redacted>',
  },
  {
    label: 'authorization-header',
    pattern: /^(\s*authorization\s*[:=]\s*(?:bearer|basic)\s+).+$/gim,
    replace: '$1<redacted>',
  },
  {
    label: 'bearer-token',
    pattern: /\b(bearer\s+)[A-Za-z0-9._~+/-]{8,}=*/gi,
    replace: '$1<redacted>',
  },
  {
    label: 'query-token',
    pattern: /([?&](?:access_token|refresh_token|id_token|token|session|cookie)=)[^&\s"'#]+/gi,
    replace: '$1<redacted>',
  },
]

export function isSensitiveSharePath(relative: string): boolean {
  const normalized = relative.replaceAll('\\', '/').toLowerCase()
  const segments = normalized.split('/')
  if (segments.some((segment) => DENIED_SEGMENTS.has(segment))) return true
  const base = segments[segments.length - 1] ?? ''
  return DENIED_BASENAMES.has(base)
}

function isTextCandidate(relative: string): boolean {
  return TEXT_EXTENSIONS.has(path.extname(relative).toLowerCase())
}

function redactJsonValue(
  value: unknown,
  prefix: string,
  fields: string[],
): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => redactJsonValue(item, `${prefix}[${index}]`, fields))
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = prefix ? `${prefix}.${key}` : key
      if (SENSITIVE_KEY.test(key)) {
        fields.push(childPath)
        output[key] = '<redacted>'
      } else {
        output[key] = redactJsonValue(child, childPath, fields)
      }
    }
    return output
  }
  return value
}

function redactJsonText(text: string): { text: string; fields: string[] } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const fields: string[] = []
  const redacted = redactJsonValue(parsed, '', fields)
  if (fields.length === 0) return { text, fields }
  return { text: `${JSON.stringify(redacted, null, 2)}\n`, fields }
}

function redactText(text: string): { text: string; fields: string[] } {
  let output = text
  const fields: string[] = []
  for (const rule of TEXT_PATTERNS) {
    const before = output
    output = output.replace(rule.pattern, rule.replace)
    if (output !== before) fields.push(rule.label)
  }
  return { text: output, fields }
}

/** Redacts sensitive JSON keys in an in-memory settings object. */
export function redactShareJsonValue<T>(value: T): { value: T; fields: string[] } {
  const fields: string[] = []
  const redacted = redactJsonValue(value, '', fields) as T
  return { value: redacted, fields }
}

export interface SanitizedShareEntry {
  data: Buffer
  redaction: ShareRedaction | null
}

/**
 * Returns the scrubbed bytes for one archive entry. Denied credential stores
 * produce `data: null` at the caller level (the helper reports `skipped`).
 */
export function sanitizeShareEntry(
  relative: string,
  data: Buffer,
): { skipped: true; redaction: ShareRedaction } | { skipped: false; result: SanitizedShareEntry } {
  if (isSensitiveSharePath(relative)) {
    return {
      skipped: true,
      redaction: { path: relative, action: 'skipped', fields: ['credential-store'] },
    }
  }
  if (!isTextCandidate(relative) || data.length > MAX_SCAN_BYTES) {
    return { skipped: false, result: { data, redaction: null } }
  }

  const raw = data.toString('utf8')
  const json = redactJsonText(raw)
  if (json) {
    // Also scan the serialized values for cookie/authorization headers and
    // tokenized URLs that live inside otherwise harmless JSON fields.
    const textScan = redactText(json.text)
    const fields = [...json.fields, ...textScan.fields]
    if (fields.length === 0) {
      return { skipped: false, result: { data, redaction: null } }
    }
    return {
      skipped: false,
      result: {
        data: Buffer.from(textScan.text, 'utf8'),
        redaction: { path: relative, action: 'redacted', fields },
      },
    }
  }
  const scanned = redactText(raw)
  if (scanned.fields.length === 0) {
    return { skipped: false, result: { data, redaction: null } }
  }
  return {
    skipped: false,
    result: {
      data: Buffer.from(scanned.text, 'utf8'),
      redaction: { path: relative, action: 'redacted', fields: scanned.fields },
    },
  }
}
