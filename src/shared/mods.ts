import { z } from 'zod'
import { defineContract } from './kernel'
import { LoaderSchema } from './instance'
import { JobFinishedSchema, JobProgressSchema } from './job'

/** Resource directories managed by the mods module. */
export const ModKind = z.enum(['mods', 'resourcepacks', 'shaderpacks', 'datapacks'])
export type ModKind = z.infer<typeof ModKind>

export const ModDependencySchema = z.object({
  /** Namespaced id, e.g. `fabric-api`, `minecraft`, `forge`. */
  id: z.string().min(1).max(128),
  /** Declared version range; null/empty means any version. */
  versionRange: z.string().max(256).nullable(),
  mandatory: z.boolean(),
  source: z.enum(['fabric', 'forge', 'neoforge']),
})
export type ModDependency = z.infer<typeof ModDependencySchema>

export const ModMetadataSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(256).nullable(),
  version: z.string().max(128).nullable(),
  loader: z.enum(['fabric', 'forge', 'neoforge', 'quilt', 'unknown']),
  dependencies: z.array(ModDependencySchema),
})
export type ModMetadata = z.infer<typeof ModMetadataSchema>

export const ModFileSchema = z.object({
  /** User-facing name without the `.disabled` suffix. */
  name: z.string().min(1),
  /** Actual file name on disk, including `.disabled` when disabled. */
  fileName: z.string().min(1),
  kind: ModKind,
  enabled: z.boolean(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
  metadata: ModMetadataSchema.nullable(),
  metadataError: z.string().nullable(),
})
export type ModFile = z.infer<typeof ModFileSchema>

export const DependencyIssueSchema = z.object({
  kind: z.enum(['missing', 'version-mismatch', 'mc-mismatch', 'loader-mismatch']),
  /** Installed mod that declared the dependency (display name). */
  mod: z.string(),
  modId: z.string(),
  dependency: z.string(),
  requiredRange: z.string().nullable(),
  installedVersion: z.string().nullable(),
  message: z.string(),
})
export type DependencyIssue = z.infer<typeof DependencyIssueSchema>

export const KindFilesSchema = z.object({
  enabled: z.array(ModFileSchema),
  disabled: z.array(ModFileSchema),
})
export type KindFiles = z.infer<typeof KindFilesSchema>

export const ModScanResultSchema = z.object({
  instanceId: z.string(),
  gameDir: z.string(),
  files: z.object({
    mods: KindFilesSchema,
    resourcepacks: KindFilesSchema,
    shaderpacks: KindFilesSchema,
    datapacks: KindFilesSchema,
  }),
  totals: z.object({
    enabled: z.number().int().nonnegative(),
    disabled: z.number().int().nonnegative(),
  }),
  issues: z.array(DependencyIssueSchema),
})
export type ModScanResult = z.infer<typeof ModScanResultSchema>

export const BatchOperationResultSchema = z.object({
  changed: z.array(z.string()),
  skipped: z.array(z.string()),
  errors: z.array(z.object({ name: z.string(), message: z.string() })),
})
export type BatchOperationResult = z.infer<typeof BatchOperationResultSchema>

export const InstallLocalFileResultSchema = z.object({
  kind: ModKind,
  targetPath: z.string(),
  file: ModFileSchema,
})
export type InstallLocalFileResult = z.infer<typeof InstallLocalFileResultSchema>

export const ModpackFormat = z.enum(['modrinth', 'curseforge'])
export type ModpackFormat = z.infer<typeof ModpackFormat>

export const ModpackImportResultSchema = z.object({
  instanceId: z.string(),
  dirName: z.string(),
  name: z.string(),
  format: ModpackFormat,
  mcVersion: z.string().nullable(),
  loader: z.object({
    type: z.enum(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'unknown']),
    version: z.string().nullable(),
  }),
  downloaded: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  overrides: z.number().int().nonnegative(),
  needsBaseInstall: z.boolean(),
  warnings: z.array(z.string()),
})
export type ModpackImportResult = z.infer<typeof ModpackImportResultSchema>

/**
 * `importModpack` is a background job: the RPC returns as soon as the pack has
 * been validated and the target directory name is reserved. Progress and the
 * final result are delivered as `importProgress` / `importFinished` events.
 */
export const ModpackImportStartSchema = z.object({
  jobId: z.string().min(1),
  /** Planned instance id (= target directory name). */
  instanceId: z.string().min(1),
  dirName: z.string().min(1),
  name: z.string().min(1),
  format: ModpackFormat,
  mcVersion: z.string().nullable(),
  loader: LoaderSchema,
  /** Downloadable files + override entries that will be processed. */
  totalFiles: z.number().int().nonnegative(),
  needsBaseInstall: z.boolean(),
})
export type ModpackImportStart = z.infer<typeof ModpackImportStartSchema>

