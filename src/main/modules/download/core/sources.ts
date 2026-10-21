import type {
  DownloadSourceId,
  DownloadSourceInfo,
  DownloadTask,
  SourcePreference,
} from '@shared/download'

/**
 * Download sources: Mojang official + BMCLAPI mirror (docs/02 SRC-01~12).
 *
 *  - The mirror URL is derived from the official URL by a documented prefix map
 *    (verified 2026-10-21: manifest, piston-meta, maven and assets paths work;
 *    `piston-data` objects do not, so the client jar gets an explicit
 *    `/version/<id>/client` mirror URL from the install plan).
 *  - Security does not depend on the mirror: the hash from the *upstream*
 *    metadata is always verified (SRC-07).
 *  - A source that fails 3 consecutive times is cooled down for 60 s
 *    (t46 per-source breaker); the other source keeps working and the cooled
 *    source becomes eligible again when the cooldown expires. The UI/log sees
 *    which source was used.
 *  - `mirrorEnabled: false` is the compliance mode required by SRC-06.
 */

export const MIRROR_BASE = 'https://bmclapi2.bangbang93.com'
export const OFFICIAL_MANIFEST_URL = 'https://launchermeta.mojang.com/mc/game/version_manifest_v2.json'
export const MIRROR_MANIFEST_URL = `${MIRROR_BASE}/mc/game/version_manifest_v2.json`
export const OFFICIAL_HOMEPAGE = 'https://www.minecraft.net/'
export const MIRROR_HOMEPAGE = 'https://bmclapi.bangbang93.com/'
export const OFFICIAL_DISPLAY_NAME = 'Mojang 官方'
export const MIRROR_DISPLAY_NAME = 'BMCLAPI（bangbang93）'

/** Official hosts that may appear as redirect targets. */
const OFFICIAL_REDIRECT_HOSTS = ['*.mojang.com', '*.minecraft.net', '*.mojang.net']
/** BMCLAPI redirects library/asset requests to its download CDN. */
const MIRROR_REDIRECT_HOSTS = ['*.bangbang93.com', '*.sakura.sld.tw']

interface MirrorHostRule {
  host: string
  prefix?: string
}

const MIRROR_HOST_RULES: MirrorHostRule[] = [
  { host: 'launchermeta.mojang.com' },
  { host: 'launcher.mojang.com' },
  { host: 'piston-meta.mojang.com' },
  { host: 'libraries.minecraft.net', prefix: '/maven' },
  { host: 'resources.download.minecraft.net', prefix: '/assets' },
]

export interface MirrorMappingOptions {
  base?: string
}

/**
 * Rewrites an official URL to the BMCLAPI mirror, or returns null when the
 * mirror has no documented mapping (piston-data objects, arbitrary mod hosts).
 */
export function mirrorUrlFor(officialUrl: string, options: MirrorMappingOptions = {}): string | null {
  let url: URL
  try {
    url = new URL(officialUrl)
  } catch {
    return null
  }
  const base = (options.base ?? MIRROR_BASE).replace(/\/+$/, '')
  const rule = MIRROR_HOST_RULES.find((entry) => entry.host === url.hostname.toLowerCase())
  if (!rule) return null
  const prefix = rule.prefix ?? ''
  return `${base}${prefix}${url.pathname}${url.search}`
}

/** `piston-data` client jar has a dedicated mirror route (verified 200). */
export function mirrorClientJarUrl(versionId: string, options: MirrorMappingOptions = {}): string {
  const base = (options.base ?? MIRROR_BASE).replace(/\/+$/, '')
  return `${base}/version/${encodeURIComponent(versionId)}/client`
}

/** `piston-data` version JSON also has `/version/<id>/json` (verified 200, 34,974 B). */
export function mirrorVersionJsonUrl(versionId: string, options: MirrorMappingOptions = {}): string {
  const base = (options.base ?? MIRROR_BASE).replace(/\/+$/, '')
  return `${base}/version/${encodeURIComponent(versionId)}/json`
}

export interface UserAgentParts {
  product?: string
  version: string
  site?: string
  contact?: string
}

