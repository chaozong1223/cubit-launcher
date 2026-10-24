import path from 'node:path'
import type { ProcessPort, FsPort } from '../../../core/ports'
import { probeJavaExecutable } from '../../../core/java/probe'
import { javaExecutableName } from '../../../core/java/detect'
import { openZipFile, safeEntryPath, type ZipArchive, type ZipEntry } from '../../../core/zip/reader'
import { CoreError } from '../../../core/errors'
import { JavaError } from './errors'
import type { JavaHttp } from './http'
import type { JavaPackage } from './providers'
import { ensureManagedRoot, javaCacheDir } from './settings'

/**
 * Download → SHA-256 → extract → validate → atomic move into `dataRoot/java/`.
 *
 * Nothing is written outside the managed root except the module cache zip; a
 * failure removes the temp extract dir and the zip, leaving the detected Java
 * list untouched. The downloaded JDK is probed before it is moved into place
 * (SEC-EXE-01: never trust a downloaded binary).
 */

export interface JavaInstallProgressDelta {
  stage: 'download' | 'verify' | 'extract' | 'validate'
  percent?: number | null
  downloadedBytes?: number
  totalBytes?: number
  entriesDone?: number
  entriesTotal?: number
  currentFile?: string | null
  message?: string | null
}

export interface InstallJavaPackageInput {
  fs: FsPort
  ports: ProcessPort
  http: JavaHttp
  dataRoot: string
  pkg: JavaPackage
  platform?: NodeJS.Platform
  signal?: AbortSignal
  onProgress?: (delta: JavaInstallProgressDelta) => void
}

export interface InstalledJava {
  path: string
  home: string
  major: number
  version: string
  vendor: string
  managedDir: string
  bytes: number
}

const MAX_EXTRACT_ENTRIES = 20_000

function sanitizeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._+-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'jdk'
}

function listFiles(archive: ZipArchive): ZipEntry[] {
  if (archive.entries.length > MAX_EXTRACT_ENTRIES) {
    throw new JavaError('JAVA.ARCHIVE_UNSAFE', {
      message: `archive has ${archive.entries.length} entries (limit ${MAX_EXTRACT_ENTRIES})`,
    })
  }
  return archive.entries.filter((entry) => !entry.isDirectory)
}

function extractArchive(
  fs: FsPort,
  archive: ZipArchive,
  destination: string,
  onProgress?: (done: number, total: number, current: string) => void,
): number {
  const files = listFiles(archive)
  let done = 0
  for (const entry of files) {
    if (entry.isSymlink) {
      throw new JavaError('JAVA.ARCHIVE_UNSAFE', {
        message: `archive contains a symlink: ${entry.name}`,
        details: { entry: entry.name },
      })
    }
    let target: string
    try {
      target = safeEntryPath(destination, entry.name)
    } catch (error) {
      throw new JavaError('JAVA.ARCHIVE_UNSAFE', {
        message: error instanceof Error ? error.message : String(error),
        details: { entry: entry.name },
        cause: error,
      })
    }
    try {
      fs.writeBytes(target, archive.readEntry(entry))
    } catch (error) {
      if (error instanceof CoreError && error.code === 'ARCHIVE.UNSAFE_PATH') {
        throw new JavaError('JAVA.ARCHIVE_UNSAFE', {
          message: error.message,
          details: { entry: entry.name },
          cause: error,
        })
      }
      throw new JavaError('JAVA.EXTRACT_FAILED', {
        message: `cannot extract ${entry.name}`,
        details: { entry: entry.name },
        cause: error,
      })
    }
    done += 1
    onProgress?.(done, files.length, entry.name)
  }
  return files.length
}

function findJavaHome(
  fs: FsPort,
  root: string,
  platform: NodeJS.Platform,
  maxDepth = 3,
): { home: string; executable: string } | null {
  const exeName = javaExecutableName(platform)
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    const exe = path.join(current.dir, 'bin', exeName)
    if (fs.exists(exe) && fs.stat(exe)?.isFile()) {
      return { home: current.dir, executable: exe }
    }
    if (current.depth >= maxDepth) continue
    for (const name of fs.readDir(current.dir)) {
      if (name === 'bin' || name.startsWith('.')) continue
      const child = path.join(current.dir, name)
      if (fs.stat(child)?.isDirectory()) queue.push({ dir: child, depth: current.depth + 1 })
    }
  }
  return null
}

function copyDirectory(fs: FsPort, from: string, to: string): void {
  fs.mkdirp(to)
  for (const name of fs.readDir(from)) {
    const source = path.join(from, name)
    const target = path.join(to, name)
    const stat = fs.stat(source)
    if (stat?.isDirectory()) copyDirectory(fs, source, target)
    else if (stat?.isFile()) fs.copyFile(source, target)
  }
}

