import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Download-domain contract (t8).
 *
 * This file is the single source of truth for the renderer bridge, the main
 * process handlers and the unit tests. Shapes follow docs/03 §12.4 and extend
 * the draft where the requirements need more (01 R1.16 wants file count, byte
 * count, current file and speed; 01 §5.2 step 3 wants named install stages).
 *
 * Compliance notes (docs/02):
 *  - SEC-DL-01: every file carries at least one upstream hash; sha512 wins over
 *    sha256 over sha1 when several are present.
 *  - SEC-DL-04: hash-less files are only accepted from the official source and
 *    are flagged `unverified`.
 *  - SRC-01: the UI must show the active source; `listSources` returns the
 *    display name + homepage so the renderer never hardcodes them.
 *  - SRC-06: all third-party mirrors can be disabled (compliance mode).
 *  - API-07: CurseForge is *not* called in P0; the provider list exposes it as
 *    unavailable so P1 only has to implement the provider, not the downloader.
 */

const HASH_SHA1 = /^[a-f0-9]{40}$/
const HASH_SHA256 = /^[a-f0-9]{64}$/
const HASH_SHA512 = /^[a-f0-9]{128}$/

export const DownloadSourceId = z.enum(['official', 'mirror'])
export type DownloadSourceId = z.infer<typeof DownloadSourceId>

export const SourcePreference = z.enum(['auto', 'official', 'mirror'])
export type SourcePreference = z.infer<typeof SourcePreference>

export const DownloadJobKind = z.enum(['install', 'batch'])
export type DownloadJobKind = z.infer<typeof DownloadJobKind>

export const DownloadJobState = z.enum([
  'queued',
  'running',
  'paused',
  'done',
  'failed',
  'cancelled',
])
export type DownloadJobState = z.infer<typeof DownloadJobState>

/** Named stages mirror 01 §5.2 step 3 (manifest → JSON → jar → libs → index → objects). */
export const DownloadStage = z.enum([
  'idle',
  'manifest',
  'version-json',
  'client',
  'libraries',
  'logging',
  'assets-index',
  'assets',
  'files',
  'done',
])
export type DownloadStage = z.infer<typeof DownloadStage>

/** A hash-bearing upstream URL. `http` is only accepted for loopback test hosts. */
export const DownloadLocation = z.object({
  source: DownloadSourceId,
  url: z.string().min(1),
})
export type DownloadLocation = z.infer<typeof DownloadLocation>

export const DownloadTaskSchema = z.object({
  /** Stable key; defaults to `destRel`. */
  id: z.string().min(1).optional(),
  /** Official (upstream) URL. https only at runtime, see SEC-DL-13. */
  url: z.string().min(1),
  /** Pre-computed mirror URL; null when the mirror cannot serve this file. */
  mirrorUrl: z.string().min(1).nullable().optional(),
  /** Path relative to `mcRoot`. Absolute paths and `..` are rejected. */
  destRel: z.string().min(1),
  sha1: z.string().regex(HASH_SHA1, 'sha1 must be 40 hex chars').nullable().optional(),
  sha256: z.string().regex(HASH_SHA256, 'sha256 must be 64 hex chars').nullable().optional(),
  sha512: z.string().regex(HASH_SHA512, 'sha512 must be 128 hex chars').nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  priority: z.number().int().min(0).max(9).default(5),
  sourceHint: z.enum(['auto', 'official', 'mirror']).default('auto'),
  /** SEC-DL-04: official source, no upstream hash. Shown as "unverified". */
  unverified: z.boolean().default(false),
  /**
   * Source policy: `metadata` (version manifest / version JSON; official-first
   * because these have no upstream content hash) or `file` (libraries/assets;
   * mirror-first). Omitted = `file` for backward compatibility.
   */
  sourcePolicy: z.enum(['metadata', 'file']).optional(),
  /** Coarse grouping for UI: version / library / asset / logging / mod. */
  label: z.string().optional(),
})
export type DownloadTask = z.infer<typeof DownloadTaskSchema>

