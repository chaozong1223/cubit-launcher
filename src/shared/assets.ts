import { z } from 'zod'
import { defineContract } from './kernel'
import { FileJobProgressSchema, JobFinishedSchema } from './job'

export const AssetArea = z.enum(['saves', 'screenshots', 'schematics', 'game-logs', 'launcher-logs'])
export type AssetArea = z.infer<typeof AssetArea>

export const LogLevel = z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
export type LogLevel = z.infer<typeof LogLevel>

export const SaveEntrySchema = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
  hasIcon: z.boolean(),
})
export type SaveEntry = z.infer<typeof SaveEntrySchema>

export const ScreenshotEntrySchema = z.object({
  name: z.string().min(1),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
  mime: z.string(),
})
export type ScreenshotEntry = z.infer<typeof ScreenshotEntrySchema>

export const LogSourceSchema = z.object({
  id: z.string(),
  area: z.enum(['launcher', 'game']),
  fileName: z.string(),
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
})
export type LogSource = z.infer<typeof LogSourceSchema>

export const LogEntrySchema = z.object({
  timestamp: z.number().int().nullable(),
  level: LogLevel.nullable(),
  source: z.string(),
  message: z.string(),
})
export type LogEntry = z.infer<typeof LogEntrySchema>

export const TrashItemSchema = z.object({
  id: z.string(),
  kind: z.enum(['save', 'screenshot', 'log', 'schematic', 'other']),
  name: z.string(),
  originalPath: z.string(),
  instanceId: z.string().nullable(),
  deletedAt: z.number().int(),
  size: z.number().int().nonnegative(),
  canRestore: z.boolean(),
})
export type TrashItem = z.infer<typeof TrashItemSchema>

export const BackupResultSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
})
export type BackupResult = z.infer<typeof BackupResultSchema>

export const BatchTrashResultSchema = z.object({
  items: z.array(TrashItemSchema),
  errors: z.array(z.object({ name: z.string(), message: z.string() })),
})
export type BatchTrashResult = z.infer<typeof BatchTrashResultSchema>

export const RestoreResultSchema = z.object({
  restored: z.array(TrashItemSchema),
  failed: z.array(z.object({ id: z.string(), message: z.string() })),
})
export type RestoreResult = z.infer<typeof RestoreResultSchema>

export const SaveConflictStrategySchema = z.enum(['overwrite', 'skip', 'rename'])
export type SaveConflictStrategy = z.infer<typeof SaveConflictStrategySchema>

/**
 * Cross-version save copy. The source stays untouched; the target instance's
 * `saves/<name>` is written after an explicit conflict decision.
 */
export const SaveCopyResultSchema = z.object({
  status: z.enum(['copied', 'skipped', 'conflict']),
  sourceInstanceId: z.string(),
  sourceName: z.string(),
  targetInstanceId: z.string(),
  /** Resolved target world folder name (null for conflict/skip). */
  targetName: z.string().nullable(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  overwritten: z.boolean(),
  renamed: z.boolean(),
  /** Source and target instances run different Minecraft/loader versions. */
  crossVersion: z.boolean(),
  warnings: z.array(z.string()),
})
export type SaveCopyResult = z.infer<typeof SaveCopyResultSchema>

export const SaveCopyStartSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conflict'), result: SaveCopyResultSchema }),
  z.object({ kind: z.literal('skipped'), result: SaveCopyResultSchema }),
  z.object({
    kind: z.literal('started'),
    jobId: z.string().min(1),
    targetInstanceId: z.string().min(1),
    targetName: z.string().min(1),
    crossVersion: z.boolean(),
  }),
])
export type SaveCopyStart = z.infer<typeof SaveCopyStartSchema>

export const SaveCopyProgressSchema = FileJobProgressSchema.extend({
  sourceInstanceId: z.string().min(1),
  targetInstanceId: z.string().min(1),
  targetName: z.string().min(1),
})
export type SaveCopyProgress = z.infer<typeof SaveCopyProgressSchema>

export const SaveCopyFinishedSchema = JobFinishedSchema.extend({
  sourceInstanceId: z.string().min(1),
  targetInstanceId: z.string().min(1),
  targetName: z.string().min(1),
  result: SaveCopyResultSchema.nullable(),
})
export type SaveCopyFinished = z.infer<typeof SaveCopyFinishedSchema>

