import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Loader install contract (t17).
 *
 * Four loaders, two mechanisms:
 *  - fabric / quilt: official meta API → complete version JSON with
 *    `inheritsFrom` (no installer jar is executed);
 *  - forge / neoforge: official maven installer jar → `java -jar … --installClient`
 *    (SEC-EXE-05/-06), output parsed into progress events.
 *
 * Compliance-relevant fields are part of the contract so the UI can show the
 * confirmation required by SEC-EXE-05 before anything is executed:
 * `installer.url`, `installer.sha1`, `installer.hashSource`, `method`.
 */

export const LoaderType = z.enum(['fabric', 'quilt', 'forge', 'neoforge'])
export type LoaderType = z.infer<typeof LoaderType>

export const LoaderHashSource = z.enum(['official', 'mirror', 'list', 'none'])
export type LoaderHashSource = z.infer<typeof LoaderHashSource>

export const InstallerInfoSchema = z.object({
  /** Official maven URL (the only executed source). */
  url: z.string().min(1),
  /** BMCLAPI path-preserving mirror used for the download when available. */
  mirrorUrl: z.string().nullable(),
  fileName: z.string().min(1),
  sha1: z.string().regex(/^[a-f0-9]{40}$/i).nullable(),
  size: z.number().int().nonnegative().nullable(),
  /** Where the hash came from; `none` requires explicit user consent. */
  hashSource: LoaderHashSource,
  /** Human readable hint when `hashSource==='none'` (shown before confirming). */
  hashNote: z.string().nullable(),
})
export type InstallerInfo = z.infer<typeof InstallerInfoSchema>

export const LoaderVersionEntrySchema = z.object({
  type: LoaderType,
  mcVersion: z.string(),
  /** Loader version string (Forge: `47.2.0`; NeoForge 1.20.1 artifact: `47.1.106`). */
  version: z.string(),
  /** Raw artifact version when it differs (`1.20.1-47.1.106` for NeoForge 1.20.1). */
  rawVersion: z.string().nullable(),
  stable: z.boolean(),
  recommended: z.boolean(),
  installer: InstallerInfoSchema.nullable(),
})
export type LoaderVersionEntry = z.infer<typeof LoaderVersionEntrySchema>

export const LoaderListResultSchema = z.object({
  type: LoaderType,
  mcVersion: z.string(),
  fetchedAt: z.number().int().nonnegative(),
  source: z.enum(['mirror', 'official', 'mixed']),
  versions: z.array(LoaderVersionEntrySchema),
  warnings: z.array(z.string()),
})
export type LoaderListResult = z.infer<typeof LoaderListResultSchema>

export const LoaderPlanSchema = z.object({
  type: LoaderType,
  mcVersion: z.string(),
  loaderVersion: z.string(),
  /** Predicted version directory id (confirmed after install). */
  versionId: z.string(),
  method: z.enum(['meta-json', 'installer']),
  installer: InstallerInfoSchema.nullable(),
  requiredJavaMajor: z.number().int().nullable(),
  parentInstalled: z.boolean(),
  /** Fabric/Quilt: number of libraries in the generated profile. */
  libraries: z.number().int().nullable(),
  warnings: z.array(z.string()),
})
export type LoaderPlan = z.infer<typeof LoaderPlanSchema>

export const LoaderJobState = z.enum([
  'queued',
  'preparing',
  'downloading',
  'installing',
  'verifying',
  'done',
  'failed',
  'cancelled',
])
export type LoaderJobState = z.infer<typeof LoaderJobState>

export const LoaderStage = z.enum([
  'plan',
  'download',
  'prepare',
  'install',
  'verify',
  'rollback',
  'done',
])
export type LoaderStage = z.infer<typeof LoaderStage>