export async function installJavaPackage(input: InstallJavaPackageInput): Promise<InstalledJava> {
  const platform = input.platform ?? process.platform
  const root = ensureManagedRoot(input.dataRoot)
  const cacheDir = javaCacheDir(input.dataRoot)
  input.fs.mkdirp(cacheDir)

  const fileName = sanitizeName(input.pkg.fileName)
  const zipPath = path.join(cacheDir, `${fileName}.zip`)
  const tempDir = path.join(root, `.tmp-${sanitizeName(input.pkg.version)}-${process.pid}-${Date.now()}`)

  try {
    input.onProgress?.({
      stage: 'download',
      percent: 0,
      downloadedBytes: 0,
      totalBytes: input.pkg.size ?? 0,
      currentFile: fileName,
      message: `下载 ${fileName}`,
    })
    const candidates = [input.pkg.mirrorUrl, input.pkg.url].filter(
      (url): url is string => typeof url === 'string' && url.length > 0,
    )
    const downloaded = await input.http.download(candidates.length > 0 ? candidates : input.pkg.url, {
      dest: zipPath,
      sha256: input.pkg.sha256,
      size: input.pkg.size,
      ...(input.signal ? { signal: input.signal } : {}),
      retries: 2,
      onBytes: (delta, total) => {
        const totalBytes = input.pkg.size ?? total
        input.onProgress?.({
          stage: 'download',
          percent: totalBytes > 0 ? Math.min(100, Math.round((total / totalBytes) * 100)) : null,
          downloadedBytes: total,
          totalBytes,
          currentFile: fileName,
        })
      },
    })
    input.onProgress?.({
      stage: 'verify',
      percent: 100,
      downloadedBytes: downloaded.bytes,
      totalBytes: downloaded.bytes,
      currentFile: fileName,
      message: 'SHA-256 校验通过',
    })

    let archive: ZipArchive
    try {
      archive = openZipFile(input.fs, zipPath, { maxEntries: MAX_EXTRACT_ENTRIES })
    } catch (error) {
      if (error instanceof CoreError && error.code === 'ARCHIVE.UNSAFE_PATH') {
        throw new JavaError('JAVA.ARCHIVE_UNSAFE', {
          message: error.message,
          cause: error,
        })
      }
      if (error instanceof CoreError) {
        throw new JavaError('JAVA.EXTRACT_FAILED', {
          message: `${error.code}: ${error.message}`,
          cause: error,
        })
      }
      throw error
    }
    input.fs.mkdirp(tempDir)
    const totalEntries = listFiles(archive).length
    input.onProgress?.({
      stage: 'extract',
      percent: 0,
      entriesDone: 0,
      entriesTotal: totalEntries,
      currentFile: null,
      message: '解压 Java',
    })
    extractArchive(input.fs, archive, tempDir, (done, total, current) => {
      input.onProgress?.({
        stage: 'extract',
        percent: total > 0 ? Math.round((done / total) * 100) : 100,
        entriesDone: done,
        entriesTotal: total,
        currentFile: current,
      })
    })

    const found = findJavaHome(input.fs, tempDir, platform)
    if (!found) {
      throw new JavaError('JAVA.EXTRACT_FAILED', {
        message: 'extracted archive contains no bin/java executable',
      })
    }

    input.onProgress?.({
      stage: 'validate',
      percent: 0,
      currentFile: found.executable,
      message: '验证 Java 版本',
    })
    const probe = await probeJavaExecutable(input.ports, found.executable)
    if (!probe.ok) {
      throw new JavaError('JAVA.VALIDATE_FAILED', {
        message: `downloaded Java cannot run: ${probe.reason}`,
        details: { path: found.executable, reason: probe.reason },
      })
    }
    if (probe.version.major !== input.pkg.major) {
      throw new JavaError('JAVA.VALIDATE_FAILED', {
        message: `downloaded Java is major ${probe.version.major}, expected ${input.pkg.major}`,
        details: { expected: input.pkg.major, actual: probe.version.major },
      })
    }

    const managedDir = sanitizeName(`${input.pkg.source}-${input.pkg.major}-${input.pkg.version}`)
    const finalDir = path.join(root, managedDir)
    const existingExe = path.join(finalDir, 'bin', javaExecutableName(platform))
    if (input.fs.exists(existingExe)) {
      input.onProgress?.({
        stage: 'validate',
        percent: 100,
        currentFile: existingExe,
        message: '已存在同版本 Java，复用现有安装',
      })
      return {
        path: existingExe,
        home: finalDir,
        major: input.pkg.major,
        version: input.pkg.version,
        vendor: input.pkg.source,
        managedDir,
        bytes: downloaded.bytes,
      }
    }
    if (input.fs.exists(finalDir)) input.fs.remove(finalDir)
    try {
      input.fs.rename(found.home, finalDir)
    } catch {
      copyDirectory(input.fs, found.home, finalDir)
    }
    const executable = path.join(finalDir, 'bin', javaExecutableName(platform))
    if (!input.fs.exists(executable)) {
      throw new JavaError('JAVA.EXTRACT_FAILED', {
        message: `java executable missing after install: ${executable}`,
      })
    }
    input.onProgress?.({
      stage: 'validate',
      percent: 100,
      currentFile: executable,
      message: `Java ${input.pkg.major} 安装完成`,
    })
    return {
      path: executable,
      home: finalDir,
      major: input.pkg.major,
      version: input.pkg.version,
      vendor: input.pkg.source,
      managedDir,
      bytes: downloaded.bytes,
    }
  } finally {
    try {
      input.fs.remove(tempDir)
    } catch {
      /* best effort */
    }
    try {
      input.fs.remove(zipPath)
    } catch {
      /* best effort */
    }
  }
}