/** Projection/schematic formats recognised by the NBT detector. */
export const SchematicFormatSchema = z.enum([
  'litematic',
  'sponge-v1',
  'sponge-v2',
  'sponge-v3',
  'mcedit',
  'structure',
  'unknown',
])
export type SchematicFormat = z.infer<typeof SchematicFormatSchema>

export const SchematicDimensionsSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
})
export type SchematicDimensions = z.infer<typeof SchematicDimensionsSchema>

export const SchematicEntrySchema = z.object({
  /** File name inside `<gameDir>/schematics`. */
  name: z.string().min(1),
  format: SchematicFormatSchema,
  size: z.number().int().nonnegative(),
  modifiedAt: z.number().int().nonnegative(),
  /** Header dimensions (EnclosingSize / Width×Height×Length / structure size). */
  dimensions: SchematicDimensionsSchema.nullable(),
  /** litematic block count (per-region sum, fallback Metadata.TotalVolume). */
  volume: z.number().int().nonnegative().nullable(),
  regionCount: z.number().int().nonnegative().nullable(),
  /** Human-readable parse error; the row is still listed so it can be deleted. */
  error: z.string().nullable(),
})
export type SchematicEntry = z.infer<typeof SchematicEntrySchema>

export const SchematicListResultSchema = z.object({
  gameDir: z.string(),
  schematics: z.array(SchematicEntrySchema),
})
export type SchematicListResult = z.infer<typeof SchematicListResultSchema>

export const SchematicImportResultSchema = z.object({
  imported: z.number().int().nonnegative(),
  fileName: z.string(),
  targetPath: z.string(),
  entry: SchematicEntrySchema,
})
export type SchematicImportResult = z.infer<typeof SchematicImportResultSchema>

export const SchematicConflictStrategySchema = z.enum(['overwrite', 'skip', 'rename'])
export type SchematicConflictStrategy = z.infer<typeof SchematicConflictStrategySchema>

export const SchematicTransferResultSchema = z.object({
  status: z.enum(['copied', 'moved', 'skipped', 'conflict']),
  sourceInstanceId: z.string(),
  sourceName: z.string(),
  targetInstanceId: z.string(),
  /** Resolved target file name (null for conflict/skip). */
  targetName: z.string().nullable(),
  size: z.number().int().nonnegative(),
  overwritten: z.boolean(),
  renamed: z.boolean(),
  warnings: z.array(z.string()),
})
export type SchematicTransferResult = z.infer<typeof SchematicTransferResultSchema>