/** `<product>/<version> (+<site>; <contact>)` — docs/02 API-01 format. */
export function buildUserAgent(parts: UserAgentParts): string {
  const product = parts.product ?? 'mc-launcher'
  const site = parts.site ?? 'https://github.com/mc-launcher'
  const contact = parts.contact ?? 'mc-launcher-maintainers@users.noreply.github.com'
  return `${product}/${parts.version} (+${site}; ${contact})`
}

/** Guard for API-01: a UA that only says `okhttp/...` gets rate limited. */
export function isDescriptiveUserAgent(value: string): boolean {
  return /^[\w.-]+\/[\w.+-]+ \(\+https?:\/\/[^)]+; [^)]+\)$/.test(value)
}

function hostAllowed(hostname: string, patterns: string[]): boolean {
  const host = hostname.toLowerCase()
  return patterns.some((pattern) => {
    const value = pattern.trim().toLowerCase()
    if (!value) return false
    if (value.startsWith('*.')) {
      const suffix = value.slice(1)
      return host.endsWith(suffix) || host === value.slice(2)
    }
    return host === value
  })
}

export interface SourceRegistryOptions {
  preference: SourcePreference
  mirrorEnabled: boolean
  /** Extra https hosts accepted as redirect targets (CDN changes, config). */
  extraRedirectHosts?: string[]
  /** Loopback hosts allowed over plain http; tests only (SEC-DL-13). */
  allowInsecureHosts?: string[]
  /** Mirror base used for mapping (custom for tests/self-hosted mirrors). */
  mirrorBase?: string
  /** Hosts of the actual configured endpoints, always allowed to redirect. */
  selfHosts?: string[]
  /** Consecutive failures before a source enters cooldown. Default 3. */
  failureThreshold?: number
  /** Cooldown duration before a source is eligible again. Default 60 s. */
  cooldownMs?: number
  /** Injectable clock for deterministic cooldown tests. */
  now?: () => number
}

interface SourceState {
  consecutiveFailures: number
  cooldownUntil: number
  lastError: string | null
  successes: number
}

export interface SourceAvailability {
  /** All applicable sources are cooling; this is a network outage, not config. */
  network: boolean
  cooling: DownloadSourceId[]
  retryAfterMs: number | null
  possible: DownloadSourceId[]
}

export interface RedirectPolicyOptions {
  /**
   * The caller verifies the whole body against an upstream hash. BMCLAPI
   * load-balances downloads across rotating CDN domains (observed:
   * `bmclapiN.sakura.sld.tw`, `2.749333.xyz`), so a fixed allowlist would break
   * the mirror unpredictably. With hash pinning the integrity boundary stays
   * the Mojang hash (SRC-07); the redirect still has to be https, ≤ 3 hops and
   * is logged (SEC-DL-06/-12). Without a hash the strict allowlist applies.
   */
  hashPinned?: boolean
}

export type SourcePolicy = 'metadata' | 'file'

export class SourceRegistry {
  private readonly states: Record<DownloadSourceId, SourceState> = {
    official: { consecutiveFailures: 0, cooldownUntil: 0, lastError: null, successes: 0 },
    mirror: { consecutiveFailures: 0, cooldownUntil: 0, lastError: null, successes: 0 },
  }
  private readonly now: () => number
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private lastSource: DownloadSourceId | null = null

