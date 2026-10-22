import { z } from 'zod'
import { defineContract } from './kernel'
import { TrashItemSchema, type TrashItem } from './assets'
import { JobFinishedSchema, JobProgressSchema } from './job'

/** Four-state instance recognition from docs/01 §5.1 / docs/03 §6.1. */
export const InstanceState = z.enum([
  'ready',
  'missing-json',
  'corrupt-json',
  'missing-jar',
  'unsupported',
])
export type InstanceState = z.infer<typeof InstanceState>

export const LoaderSchema = z.object({
  type: z.enum(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'unknown']),
  version: z.string().nullable(),
})
export type Loader = z.infer<typeof LoaderSchema>

export const InstanceSummarySchema = z.object({
  id: z.string(),
  dirName: z.string(),
  name: z.string(),
  mcVersion: z.string().nullable(),
  loader: LoaderSchema,
  state: InstanceState,
  reason: z.string().nullable(),
  isolation: z.enum(['shared', 'isolated']),
  lastPlayedAt: z.number().int().nullable(),
  icon: z.string().nullable(),
  javaMajor: z.number().int().nullable(),
})
export type InstanceSummary = z.infer<typeof InstanceSummarySchema>

export const InstanceJavaSchema = z.object({
  mode: z.enum(['auto', 'major', 'path']),
  value: z.union([z.number().int(), z.string()]).nullable(),
})

export const InstanceMemorySchema = z.object({
  minMb: z.number().int().min(512),
  maxMb: z.number().int().min(512).max(65536),
})

/** Window settings are per instance (P0-4 R4.6). */
export const InstanceWindowSchema = z.object({
  width: z.number().int().min(320).max(7680),
  height: z.number().int().min(240).max(4320),
  fullscreen: z.boolean(),
})

/** `instance.json` (docs/03 §8.3). One writer: the instance module. */
export const InstanceSettingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().min(1),
  dirName: z.string().min(1),
  name: z.string().min(1).max(64),
  mcVersion: z.string().nullable(),
  loader: LoaderSchema,
  java: InstanceJavaSchema.default({ mode: 'auto', value: null }),
  memory: InstanceMemorySchema.default({ minMb: 1024, maxMb: 4096 }),
  /** auto = clamp(25% RAM, 2048, 8192); custom = honour `memory`. */
  memoryMode: z.enum(['auto', 'custom']).default('auto'),
  window: InstanceWindowSchema.default({ width: 1280, height: 720, fullscreen: false }),
  isolation: z.enum(['shared', 'isolated']).default('isolated'),
  serverAuth: z
    .object({ type: z.enum(['none', 'authlib']) })
    .default({ type: 'none' }),
  autoJoin: z
    .object({ host: z.string(), port: z.number().int().min(1).max(65535) })
    .nullable()
    .default(null),
  jvmArgs: z.array(z.string()).default([]),
  source: z.enum(['ours', 'pcl', 'pack', 'manual']).default('ours'),
  createdAt: z.number().int(),
  lastPlayedAt: z.number().int().nullable().default(null),
  playTimeSec: z.number().int().nonnegative().default(0),
  icon: z.string().nullable().default(null),
})
export type InstanceSettings = z.infer<typeof InstanceSettingsSchema>

export const InstancePatchSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  java: InstanceJavaSchema.optional(),
  memory: InstanceMemorySchema.optional(),
  window: InstanceWindowSchema.optional(),
  isolation: z.enum(['shared', 'isolated']).optional(),
  jvmArgs: z.array(z.string()).optional(),
  autoJoin: z
    .object({ host: z.string(), port: z.number().int().min(1).max(65535) })
    .nullable()
    .optional(),
  icon: z.string().nullable().optional(),
})
export type InstancePatch = z.infer<typeof InstancePatchSchema>

export const InstanceCandidateSource = z.enum([
  'appdata',
  'userprofile',
  'install',
  'drive',
  'configured',
  'manual',
])
export type InstanceCandidateSource = z.infer<typeof InstanceCandidateSource>

export const MinecraftCandidateSchema = z.object({
  path: z.string(),
  source: InstanceCandidateSource,
  hasVersions: z.boolean(),
  versionCount: z.number().int().nonnegative(),
  hasMods: z.boolean(),
  hasSaves: z.boolean(),
  lastModified: z.number().int().nullable(),
  recommended: z.boolean(),
  warning: z.string().nullable(),
})
export type MinecraftCandidate = z.infer<typeof MinecraftCandidateSchema>

export const DiscoverResultSchema = z.object({
  configured: z.boolean(),
  firstRun: z.boolean(),
  currentRoot: z.string().nullable(),
  candidates: z.array(MinecraftCandidateSchema),
  guidance: z.array(z.string()),
  /** Non-fatal directory/access errors encountered while scanning. */
  errors: z.array(z.string()),
  scannedAt: z.number().int(),
})
export type DiscoverResult = z.infer<typeof DiscoverResultSchema>

