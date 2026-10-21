import path from 'node:path'
import type { FsPort } from '../../core/ports'
import type { ZipArchive } from '../../core/zip/reader'
import { safeEntryPath } from '../../core/zip/reader'
import type { Loader } from '@shared/instance'
import type { ModpackFormat } from '@shared/mods'
import { AppError } from '@shared/errors'
import { readJsonEntry } from './archive'
import {
  downloadVerified,
  MAX_PACK_FILE_BYTES,
  sha1 as sha1Of,
  sha512 as sha512Of,
  type FileDownloader,
  type FileHashes,
} from './downloader'

export interface MrpackFile {
  path: string
  hashes: FileHashes
  downloads: string[]
  fileSize?: number
  env?: { client?: string; server?: string }
}

export interface MrpackIndex {
  formatVersion: number
  game: string
  versionId: string
  name: string
  files: MrpackFile[]
  dependencies: Record<string, string>
}

export interface CurseManifest {
  minecraft: {
    version: string
    modLoaders: Array<{ id: string; primary?: boolean }>
  }
  manifestType: string
  name: string
  files: Array<{
    projectID: number
    fileID: number
    required?: boolean
    /** Some repacked CF zips carry these; use them before the API. */
    fileName?: string
    downloadUrl?: string
    hashes?: FileHashes
  }>
  overrides?: string
}

export interface PackManifest {
  format: ModpackFormat
  name: string
  mcVersion: string | null
  loader: Loader
  index: MrpackIndex | CurseManifest
}