export const DownloadProgressSchema = z.object({
  jobId: z.string().min(1),
  kind: DownloadJobKind,
  state: DownloadJobState,
  stage: DownloadStage,
  /** Files finished (downloaded + already-present), and total planned files. */
  done: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  bytesDone: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
  /** Path relative to `mcRoot`; safe to show and to log. */
  currentFile: z.string().nullable(),
  bytesPerSec: z.number().nonnegative(),
  source: DownloadSourceId.nullable(),
  versionId: z.string().nullable(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  message: z.string().nullable(),
})
export type DownloadProgress = z.infer<typeof DownloadProgressSchema>

export const DownloadFailureSchema = z.object({
  destRel: z.string(),
  code: z.string(),
  message: z.string(),
  /** User-facing explanation (e.g. network vs configuration); optional for old logs. */
  userMessage: z.string().optional(),
  retryable: z.boolean(),
  attempts: z.number().int().nonnegative(),
  urls: z.array(z.string()),
})
export type DownloadFailure = z.infer<typeof DownloadFailureSchema>

export const DownloadFinishedSchema = z.object({
  jobId: z.string(),
  ok: z.boolean(),
  state: DownloadJobState,
  downloaded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  failed: z.array(DownloadFailureSchema),
  bytes: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
})
export type DownloadFinished = z.infer<typeof DownloadFinishedSchema>

export const DownloadSourceInfoSchema = z.object({
  id: DownloadSourceId,
  displayName: z.string(),
  homepage: z.string(),
  enabled: z.boolean(),
  /** Evaluated source order for the current preference (ids). */
  order: z.number().int().nonnegative(),
  note: z.string().nullable(),
})
export type DownloadSourceInfo = z.infer<typeof DownloadSourceInfoSchema>

export const DownloadSettingsSchema = z.object({
  concurrency: z.number().int().min(1).max(16),
  perHostConcurrency: z.number().int().min(1).max(8),
  maxRetries: z.number().int().min(0).max(10),
  sourcePreference: SourcePreference,
  mirrorEnabled: z.boolean(),
  downloadEnabled: z.boolean(),
  /** Bytes per second cap per job; 0 = unlimited (SEC-DL-07). */
  speedLimitBytesPerSec: z.number().int().nonnegative(),
  /** Extra https hosts accepted as mirror redirect targets (CDN changes). */
  extraRedirectHosts: z.array(z.string()),
  userAgent: z.string().min(1),
})
export type DownloadSettings = z.infer<typeof DownloadSettingsSchema>

export const DownloadSettingsPatchSchema = DownloadSettingsSchema.partial()
export type DownloadSettingsPatch = z.infer<typeof DownloadSettingsPatchSchema>

export const DownloadSourcesResultSchema = z.object({
  preference: SourcePreference,
  mirrorEnabled: z.boolean(),
  downloadEnabled: z.boolean(),
  activeSource: DownloadSourceId.nullable(),
  sources: z.array(DownloadSourceInfoSchema),
  userAgent: z.string(),
})
export type DownloadSourcesResult = z.infer<typeof DownloadSourcesResultSchema>

export const ManifestVersionSchema = z.object({
  id: z.string(),
  type: z.string(),
  url: z.string(),
  sha1: z.string().nullable(),
  releaseTime: z.string().nullable(),
  complianceLevel: z.number().int().nullable(),
})
export type ManifestVersion = z.infer<typeof ManifestVersionSchema>

export const ManifestResultSchema = z.object({
  fetchedAt: z.number().int().nonnegative(),
  source: DownloadSourceId,
  cached: z.boolean(),
  latest: z.object({ release: z.string(), snapshot: z.string() }),
  versions: z.array(ManifestVersionSchema),
  /** Trust warnings (e.g. hash-less metadata loaded from a mirror). */
  warnings: z.array(z.string()).optional(),
})
export type ManifestResult = z.infer<typeof ManifestResultSchema>

export const InstallPlanSummarySchema = z.object({
  versionId: z.string(),
  type: z.string().nullable(),
  clientJar: z.object({ destRel: z.string(), size: z.number().int().nullable() }).nullable(),
  libraries: z.object({
    total: z.number().int(),
    allowed: z.number().int(),
    skipped: z.number().int(),
    natives: z.number().int(),
    files: z.number().int(),
    bytes: z.number().int(),
  }),
  assets: z.object({
    indexId: z.string().nullable(),
    objects: z.number().int(),
    bytes: z.number().int(),
  }),
  logging: z.number().int(),
  files: z.number().int(),
  bytes: z.number().int(),
  missingFiles: z.number().int(),
  missingBytes: z.number().int(),
  /** Metadata trust warnings carried from the manifest/version JSON fetch. */
  warnings: z.array(z.string()).optional(),
})
export type InstallPlanSummary = z.infer<typeof InstallPlanSummarySchema>

export const InstallResultSchema = z.object({
  jobId: z.string(),
  versionId: z.string(),
  plan: InstallPlanSummarySchema,
})
export type InstallResult = z.infer<typeof InstallResultSchema>

export const RepairResultSchema = z.object({
  jobId: z.string(),
  versionId: z.string(),
  missingFiles: z.number().int(),
  missingBytes: z.number().int(),
})
export type RepairResult = z.infer<typeof RepairResultSchema>

export const ProviderId = z.enum(['modrinth', 'curseforge'])
export type ProviderId = z.infer<typeof ProviderId>

export const ModProviderInfoSchema = z.object({
  id: ProviderId,
  displayName: z.string(),
  homepage: z.string(),
  /** P0: only Modrinth is live. CurseForge needs its own API key (P1, API-09). */
  available: z.boolean(),
  requiresKey: z.boolean(),
  note: z.string(),
})
export type ModProviderInfo = z.infer<typeof ModProviderInfoSchema>

export const contract = defineContract({
  id: 'download',
  methods: {
    listSources: {
      input: z.void(),
      output: DownloadSourcesResultSchema,
    },
    getSettings: {
      input: z.void(),
      output: DownloadSettingsSchema,
    },
    updateSettings: {
      input: DownloadSettingsPatchSchema,
      output: DownloadSettingsSchema,
    },
    fetchManifest: {
      input: z.object({ force: z.boolean().default(false) }).default({ force: false }),
      output: ManifestResultSchema,
    },
    plan: {
      input: z.object({ versionId: z.string().min(1), verifyExisting: z.boolean().default(false) }),
      output: InstallPlanSummarySchema,
    },
    install: {
      input: z.object({
        versionId: z.string().min(1),
        /** Hash-check files that already exist (slower, catches same-size corruption). */
        verifyExisting: z.enum(['size', 'hash']).default('size'),
      }),
      output: InstallResultSchema,
    },
    repair: {
      input: z.object({
        versionId: z.string().min(1),
        verifyExisting: z.enum(['size', 'hash']).default('size'),
      }),
      output: RepairResultSchema,
    },
    enqueue: {
      input: z.object({ tasks: z.array(DownloadTaskSchema).min(1) }),
      output: z.object({ jobId: z.string(), total: z.number().int().nonnegative() }),
    },
    cancel: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ cancelled: z.boolean() }),
    },
    pause: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ paused: z.boolean() }),
    },
    resume: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ resumed: z.boolean() }),
    },
    list: {
      input: z.void(),
      output: z.array(DownloadProgressSchema),
    },
    status: {
      input: z.object({ jobId: z.string().min(1) }),
      output: DownloadProgressSchema.nullable(),
    },
    listProviders: {
      input: z.void(),
      output: z.array(ModProviderInfoSchema),
    },
    /** P0: returns the external project page URL; the renderer opens it via shell. */
    projectPage: {
      input: z.object({ provider: ProviderId, project: z.string().min(1) }),
      output: z.object({ url: z.string() }),
    },
  },
  events: {
    /** 100 ms throttle is required by docs/03 §6.3 and §12.4. */
    progress: { payload: DownloadProgressSchema, throttleMs: 100 },
    finished: { payload: DownloadFinishedSchema },
  },
})

