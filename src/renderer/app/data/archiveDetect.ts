/**
 * Renderer-side archive sniffing for drag & drop.
 *
 * The dropped File is a Blob, so we can read only the ZIP central directory and
 * the few manifest entries we need. This keeps a 100 MB+ pack out of memory and
 * lets the UI decide what to install without asking the user to pick a type.
 */

export type DetectedLoaderType = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'unknown'

export interface DetectedLoader {
  type: DetectedLoaderType
  version: string | null
}

export type ArchiveDetection =
  | {
      kind: 'modpack'
      format: 'modrinth' | 'curseforge'
      name: string | null
      gameVersion: string | null
      loader: DetectedLoader
      evidence: string[]
    }
  | { kind: 'resourcepack'; evidence: string[] }
  | { kind: 'shaderpack'; evidence: string[] }
  | { kind: 'unknown'; evidence: string[] }

export type ArchiveSource = Blob | ArrayBuffer | Uint8Array

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  localOffset: number
  flags: number
}

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

function sourceSize(source: ArchiveSource): number {
  if (source instanceof Uint8Array) return source.byteLength
  if (source instanceof ArrayBuffer) return source.byteLength
  return source.size
}

async function readRange(source: ArchiveSource, start: number, end: number): Promise<Uint8Array> {
  const from = Math.max(0, start)
  const to = Math.min(sourceSize(source), end)
  if (to <= from) return new Uint8Array(0)
  if (source instanceof Uint8Array) return source.slice(from, to)
  if (source instanceof ArrayBuffer) return new Uint8Array(source.slice(from, to))
  return new Uint8Array(await source.slice(from, to).arrayBuffer())
}

function u16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8)
}

function u32(data: Uint8Array, offset: number): number {
  return (
    (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0
  )
}

function decodeName(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes).replace(/\\/g, '/').replace(/^\.\//, '')
}

async function readCentralDirectory(source: ArchiveSource): Promise<Map<string, ZipEntry>> {
  const size = sourceSize(source)
  if (size < 22) throw new Error('archive too small')
  const tailSize = Math.min(size, 0x10000 + 22)
  const tail = await readRange(source, size - tailSize, size)
  let eocd = -1
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (u32(tail, i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('zip end-of-central-directory not found')
  const count = u16(tail, eocd + 10)
  const centralSize = u32(tail, eocd + 12)
  const centralOffset = u32(tail, eocd + 16)
  if (count === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error('ZIP64 archive is not supported by the drop sniffer')
  }
  const central = await readRange(source, centralOffset, centralOffset + centralSize)
  const entries = new Map<string, ZipEntry>()
  let offset = 0
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > central.length || u32(central, offset) !== CENTRAL_SIG) break
    const flags = u16(central, offset + 8)
    const method = u16(central, offset + 10)
    const compressedSize = u32(central, offset + 20)
    const nameLength = u16(central, offset + 28)
    const extraLength = u16(central, offset + 30)
    const commentLength = u16(central, offset + 32)
    const localOffset = u32(central, offset + 42)
    const nameStart = offset + 46
    if (nameStart + nameLength > central.length) break
    const name = decodeName(central.slice(nameStart, nameStart + nameLength))
    if (name) entries.set(name, { name, method, compressedSize, localOffset, flags })
    offset = nameStart + nameLength + extraLength + commentLength
  }
  return entries
}

async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream is unavailable')
  }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

async function readEntry(source: ArchiveSource, entry: ZipEntry, maxBytes = 4 * 1024 * 1024): Promise<Uint8Array> {
  if (entry.flags & 1) throw new Error('encrypted zip entry')
  const local = await readRange(source, entry.localOffset, entry.localOffset + 30)
  if (local.length < 30 || u32(local, 0) !== LOCAL_SIG) throw new Error('invalid local zip header')
  const nameLength = u16(local, 26)
  const extraLength = u16(local, 28)
  const dataStart = entry.localOffset + 30 + nameLength + extraLength
  const compressed = await readRange(source, dataStart, dataStart + entry.compressedSize)
  let data: Uint8Array
  if (entry.method === 0) data = compressed
  else if (entry.method === 8) data = await inflateRaw(compressed)
  else throw new Error(`unsupported zip compression method ${entry.method}`)
  if (data.byteLength > maxBytes) throw new Error('zip entry exceeds size limit')
  return data
}

async function readJson(
  source: ArchiveSource,
  entries: Map<string, ZipEntry>,
  name: string,
): Promise<Record<string, unknown> | null> {
  const entry = entries.get(name)
  if (!entry) return null
  const bytes = await readEntry(source, entry)
  const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '')
  const parsed: unknown = JSON.parse(text)
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

const LOADER_KEYS: ReadonlyArray<[string, DetectedLoaderType]> = [
  ['fabric-loader', 'fabric'],
  ['quilt-loader', 'quilt'],
  ['forge', 'forge'],
  ['neoforge', 'neoforge'],
]

function parseModrinth(index: Record<string, unknown>): {
  gameVersion: string | null
  loader: DetectedLoader
} | null {
  const dependencies = asRecord(index.dependencies)
  if (!dependencies) return null
  const gameVersion = asString(dependencies.minecraft)
  for (const [key, type] of LOADER_KEYS) {
    const version = asString(dependencies[key])
    if (version) return { gameVersion, loader: { type, version } }
  }
  return { gameVersion, loader: { type: gameVersion ? 'vanilla' : 'unknown', version: null } }
}

