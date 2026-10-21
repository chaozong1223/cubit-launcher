import path from 'node:path'
import type { FsPort } from '../ports'

export const DEFAULT_GAME_LANGUAGE = 'zh_cn'
const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:_[A-Za-z0-9]+)?$/

export interface GameLanguageResult {
  path: string
  backupPath: string | null
  changed: boolean
  language: string | null
}

/** `null`/empty means "follow the game"; invalid values are ignored. */
export function normalizeGameLanguage(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null
  const trimmed = value.trim()
  if (!trimmed || trimmed === 'follow' || trimmed === 'auto') return null
  return LANGUAGE_PATTERN.test(trimmed) ? trimmed : null
}

/**
 * Writes `lang:<code>` into the actual gameDir/options.txt (plan.cwd).
 * Other keys, key order and CRLF are preserved; the existing file is backed up
 * once as options.txt.bak. Called before every launch so an in-game language
 * change is overridden by the launcher setting.
 */
export function applyGameLanguage(
  fs: FsPort,
  gameDir: string,
  language: string | null | undefined,
): GameLanguageResult {
  const code = normalizeGameLanguage(language)
  const optionsPath = path.join(gameDir, 'options.txt')
  const backupPath = `${optionsPath}.bak`
  if (code === null) {
    return { path: optionsPath, backupPath: null, changed: false, language: null }
  }
  const existed = fs.exists(optionsPath)
  if (existed && !fs.exists(backupPath)) {
    fs.copyFile(optionsPath, backupPath)
  }
  fs.mkdirp(gameDir)
  const original = existed ? fs.readText(optionsPath) : ''
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.length > 0 ? original.split(/\r?\n/) : []
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const next: string[] = []
  let replaced = false
  for (const line of lines) {
    if (/^lang\s*:/.test(line)) {
      if (!replaced) {
        next.push(`lang:${code}`)
        replaced = true
      }
      continue
    }
    next.push(line)
  }
  if (!replaced) next.push(`lang:${code}`)
  const contents = `${next.join(eol)}${eol}`
  if (!existed || original !== contents) {
    fs.writeTextAtomic(optionsPath, contents)
  }
  return {
    path: optionsPath,
    backupPath: existed ? backupPath : null,
    changed: !existed || original !== contents,
    language: code,
  }
}

export { LANGUAGE_PATTERN }
