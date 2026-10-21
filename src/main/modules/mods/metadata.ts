import type { FsPort } from '../../core/ports'
import { openZipFile } from '../../core/zip/reader'
import type { ModDependency, ModMetadata } from '@shared/mods'

/**
 * Small, dependency-free metadata reader for Fabric and Forge/NeoForge mods.
 * It deliberately reads only the two metadata files; jars are untrusted input,
 * so every archive access goes through the bounded core ZIP reader.
 */

function normalizeVersion(value: string): string {
  return value.trim().replace(/^v/i, '').split('+')[0]
}

function versionParts(value: string): Array<number | string> {
  return normalizeVersion(value)
    .split(/[.-]/)
    .filter((part) => part.length > 0)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()))
}

export function compareVersions(left: string, right: string): number {
  const a = versionParts(left)
  const b = versionParts(right)
  const length = Math.max(a.length, b.length)
  for (let index = 0; index < length; index += 1) {
    const x = a[index]
    const y = b[index]
    if (x === undefined) return y === 0 ? 0 : -1
    if (y === undefined) return x === 0 ? 0 : 1
    if (x === y) continue
    if (typeof x === 'number' && typeof y === 'number') return x < y ? -1 : 1
    if (typeof x === 'number') return 1
    if (typeof y === 'number') return -1
    return x < y ? -1 : 1
  }
  return 0
}

function compareToken(version: string, token: string): boolean {
  const trimmed = token.trim()
  if (!trimmed || trimmed === '*' || trimmed === 'x' || trimmed === 'X') return true

  if (trimmed.startsWith('>=')) return compareVersions(version, trimmed.slice(2)) >= 0
  if (trimmed.startsWith('<=')) return compareVersions(version, trimmed.slice(2)) <= 0
  if (trimmed.startsWith('>')) return compareVersions(version, trimmed.slice(1)) > 0
  if (trimmed.startsWith('<')) return compareVersions(version, trimmed.slice(1)) < 0
  if (trimmed.startsWith('==')) return compareVersions(version, trimmed.slice(2)) === 0
  if (trimmed.startsWith('=')) return compareVersions(version, trimmed.slice(1)) === 0

  if (trimmed.startsWith('~')) {
    const base = trimmed.slice(1)
    const parts = versionParts(base)
    const upper =
      parts.length >= 2
        ? `${String(parts[0])}.${Number(parts[1]) + 1}.0`
        : `${Number(parts[0]) + 1}.0.0`
    return compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0
  }
  if (trimmed.startsWith('^')) {
    const base = trimmed.slice(1)
    const parts = versionParts(base)
    const upper = `${Number(parts[0]) + 1}.0.0`
    return compareVersions(version, base) >= 0 && compareVersions(version, upper) < 0
  }

  // 1.20.x / 1.20.* — prefix match on dot-separated numeric parts.
  if (/[xX*]$/.test(trimmed)) {
    const prefix = normalizeVersion(trimmed.replace(/[xX*]+$/, '')).replace(/\.$/, '')
    return (
      normalizeVersion(version) === prefix || normalizeVersion(version).startsWith(`${prefix}.`)
    )
  }
  return compareVersions(version, trimmed) === 0
}

/** `null`/empty means "any version"; Forge Maven ranges and Fabric comparators
 * are both accepted because modpacks commonly mix them. */
export function satisfiesRange(version: string | null, range: string | null): boolean {
  if (!range || range.trim().length === 0 || range.trim() === '*') return true
  if (!version) return false
  const value = range.trim()

  if (value.includes('||')) {
    return value.split('||').some((branch) => satisfiesRange(version, branch))
  }

  if (value.startsWith('[') || value.startsWith('(')) {
    const close = value.endsWith(']') || value.endsWith(')')
    const body = close ? value.slice(1, -1) : value.slice(1)
    const pieces = body.split(',').map((piece) => piece.trim())
    if (pieces.length === 1 && close) {
      return compareVersions(version, pieces[0]) === 0
    }
    const lowerOk = pieces[0]
      ? value.startsWith('[')
        ? compareVersions(version, pieces[0]) >= 0
        : compareVersions(version, pieces[0]) > 0
      : true
    const upperOk = pieces[1]
      ? value.endsWith(']')
        ? compareVersions(version, pieces[1]) <= 0
        : compareVersions(version, pieces[1]) < 0
      : true
    return lowerOk && upperOk
  }

  return value.split(/\s+/).filter(Boolean).every((token) => compareToken(version, token))
}