export const ModpackImportProgressSchema = JobProgressSchema.extend({
  instanceId: z.string().min(1),
  format: ModpackFormat,
})
export type ModpackImportProgress = z.infer<typeof ModpackImportProgressSchema>

export const ModpackImportFinishedSchema = JobFinishedSchema.extend({
  instanceId: z.string().min(1),
  result: ModpackImportResultSchema.nullable(),
})
export type ModpackImportFinished = z.infer<typeof ModpackImportFinishedSchema>

export const ModpackExportResultSchema = z.object({
  path: z.string(),
  format: z.literal('mrpack'),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
})
export type ModpackExportResult = z.infer<typeof ModpackExportResultSchema>

export const contract = defineContract({
  id: 'mods',
  methods: {
    scan: {
      input: z.object({
        instanceId: z.string().min(1),
        kind: ModKind.optional(),
      }),
      output: ModScanResultSchema,
    },
    setEnabled: {
      input: z.object({
        instanceId: z.string().min(1),
        kind: ModKind,
        names: z.array(z.string().min(1)).min(1),
        enabled: z.boolean(),
      }),
      output: BatchOperationResultSchema,
    },
    remove: {
      input: z.object({
        instanceId: z.string().min(1),
        kind: ModKind,
        names: z.array(z.string().min(1)).min(1),
      }),
      output: BatchOperationResultSchema,
    },
    installLocalFile: {
      input: z.object({
        instanceId: z.string().min(1),
        path: z.string().min(1),
        kind: ModKind.optional(),
      }),
      output: InstallLocalFileResultSchema,
    },
    analyzeDependencies: {
      input: z.object({ instanceId: z.string().min(1) }),
      output: z.object({ issues: z.array(DependencyIssueSchema) }),
    },
    importModpack: {
      input: z.object({
        filePath: z.string().min(1),
        name: z.string().min(1).max(64).optional(),
      }),
      output: ModpackImportStartSchema,
    },
    cancelImport: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ cancelled: z.boolean() }),
    },
    pauseImport: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ paused: z.boolean() }),
    },
    resumeImport: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ resumed: z.boolean() }),
    },
    importStatus: {
      input: z.object({ jobId: z.string().min(1) }),
      output: ModpackImportProgressSchema.nullable(),
    },
    importResult: {
      input: z.object({ jobId: z.string().min(1) }),
      output: ModpackImportFinishedSchema.nullable(),
    },
    exportModpack: {
      input: z.object({
        instanceId: z.string().min(1),
        outPath: z.string().min(1).optional(),
      }),
      output: ModpackExportResultSchema,
    },
    openFolder: {
      input: z.object({
        instanceId: z.string().min(1),
        kind: ModKind,
      }),
      output: z.object({ path: z.string() }),
    },
  },
  events: {
    changed: { payload: z.object({ instanceId: z.string() }) },
    importProgress: {
      payload: ModpackImportProgressSchema,
      throttleMs: 100,
    },
    importFinished: {
      payload: ModpackImportFinishedSchema,
    },
  },
})

export const modsContract = contract
export type ModsContract = typeof contract

export interface ModsService {
  scan(input: { instanceId: string; kind?: ModKind }): Promise<ModScanResult>
  setEnabled(input: {
    instanceId: string
    kind: ModKind
    names: string[]
    enabled: boolean
  }): Promise<BatchOperationResult>
  remove(input: { instanceId: string; kind: ModKind; names: string[] }): Promise<BatchOperationResult>
  installLocalFile(input: {
    instanceId: string
    path: string
    kind?: ModKind
  }): Promise<InstallLocalFileResult>
  analyzeDependencies(input: { instanceId: string }): Promise<{ issues: DependencyIssue[] }>
  importModpack(input: { filePath: string; name?: string }): Promise<ModpackImportStart>
  cancelImport(jobId: string): Promise<{ cancelled: boolean }>
  pauseImport(jobId: string): Promise<{ paused: boolean }>
  resumeImport(jobId: string): Promise<{ resumed: boolean }>
  importStatus(jobId: string): Promise<ModpackImportProgress | null>
  importResult(jobId: string): Promise<ModpackImportFinished | null>
  exportModpack(input: { instanceId: string; outPath?: string }): Promise<ModpackExportResult>
  openFolder(input: { instanceId: string; kind: ModKind }): Promise<{ path: string }>
}
