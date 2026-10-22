import path from 'node:path'
import type { InstanceSettings, ShareContentSelection, ShareExportResult, ShareRedaction } from '@shared/instance'
import { AppError } from '@shared/errors'
import type { FsPort } from '../../ports'
import { createStoredZip, type ZipWriteEntry } from '../../zip/writer'
import { sanitizePathName } from '../../fs/conflict'
import {
  DEFAULT_SHARE_CONTENT,
  normalizeShareSelection,
  SHARE_MANIFEST_ENTRY,
  SHARE_MANIFEST_SCHEMA_VERSION,
  SHARE_PACK_EXTENSION,
  SHARE_PACK_KIND,
  SHARE_SECTION_FOLDERS,
  ShareManifestSchema,
  countRedactions,
  type ShareManifest,
} from './manifest'
import { MAX_SCAN_BYTES, redactShareJsonValue, sanitizeShareEntry } from './sanitize'

/** Hard limits keep the pack readable by the in-memory zip reader on import. */
export const MAX_SHARE_BYTES = 2 * 1024 * 1024 * 1024
export const MAX_SHARE_FILES = 100_000
export const MAX_SHARE_ENTRY_BYTES = 1024 * 1024 * 1024
export const MAX_ICON_BYTES = 2 * 1024 * 1024

export interface ShareExportLogger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface CreateSharePackInput {
  fs: FsPort
  mcRoot: string
  dataRoot: string
  /** Absolute `versions/<dirName>` directory. */
  instanceDir: string
  dirName: string
  settings: InstanceSettings
  include?: Partial<ShareContentSelection>
  outPath?: string
  now?: () => number
  log?: ShareExportLogger
}

interface SectionName {
  key: keyof ShareContentSelection
  folder: string
}

class PackBuilder {
  readonly entries: ZipWriteEntry[] = []
  readonly redactions: ShareRedaction[] = []
  readonly warnings: string[] = []
  readonly counts: Record<keyof ShareContentSelection, number> = {
    mods: 0,
    config: 0,
    resourcepacks: 0,
    shaderpacks: 0,
    saves: 0,
    options: 0,
  }
  bytes = 0

  constructor(private readonly fs: FsPort) {}

  add(entryName: string, data: Buffer, section: keyof ShareContentSelection | null): void {
    if (this.entries.length >= MAX_SHARE_FILES) {
      throw new AppError(
        'INSTANCE.SHARE_TOO_LARGE',
        `分享包文件数超过 ${MAX_SHARE_FILES} 上限`,
      )
    }
    if (this.bytes + data.length > MAX_SHARE_BYTES) {
      throw new AppError('INSTANCE.SHARE_TOO_LARGE', '分享包内容超过 2 GB 上限')
    }
    this.entries.push({ name: entryName, data })
    this.bytes += data.length
    if (section) this.counts[section] += 1
  }
}

function addSanitizedFile(
  builder: PackBuilder,
  archiveName: string,
  data: Buffer,
  section: keyof ShareContentSelection | null,
): void {
  const sanitized = sanitizeShareEntry(archiveName, data)
  if (sanitized.skipped) {
    builder.redactions.push(sanitized.redaction)
    return
  }
  builder.add(archiveName, sanitized.result.data, section)
  if (sanitized.result.redaction) builder.redactions.push(sanitized.result.redaction)
}

interface WalkContext {
  fs: FsPort
  instanceRoot: string
  builder: PackBuilder
  /** Guards against a symlink loop while walking selected folders. */
  visitedDirs: Set<string>
}

function walkSection(
  context: WalkContext,
  section: keyof ShareContentSelection,
  absoluteDir: string,
  relativeDir: string,
  depth = 0,
): void {
  if (depth > 32) {
    context.builder.warnings.push(`目录层级过深，已跳过: ${relativeDir}`)
    return
  }
  const realDir = context.fs.realpath(absoluteDir)
  if (context.visitedDirs.has(realDir)) return
  context.visitedDirs.add(realDir)
  for (const name of context.fs.readDir(absoluteDir)) {
    const absolute = path.join(absoluteDir, name)
    const stat = context.fs.stat(absolute)
    if (!stat) continue
    const relative = relativeDir ? `${relativeDir}/${name}` : name
    if (stat.isDirectory()) {
      walkSection(context, section, absolute, relative, depth + 1)
      continue
    }
    if (!stat.isFile()) continue
    // Symlinks that leave the instance must not leak unrelated files.
    const real = context.fs.realpath(absolute)
    const root = context.fs.realpath(context.instanceRoot)
    if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
      context.builder.warnings.push(`跳过指向实例目录之外的链接: ${relative}`)
      continue
    }
    if (stat.size > MAX_SHARE_ENTRY_BYTES) {
      context.builder.warnings.push(`跳过超过 1 GB 的文件: ${relative}`)
      continue
    }
    addSanitizedFile(
      context.builder,
      `game/${relative}`,
      context.fs.readBytes(absolute),
      section,
    )
  }
}