export const contract = defineContract({
  id: 'assets',
  methods: {
    listSaves: {
      input: z.object({ instanceId: z.string().min(1) }),
      output: z.object({ gameDir: z.string(), saves: z.array(SaveEntrySchema) }),
    },
    backupSave: {
      input: z.object({
        instanceId: z.string().min(1),
        name: z.string().min(1),
        outPath: z.string().min(1).optional(),
      }),
      output: BackupResultSchema,
    },
    deleteSaves: {
      input: z.object({ instanceId: z.string().min(1), names: z.array(z.string().min(1)).min(1) }),
      output: BatchTrashResultSchema,
    },
    /** Copy `saves/<name>` into another instance (cross-version aware). */
    copySaveJob: {
      input: z.object({
        instanceId: z.string().min(1),
        name: z.string().min(1),
        targetInstanceId: z.string().min(1),
        targetName: z.string().min(1).max(128).optional(),
        conflict: SaveConflictStrategySchema.optional(),
      }),
      output: SaveCopyStartSchema,
    },
    cancelCopySave: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ cancelled: z.boolean() }),
    },
    copySaveStatus: {
      input: z.object({ jobId: z.string().min(1) }),
      output: SaveCopyProgressSchema.nullable(),
    },
    copySaveResult: {
      input: z.object({ jobId: z.string().min(1) }),
      output: SaveCopyFinishedSchema.nullable(),
    },
    listScreenshots: {
      input: z.object({ instanceId: z.string().min(1) }),
      output: z.object({ gameDir: z.string(), screenshots: z.array(ScreenshotEntrySchema) }),
    },
    /** Projections under the instance's `gameDir/schematics` directory. */
    listSchematics: {
      input: z.object({ instanceId: z.string().min(1) }),
      output: SchematicListResultSchema,
    },
    /** Import one local projection file (drag/drop); collision gets a new name. */
    importSchematic: {
      input: z.object({
        instanceId: z.string().min(1),
        filePath: z.string().min(1),
        targetName: z.string().min(1).max(255).optional(),
      }),
      output: SchematicImportResultSchema,
    },
    deleteSchematics: {
      input: z.object({ instanceId: z.string().min(1), names: z.array(z.string().min(1)).min(1) }),
      output: BatchTrashResultSchema,
    },
    /** Copy or move a projection to another instance's schematics folder. */
    copySchematic: {
      input: z.object({
        instanceId: z.string().min(1),
        name: z.string().min(1),
        targetInstanceId: z.string().min(1),
        mode: z.enum(['copy', 'move']).default('copy'),
        targetName: z.string().min(1).max(255).optional(),
        conflict: SchematicConflictStrategySchema.optional(),
      }),
      output: SchematicTransferResultSchema,
    },
    previewScreenshot: {
      input: z.object({ instanceId: z.string().min(1), name: z.string().min(1) }),
      output: z.object({ dataUrl: z.string(), mime: z.string(), size: z.number().int() }),
    },
    deleteScreenshots: {
      input: z.object({ instanceId: z.string().min(1), names: z.array(z.string().min(1)).min(1) }),
      output: BatchTrashResultSchema,
    },
    listLogs: {
      input: z.object({ instanceId: z.string().optional() }),
      output: z.object({ sources: z.array(LogSourceSchema) }),
    },
    queryLogs: {
      input: z.object({
        instanceId: z.string().optional(),
        level: LogLevel.optional(),
        minLevel: LogLevel.optional(),
        since: z.number().int().optional(),
        until: z.number().int().optional(),
        search: z.string().optional(),
        limit: z.number().int().min(1).max(5_000).optional(),
        offset: z.number().int().min(0).optional(),
      }),
      output: z.object({
        entries: z.array(LogEntrySchema),
        total: z.number().int().nonnegative(),
        sources: z.array(LogSourceSchema),
      }),
    },
    exportLogs: {
      input: z.object({
        instanceId: z.string().optional(),
        outPath: z.string().min(1).optional(),
      }),
      output: BackupResultSchema,
    },
    exportDiagnostics: {
      input: z.object({
        instanceId: z.string().optional(),
        outPath: z.string().min(1).optional(),
      }),
      output: BackupResultSchema,
    },
    openFolder: {
      input: z.object({
        instanceId: z.string().optional(),
        area: AssetArea,
      }),
      output: z.object({ path: z.string() }),
    },
    showInFolder: {
      input: z.object({
        instanceId: z.string().min(1),
        kind: z.enum(['save', 'screenshot', 'schematic']),
        name: z.string().min(1),
      }),
      output: z.object({ path: z.string() }),
    },
    openFile: {
      input: z.object({
        instanceId: z.string().min(1),
        kind: z.enum(['save', 'screenshot', 'schematic']),
        name: z.string().min(1),
      }),
      output: z.object({ ok: z.boolean() }),
    },
    listTrash: {
      input: z.void(),
      output: z.object({ items: z.array(TrashItemSchema) }),
    },
    restoreTrash: {
      input: z.object({ ids: z.array(z.string().min(1)).optional() }),
      output: RestoreResultSchema,
    },
    purgeTrash: {
      input: z.object({ ids: z.array(z.string().min(1)).optional() }),
      output: z.object({
        purged: z.array(z.string()),
        failed: z.array(z.object({ id: z.string(), message: z.string() })),
      }),
    },
  },
  events: {
    changed: { payload: z.object({ area: AssetArea }) },
    copySaveProgress: {
      payload: SaveCopyProgressSchema,
      throttleMs: 100,
    },
    copySaveFinished: {
      payload: SaveCopyFinishedSchema,
    },
  },
})

export const assetsContract = contract
export type AssetsContract = typeof contract
