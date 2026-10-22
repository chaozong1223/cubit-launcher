import { z } from 'zod'

/**
 * Generic contract types for long-running, cancellable jobs.
 *
 * The first user is the modpack import (`mods.importModpack`) and the instance
 * copy (`instance.copyInstance`): both used to be blocking RPCs. Modules keep
 * their own payload shape by extending `JobProgressSchema` / `JobFinishedSchema`
 * with the identity fields the renderer needs (instance id, pack format, ...).
 */

export const JobStateSchema = z.enum([
  'queued',
  'running',
  'paused',
  'done',
  'failed',
  'cancelled',
])
export type JobState = z.infer<typeof JobStateSchema>

export const JobErrorSchema = z.object({
  code: z.string().min(1).max(96),
  message: z.string(),
  retryable: z.boolean(),
})
export type JobError = z.infer<typeof JobErrorSchema>

export const JobProgressSchema = z.object({
  jobId: z.string().min(1),
  state: JobStateSchema,
  stage: z.string().min(1).max(64),
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  bytesDone: z.number().int().nonnegative(),
  bytesTotal: z.number().int().nonnegative(),
  currentFile: z.string().nullable(),
  message: z.string().nullable(),
  startedAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
})
export type JobProgress = z.infer<typeof JobProgressSchema>

export const JobFinishedSchema = z.object({
  jobId: z.string().min(1),
  state: JobStateSchema,
  ok: z.boolean(),
  error: JobErrorSchema.nullable(),
  durationMs: z.number().int().nonnegative(),
})
export type JobFinished = z.infer<typeof JobFinishedSchema>
