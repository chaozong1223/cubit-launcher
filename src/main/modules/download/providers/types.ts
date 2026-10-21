import type { DownloadTask, ModProviderInfo, ProviderId } from '@shared/download'
import type { HttpClient, HttpLogger } from '../core/http'

/**
 * Mod content source abstraction (docs/02 API-07).
 *
 * P0 ships a Modrinth implementation only. CurseForge is deliberately a
 * *declaration*: it reports `available: false` and throws a readable error, so
 * the P1 work is an adapter behind the same interface — the download queue,
 * hashing, atomic writes and IPC never change.
 */

export interface ModSearchQuery {
  query: string
  limit?: number
  offset?: number
  loaders?: string[]
  gameVersion?: string
  categories?: string[]
}

export interface ModProject {
  source: ProviderId
  id: string
  slug: string
  title: string
  description: string
  author: string
  downloads: number
  follows: number
  iconUrl: string | null
  pageUrl: string
}

export interface ModFileHashes {
  sha1: string | null
  sha512: string | null
}

export interface ModVersionFile {
  url: string
  filename: string
  size: number
  hashes: ModFileHashes
  primary: boolean
}

export interface ModVersion {
  id: string
  projectId: string
  name: string
  versionNumber: string
  versionType: string
  gameVersions: string[]
  loaders: string[]
  files: ModVersionFile[]
}

/** Where a provider file should land, relative to `mcRoot`. */
export interface ModDestination {
  destDir: string
  /** Optional rename; defaults to the provider filename. */
  filename?: string
}

export interface ModSourceProvider {
  readonly id: ProviderId
  readonly info: ModProviderInfo
  search(query: ModSearchQuery): Promise<ModProject[]>
  listVersions(projectId: string): Promise<ModVersion[]>
  /**
   * Maps version files to download tasks. Implementations must carry upstream
   * hashes (sha512 preferred) and must never invent download URLs (API-10/21).
   */
  toDownloadTasks(version: ModVersion, destination: ModDestination): DownloadTask[]
  projectPage(project: string | ModProject): string
}

export interface ProviderDeps {
  http: HttpClient
  log?: HttpLogger
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  /** Test seam; production defaults to the public Modrinth API. */
  apiBase?: string
}

/**
 * Sliding-window request limiter. Modrinth allows 300 req/min; we self-limit to
 * 240 (20 % headroom, API-02) and never burst.
 */
export class RequestLimiter {
  private readonly stamps: number[] = []

  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private prune(now: number): void {
    while (this.stamps.length > 0 && now - this.stamps[0] >= 60_000) this.stamps.shift()
  }

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.now()
      this.prune(now)
      if (this.stamps.length < this.limitPerMinute) {
        this.stamps.push(now)
        return
      }
      const waitMs = Math.max(1, 60_000 - (now - this.stamps[0]))
      await this.sleep(waitMs)
    }
  }

  get used(): number {
    this.prune(this.now())
    return this.stamps.length
  }
}
