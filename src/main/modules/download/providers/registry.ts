import type { ModProviderInfo, ProviderId } from '@shared/download'
import { DownloadError } from '../core/errors'
import type { HttpClient, HttpLogger } from '../core/http'
import { CurseForgeProvider } from './curseforge'
import { ModrinthProvider } from './modrinth'
import type { ModSourceProvider, ProviderDeps } from './types'

/**
 * Provider registry. P0 has exactly one live provider; the CurseForge entry is
 * visible to the UI (so "打开项目页" works) but reports `available: false`.
 */
export class ModProviderRegistry {
  readonly modrinth: ModrinthProvider
  readonly curseforge: CurseForgeProvider

  constructor(deps: ProviderDeps) {
    this.modrinth = new ModrinthProvider(deps)
    this.curseforge = new CurseForgeProvider()
  }

  list(): ModProviderInfo[] {
    return [this.modrinth.info, this.curseforge.info]
  }

  get(id: ProviderId): ModSourceProvider {
    if (id === 'modrinth') return this.modrinth
    if (id === 'curseforge') return this.curseforge
    throw new DownloadError('SOURCE.PROVIDER_UNAVAILABLE', {
      message: `unknown provider: ${String(id)}`,
      details: { provider: String(id) },
    })
  }
}

export function createModProviderRegistry(options: {
  http: HttpClient
  log?: HttpLogger
}): ModProviderRegistry {
  return new ModProviderRegistry({ http: options.http, log: options.log })
}
