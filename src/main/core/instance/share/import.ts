import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { AppError } from '@shared/errors'
import { isCoreError } from '../../errors'
import {
  InstanceSettingsSchema,
  type InstanceSettings,
  type ShareConflictStrategy,
  type ShareImportResult,
} from '@shared/instance'
import type { FsPort } from '../../ports'
import { openZipFile, safeEntryPath, type ZipArchive } from '../../zip/reader'
import { resolveLibraries } from '../../version/classpath'
import { resolveVersion } from '../../version/load'
import { defaultInstanceSettings, writeInstanceSettings } from '../settings'
import { resolvePathConflict, sanitizePathName, uniquePathName } from '../../fs/conflict'
import { RollbackStack } from '../../fs/rollback'
import { readShareManifest, SHARE_MANIFEST_ENTRY } from './manifest'
import { redactShareJsonValue } from './sanitize'

/** Import limits; the exporter never produces archives beyond these. */
export const SHARE_ZIP_LIMITS = {
  maxEntries: 100_000,
  maxEntrySize: 1024 * 1024 * 1024,
  maxTotalSize: 4 * 1024 * 1024 * 1024,
  maxArchiveSize: 2 * 1024 * 1024 * 1024 + 16 * 1024 * 1024,
}

const STAGING_PREFIX = '.share-import-'
const BACKUP_PREFIX = '.share-backup-'
const STALE_STAGING_MS = 24 * 60 * 60 * 1000