export const SetGameDirResultSchema = z.object({
  mcRoot: z.string(),
  instanceCount: z.number().int().nonnegative(),
  hasVersions: z.boolean(),
  restartRequired: z.boolean(),
  guidance: z.array(z.string()),
})
export type SetGameDirResult = z.infer<typeof SetGameDirResultSchema>

/** Immediate acknowledgement of an asynchronous instance copy (jobId + target). */
export const InstanceCopyStartSchema = z.object({
  jobId: z.string().min(1),
  /** Planned directory name / instance id of the new copy. */
  instanceId: z.string().min(1),
  dirName: z.string().min(1),
  name: z.string().min(1),
})
export type InstanceCopyStart = z.infer<typeof InstanceCopyStartSchema>

export const InstanceCopyProgressSchema = JobProgressSchema.extend({
  instanceId: z.string().min(1),
  name: z.string().min(1),
})
export type InstanceCopyProgress = z.infer<typeof InstanceCopyProgressSchema>

export const InstanceCopyFinishedSchema = JobFinishedSchema.extend({
  instanceId: z.string().min(1),
  result: InstanceSummarySchema.nullable(),
})
export type InstanceCopyFinished = z.infer<typeof InstanceCopyFinishedSchema>

/** Removing an instance only moves versions/<dir> into dataRoot/trash. */
export const RemoveInstanceResultSchema = z.object({
  trashId: z.string(),
  originalPath: z.string(),
  size: z.number().int().nonnegative(),
  deletedAt: z.number().int(),
})
export type RemoveInstanceResult = z.infer<typeof RemoveInstanceResultSchema>

export const contract = defineContract({
  id: 'instance',
  methods: {
    list: { input: z.void(), output: z.array(InstanceSummarySchema) },
    get: { input: z.object({ id: z.string() }), output: InstanceSummarySchema },
    remove: {
      input: z.object({ id: z.string().min(1) }),
      output: RemoveInstanceResultSchema,
    },
    /** Explicit alias matching the service method name. */
    removeInstance: {
      input: z.object({ instanceId: z.string().min(1) }),
      output: RemoveInstanceResultSchema,
    },
    restore: {
      input: z.object({ trashId: z.string().min(1) }),
      output: TrashItemSchema,
    },
    update: {
      input: z.object({ id: z.string(), patch: InstancePatchSchema }),
      output: InstanceSummarySchema,
    },
    /** Duplicates an isolated instance (version files, mods, configs, optionally saves). */
    copyInstance: {
      input: z.object({
        id: z.string().min(1),
        newName: z.string().min(1).max(64).optional(),
        includeWorlds: z.boolean().optional(),
      }),
      output: InstanceCopyStartSchema,
    },
    /** Cancel a running copy job; partial target directories are rolled back. */
    cancelCopy: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ cancelled: z.boolean() }),
    },
    pauseCopy: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ paused: z.boolean() }),
    },
    resumeCopy: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ resumed: z.boolean() }),
    },
    copyStatus: {
      input: z.object({ jobId: z.string().min(1) }),
      output: InstanceCopyProgressSchema.nullable(),
    },
    copyResult: {
      input: z.object({ jobId: z.string().min(1) }),
      output: InstanceCopyFinishedSchema.nullable(),
    },
    scan: {
      input: z.object({ mcRoot: z.string().optional() }),
      output: z.object({ count: z.number().int() }),
    },
    create: {
      input: z.object({
        dirName: z.string().min(1).max(64),
        name: z.string().min(1).max(64).optional(),
        mcVersion: z.string().min(1),
        loader: LoaderSchema,
        isolation: z.enum(['shared', 'isolated']),
      }),
      output: InstanceSummarySchema,
    },
    discover: {
      input: z.void(),
      output: DiscoverResultSchema,
    },
    setGameDir: {
      input: z.object({ path: z.string().min(1) }),
      output: SetGameDirResultSchema,
    },
    /** Explicit import alias for the first-run flow. */
    import: {
      input: z.object({ path: z.string().min(1) }),
      output: SetGameDirResultSchema,
    },
  },
  events: {
    changed: { payload: z.object({ instanceId: z.string().nullable() }) },
    copyProgress: {
      payload: InstanceCopyProgressSchema,
      throttleMs: 100,
    },
    copyFinished: {
      payload: InstanceCopyFinishedSchema,
    },
  },
})

/** Alias so consumers can write `instanceContract` unambiguously. */
export const instanceContract = contract

export interface InstanceService {
  list(): Promise<InstanceSummary[]>
  get(id: string): InstanceSummary
  removeInstance(id: string): RemoveInstanceResult
  restoreInstance(trashId: string): TrashItem
  create(input: {
    dirName: string
    name?: string
    mcVersion: string
    loader: Loader
    isolation: 'shared' | 'isolated'
  }): Promise<InstanceSummary>
  discover(): Promise<DiscoverResult>
  setGameDir(input: { path: string }): Promise<SetGameDirResult>
  importRoot(input: { path: string }): Promise<SetGameDirResult>
  update(id: string, patch: InstancePatch): Promise<InstanceSummary>
  markPlayed(id: string, playTimeSec: number): Promise<void>
  gameDir(id: string): string
}
