import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Instance integrity + repair contract (t31).
 *
 * Verifies only the files owned by the version's installation metadata:
 *  - `versions/<dir>/<dir>.jar` (client);
 *  - `libraries/**` (artifact + native classifiers allowed by rules);
 *  - `assets/indexes/<id>.json` and `assets/objects/<2>/<hash>`.
 *
 * It never reads, reports as owned, or writes `mods/`, `saves/`, `config/`,
 * resource packs or shader packs. "Extra" entries are informational; repair
 * only re-downloads missing/corrupt files and never deletes anything.
 */

export const RepairVerifyMode = z.enum(['hash', 'size'])
export type RepairVerifyMode = z.infer<typeof RepairVerifyMode>

export const RepairIssueKind = z.enum(['client', 'library', 'asset-index', 'asset'])
export type RepairIssueKind = z.infer<typeof RepairIssueKind>

export const RepairIssueType = z.enum(['missing', 'corrupt', 'extra'])
export type RepairIssueType = z.infer<typeof RepairIssueType>

export const RepairHashAlgorithm = z.enum(['sha1', 'sha256', 'sha512'])

export const RepairIssueSchema = z.object({
  kind: RepairIssueKind,
  type: RepairIssueType,
  /** POSIX path relative to mcRoot (safe to display and log). */
  destRel: z.string(),
  /** Shared cache file (libraries/assets); extra entries are never deleted. */
  shared: z.boolean(),
  expectedSize: z.number().int().nonnegative().nullable(),
  actualSize: z.number().int().nonnegative().nullable(),
  expectedHash: z.string().nullable(),
  actualHash: z.string().nullable(),
  hashAlgorithm: RepairHashAlgorithm.nullable(),
  reason: z.string(),
  url: z.string().nullable(),
})
export type RepairIssue = z.infer<typeof RepairIssueSchema>

export const RepairCountsSchema = z.object({
  checked: z.number().int().nonnegative(),
  bytesChecked: z.number().int().nonnegative(),
  missing: z.number().int().nonnegative(),
  corrupt: z.number().int().nonnegative(),
  extra: z.number().int().nonnegative(),
  missingBytes: z.number().int().nonnegative(),
  corruptBytes: z.number().int().nonnegative(),
})
export type RepairCounts = z.infer<typeof RepairCountsSchema>

export const RepairReportSchema = z.object({
  versionId: z.string(),
  dirName: z.string(),
  /** `hash` compares content; `size` is the fast mode and can miss same-size corruption. */
  verify: RepairVerifyMode,
  checkedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  counts: RepairCountsSchema,
  missing: z.array(RepairIssueSchema),
  corrupt: z.array(RepairIssueSchema),
  extra: z.array(RepairIssueSchema),
  warnings: z.array(z.string()),
  /** True when there are no missing/corrupt files; extras do not affect it. */
  ok: z.boolean(),
})
export type RepairReport = z.infer<typeof RepairReportSchema>

export const RepairJobState = z.enum([
  'queued',
  'scanning',
  'downloading',
  'verifying',
  'done',
  'failed',
  'cancelled',
])
export type RepairJobState = z.infer<typeof RepairJobState>

export const RepairJobKind = z.enum(['scan', 'repair'])
export type RepairJobKind = z.infer<typeof RepairJobKind>

export const RepairProgressSchema = z.object({
  jobId: z.string(),
  kind: RepairJobKind,
  versionId: z.string(),
  state: RepairJobState,
  stage: z.enum(['scan', 'download', 'verify', 'done']),
  percent: z.number().min(0).max(100).nullable(),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  currentFile: z.string().nullable(),
  message: z.string().nullable(),
  bytesDone: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type RepairProgress = z.infer<typeof RepairProgressSchema>

export const RepairErrorShapeSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type RepairErrorShape = z.infer<typeof RepairErrorShapeSchema>

export const RepairScanResultSchema = z.object({
  jobId: z.string(),
  report: RepairReportSchema,
})
export type RepairScanResult = z.infer<typeof RepairScanResultSchema>

export const RepairFinishedSchema = z.object({
  jobId: z.string(),
  kind: RepairJobKind,
  ok: z.boolean(),
  report: RepairReportSchema.nullable(),
  error: RepairErrorShapeSchema.nullable(),
})
export type RepairFinished = z.infer<typeof RepairFinishedSchema>

export const RepairScanInputSchema = z.object({
  versionId: z.string().min(1),
  verify: RepairVerifyMode.default('hash'),
})
export type RepairScanInput = z.infer<typeof RepairScanInputSchema>

export const RepairStartInputSchema = z.object({
  versionId: z.string().min(1),
  verify: RepairVerifyMode.default('hash'),
})
export type RepairStartInput = z.infer<typeof RepairStartInputSchema>

export const contract = defineContract({
  id: 'repair',
  methods: {
    scan: {
      input: RepairScanInputSchema,
      output: z.object({ jobId: z.string() }),
    },
    repair: {
      input: RepairStartInputSchema,
      output: z.object({ jobId: z.string() }),
    },
    status: {
      input: z.object({ jobId: z.string().min(1) }),
      output: RepairProgressSchema.nullable(),
    },
    report: {
      input: z.object({ jobId: z.string().min(1) }),
      output: RepairReportSchema.nullable(),
    },
    cancel: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ cancelled: z.boolean() }),
    },
    listJobs: {
      input: z.void(),
      output: z.array(RepairProgressSchema),
    },
  },
  events: {
    scanProgress: {
      payload: RepairProgressSchema,
      throttleMs: 100,
    },
    scanFinished: {
      payload: RepairFinishedSchema,
    },
    repairProgress: {
      payload: RepairProgressSchema,
      throttleMs: 100,
    },
    repairFinished: {
      payload: RepairFinishedSchema,
    },
  },
})

export const repairContract = contract

export interface RepairService {
  scan(input: RepairScanInput): Promise<{ jobId: string }>
  repair(input: RepairStartInput): Promise<{ jobId: string }>
  status(jobId: string): RepairProgress | null
  report(jobId: string): RepairReport | null
  cancel(jobId: string): Promise<{ cancelled: boolean }>
  listJobs(): RepairProgress[]
}