export interface ShareImportLogger {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

export interface ExtractSharePackInput {
  fs: FsPort
  mcRoot: string
  filePath: string
  name?: string
  /** Omitted → conflict is reported without touching the filesystem. */
  conflict?: ShareConflictStrategy
  /** Rejects an overwrite while the existing instance is running. */
  isTargetRunning?: (dirName: string) => boolean
  now?: () => number
  log?: ShareImportLogger
}

function parseJsonObject(data: Buffer, label: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(data.toString('utf8'))
  } catch {
    throw new AppError('INSTANCE.SHARE_INVALID', `${label} 不是有效 JSON`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AppError('INSTANCE.SHARE_INVALID', `${label} 结构不正确`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Imports a `.cubitpack` as a new isolated instance.
 *
 * Everything is unpacked into a hidden staging directory inside `versions/`
 * first; an existing same-name instance is only moved aside during the final
 * rename. Any failure unwinds the `RollbackStack`, restoring the previous
 * instance and deleting the staging directory (acceptance: 失败可回滚).
 */
export async function extractSharePack(input: ExtractSharePackInput): Promise<ShareImportResult> {
  const fs = input.fs
  const now = input.now ?? Date.now
  const file = path.resolve(input.filePath)
  if (!fs.exists(file)) {
    throw new AppError('INSTANCE.SHARE_NOT_FOUND', `找不到分享包: ${input.filePath}`)
  }
  const archive: ZipArchive = openZipFile(fs, file, SHARE_ZIP_LIMITS)
  const manifest = readShareManifest(archive)
  const versionsDir = path.join(input.mcRoot, 'versions')
  fs.mkdirp(versionsDir)

  const displayName = input.name?.trim() || manifest.name
  const baseDirName = sanitizePathName(displayName, 'share')
  const baseTarget = path.join(versionsDir, baseDirName)
  const occupied = fs.exists(baseTarget)

  const baseResult: Omit<ShareImportResult, 'status' | 'instanceId' | 'dirName'> = {
    name: displayName,
    mcVersion: manifest.mcVersion,
    loader: manifest.loader,
    files: 0,
    bytes: 0,
    overwritten: false,
    renamed: false,
    needsBaseInstall: false,
    launchable: false,
    missingLibraries: 0,
    warnings: [...manifest.warnings],
    redactions: manifest.redactions,
  }

  // Conflict without a decision: report it and write nothing, so the UI can
  // offer 覆盖/跳过/改名 and call again with the chosen strategy.
  if (occupied && input.conflict === undefined) {
    return {
      ...baseResult,
      status: 'conflict',
      instanceId: null,
      dirName: baseDirName,
      warnings: [
        ...baseResult.warnings,
        `同名实例「${baseDirName}」已存在；请选择覆盖、跳过或改名后重试。`,
      ],
    }
  }
  if (occupied && input.conflict === 'skip') {
    return {
      ...baseResult,
      status: 'skipped',
      instanceId: null,
      dirName: baseDirName,
      warnings: [...baseResult.warnings, `同名实例「${baseDirName}」已存在，已按“跳过”处理。`],
    }
  }

  const resolution = resolvePathConflict({
    target: baseTarget,
    strategy: input.conflict ?? 'rename',
    exists: (target) => fs.exists(target),
    uniqueTarget: () =>
      path.join(versionsDir, uniquePathName(versionsDir, displayName, (target) => fs.exists(target))),
  })
  const dirName = path.basename(resolution.target)
  const targetDir = resolution.target
  const overwriteExisting = resolution.strategy === 'overwrite' && occupied
  const warnings = [...baseResult.warnings]
  if (overwriteExisting && input.isTargetRunning?.(dirName)) {
    throw new AppError('INSTANCE.RUNNING', '要覆盖的实例正在运行，请先结束游戏后再导入', {
      details: { instanceId: dirName },
    })
  }

  // Leftovers can only come from a crashed import; never reuse them. A fresh
  // staging dir from another launcher process is young and left alone.
  const nowMs = now()
  for (const name of fs.readDir(versionsDir)) {
    if (!name.startsWith(STAGING_PREFIX)) continue
    const stagingPath = path.join(versionsDir, name)
    const stat = fs.stat(stagingPath)
    if (stat && nowMs - stat.mtimeMs < STALE_STAGING_MS) continue
    try {
      fs.remove(stagingPath)
    } catch {
      /* best effort */
    }
  }
  const backupDir = path.join(versionsDir, `${BACKUP_PREFIX}${dirName}`)
  if (fs.exists(backupDir)) {
    if (!fs.exists(targetDir)) {
      // Crash between "move old aside" and "move new in": restore the original.
      fs.rename(backupDir, targetDir)
      warnings.push('检测到上次导入中断，已恢复原有实例')
    } else {
      try {
        fs.remove(backupDir)
      } catch {
        /* a locked leftover is hidden from the instance scan */
      }
    }
  }

  const staging = path.join(versionsDir, `${STAGING_PREFIX}${process.pid}-${randomUUID()}`)
  const rollback = new RollbackStack()
  const record = { files: 0, bytes: 0 }

  try {
    rollback.push('删除导入暂存目录', () => {
      try {
        fs.remove(staging)
      } catch {
        /* best effort */
      }
    })
    fs.mkdirp(staging)

    let profileData: Buffer | null = null
    let jarData: Buffer | null = null
    let instanceJsonData: Buffer | null = null
    const extraInstanceFiles = new Map<string, Buffer>()
    const seen = new Set<string>()

    for (const entry of archive.entries) {
      if (entry.isDirectory) continue
      if (seen.has(entry.name)) {
        warnings.push(`忽略重复条目: ${entry.name}`)
        continue
      }
      seen.add(entry.name)
      if (entry.name === SHARE_MANIFEST_ENTRY) continue
      if (entry.isSymlink) {
        warnings.push(`忽略符号链接条目: ${entry.name}`)
        continue
      }
      if (entry.name.startsWith('game/')) {
        const relative = entry.name.slice('game/'.length)
        if (!relative) continue
        const lowered = relative.replaceAll('\\', '/').toLowerCase()
        if (
          lowered === 'instance.json' ||
          lowered.startsWith('versions/') ||
          lowered.startsWith('.minecraft/')
        ) {
          warnings.push(`拒绝覆盖启动器文件: ${entry.name}`)
          continue
        }
        const data = archive.readEntry(entry)
        const target = safeEntryPath(staging, relative)
        fs.mkdirp(path.dirname(target))
        fs.writeBytes(target, data)
        record.files += 1
        record.bytes += data.length
        continue
      }
      if (entry.name.startsWith('version/')) {
        const relative = entry.name.slice('version/'.length)
        if (relative === 'profile.json') profileData = archive.readEntry(entry)
        else if (relative === 'client.jar') jarData = archive.readEntry(entry)
        else warnings.push(`忽略未知版本条目: ${entry.name}`)
        continue
      }
      if (entry.name.startsWith('instance/')) {
        const relative = entry.name.slice('instance/'.length)
        if (relative === 'instance.json') instanceJsonData = archive.readEntry(entry)
        else extraInstanceFiles.set(relative, archive.readEntry(entry))
        continue
      }
      warnings.push(`忽略未知条目: ${entry.name}`)
    }

    if (!profileData) {
      throw new AppError('INSTANCE.SHARE_INVALID', '分享包缺少版本配置（version/profile.json）')
    }
    const profile = parseJsonObject(profileData, 'version/profile.json')
    // scanInstances rejects an instance whose JSON id ≠ directory name.
    profile.id = dirName
    const inheritsFrom =
      typeof profile.inheritsFrom === 'string' && profile.inheritsFrom.length > 0
        ? profile.inheritsFrom
        : null
    let needsBaseInstall = false
    if (inheritsFrom) {
      const baseJson = path.join(versionsDir, inheritsFrom, `${inheritsFrom}.json`)
      needsBaseInstall = !fs.exists(baseJson)
      if (needsBaseInstall) {
        warnings.push(
          `缺少基础版本 ${inheritsFrom}；请先在“下载”页安装该版本，否则无法启动。`,
        )
      }
    }
    const profileText = `${JSON.stringify(profile, null, 2)}\n`
    fs.writeTextAtomic(path.join(staging, `${dirName}.json`), profileText)
    record.files += 1
    record.bytes += Buffer.byteLength(profileText, 'utf8')
    if (jarData) {
      fs.writeBytes(path.join(staging, `${dirName}.jar`), jarData)
      record.files += 1
      record.bytes += jarData.length
    }

    // ---- instance settings -------------------------------------------------
    let packedSettings: InstanceSettings | null = null
    if (instanceJsonData) {
      try {
        const parsed = InstanceSettingsSchema.safeParse(
          JSON.parse(instanceJsonData.toString('utf8')),
        )
        if (parsed.success) packedSettings = parsed.data
        else warnings.push('分享包里的实例设置无效，已使用默认设置')
      } catch {
        warnings.push('分享包里的实例设置无法解析，已使用默认设置')
      }
    }
    const defaults = defaultInstanceSettings({
      dirName,
      id: dirName,
      name: displayName,
      mcVersion: manifest.mcVersion,
      loader: manifest.loader,
      isolation: 'isolated',
      source: 'pack',
      now: now(),
    })
    if (
      packedSettings &&
      (packedSettings.java.mode === 'path' || packedSettings.jvmArgs.length > 0)
    ) {
      warnings.push('出于安全考虑，未导入分享包中的自定义 Java 路径/JVM 参数')
    }
    const importedSettings: InstanceSettings = packedSettings
      ? {
          ...defaults,
          ...packedSettings,
          id: dirName,
          dirName,
          name: displayName,
          isolation: 'isolated',
          source: 'pack',
          java: { mode: 'auto', value: null },
          jvmArgs: [],
          icon: null,
          createdAt: now(),
          lastPlayedAt: null,
          playTimeSec: 0,
        }
      : defaults

    if (manifest.icon && extraInstanceFiles.has(manifest.icon)) {
      const extension = path.extname(manifest.icon).toLowerCase()
      const iconName = /^\.(png|jpe?g|webp|gif|ico)$/.test(extension) ? `icon${extension}` : 'icon.png'
      const iconData = extraInstanceFiles.get(manifest.icon)!
      fs.writeBytes(path.join(staging, iconName), iconData)
      importedSettings.icon = path.join(targetDir, iconName)
      record.files += 1
      record.bytes += iconData.length
    }
    for (const key of extraInstanceFiles.keys()) {
      if (key !== manifest.icon) warnings.push(`忽略未知实例条目: instance/${key}`)
    }
    const sanitizedSettings = redactShareJsonValue(importedSettings)
    writeInstanceSettings(fs, staging, sanitizedSettings.value)
    record.files += 1
    record.bytes += Buffer.byteLength(JSON.stringify(sanitizedSettings.value, null, 2), 'utf8')

    // ---- commit ------------------------------------------------------------
    if (overwriteExisting) {
      fs.rename(targetDir, backupDir)
      rollback.push('恢复原有实例', () => {
        try {
          if (fs.exists(backupDir)) {
            if (fs.exists(targetDir)) fs.remove(targetDir)
            fs.rename(backupDir, targetDir)
          }
        } catch {
          /* best effort */
        }
      })
    }
    fs.rename(staging, targetDir)
    rollback.push('删除已导入实例', () => {
      try {
        fs.remove(targetDir)
      } catch {
        /* best effort */
      }
    })

    rollback.commit()
    if (overwriteExisting && fs.exists(backupDir)) {
      try {
        fs.remove(backupDir)
      } catch {
        warnings.push('旧实例备份未能删除（位于 versions/ 下的隐藏目录）')
      }
    }

    // ---- launchability -----------------------------------------------------
    let launchable = false
    let missingLibraries = 0
    try {
      const resolved = resolveVersion(fs, input.mcRoot, dirName)
      const libraries = resolveLibraries(resolved.json, {
        librariesDir: path.join(input.mcRoot, 'libraries'),
        clientJar: resolved.clientJar,
        platform: process.platform,
        arch: process.arch,
        exists: (target) => fs.exists(target),
      })
      missingLibraries = libraries.missing.length
      launchable =
        resolved.clientJarExists &&
        missingLibraries === 0 &&
        typeof resolved.json.mainClass === 'string' &&
        resolved.json.mainClass.length > 0
      if (missingLibraries > 0) {
        warnings.push(`缺少 ${missingLibraries} 个库文件；请重新安装对应加载器或执行修复。`)
      }
      if (!resolved.clientJarExists) {
        warnings.push('找不到客户端 jar；请安装基础版本或执行修复。')
      }
    } catch (error) {
      if (isCoreError(error) && error.code === 'VERSION_PARENT_NOT_FOUND') {
        needsBaseInstall = true
      } else {
        warnings.push(
          `导入后校验失败: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    const result: ShareImportResult = {
      ...baseResult,
      status: 'imported',
      instanceId: dirName,
      dirName,
      files: record.files,
      bytes: record.bytes,
      overwritten: overwriteExisting,
      renamed: resolution.renamed,
      needsBaseInstall,
      launchable,
      missingLibraries,
      warnings: [...new Set(warnings)],
    }
    input.log?.info('share pack imported', {
      instanceId: dirName,
      files: result.files,
      bytes: result.bytes,
      overwritten: result.overwritten,
      renamed: result.renamed,
      launchable: result.launchable,
      redacted: manifest.redactions.length,
    })
    return result
  } catch (error) {
    const failures = await rollback.rollback()
    if (failures.length > 0) {
      input.log?.warn('share pack rollback step failed', { failures })
    }
    input.log?.warn('share pack import failed', {
      message: error instanceof Error ? error.message : String(error),
      rollbackFailures: failures.length,
    })
    if (error instanceof AppError) throw error
    throw new AppError(
      'INSTANCE.SHARE_IMPORT_FAILED',
      `导入分享包失败: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
