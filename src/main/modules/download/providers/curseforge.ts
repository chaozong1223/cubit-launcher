import type { DownloadTask, ModProviderInfo } from '@shared/download'
import { DownloadError } from '../core/errors'
import type {
  ModDestination,
  ModProject,
  ModSearchQuery,
  ModSourceProvider,
  ModVersion,
} from './types'

/**
 * CurseForge provider placeholder (docs/02 API-07).
 *
 * P0 must not call `api.curseforge.com` at all: the key cannot be shipped to a
 * client (API-08), responses may not be cached (API-12) and the terms carry
 * competitor and distribution-toggle clauses that require legal sign-off
 * (API-16~22). This class therefore exposes only the project page and fails
 * loudly for everything that would need the API. P1 replaces the bodies; the
 * download queue never changes.
 */
export class CurseForgeProvider implements ModSourceProvider {
  readonly id = 'curseforge' as const
  readonly info: ModProviderInfo = {
    id: 'curseforge',
    displayName: 'CurseForge',
    homepage: 'https://www.curseforge.com/minecraft',
    available: false,
    requiresKey: true,
    note: 'P0 不接入 API（key 不可随客户端分发）；本轮只支持打开项目页与本地 zip 导入，P1 自备官方 key 后启用',
  }

  private unavailable(action: string): never {
    throw new DownloadError('SOURCE.PROVIDER_UNAVAILABLE', {
      message: `CurseForge ${action} needs the P1 API integration (docs/02 API-16~22)`,
      details: { provider: 'curseforge', action },
    })
  }

  async search(_query: ModSearchQuery): Promise<ModProject[]> {
    this.unavailable('search')
  }

  async listVersions(_projectId: string): Promise<ModVersion[]> {
    this.unavailable('listVersions')
  }

  toDownloadTasks(_version: ModVersion, _destination: ModDestination): DownloadTask[] {
    this.unavailable('toDownloadTasks')
  }

  projectPage(project: string | ModProject): string {
    const slug = typeof project === 'string' ? project : project.slug
    return `https://www.curseforge.com/minecraft/mc-mods/${encodeURIComponent(slug)}`
  }
}
