import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Third-party multiplayer SDK manifests.
 *
 * Built-in EasyTier remains the default channel; a manifest is only a
 * *validated* alternative sidecar. Validation is strict: required fields,
 * command allowlist (no shell metacharacters), path containment and an optional
 * SHA-256. Anything invalid is listed as rejected and can never be started.
 */
export const SDK_SCHEMA_VERSION = 1

export const SdkManifestSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,63}$/),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(64),
  /** Single executable basename inside the SDK directory (no path separators). */
  command: z.string().min(1).max(128),
  args: z.array(z.string().max(512)).max(64).default([]),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  homepage: z.string().url().max(500).optional(),
  description: z.string().max(500).optional(),
})
export type SdkManifest = z.infer<typeof SdkManifestSchema>

export const SdkEntrySchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  command: z.string(),
  directory: z.string(),
  /** Absolute path of the validated manifest (diagnostics only). */
  manifestPath: z.string(),
  valid: z.boolean(),
  /** Human-readable reasons; a rejected entry can never be started. */
  errors: z.array(z.string()),
  hashVerified: z.boolean(),
  running: z.boolean(),
  pid: z.number().int().positive().nullable(),
})
export type SdkEntry = z.infer<typeof SdkEntrySchema>

export const SdkListSchema = z.object({
  directory: z.string(),
  entries: z.array(SdkEntrySchema),
  rejected: z.array(
    z.object({
      path: z.string(),
      errors: z.array(z.string()),
    }),
  ),
})
export type SdkList = z.infer<typeof SdkListSchema>

export const SdkStartInputSchema = z.object({
  id: z.string().min(1).max(64),
  args: z.array(z.string().max(512)).max(32).default([]),
})
export type SdkStartInput = z.input<typeof SdkStartInputSchema>

export const SdkStartResultSchema = z.object({
  id: z.string(),
  pid: z.number().int().positive(),
  startedAt: z.number().int().nonnegative(),
  command: z.string(),
})
export type SdkStartResult = z.infer<typeof SdkStartResultSchema>

export const SdkStopResultSchema = z.object({
  id: z.string(),
  stopped: z.boolean(),
})
export type SdkStopResult = z.infer<typeof SdkStopResultSchema>

export const contract = defineContract({
  id: 'sdk',
  methods: {
    /** Re-scans the manifest directory; invalid entries are returned as rejected. */
    list: { input: z.void(), output: SdkListSchema },
    start: { input: SdkStartInputSchema, output: SdkStartResultSchema },
    stop: { input: z.object({ id: z.string().min(1).max(64) }), output: SdkStopResultSchema },
    openFolder: { input: z.void(), output: z.object({ path: z.string(), opened: z.boolean() }) },
  },
  events: {},
})

export const sdkContract = contract
export type SdkContract = typeof contract
