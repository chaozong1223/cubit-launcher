import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Memory/performance panel contract.
 *
 * Hardware values are nullable: when a probe fails the API returns `null` and a
 * warning instead of inventing a number ("拿不到就未知").
 */
export const PerfHardwareSchema = z.object({
  platform: z.string().nullable(),
  arch: z.string().nullable(),
  cpuModel: z.string().nullable(),
  cpuCores: z.number().int().positive().nullable(),
  totalMemBytes: z.number().int().nonnegative().nullable(),
  freeMemBytes: z.number().int().nonnegative().nullable(),
  warnings: z.array(z.string()),
  detectedAt: z.number().int().nonnegative(),
})
export type PerfHardware = z.infer<typeof PerfHardwareSchema>

export const MemoryRecommendationSchema = z.object({
  instanceId: z.string().nullable(),
  modCount: z.number().int().nonnegative(),
  totalMemBytes: z.number().int().nonnegative(),
  /** clamp(25% of RAM, 2048, 8192). */
  baseMb: z.number().int().positive(),
  /** +512 MB per started 50 mods. */
  bonusMb: z.number().int().nonnegative(),
  /** 75% of RAM; the recommendation never exceeds it. */
  capMb: z.number().int().nonnegative(),
  recommendedMb: z.number().int().positive(),
  /** True when the plan/instance count pushed the value down to the cap. */
  clamped: z.boolean(),
  running: z.boolean(),
  warnings: z.array(z.string()),
})
export type MemoryRecommendation = z.infer<typeof MemoryRecommendationSchema>

export const PerfRecommendInputSchema = z.object({
  instanceId: z.string().min(1).optional(),
  /** Explicit mod count (otherwise counted from the instance's mods folder). */
  modCount: z.number().int().nonnegative().max(100_000).optional(),
})
export type PerfRecommendInput = z.infer<typeof PerfRecommendInputSchema>

export const PerfApplyInputSchema = z.object({
  instanceId: z.string().min(1),
  /** Defaults to the recommendation for this instance. */
  mb: z.number().int().min(512).max(65_536).optional(),
})
export type PerfApplyInput = z.infer<typeof PerfApplyInputSchema>

export const PerfApplyResultSchema = z.object({
  instanceId: z.string(),
  dirName: z.string(),
  previousMb: z.number().int().positive().nullable(),
  mb: z.number().int().positive(),
  mode: z.literal('custom'),
  /** The running process keeps its old heap; the value applies next launch. */
  appliesNextLaunch: z.boolean(),
})
export type PerfApplyResult = z.infer<typeof PerfApplyResultSchema>

export const PerfProcessSchema = z.object({
  pid: z.number().int().positive(),
  name: z.string(),
  memBytes: z.number().int().nonnegative(),
})
export type PerfProcess = z.infer<typeof PerfProcessSchema>

export const PerfProcessResultSchema = z.object({
  supported: z.boolean(),
  source: z.enum(['tasklist', 'unavailable']),
  processes: z.array(PerfProcessSchema),
  totalBytes: z.number().int().nonnegative(),
  /** Stable reason when tasklist is unavailable/failed; never a stack trace. */
  error: z.string().nullable(),
})
export type PerfProcessResult = z.infer<typeof PerfProcessResultSchema>

export const PerfCacheCategorySchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1),
  path: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  /** Present when the category exists but is empty/missing. */
  present: z.boolean(),
})
export type PerfCacheCategory = z.infer<typeof PerfCacheCategorySchema>

export const PerfCacheScanSchema = z.object({
  categories: z.array(PerfCacheCategorySchema),
  totalFiles: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  generatedAt: z.number().int().nonnegative(),
})
export type PerfCacheScan = z.infer<typeof PerfCacheScanSchema>

export const PerfCacheCleanInputSchema = z.object({
  /** Omit to clean every whitelisted category. */
  categories: z.array(z.string().min(1).max(64)).max(32).optional(),
})
export type PerfCacheCleanInput = z.infer<typeof PerfCacheCleanInputSchema>

export const PerfCacheCleanResultSchema = z.object({
  removedFiles: z.number().int().nonnegative(),
  removedBytes: z.number().int().nonnegative(),
  categories: z.array(PerfCacheCategorySchema),
  errors: z.array(z.string()),
})
export type PerfCacheCleanResult = z.infer<typeof PerfCacheCleanResultSchema>

export const contract = defineContract({
  id: 'perf',
  methods: {
    hardware: { input: z.void(), output: PerfHardwareSchema },
    recommend: { input: PerfRecommendInputSchema, output: MemoryRecommendationSchema },
    apply: { input: PerfApplyInputSchema, output: PerfApplyResultSchema },
    processes: { input: z.void(), output: PerfProcessResultSchema },
    /** Dry-run only: counts files/bytes without deleting anything. */
    scanCache: { input: z.void(), output: PerfCacheScanSchema },
    cleanCache: { input: PerfCacheCleanInputSchema, output: PerfCacheCleanResultSchema },
  },
  events: {},
})

export const perfContract = contract
export type PerfContract = typeof contract
