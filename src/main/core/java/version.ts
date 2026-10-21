/**
 * Java version parsing and the Minecraft → required-Java table.
 *
 * The table mirrors the documented requirement (docs/01 §5.4, docs/03 §6.4):
 *   ≥1.20.5 → 21, 1.18–1.20.4 → 17, 1.17 → 16, ≤1.16.5 → 8.
 * A version JSON's own `javaVersion.majorVersion` always wins.
 */

export interface JavaVersion {
  major: number
  minor: number
  patch: number
  /** Raw string exactly as printed by Java. */
  raw: string
}

const VERSION_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[._](\d+))?/

/**
 * Parses every layout seen in the wild:
 *   1.8.0_402, 1.8.0_402-b06, 17.0.15, 21.0.12.1, 21-ea, 9.0.4, 25+36
 */
export function parseJavaVersion(raw: string | null | undefined): JavaVersion | null {
  if (!raw) return null
  const value = raw.trim().replace(/^"|"$/g, '')
  const match = VERSION_PATTERN.exec(value)
  if (!match) return null

  let major = Number(match[1])
  let minor = match[2] === undefined ? 0 : Number(match[2])
  let patch = match[3] === undefined ? 0 : Number(match[3])

  if (major === 1) {
    // Legacy scheme: 1.8.0_402 means Java 8. The build number is the useful
    // patch value for display ("17.0.15" style is used by everything else).
    major = minor
    minor = 0
    patch = match[4] !== undefined ? Number(match[4]) : patch
  } else if (match[4] !== undefined) {
    // 21.0.12.1 — the fourth component is a vendor build; keep patch = 12.
    patch = match[3] === undefined ? 0 : Number(match[3])
  }

  if (!Number.isFinite(major) || major <= 0) return null
  return { major, minor: Number.isFinite(minor) ? minor : 0, patch: Number.isFinite(patch) ? patch : 0, raw: value }
}

export function formatJavaVersion(version: JavaVersion): string {
  if (version.major <= 8) return `1.${version.major}.0_${version.patch}`
  return `${version.major}.${version.minor}.${version.patch}`
}

/** Parses the numeric Minecraft version; pre-releases/snapshots return null. */
export function parseMinecraftVersion(value: string | null | undefined): [number, number, number] | null {
  if (!value) return null
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!match) return null
  return [Number(match[1]), Number(match[2]), match[3] === undefined ? 0 : Number(match[3])]
}

function atLeast(
  version: [number, number, number],
  target: [number, number, number],
): boolean {
  for (let index = 0; index < 3; index += 1) {
    if (version[index] !== target[index]) return version[index] > target[index]
  }
  return true
}

/** Fallback table used when a version JSON has no `javaVersion` block. */
export function javaMajorForMinecraft(mcVersion: string | null | undefined): number | null {
  const parsed = parseMinecraftVersion(mcVersion)
  if (!parsed) return null
  if (atLeast(parsed, [1, 20, 5])) return 21
  if (atLeast(parsed, [1, 18, 0])) return 17
  if (atLeast(parsed, [1, 17, 0])) return 16
  return 8
}

/** Java 17 and older cannot represent NBSP-free console encodings via COMPAT. */
export function fileEncodingForJava(javaMajor: number, codePageName: string): string {
  if (javaMajor >= 18) return 'COMPAT'
  return codePageName
}

/**
 * Windows code page → Java charset name used for stdout/stderr and
 * `file.encoding`. 936 (Simplified Chinese) is the local acceptance machine.
 */
export const CODE_PAGE_ENCODINGS: Record<number, string> = {
  437: 'IBM437',
  65001: 'UTF-8',
  936: 'GBK',
  950: 'Big5',
  932: 'Shift_JIS',
  949: 'EUC-KR',
  1252: 'windows-1252',
  1251: 'windows-1251',
  874: 'x-windows-874',
}

export function encodingForCodePage(codePage: number | null | undefined): string {
  if (!codePage) return 'UTF-8'
  return CODE_PAGE_ENCODINGS[codePage] ?? `cp${codePage}`
}