function unquote(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function tomlValue(line: string): { key: string; value: string } | null {
  const index = line.indexOf('=')
  if (index <= 0) return null
  return {
    key: line.slice(0, index).trim(),
    value: unquote(line.slice(index + 1).trim()),
  }
}

interface ParsedTomlMod {
  id: string
  name: string | null
  version: string | null
  loader: 'forge' | 'neoforge'
  dependencies: ModDependency[]
}

function parseTomlMods(text: string, loader: 'forge' | 'neoforge'): ParsedTomlMod | null {
  let mod: { id: string; name: string | null; version: string | null } | null = null
  let current: 'mod' | 'dependency' | null = null
  let owner = ''
  let dep: Partial<ModDependency> | null = null
  const dependencies: ModDependency[] = []

  const finishDependency = () => {
    if (!dep?.id) return
    dependencies.push({
      id: dep.id,
      versionRange: dep.versionRange ?? null,
      mandatory: dep.mandatory ?? true,
      source: loader,
    })
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/(^|\s)#.*$/, '').trim()
    if (!line) continue
    const header = line.match(/^\[\[(.+)\]\]$/)
    if (header) {
      const name = header[1].trim()
      if (name === 'mods') {
        current = 'mod'
        mod ??= { id: '', name: null, version: null }
      } else if (name.startsWith('dependencies.')) {
        current = 'dependency'
        owner = unquote(name.slice('dependencies.'.length))
        finishDependency()
        dep = {}
      } else {
        current = null
      }
      continue
    }
    const pair = tomlValue(line)
    if (!pair) continue
    if (current === 'mod' && mod) {
      if (pair.key === 'modId') mod.id = pair.value
      else if (pair.key === 'displayName') mod.name = pair.value
      else if (pair.key === 'version') mod.version = pair.value
    } else if (current === 'dependency' && dep) {
      if (pair.key === 'modId') dep.id = pair.value
      else if (pair.key === 'versionRange') dep.versionRange = pair.value
      else if (pair.key === 'mandatory') dep.mandatory = pair.value.toLowerCase() !== 'false'
    }
  }
  finishDependency()

  if (!mod && dependencies.length === 0) return null
  return {
    id: mod?.id || owner || 'unknown',
    name: mod?.name ?? mod?.id ?? null,
    version: mod?.version ?? null,
    loader,
    dependencies,
  }
}

function fabricDependencies(value: unknown, warnings: string[]): ModDependency[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const result: ModDependency[] = []
  for (const [id, range] of Object.entries(value as Record<string, unknown>)) {
    if (typeof range === 'string' || range === null) {
      result.push({
        id,
        versionRange: typeof range === 'string' ? range : null,
        mandatory: true,
        source: 'fabric',
      })
    } else if (Array.isArray(range)) {
      for (const item of range) {
        if (typeof item === 'string') {
          result.push({ id, versionRange: item, mandatory: true, source: 'fabric' })
        }
      }
    } else if (range && typeof range === 'object') {
      const record = range as Record<string, unknown>
      if (typeof record.version === 'string') {
        result.push({
          id,
          versionRange: record.version,
          mandatory: record.mandatory !== false,
          source: 'fabric',
        })
      } else {
        warnings.push(`无法解析依赖 ${id} 的版本声明`)
      }
    }
  }
  return result
}

export interface MetadataReadResult {
  metadata: ModMetadata | null
  error: string | null
}

export function readModMetadata(fs: FsPort, file: string): MetadataReadResult {
  try {
    const archive = openZipFile(fs, file)
    if (archive.has('fabric.mod.json')) {
      const parsed = JSON.parse(archive.read('fabric.mod.json').toString('utf8')) as Record<
        string,
        unknown
      >
      if (typeof parsed.id !== 'string' || parsed.id.length === 0) {
        return { metadata: null, error: 'fabric.mod.json 缺少 id' }
      }
      const warnings: string[] = []
      return {
        metadata: {
          id: parsed.id,
          name: typeof parsed.name === 'string' ? parsed.name : parsed.id,
          version: typeof parsed.version === 'string' ? parsed.version : null,
          loader: parsed.quilt_loader ? 'quilt' : 'fabric',
          dependencies: fabricDependencies(parsed.depends, warnings),
        },
        error: warnings.length > 0 ? warnings.join('; ') : null,
      }
    }

    const tomlName = archive.has('META-INF/neoforge.mods.toml')
      ? 'META-INF/neoforge.mods.toml'
      : archive.has('META-INF/mods.toml')
        ? 'META-INF/mods.toml'
        : null
    if (tomlName) {
      const text = archive.read(tomlName).toString('utf8')
      const parsed = parseTomlMods(
        text,
        tomlName.includes('neoforge') ? 'neoforge' : 'forge',
      )
      if (!parsed) return { metadata: null, error: `${tomlName} 中没有 mods 声明` }
      return {
        metadata: {
          id: parsed.id,
          name: parsed.name,
          version: parsed.version,
          loader: parsed.loader,
          dependencies: parsed.dependencies,
        },
        error: null,
      }
    }
    return { metadata: null, error: null }
  } catch (error) {
    return {
      metadata: null,
      error: `无法读取模组元数据: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export { normalizeVersion }