export const downloadContract = contract

export interface DownloadService {
  listSources(): Promise<DownloadSourcesResult>
  getSettings(): DownloadSettings
  updateSettings(patch: DownloadSettingsPatch): DownloadSettings
  fetchManifest(input: { force?: boolean }): Promise<ManifestResult>
  plan(input: { versionId: string; verifyExisting?: boolean }): Promise<InstallPlanSummary>
  install(input: {
    versionId: string
    verifyExisting?: 'size' | 'hash'
  }): Promise<InstallResult>
  repair(input: {
    versionId: string
    verifyExisting?: 'size' | 'hash'
  }): Promise<RepairResult>
  enqueue(tasks: DownloadTask[]): Promise<{ jobId: string; total: number }>
  cancel(jobId: string): Promise<{ cancelled: boolean }>
  pause(jobId: string): Promise<{ paused: boolean }>
  resume(jobId: string): Promise<{ resumed: boolean }>
  list(): DownloadProgress[]
  status(jobId: string): DownloadProgress | null
  listProviders(): ModProviderInfo[]
  projectPage(input: { provider: ProviderId; project: string }): Promise<{ url: string }>
}

/** IPC channel helpers (`mc:download:<method>` / `mc:download:evt:<event>`). */
export const DOWNLOAD_CHANNELS = {
  listSources: 'mc:download:listSources',
  getSettings: 'mc:download:getSettings',
  updateSettings: 'mc:download:updateSettings',
  fetchManifest: 'mc:download:fetchManifest',
  plan: 'mc:download:plan',
  install: 'mc:download:install',
  repair: 'mc:download:repair',
  enqueue: 'mc:download:enqueue',
  cancel: 'mc:download:cancel',
  pause: 'mc:download:pause',
  resume: 'mc:download:resume',
  list: 'mc:download:list',
  status: 'mc:download:status',
  listProviders: 'mc:download:listProviders',
  projectPage: 'mc:download:projectPage',
} as const

export const DOWNLOAD_EVENTS = {
  progress: 'mc:download:evt:progress',
  finished: 'mc:download:evt:finished',
} as const