  constructor(private readonly options: SourceRegistryOptions) {
    this.now = options.now ?? Date.now
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 3)
    this.cooldownMs = Math.max(1, options.cooldownMs ?? 60_000)
  }

  get preference(): SourcePreference {
    return this.options.preference
  }

  get mirrorEnabled(): boolean {
    return this.options.mirrorEnabled
  }

  get mirrorBase(): string {
    return this.options.mirrorBase ?? MIRROR_BASE
  }

  /**
   * Source order.
   *
   * t42 trust anchor: metadata that has no upstream content hash (version
   * manifest, version JSON) is official-first. Files (libraries/assets/client)
   * keep mirror-first. `sourcePreference=mirror` is an explicit override and
   * still permits mirror-first, but metadata from the mirror is warned about.
   */
  order(policy: SourcePolicy = 'file'): DownloadSourceId[] {
    if (policy === 'metadata') {
      if (this.options.preference === 'official') return ['official']
      if (this.options.preference === 'mirror' && this.options.mirrorEnabled) {
        return ['mirror', 'official']
      }
      return this.options.mirrorEnabled ? ['official', 'mirror'] : ['official']
    }
    if (this.options.preference === 'official') return ['official']
    if (this.options.preference === 'mirror') return this.options.mirrorEnabled ? ['mirror'] : ['official']
    return this.options.mirrorEnabled ? ['mirror', 'official'] : ['official']
  }

  isDisabled(id: DownloadSourceId): boolean {
    return this.states[id].cooldownUntil > this.now()
  }

  /** Alias with the post-t46 semantics: a source is cooling, not dead forever. */
  isCooling(id: DownloadSourceId): boolean {
    return this.isDisabled(id)
  }

  disabledSources(): DownloadSourceId[] {
    return (['mirror', 'official'] as DownloadSourceId[]).filter((id) => this.isDisabled(id))
  }

  cooldownRemainingMs(id: DownloadSourceId): number {
    return Math.max(0, this.states[id].cooldownUntil - this.now())
  }

  activeSource(): DownloadSourceId | null {
    return this.lastSource
  }

  recordSuccess(id: DownloadSourceId): void {
    const state = this.states[id]
    state.consecutiveFailures = 0
    state.cooldownUntil = 0
    state.successes += 1
    state.lastError = null
    this.lastSource = id
  }

  /**
   * Per-source breaker (t46): three consecutive failures cool this source for
   * `cooldownMs`, then it is eligible again. Other sources are never affected.
   */
  recordFailure(id: DownloadSourceId, reason: string, weight = 1): void {
    const state = this.states[id]
    state.consecutiveFailures += Math.max(1, Math.trunc(weight))
    state.lastError = reason
    if (state.consecutiveFailures >= this.failureThreshold) {
      state.cooldownUntil = this.now() + this.cooldownMs
    }
  }

  /**
   * Candidate URLs for a task, in preference order. A task's `sourceHint`
   * moves that source to the front but keeps the other one as a fallback.
   * Cooling sources are skipped until their cooldown expires.
   */
  private hintedSources(
    task: Pick<DownloadTask, 'sourceHint'>,
    policy: SourcePolicy,
  ): DownloadSourceId[] {
    const preferred = this.order(policy)
    return task.sourceHint && task.sourceHint !== 'auto'
      ? [task.sourceHint as DownloadSourceId, ...preferred.filter((id) => id !== task.sourceHint)]
      : preferred
  }

  private urlForSource(
    task: Pick<DownloadTask, 'url' | 'mirrorUrl'>,
    source: DownloadSourceId,
  ): string | null {
    if (source === 'mirror') {
      if (!this.options.mirrorEnabled) return null
      return task.mirrorUrl ?? mirrorUrlFor(task.url, { base: this.mirrorBase })
    }
    return task.url
  }

  /** Every source that could serve this task (ignoring cooldown). */
  private possibleSources(
    task: Pick<DownloadTask, 'url' | 'mirrorUrl' | 'sourceHint'>,
    policy: SourcePolicy,
  ): DownloadSourceId[] {
    const out: DownloadSourceId[] = []
    for (const source of this.hintedSources(task, policy)) {
      if (out.includes(source)) continue
      if (!this.urlForSource(task, source)) continue
      out.push(source)
    }
    return out
  }

  /**
   * Why a task has no usable source. `network` is true only when every
   * applicable source is cooling (an outage), so callers can emit a readable
   * NETWORK/UNREACHABLE error instead of blaming configuration.
   */
  availability(
    task: Pick<DownloadTask, 'url' | 'mirrorUrl' | 'sourceHint'>,
    policy: SourcePolicy = 'file',
  ): SourceAvailability {
    const possible = this.possibleSources(task, policy)
    const cooling = possible.filter((id) => this.isCooling(id))
    const retryAfterMs =
      cooling.length === 0
        ? null
        : Math.min(...cooling.map((id) => this.cooldownRemainingMs(id)))
    return {
      network: possible.length > 0 && cooling.length === possible.length,
      cooling,
      retryAfterMs,
      possible,
    }
  }

  candidates(
    task: Pick<DownloadTask, 'url' | 'mirrorUrl' | 'sourceHint'>,
    policy: SourcePolicy = 'file',
  ): Array<{
    source: DownloadSourceId
    url: string
  }> {
    const out: Array<{ source: DownloadSourceId; url: string }> = []
    for (const source of this.possibleSources(task, policy)) {
      if (this.isCooling(source)) continue
      const url = this.urlForSource(task, source)
      if (url) out.push({ source, url })
    }
    return out
  }

  isRedirectAllowed(
    source: DownloadSourceId,
    from: URL,
    to: URL,
    options: RedirectPolicyOptions = {},
  ): boolean {
    const insecure = this.options.allowInsecureHosts ?? []
    if (to.protocol !== 'https:' && !(to.protocol === 'http:' && hostAllowed(to.hostname, insecure))) {
      return false
    }

    // Official metadata (the trust anchor) is never allowed to wander off the
    // Mojang host family, and a mirror redirect without a pinned hash keeps the
    // strict list as well.
    if (source === 'mirror' && options.hashPinned) return true
    if (source === 'official' && options.hashPinned) {
      return hostAllowed(to.hostname, [...OFFICIAL_REDIRECT_HOSTS, ...(this.options.selfHosts ?? [])])
    }

    const selfHosts = this.options.selfHosts ?? []
    const officialPatterns = [...OFFICIAL_REDIRECT_HOSTS, ...selfHosts]
    const mirrorPatterns = [
      ...MIRROR_REDIRECT_HOSTS,
      ...officialPatterns,
      ...(this.options.extraRedirectHosts ?? []),
      ...selfHosts,
      ...insecure,
    ]

    // The redirect must stay inside the source's own family of hosts.
    if (source === 'official') return hostAllowed(to.hostname, officialPatterns)
    return hostAllowed(to.hostname, mirrorPatterns)
  }

  info(): DownloadSourceInfo[] {
    const order = this.order()
    const stateNote = (id: DownloadSourceId, label: string): string | null => {
      if (!this.isDisabled(id)) return null
      const remaining = Math.ceil(this.cooldownRemainingMs(id) / 1000)
      return `${label}已冷却（约 ${remaining}s 后自动恢复）${this.states[id].lastError ? `：${this.states[id].lastError}` : ''}`
    }
    const make = (
      id: DownloadSourceId,
      displayName: string,
      homepage: string,
      enabled: boolean,
      note: string | null,
    ): DownloadSourceInfo => ({
      id,
      displayName,
      homepage,
      enabled,
      order: Math.max(0, order.indexOf(id)),
      note,
    })

    const mirrorNote =
      stateNote('mirror', '镜像连续失败 3 次，') ??
      (this.options.mirrorEnabled
        ? '第三方镜像，非开源服务且无 SLA；文件权利归源站点'
        : '已在设置中关闭镜像（合规模式）')
    const officialNote = stateNote('official', '官方源连续失败 3 次，') ?? 'Mojang 官方源'

    return [
      make(
        'mirror',
        MIRROR_DISPLAY_NAME,
        MIRROR_HOMEPAGE,
        this.options.mirrorEnabled && !this.isDisabled('mirror'),
        mirrorNote,
      ),
      make(
        'official',
        OFFICIAL_DISPLAY_NAME,
        OFFICIAL_HOMEPAGE,
        !this.isDisabled('official'),
        officialNote,
      ),
    ]
  }
}

export function createSourceRegistry(options: SourceRegistryOptions): SourceRegistry {
  return new SourceRegistry(options)
}

/** All candidate URLs of all sources; used in `DOWNLOAD.NO_SOURCE` messages. */
export function describeCandidates(
  candidates: Array<{ source: DownloadSourceId; url: string }>,
): string {
  if (candidates.length === 0) return '(无可用源)'
  return candidates.map((entry) => `${entry.source}:${entry.url}`).join(', ')
}