export const LoaderProgressSchema = z.object({
  jobId: z.string(),
  type: LoaderType,
  mcVersion: z.string(),
  loaderVersion: z.string(),
  state: LoaderJobState,
  stage: LoaderStage,
  /** 0–100 when the installer exposes a counter, null when indeterminate. */
  percent: z.number().min(0).max(100).nullable(),
  currentTask: z.string().nullable(),
  message: z.string().nullable(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  versionId: z.string().nullable(),
})
export type LoaderProgress = z.infer<typeof LoaderProgressSchema>

export const LoaderLogEventSchema = z.object({
  jobId: z.string(),
  stream: z.enum(['stdout', 'stderr']),
  lines: z.array(z.string()).max(200),
})
export type LoaderLogEvent = z.infer<typeof LoaderLogEventSchema>

export const LoaderErrorShapeSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const LoaderFinishedSchema = z.object({
  jobId: z.string(),
  ok: z.boolean(),
  state: LoaderJobState,
  versionId: z.string().nullable(),
  error: LoaderErrorShapeSchema.nullable(),
})
export type LoaderFinished = z.infer<typeof LoaderFinishedSchema>

export const LoaderInstallResultSchema = z.object({
  jobId: z.string(),
  type: LoaderType,
  mcVersion: z.string(),
  loaderVersion: z.string(),
  versionId: z.string(),
  plan: LoaderPlanSchema,
})
export type LoaderInstallResult = z.infer<typeof LoaderInstallResultSchema>

export const LoaderVerifyResultSchema = z.object({
  versionId: z.string(),
  chain: z.array(z.string()),
  mainClass: z.string().nullable(),
  loader: z.object({ type: z.string(), version: z.string().nullable() }),
  libraries: z.number().int(),
  classpathCount: z.number().int(),
  javaMajor: z.number().int().nullable(),
  warnings: z.array(z.string()),
})
export type LoaderVerifyResult = z.infer<typeof LoaderVerifyResultSchema>

export const LoaderDryRunResultSchema = z.object({
  versionId: z.string(),
  mainClass: z.string().nullable(),
  argv: z.array(z.string()),
  classpathCount: z.number().int(),
  /** True when a placeholder offline account was used for verification only. */
  syntheticAccount: z.boolean(),
  /** Must be false: no unresolved `${...}` may survive (01 R1.8). */
  hasPlaceholders: z.boolean(),
  warnings: z.array(z.string()),
})
export type LoaderDryRunResult = z.infer<typeof LoaderDryRunResultSchema>

export const contract = defineContract({
  id: 'loader',
  methods: {
    list: {
      input: z.object({
        type: LoaderType,
        mcVersion: z.string().min(1),
        force: z.boolean().default(false),
      }),
      output: LoaderListResultSchema,
    },
    plan: {
      input: z.object({
        type: LoaderType,
        mcVersion: z.string().min(1),
        loaderVersion: z.string().min(1).optional(),
      }),
      output: LoaderPlanSchema,
    },
    install: {
      input: z.object({
        type: LoaderType,
        mcVersion: z.string().min(1),
        loaderVersion: z.string().min(1).optional(),
        /** User-selected java.exe; auto-detected when omitted. */
        javaPath: z.string().min(1).optional(),
        /** SEC-EXE-05: echo the SHA1 shown in the confirmation dialog. */
        confirmSha1: z.string().regex(/^[a-f0-9]{40}$/i).nullable().optional(),
        /** Required when the installer has no upstream hash (hashSource=none). */
        allowUnverifiedInstaller: z.boolean().default(false),
      }),
      output: LoaderInstallResultSchema,
    },
    cancel: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ cancelled: z.boolean() }),
    },
    status: {
      input: z.object({ jobId: z.string().min(1) }),
      output: LoaderProgressSchema.nullable(),
    },
    listJobs: {
      input: z.void(),
      output: z.array(LoaderProgressSchema),
    },
    verify: {
      input: z.object({ versionId: z.string().min(1) }),
      output: LoaderVerifyResultSchema,
    },
    dryRun: {
      input: z.object({
        versionId: z.string().min(1),
        javaPath: z.string().min(1).optional(),
      }),
      output: LoaderDryRunResultSchema,
    },
  },
  events: {
    progress: { payload: LoaderProgressSchema, throttleMs: 100 },
    log: { payload: LoaderLogEventSchema, throttleMs: 0 },
    finished: { payload: LoaderFinishedSchema },
  },
})

export const loaderContract = contract

export interface LoaderServiceApi {
  list(input: { type: LoaderType; mcVersion: string; force?: boolean }): Promise<LoaderListResult>
  plan(input: {
    type: LoaderType
    mcVersion: string
    loaderVersion?: string
  }): Promise<LoaderPlan>
  install(input: {
    type: LoaderType
    mcVersion: string
    loaderVersion?: string
    javaPath?: string
    confirmSha1?: string | null
    allowUnverifiedInstaller?: boolean
  }): Promise<LoaderInstallResult>
  cancel(jobId: string): Promise<{ cancelled: boolean }>
  status(jobId: string): LoaderProgress | null
  listJobs(): LoaderProgress[]
  verify(input: { versionId: string }): Promise<LoaderVerifyResult>
  dryRun(input: { versionId: string; javaPath?: string }): Promise<LoaderDryRunResult>
}
