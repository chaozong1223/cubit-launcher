import path from 'node:path'
import type { DownloadTask } from '@shared/download'
import { libraryArtifactPath } from '../../../core/version/name'

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

function mirrorUrlFor(baseUrl: string, relative: string): string | null {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return null
  }
  if (host === 'maven.fabricmc.net' || host === 'maven.quiltmc.org') {
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
      warnings.push(`无法解析加载器库路径：${library.name}`)
      continue
    }
    const artifact = library.downloads?.artifact
    const base = typeof artifact?.url === 'string' ? artifact.url : typeof library.url === 'string' ? library.url : null
    if (!base) {
      warnings.push(`加载器库缺少下载地址：${library.name}`)
      continue
    }
    const url = artifact?.url ? base : `${base.replace(/\/+$/, '')}/${relative}`
    const sha1Raw = artifact?.sha1 ?? library.sha1
    const sha1 = typeof sha1Raw === 'string' && /^[a-f0-9]{40}$/i.test(sha1Raw) ? sha1Raw.toLowerCase() : null
    const sizeRaw = artifact?.size ?? library.size
    const size = typeof sizeRaw === 'number' && Number.isFinite(sizeRaw) ? sizeRaw : null
    if (!sha1) {
      warnings.push(`加载器库没有可信哈希：${library.name}`)
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