interface IconPlan {
  entry: ZipWriteEntry | null
  /** Value stored in `instance.json` inside the pack. */
  settingsIcon: string | null
  manifestIcon: string | null
  warning: string | null
}

function planIcon(fs: FsPort, instanceDir: string, icon: string | null): IconPlan {
  if (!icon) {
    return { entry: null, settingsIcon: null, manifestIcon: null, warning: null }
  }
  if (icon.startsWith('data:image/')) {
    if (icon.length > 512 * 1024) {
      return {
        entry: null,
        settingsIcon: null,
        manifestIcon: null,
        warning: '实例图标过大，已从分享包中省略',
      }
    }
    return { entry: null, settingsIcon: icon, manifestIcon: null, warning: null }
  }
  if (/^https?:\/\//i.test(icon)) {
    return { entry: null, settingsIcon: icon, manifestIcon: null, warning: null }
  }
  try {
    const real = fs.realpath(icon)
    const root = fs.realpath(instanceDir)
    const inside = real === root || real.startsWith(`${root}${path.sep}`)
    const stat = fs.stat(real)
    if (!inside || !stat?.isFile()) {
      return {
        entry: null,
        settingsIcon: null,
        manifestIcon: null,
        warning: '实例图标不在实例目录内，已从分享包中省略',
      }
    }
    if (stat.size > MAX_ICON_BYTES) {
      return {
        entry: null,
        settingsIcon: null,
        manifestIcon: null,
        warning: '实例图标超过 2 MB，已从分享包中省略',
      }
    }
    const extension = path.extname(real).toLowerCase()
    const safeExtension = /^\.(png|jpe?g|webp|gif|ico)$/.test(extension) ? extension : '.png'
    const iconRel = `icon${safeExtension}`
    return {
      entry: { name: `instance/${iconRel}`, data: fs.readBytes(real) },
      settingsIcon: null,
      manifestIcon: iconRel,
      warning: null,
    }
  } catch {
    return {
      entry: null,
      settingsIcon: null,
      manifestIcon: null,
      warning: '实例图标不可读取，已从分享包中省略',
    }
  }
}

/**
 * Builds a `.cubitpack` from an isolated instance directory.
 *
 * The instance directory doubles as the game directory (isolated layout), so
 * the pack stores the version profile separately from the selected game
 * folders; `manifest.json` records what was included and which credential
 * material was stripped (evidence only, never values).
 */