function parseCurseLoader(id: string | null): DetectedLoader {
  if (!id) return { type: 'vanilla', version: null }
  const dash = id.indexOf('-')
  if (dash < 0) return { type: 'unknown', version: id }
  const rawType = id.slice(0, dash).toLowerCase()
  const version = id.slice(dash + 1) || null
  if (rawType === 'forge') return { type: 'forge', version }
  if (rawType === 'neoforge') return { type: 'neoforge', version }
  if (rawType === 'fabric') return { type: 'fabric', version }
  if (rawType === 'quilt') return { type: 'quilt', version }
  return { type: 'unknown', version }
}

function parseCurse(manifest: Record<string, unknown>): {
  gameVersion: string | null
  loader: DetectedLoader
  name: string | null
} | null {
  const minecraft = asRecord(manifest.minecraft)
  if (!minecraft) return null
  const gameVersion = asString(minecraft.version)
  const loaders = Array.isArray(minecraft.modLoaders) ? minecraft.modLoaders : []
  const chosen = loaders
    .map((item) => asRecord(item))
    .find((item) => item?.primary === true) ?? asRecord(loaders[0])
  return {
    gameVersion,
    loader: parseCurseLoader(asString(chosen?.id)),
    name: asString(manifest.name),
  }
}

function hasPrefix(names: Iterable<string>, prefix: string): boolean {
  const lower = prefix.toLowerCase()
  for (const name of names) if (name.toLowerCase().startsWith(lower)) return true
  return false
}

/** Sniff a ZIP/MRPACK from its bytes without extracting it. */
export async function detectArchive(source: ArchiveSource, fileName = ''): Promise<ArchiveDetection> {
  const lowerName = fileName.toLowerCase()
  const isMrpack = lowerName.endsWith('.mrpack')
  let entries: Map<string, ZipEntry>
  try {
    entries = await readCentralDirectory(source)
  } catch (error) {
    return {
      kind: 'unknown',
      evidence: [`无法读取 ZIP 目录：${error instanceof Error ? error.message : String(error)}`],
    }
  }
  if (entries.size === 0) {
    return { kind: 'unknown', evidence: ['ZIP 中没有可读条目'] }
  }
  const names = [...entries.keys()]
  const hasModrinth = entries.has('modrinth.index.json')
  const hasCurse = entries.has('manifest.json')
  const hasPackMeta = entries.has('pack.mcmeta')
  const hasAssets = hasPrefix(names, 'assets/')
  const hasShaders = hasPrefix(names, 'shaders/')

  if (hasModrinth) {
    try {
      const index = await readJson(source, entries, 'modrinth.index.json')
      if (index) {
        const parsed = parseModrinth(index)
        if (parsed) {
          return {
            kind: 'modpack',
            format: 'modrinth',
            name: asString(index.name),
            gameVersion: parsed.gameVersion,
            loader: parsed.loader,
            evidence: [
              '发现 modrinth.index.json',
              parsed.gameVersion ? `清单游戏版本 ${parsed.gameVersion}` : '清单未声明游戏版本',
              parsed.loader.type === 'unknown'
                ? '清单未声明可识别的加载器'
                : `清单加载器 ${parsed.loader.type}${parsed.loader.version ? ` ${parsed.loader.version}` : ''}`,
            ],
          }
        }
      }
    } catch (error) {
      if (!isMrpack) {
        return {
          kind: 'unknown',
          evidence: [`发现 modrinth.index.json，但无法解析：${error instanceof Error ? error.message : String(error)}`],
        }
      }
    }
  }

  if (hasCurse) {
    try {
      const manifest = await readJson(source, entries, 'manifest.json')
      if (manifest) {
        const parsed = parseCurse(manifest)
        if (parsed) {
          return {
            kind: 'modpack',
            format: 'curseforge',
            name: parsed.name,
            gameVersion: parsed.gameVersion,
            loader: parsed.loader,
            evidence: [
              '发现 CurseForge manifest.json',
              parsed.gameVersion ? `清单游戏版本 ${parsed.gameVersion}` : '清单未声明游戏版本',
              parsed.loader.type === 'unknown'
                ? '清单未声明可识别的加载器'
                : `清单加载器 ${parsed.loader.type}${parsed.loader.version ? ` ${parsed.loader.version}` : ''}`,
            ],
          }
        }
      }
    } catch (error) {
      if (!isMrpack) {
        return {
          kind: 'unknown',
          evidence: [`发现 manifest.json，但无法解析：${error instanceof Error ? error.message : String(error)}`],
        }
      }
    }
  }

  if (isMrpack) {
    return {
      kind: 'modpack',
      format: 'modrinth',
      name: null,
      gameVersion: null,
      loader: { type: 'unknown', version: null },
      evidence: ['扩展名为 .mrpack；清单未能完整解析，将交给后端校验'],
    }
  }

  if (hasPackMeta && hasAssets) {
    return {
      kind: 'resourcepack',
      evidence: ['发现 pack.mcmeta', '发现 assets/ 资源目录'],
    }
  }
  if (hasShaders) {
    return { kind: 'shaderpack', evidence: ['发现 shaders/ 光影目录'] }
  }
  if (hasPackMeta) {
    return {
      kind: 'resourcepack',
      evidence: ['发现 pack.mcmeta；没有 assets/，但 pack.mcmeta 表明是资源包'],
    }
  }

  return {
    kind: 'unknown',
    evidence: [
      '未找到 modrinth.index.json / manifest.json / pack.mcmeta / shaders/',
      `ZIP 条目 ${entries.size} 个，扩展名 ${lowerName || '未知'}；无法可靠判断类型`,
    ],
  }
}
