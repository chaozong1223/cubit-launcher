import { z } from 'zod'
import { defineContract } from './kernel'

export const AssetArea = z.enum(['saves', 'screenshots', 'game-logs', 'launcher-logs'])
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
  kind: z.enum(['save', 'screenshot', 'log', 'other']),
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
    listScreenshots: {
      input: z.object({ instanceId: z.string().min(1) }),
      output: z.object({ gameDir: z.string(), screenshots: z.array(ScreenshotEntrySchema) }),
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
        kind: z.enum(['save', 'screenshot']),
        name: z.string().min(1),
      }),
      output: z.object({ path: z.string() }),
    },
    openFile: {
      input: z.object({
        instanceId: z.string().min(1),
        kind: z.enum(['save', 'screenshot']),
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
  },
  events: {
    changed: { payload: z.object({ area: AssetArea }) },
  },
})

export const assetsContract = contract
export type AssetsContract = typeof contract
