import type { CatalogProjectType, CatalogSearchHit, CatalogVersion } from '@shared/catalog'
import type { InstanceSummary } from '@shared/instance'

export const PROJECT_TYPE_OPTIONS: ReadonlyArray<{ value: CatalogProjectType; label: string }> = [
  { value: 'mod', label: '模组' },
  { value: 'resourcepack', label: '资源包' },
  { value: 'shader', label: '光影' },
  { value: 'modpack', label: '整合包' },
]

export const LOADER_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'fabric', label: 'Fabric' },
  { value: 'forge', label: 'Forge' },
  { value: 'neoforge', label: 'NeoForge' },
  { value: 'quilt', label: 'Quilt' },
]

export function projectTypeLabel(type: CatalogProjectType): string {
  return PROJECT_TYPE_OPTIONS.find((entry) => entry.value === type)?.label ?? type
}

export function loaderLabel(loader: string): string {
  return LOADER_OPTIONS.find((entry) => entry.value === loader)?.label ?? loader
}

export function versionTypeLabel(type: 'release' | 'beta' | 'alpha'): string {
  if (type === 'release') return '正式版'
  if (type === 'beta') return '测试版 beta'
  return '内测版 alpha'
}

export function formatDownloads(n: number): string {
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(1)} 亿`
  if (n >= 10_000) return `${(n / 10_000).toFixed(1)} 万`
  return n.toLocaleString('zh-CN')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export function formatDate(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('zh-CN')
}

export interface Compatibility {
  ok: boolean
  reason: string | null
}

function loaderReason(instance: InstanceSummary): string | null {
  if (instance.state !== 'ready') return `实例当前状态为 ${instance.state}，不能写入模组`
  if (!instance.mcVersion) return '实例缺少 Minecraft 版本，无法判断兼容性'
  const loader = instance.loader.type
  if (loader === 'vanilla' || loader === 'unknown') {
    return '当前实例是原版（没有 Fabric/Forge 等加载器），不能安装模组'
  }
  return null
}

function matchLoader(loaders: string[], instance: InstanceSummary): string | null {
  const loader = instance.loader.type
  if (loader === 'vanilla' || loader === 'unknown') return loaderReason(instance)
  if (!loaders.includes(loader)) return `项目不支持 ${loaderLabel(loader)} 加载器`
  return null
}

/**
 * Project-level compatibility used before the card's one-click install.
 * The backend repeats the exact version check; this is only a truthful
 * pre-check so the button can be disabled with a reason.
 */
export function projectCompatibility(hit: CatalogSearchHit, instance: InstanceSummary | null): Compatibility {
  if (!instance) return { ok: false, reason: '请先在顶部选择目标实例' }
  if (hit.projectType !== 'mod') {
    return { ok: false, reason: `一键安装目前只支持模组；${projectTypeLabel(hit.projectType)}请打开项目页下载` }
  }
  const instanceIssue = loaderReason(instance)
  if (instanceIssue) return { ok: false, reason: instanceIssue }
  if (!instance.mcVersion || !hit.gameVersions.includes(instance.mcVersion)) {
    return { ok: false, reason: `项目不支持 MC ${instance.mcVersion ?? '未知版本'}` }
  }
  const loaderIssue = matchLoader(hit.loaders, instance)
  if (loaderIssue) return { ok: false, reason: loaderIssue }
  return { ok: true, reason: null }
}

/** Exact version compatibility; the backend enforces the same rule again. */
export function versionCompatibility(
  version: CatalogVersion,
  instance: InstanceSummary | null,
  projectType: CatalogProjectType,
): Compatibility {
  if (!instance) return { ok: false, reason: '请先在顶部选择目标实例' }
  if (projectType !== 'mod') {
    return { ok: false, reason: `catalog.install 当前只把文件落到 mods；${projectTypeLabel(projectType)}请打开项目页下载` }
  }
  const instanceIssue = loaderReason(instance)
  if (instanceIssue) return { ok: false, reason: instanceIssue }
  if (!instance.mcVersion || !version.gameVersions.includes(instance.mcVersion)) {
    return { ok: false, reason: `该版本不支持 MC ${instance.mcVersion ?? '未知版本'}` }
  }
  const loaderIssue = matchLoader(version.loaders, instance)
  if (loaderIssue) return { ok: false, reason: loaderIssue }
  return { ok: true, reason: null }
}

export function shortText(value: string | null, max = 180): string {
  if (!value) return ''
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}