const LOADER_KEYS: Record<string, Loader['type']> = {
  'fabric-loader': 'fabric',
  'quilt-loader': 'quilt',
  forge: 'forge',
  neoforge: 'neoforge',
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function parseLoader(dependencies: Record<string, unknown>): Loader {
  for (const [key, type] of Object.entries(LOADER_KEYS)) {
    const version = dependencies[key]
    if (typeof version === 'string' && version.length > 0) return { type, version }
  }
  return { type: 'vanilla', version: null }
}

export function parseCurseLoader(id: string | undefined): Loader {
  if (!id) return { type: 'vanilla', version: null }
  const dash = id.indexOf('-')
  if (dash < 0) return { type: 'unknown', version: id }
  const rawType = id.slice(0, dash).toLowerCase()
  const version = id.slice(dash + 1)
  if (rawType === 'forge') return { type: 'forge', version }
  if (rawType === 'neoforge') return { type: 'neoforge', version }
  if (rawType === 'fabric') return { type: 'fabric', version }
  if (rawType === 'quilt') return { type: 'quilt', version }
  return { type: 'unknown', version: id }
}

function parseCurseManifest(raw: unknown): CurseManifest {
  const record = asRecord(raw)
  const minecraft = record ? asRecord(record.minecraft) : null
  if (!record || !minecraft || typeof minecraft.version !== 'string') {
    throw new AppError('MODS.PACK_INVALID', 'CurseForge manifest.json 缺少 minecraft.version')
  }
  const files = Array.isArray(record.files) ? record.files : []
  const parsedFiles = files.flatMap((item) => {
    const entry = asRecord(item)
    if (!entry) return []
    const projectID = Number(entry.projectID)
    const fileID = Number(entry.fileID)
    if (!Number.isInteger(projectID) || !Number.isInteger(fileID)) return []
    const hashes = asRecord(entry.hashes)
    return [
      {
        projectID,
        fileID,
        required: entry.required !== false,
        ...(typeof entry.fileName === 'string' ? { fileName: entry.fileName } : {}),
        ...(typeof entry.downloadUrl === 'string' ? { downloadUrl: entry.downloadUrl } : {}),
        ...(hashes && typeof hashes.sha1 === 'string'
          ? { hashes: { sha1: hashes.sha1 } }
          : {}),
      },
    ]
  })
  return {
    minecraft: {
      version: minecraft.version,
      modLoaders: Array.isArray(minecraft.modLoaders)
        ? minecraft.modLoaders.flatMap((item) => {
            const entry = asRecord(item)
            return entry && typeof entry.id === 'string'
              ? [{ id: entry.id, primary: entry.primary === true }]
              : []
          })
        : [],
    },
    manifestType: typeof record.manifestType === 'string' ? record.manifestType : 'minecraftModpack',
    name: typeof record.name === 'string' ? record.name : 'CurseForge modpack',
    files: parsedFiles,
    overrides: typeof record.overrides === 'string' ? record.overrides : 'overrides',
  }
}

function parseMrpack(raw: unknown): MrpackIndex {
  const record = asRecord(raw)
  if (!record || Number(record.formatVersion) !== 1 || record.game !== 'minecraft') {
    throw new AppError('MODS.PACK_INVALID', '不支持的 .mrpack 格式（需要 formatVersion=1）')
  }
  const dependencies = asRecord(record.dependencies)
  if (!dependencies) {
    throw new AppError('MODS.PACK_INVALID', '.mrpack 缺少 dependencies')
  }
  const files = Array.isArray(record.files) ? record.files : []
  const parsedFiles = files.flatMap((item) => {
    const entry = asRecord(item)
    if (!entry || typeof entry.path !== 'string') return []
    const hashes = asRecord(entry.hashes) ?? {}
    const downloads = Array.isArray(entry.downloads)
      ? entry.downloads.filter((url): url is string => typeof url === 'string')
      : []
    const env = asRecord(entry.env)
    return [
      {
        path: entry.path,
        hashes: {
          ...(typeof hashes.sha1 === 'string' ? { sha1: hashes.sha1 } : {}),
          ...(typeof hashes.sha512 === 'string' ? { sha512: hashes.sha512 } : {}),
        },
        downloads,
        ...(typeof entry.fileSize === 'number' ? { fileSize: entry.fileSize } : {}),
        ...(env
          ? {
              env: {
                ...(typeof env.client === 'string' ? { client: env.client } : {}),
                ...(typeof env.server === 'string' ? { server: env.server } : {}),
              },
            }
          : {}),
      },
    ]
  })
  return {
    formatVersion: 1,
    game: 'minecraft',
    versionId: typeof record.versionId === 'string' ? record.versionId : '1.0.0',
    name: typeof record.name === 'string' ? record.name : 'Modrinth modpack',
    files: parsedFiles,
    dependencies: Object.fromEntries(
      Object.entries(dependencies).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  }
}

export function readPackManifest(fs: FsPort, archive: ZipArchive): PackManifest {
  if (archive.has('modrinth.index.json')) {
    const index = parseMrpack(readJsonEntry(archive, 'modrinth.index.json'))
    return {
      format: 'modrinth',
      name: index.name,
      mcVersion: index.dependencies.minecraft ?? null,
      loader: parseLoader(index.dependencies),
      index,
    }
  }
  if (archive.has('manifest.json')) {
    const manifest = parseCurseManifest(readJsonEntry(archive, 'manifest.json'))
    const primary = manifest.minecraft.modLoaders.find((loader) => loader.primary) ??
      manifest.minecraft.modLoaders[0]
    return {
      format: 'curseforge',
      name: manifest.name,
      mcVersion: manifest.minecraft.version,
      loader: parseCurseLoader(primary?.id),
      index: manifest,
    }
  }
  void fs
  throw new AppError('MODS.PACK_UNSUPPORTED', '不是可识别的整合包（缺少 modrinth.index.json / manifest.json）')
}

const BLOCKED_ROOTS = new Set([
  'instance.json',
  'versions',
  'logs',
  'saves',
  'screenshots',
  'crash-reports',
  '.minecraft',
])

function packTarget(gameDir: string, relative: string): string {
  const normalized = relative.replaceAll('\\', '/')
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new AppError('MODS.PACK_UNSAFE_PATH', `整合包包含非法路径: ${relative}`)
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    throw new AppError('MODS.PACK_UNSAFE_PATH', `整合包包含路径穿越: ${relative}`)
  }
  if (BLOCKED_ROOTS.has(segments[0].toLowerCase())) {
    throw new AppError('MODS.PACK_UNSAFE_PATH', `整合包试图写入受保护目录: ${relative}`, {
      details: { path: relative },
    })
  }
  return safeEntryPath(gameDir, normalized)
}

export interface PackDownloadResult {
  downloaded: number
  skipped: number
}

async function writeIfNeeded(
  fs: FsPort,
  target: string,
  data: Buffer,
  hashes: FileHashes,
): Promise<boolean> {
  if (fs.exists(target)) {
    const existing = fs.readBytes(target)
    const sha1 = hashes.sha1?.toLowerCase()
    const sha512 = hashes.sha512?.toLowerCase()
    if (
      (!sha1 || sha1Of(existing) === sha1) &&
      (!sha512 || sha512Of(existing) === sha512)
    ) {
      return false
    }
  }
  fs.mkdirp(path.dirname(target))
  fs.writeBytes(target, data)
  return true
}

function existingMatches(fs: FsPort, target: string, hashes: FileHashes): boolean {
  if (!fs.exists(target)) return false
  const data = fs.readBytes(target)
  const expectedSha1 = hashes.sha1?.toLowerCase()
  const expectedSha512 = hashes.sha512?.toLowerCase()
  return (
    (!expectedSha1 || sha1Of(data) === expectedSha1) &&
    (!expectedSha512 || sha512Of(data) === expectedSha512)
  )
}

export async function downloadMrpackFiles(
  fs: FsPort,
  gameDir: string,
  index: MrpackIndex,
  downloader: FileDownloader,
): Promise<PackDownloadResult> {
  let downloaded = 0
  let skipped = 0
  for (const file of index.files) {
    if (file.env?.client === 'unsupported') {
      skipped += 1
      continue
    }
    const target = packTarget(gameDir, file.path)
    // Overrides are extracted first; an exported pack can therefore reproduce
    // files without any downloadable URL.
    if (existingMatches(fs, target, file.hashes)) {
      skipped += 1
      continue
    }
    const result = await downloadVerified(
      downloader,
      file.downloads,
      file.hashes,
      Math.min(file.fileSize ?? MAX_PACK_FILE_BYTES, MAX_PACK_FILE_BYTES),
    )
    const wrote = await writeIfNeeded(fs, target, result.data, file.hashes)
    if (wrote) downloaded += 1
    else skipped += 1
  }
  return { downloaded, skipped }
}

export interface CurseForgeFile {
  fileName: string
  downloadUrl: string
  hashes?: FileHashes
}

export type CurseForgeResolver = (
  projectID: number,
  fileID: number,
) => Promise<CurseForgeFile>

export function createCurseForgeResolver(
  fetchImpl: typeof fetch = fetch,
  apiKey = process.env.MCL_CF_API_KEY,
): CurseForgeResolver {
  return async (projectID, fileID) => {
    if (!apiKey) {
      throw new AppError(
        'MODS.CF_API_KEY_MISSING',
        '导入 CurseForge 整合包需要 CurseForge API key（仅后端环境变量）',
        {
          details: {
            hint: '设置 MCL_CF_API_KEY 后重试；overrides 仍可手动解压，但 manifest 中的文件无法解析下载地址。',
          },
        },
      )
    }
    const response = await fetchImpl(
      `https://api.curseforge.com/v1/mods/${projectID}/files/${fileID}`,
      { headers: { 'x-api-key': apiKey, Accept: 'application/json' } },
    )
    if (!response.ok) {
      throw new AppError('MODS.PACK_DOWNLOAD_FAILED', `CurseForge API HTTP ${response.status}`, {
        retryable: response.status >= 500,
      })
    }
    const body = (await response.json()) as { data?: Record<string, unknown> }
    const data = body.data
    if (!data || typeof data.fileName !== 'string') {
      throw new AppError('MODS.PACK_DOWNLOAD_FAILED', 'CurseForge 未返回文件名')
    }
    const hashes = Array.isArray(data.hashes)
      ? data.hashes.flatMap((item) => {
          const entry = asRecord(item)
          if (!entry || typeof entry.value !== 'string') return []
          // CurseForge: 1=SHA1, 2=MD5, 3=SHA256 (SHA1 is what we verify).
          return Number(entry.algo) === 1 ? [{ sha1: entry.value }] : []
        })
      : []
    const downloadUrl =
      typeof data.downloadUrl === 'string' && data.downloadUrl.length > 0
        ? data.downloadUrl
        : `https://edge.forgecdn.net/files/${Math.floor(fileID / 1000)}/${fileID % 1000}/${encodeURIComponent(data.fileName)}`
    return {
      fileName: data.fileName,
      downloadUrl,
      ...(hashes[0] ? { hashes: hashes[0] } : {}),
    }
  }
}

export async function downloadCurseForgeFiles(
  fs: FsPort,
  gameDir: string,
  manifest: CurseManifest,
  downloader: FileDownloader,
  resolver: CurseForgeResolver,
): Promise<PackDownloadResult & { warnings: string[] }> {
  let downloaded = 0
  let skipped = 0
  const warnings: string[] = []
  for (const file of manifest.files) {
    try {
      const info =
        file.fileName && file.downloadUrl
          ? {
              fileName: file.fileName,
              downloadUrl: file.downloadUrl,
              ...(file.hashes ? { hashes: file.hashes } : {}),
            }
          : await resolver(file.projectID, file.fileID)
      const fileName = path.basename(info.fileName)
      if (!fileName || fileName === '.' || fileName === '..') {
        throw new AppError('MODS.PACK_UNSAFE_PATH', `CurseForge 返回非法文件名: ${info.fileName}`)
      }
      const target = packTarget(gameDir, `mods/${fileName}`)
      const result = await downloadVerified(downloader, [info.downloadUrl], info.hashes ?? {})
      const wrote = await writeIfNeeded(fs, target, result.data, info.hashes ?? {})
      if (wrote) downloaded += 1
      else skipped += 1
    } catch (error) {
      if (error instanceof AppError && error.code === 'MODS.CF_API_KEY_MISSING') {
        warnings.push(
          `${error.message}；已跳过 ${file.projectID}/${file.fileID}，overrides 仍会解压`,
        )
        skipped += 1
        continue
      }
      if (file.required === false) {
        warnings.push(`跳过可选文件 ${file.projectID}/${file.fileID}: ${error instanceof Error ? error.message : String(error)}`)
        skipped += 1
        continue
      }
      throw error
    }
  }
  return { downloaded, skipped, warnings }
}
