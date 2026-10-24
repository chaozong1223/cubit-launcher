import path from 'node:path'
import type { DownloadTask } from '@shared/download'
import { libraryArtifactPath } from '../../../core/version/name'
import type { FsPort } from '../../../core/ports'
import { openZipFile } from '../../../core/zip/reader'

/**
 * Turns a Fabric/Quilt profile JSON into download tasks for the shared
 * download module.
 *
 * Profiles reference maven libraries by `name` plus a repository base `url`
 * (no `downloads.artifact` block), so the path comes from the maven layout and
 * the hash from the profile's own `sha1`. BMCLAPI mirrors both loader mavens
 * under `/maven`, so a mirror URL is provided when the host is recognised.
 */

export interface ProfileLibraryTaskResult {
  tasks: DownloadTask[]
  warnings: string[]
}

const MIRROR = 'https://bmclapi2.bangbang93.com/maven'

const MIRRORED_HOSTS = new Set([
  'maven.fabricmc.net',
  'maven.quiltmc.org',
  // BMCLAPI proxies the Forge maven tree as well (verified: 302 -> CN CDN).
  'maven.minecraftforge.net',
  'maven.neoforged.net',
  'files.minecraftforge.net',
])

function mirrorUrlFor(baseUrl: string, relative: string): string | null {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
  if (MIRRORED_HOSTS.has(host)) {
    return `${MIRROR}/${relative}`
  }
  return null
}

export function profileLibraryTasks(profile: Record<string, unknown>): ProfileLibraryTaskResult {
  const warnings: string[] = []
  const tasks: DownloadTask[] = []
  const libraries = Array.isArray(profile.libraries) ? profile.libraries : []

  for (const raw of libraries) {
    const library = raw as {
      name?: unknown
      url?: unknown
      sha1?: unknown
      size?: unknown
      downloads?: { artifact?: { url?: unknown; sha1?: unknown; size?: unknown; path?: unknown } }
    }
    if (!library || typeof library.name !== 'string') continue
    const relative = libraryArtifactPath(library as { name: string; downloads?: { artifact?: { path?: string } } })
    if (!relative) {
      warnings.push(`鏃犳硶瑙ｆ瀽鍔犺浇鍣ㄥ簱璺緞锛?{library.name}`)
      continue
    }
    const artifact = library.downloads?.artifact
    const base = typeof artifact?.url === 'string' ? artifact.url : typeof library.url === 'string' ? library.url : null
    if (!base) {
      warnings.push(`鍔犺浇鍣ㄥ簱缂哄皯涓嬭浇鍦板潃锛?{library.name}`)
      continue
    }
    const url = artifact?.url ? base : `${base.replace(/\/+$/, '')}/${relative}`
    const sha1Raw = artifact?.sha1 ?? library.sha1
    const sha1 = typeof sha1Raw === 'string' && /^[a-f0-9]{40}$/i.test(sha1Raw) ? sha1Raw.toLowerCase() : null
    const sizeRaw = artifact?.size ?? library.size
    const size = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) ? sizeRaw : null
    if (!sha1) {
      warnings.push(`鍔犺浇鍣ㄥ簱娌℃湁鍙俊鍝堝笇锛?{library.name}`)
      continue
    }
    tasks.push({
      id: `loader-lib:${relative}`,
      url,
      mirrorUrl: mirrorUrlFor(base, relative),
      destRel: path.posix.join('libraries', relative.split(path.sep).join('/')),
      sha1,
      size,
      priority: 5,
      sourceHint: 'auto',
      unverified: false,
      label: 'library',
    })
  }

  return { tasks, warnings }
}

export interface InstallerProfileResult extends ProfileLibraryTaskResult {
  /** True when install_profile.json was found and parsed. */
  found: boolean
}

/**
 * Reads `install_profile.json` out of a Forge/NeoForge installer jar and turns
 * its libraries into download tasks.
 *
 * Why: the installer downloads its libraries one at a time, over the open
 * internet, including a few artifacts that no longer exist (it then retries).
 * Prefetching them with the shared parallel downloader (which knows the BMCLAPI
 * mirror) makes the installer find the files already present and skip straight
 * to unpacking.
 *
 * Two shapes exist:
 *  - modern (1.13+): top-level `libraries` array + `processors`
 *  - legacy (1.12.2): `versionInfo.libraries` (a full version JSON)
 */
export function installerProfileTasks(fs: FsPort, jarPath: string): InstallerProfileResult {
  const warnings: string[] = []
  let archive
  try {
    archive = openZipFile(fs, jarPath)
  } catch (error) {
    warnings.push(
      `鏃犳硶璇诲彇瀹夎鍣ㄥ唴瀹癸細${error instanceof Error ? error.message : String(error)}`,
    )
    return { tasks: [], warnings, found: false }
  }
  const entry = archive.entries.find(
    (candidate) => !candidate.isDirectory && candidate.name === 'install_profile.json',
  )
  if (!entry) {
    return { tasks: [], warnings, found: false }
  }
  let profile: Record<string, unknown>
  try {
    profile = JSON.parse(archive.readEntry(entry).toString('utf8')) as Record<string, unknown>
  } catch (error) {
    warnings.push(
      `install_profile.json 瑙ｆ瀽澶辫触锛?{error instanceof Error ? error.message : String(error)}`,
    )
    return { tasks: [], warnings, found: false }
  }

  const libraries = Array.isArray(profile.libraries) ? profile.libraries : []
  const primary = profileLibraryTasks({ libraries })
  const tasks = [...primary.tasks]
  const allWarnings = [...warnings, ...primary.warnings]

  // Legacy installers (e.g. Forge 1.12.2) keep the real library list in an
  // embedded `version.json` (`json: "/version.json"`) and only put one or two
  // artifacts in install_profile.json. Parse that file too, otherwise the
  // prefill would save almost nothing.
  const embeddedPath = typeof profile.json === 'string' ? profile.json.replace(/^\/+/, '') : null
  if (embeddedPath) {
    const embedded = archive.entries.find(
      (candidate) => !candidate.isDirectory && candidate.name === embeddedPath,
    )
    if (embedded) {
      try {
        const versionJson = JSON.parse(archive.readEntry(embedded).toString('utf8')) as Record<
          string,
          unknown
        >
        if (Array.isArray(versionJson.libraries)) {
          const extra = profileLibraryTasks(versionJson)
          tasks.push(...extra.tasks)
          allWarnings.push(...extra.warnings)
        }
      } catch (error) {
          allWarnings.push(
          `鍐呭祵鐗堟湰娓呭崟瑙ｆ瀽澶辫触锛?{error instanceof Error ? error.message : String(error)}`,
        )
      }
    }
  }

  // De-duplicate by destination (install_profile may repeat version.json entries).
  const seen = new Set<string>()
  const unique = tasks.filter((task) => {
    if (seen.has(task.destRel)) return false
    seen.add(task.destRel)
    return true
  })
  return { tasks: unique, warnings: allWarnings, found: true }
}
