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

export interface GameFullscreenResult {
  path: string
  changed: boolean
  /** What the file said before (null when the file or the key is absent). */
  previous: boolean | null
  fullscreen: boolean
}

/**
 * Align `fullscreen:` in options.txt with the launcher's window setting.
 *
 * Minecraft 1.12.2 uses LWJGL2, whose `ChangeDisplaySettings` fullscreen call
 * fails on this class of machine (`LWJGLException: Failed to set display mode
 * (-1)`) and takes the OpenGL context down with it — the game then dies with
 * "Pixel format not accelerated". `options.txt` wins over `--width/--height`,
 * so a player who pressed F11 once would keep crashing on every launch until
 * they found that setting again. The launcher setting is the source of truth.
 */
export function applyGameFullscreen(
  fs: FsPort,
  gameDir: string,
  fullscreen: boolean,
): GameFullscreenResult {
  const optionsPath = path.join(gameDir, 'options.txt')
  if (!fs.exists(optionsPath)) {
    return { path: optionsPath, changed: false, previous: null, fullscreen }
  }
  const original = fs.readText(optionsPath)
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const lines = original.split(/\r?\n/)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  const desired = `fullscreen:${fullscreen ? 'true' : 'false'}`
  const next: string[] = []
  let previous: boolean | null = null
  let replaced = false
  for (const line of lines) {
    const match = /^fullscreen\s*:\s*(\w+)/.exec(line)
    if (match) {
      if (!replaced) {
        previous = match[1]?.toLowerCase() === 'true'
        next.push(desired)
        replaced = true
      }
      continue
    }
    next.push(line)
  }
  if (!replaced) next.push(desired)
  const contents = `${next.join(eol)}${eol}`
  const changed = original !== contents
  if (changed) fs.writeTextAtomic(optionsPath, contents)
  return { path: optionsPath, changed, previous, fullscreen }
}