export function createSharePack(input: CreateSharePackInput): ShareExportResult {
  const now = input.now ?? Date.now
  const fs = input.fs
  const selection = normalizeShareSelection(input.include)
  if (input.settings.isolation !== 'isolated') {
    throw new AppError('INSTANCE.SHARE_EXPORT_UNSUPPORTED', '只有「隔离」实例可以导出分享包')
  }

  const profilePath = path.join(input.instanceDir, `${input.dirName}.json`)
  if (!fs.exists(profilePath)) {
    throw new AppError(
      'INSTANCE.SHARE_EXPORT_UNSUPPORTED',
      `实例缺少版本配置 ${input.dirName}.json，无法导出分享包`,
    )
  }
  let profile: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(fs.readText(profilePath))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad shape')
    profile = parsed as Record<string, unknown>
  } catch {
    throw new AppError('INSTANCE.SHARE_EXPORT_UNSUPPORTED', '实例版本配置已损坏，无法导出分享包')
  }

  const builder = new PackBuilder(fs)
  const warnings: string[] = []

  const iconPlan = planIcon(fs, input.instanceDir, input.settings.icon)
  if (iconPlan.warning) warnings.push(iconPlan.warning)

  // Version profile + optional client jar (the launcher resolves the jar from
  // the base version otherwise, exactly like a normal instance).
  addSanitizedFile(
    builder,
    'version/profile.json',
    Buffer.from(`${JSON.stringify(profile, null, 2)}\n`, 'utf8'),
    null,
  )
  const jarPath = path.join(input.instanceDir, `${input.dirName}.jar`)
  const jarStat = fs.stat(jarPath)
  if (jarStat?.isFile()) {
    if (jarStat.size > MAX_SHARE_ENTRY_BYTES) {
      warnings.push('客户端 jar 超过 1 GB，已从分享包中省略')
    } else {
      addSanitizedFile(builder, 'version/client.jar', fs.readBytes(jarPath), null)
    }
  }

  const context: WalkContext = {
    fs,
    instanceRoot: input.instanceDir,
    builder,
    visitedDirs: new Set<string>(),
  }
  const sections: Array<keyof ShareContentSelection> = [
    'mods',
    'config',
    'resourcepacks',
    'shaderpacks',
    'saves',
  ]
  for (const section of sections) {
    if (!selection[section]) continue
    for (const folder of SHARE_SECTION_FOLDERS[section]) {
      const absolute = path.join(input.instanceDir, folder)
      if (fs.exists(absolute)) walkSection(context, section, absolute, folder)
    }
  }
  if (selection.options) {
    const optionsPath = path.join(input.instanceDir, 'options.txt')
    if (fs.stat(optionsPath)?.isFile()) {
      addSanitizedFile(builder, 'game/options.txt', fs.readBytes(optionsPath), 'options')
    }
  }

  if (iconPlan.entry) builder.add(iconPlan.entry.name, iconPlan.entry.data, null)

  const settingsForPack = {
    ...input.settings,
    isolation: 'isolated' as const,
    icon: iconPlan.settingsIcon,
    lastPlayedAt: null,
    playTimeSec: 0,
  }
  const settingsSanitized = redactShareJsonValue(settingsForPack)
  const settingsBuffer = Buffer.from(`${JSON.stringify(settingsSanitized.value, null, 2)}\n`, 'utf8')
  // The settings object only contains known fields, but run it through the same
  // scanner so an unexpected credential field can never slip into the pack.
  const settingsScan = sanitizeShareEntry('instance/instance.json', settingsBuffer)
  if (settingsScan.skipped) {
    throw new AppError('INSTANCE.SHARE_EXPORT_UNSUPPORTED', '实例配置被安全策略拒绝导出')
  }
  builder.add('instance/instance.json', settingsScan.result.data, null)
  const settingsFields = [
    ...new Set([...settingsSanitized.fields, ...(settingsScan.result.redaction?.fields ?? [])]),
  ]
  if (settingsFields.length > 0) {
    builder.redactions.push({
      path: 'instance/instance.json',
      action: 'redacted',
      fields: settingsFields,
    })
  }

  const manifest: ShareManifest = {
    schemaVersion: SHARE_MANIFEST_SCHEMA_VERSION,
    kind: SHARE_PACK_KIND,
    createdAt: now(),
    name: input.settings.name,
    mcVersion: input.settings.mcVersion,
    loader: input.settings.loader,
    isolation: 'isolated',
    selection,
    counts: {
      files: builder.entries.length,
      bytes: builder.bytes,
      mods: builder.counts.mods,
      config: builder.counts.config,
      resourcepacks: builder.counts.resourcepacks,
      shaderpacks: builder.counts.shaderpacks,
      saves: builder.counts.saves,
      options: builder.counts.options,
    },
    redactions: builder.redactions,
    warnings: [...new Set([...warnings, ...builder.warnings])],
    icon: iconPlan.manifestIcon,
  }
  const manifestParsed = ShareManifestSchema.safeParse(manifest)
  if (!manifestParsed.success) {
    throw new AppError('INSTANCE.SHARE_EXPORT_UNSUPPORTED', '分享包清单生成失败')
  }

  const buffer = createStoredZip(
    [
      {
        name: SHARE_MANIFEST_ENTRY,
        data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      },
      ...builder.entries,
    ],
    { now: new Date(now()), maxEntries: MAX_SHARE_FILES, maxTotalBytes: MAX_SHARE_BYTES },
  )

  const timestamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const defaultTarget = path.join(
    input.dataRoot,
    'modules',
    'instance',
    'exports',
    `${sanitizePathName(input.settings.name)}-${timestamp}${SHARE_PACK_EXTENSION}`,
  )
  const requested = input.outPath ?? defaultTarget
  const finalPath = requested.toLowerCase().endsWith(SHARE_PACK_EXTENSION)
    ? requested
    : `${requested}${SHARE_PACK_EXTENSION}`
  fs.mkdirp(path.dirname(finalPath))
  fs.writeBytes(finalPath, buffer)

  const summary = {
    path: finalPath,
    format: 'cubitpack' as const,
    files: builder.entries.length,
    bytes: buffer.length,
    content: selection,
    redactions: builder.redactions,
    warnings: [...new Set([...warnings, ...builder.warnings])],
  }
  input.log?.info('share pack exported', {
    path: summary.path,
    files: summary.files,
    bytes: summary.bytes,
    redacted: builder.redactions.filter((record) => record.action === 'redacted').length,
    skipped: builder.redactions.filter((record) => record.action === 'skipped').length,
  })
  if (builder.redactions.length > 0) {
    // Evidence log: paths and field names only, never secret values.
    input.log?.warn('share pack credentials stripped', describeShareRedactions(builder.redactions))
  }
  return summary
}

export function describeShareRedactions(redactions: ShareRedaction[]): Record<string, unknown> {
  const counts = countRedactions(redactions)
  return {
    redactedFiles: counts.redacted,
    skippedFiles: counts.skipped,
    // Paths only: the redaction log must never contain secret values.
    redactions: redactions.map((record) => ({
      path: record.path,
      action: record.action,
      fields: record.fields,
    })),
  }
}

export { DEFAULT_SHARE_CONTENT }
export { MAX_SCAN_BYTES }
