import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Java detection + managed-runtime contract.
 *
 * t6 delivered detection/selection. t30 adds the HMCL-style management layer:
 *  - required major from the version JSON (`javaVersion.majorVersion`);
 *  - a match result that explains *why* a Java was recommended;
 *  - instance override > global default > automatic selection;
 *  - downloading an Adoptium / Microsoft OpenJDK into `dataRoot/java/` with
 *    SHA-256 verification, extraction and validation (SEC-DL-05/SEC-EXE-01).
 */

export const JavaSource = z.enum([
  'manual',
  'java-home',
  'mojang-runtime',
  'launcher-runtime',
  'registry',
  'common-path',
  'path',
  'instance',
])
export type JavaSource = z.infer<typeof JavaSource>

export const JavaVersionSchema = z.object({
  major: z.number().int().positive(),
  minor: z.number().int().nonnegative(),
  patch: z.number().int().nonnegative(),
  raw: z.string(),
})

export const JavaCandidateSchema = z.object({
  path: z.string(),
  home: z.string().nullable(),
  source: JavaSource,
  version: JavaVersionSchema,
  vendor: z.string().nullable(),
  arch: z.string().nullable(),
  bits: z.union([z.literal(32), z.literal(64), z.literal('unknown')]),
  probedAt: z.number().int().nullable(),
})
export type JavaCandidate = z.infer<typeof JavaCandidateSchema>

export const JavaRejectedSchema = z.object({
  path: z.string(),
  source: JavaSource,
  reason: z.string(),
})
export type JavaRejected = z.infer<typeof JavaRejectedSchema>

export const JavaDetectResultSchema = z.object({
  candidates: z.array(JavaCandidateSchema),
  rejected: z.array(JavaRejectedSchema),
  durationMs: z.number().int().nonnegative(),
  cached: z.boolean(),
  scannedAt: z.number().int(),
  sources: z.array(z.string()),
})
export type JavaDetectResult = z.infer<typeof JavaDetectResultSchema>

export const JavaChoiceSchema = z.object({
  candidate: JavaCandidateSchema.nullable(),
  requiredMajor: z.number().int().nullable(),
  warnings: z.array(z.string()),
})
export type JavaChoice = z.infer<typeof JavaChoiceSchema>

export const JavaChooseInputSchema = z.object({
  requiredMajor: z.number().int().nullable().optional(),
  forcedPath: z.string().nullable().optional(),
  forcedMajor: z.number().int().nullable().optional(),
})

// --------------------------------------------------------------- management

export const JavaOverrideMode = z.enum(['auto', 'major', 'path'])
export type JavaOverrideMode = z.infer<typeof JavaOverrideMode>

export const JavaOverrideSchema = z.object({
  mode: JavaOverrideMode,
  value: z.union([z.number().int().positive(), z.string().min(1)]).nullable(),
})
export type JavaOverride = z.infer<typeof JavaOverrideSchema>

export const DEFAULT_JAVA_OVERRIDE: JavaOverride = { mode: 'auto', value: null }

export const JavaProviderId = z.enum(['adoptium', 'microsoft'])
export type JavaProviderId = z.infer<typeof JavaProviderId>

export const JavaSettingsSchema = z.object({
  schemaVersion: z.literal(1),
  /** Global default, applied when the instance does not override it. */
  defaultJava: JavaOverrideSchema,
  preferredSource: JavaProviderId,
  /** Allowed by default; P1 setting can disable one-click downloads. */
  autoDownload: z.boolean(),
})
export type JavaSettings = z.infer<typeof JavaSettingsSchema>

export const JavaSettingsPatchSchema = z.object({
  defaultJava: JavaOverrideSchema.optional(),
  preferredSource: JavaProviderId.optional(),
  autoDownload: z.boolean().optional(),
})
export type JavaSettingsPatch = z.infer<typeof JavaSettingsPatchSchema>

export const JavaRequiredSource = z.enum(['version-json', 'fallback', 'unknown'])
export type JavaRequiredSource = z.infer<typeof JavaRequiredSource>

export const JavaRequirementSchema = z.object({
  versionId: z.string(),
  dirName: z.string(),
  mcVersion: z.string().nullable(),
  javaVersionComponent: z.string().nullable(),
  requiredMajor: z.number().int().nullable(),
  requiredSource: JavaRequiredSource,
  instanceJava: JavaOverrideSchema.nullable(),
  globalJava: JavaOverrideSchema,
  warnings: z.array(z.string()),
})
export type JavaRequirement = z.infer<typeof JavaRequirementSchema>

export const JavaReasonCode = z.enum([
  'instance-path',
  'instance-major',
  'global-path',
  'global-major',
  'exact-match',
  'newer-allowed',
  'forced-path-invalid',
  'forced-major-missing',
  'no-java',
  'required-missing',
  'unknown-version',
])
export type JavaReasonCode = z.infer<typeof JavaReasonCode>

export const JavaReasonSchema = z.object({
  code: JavaReasonCode,
  /** Human-readable explanation shown next to the recommendation. */
  text: z.string(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type JavaReason = z.infer<typeof JavaReasonSchema>

export const JavaDownloadSuggestionSchema = z.object({
  needed: z.boolean(),
  /** Major version the UI should offer to download. */
  suggestedMajor: z.number().int().nullable(),
  /** Major that would otherwise be used automatically (null when none). */
  installedMajor: z.number().int().nullable(),
  sources: z.array(JavaProviderId),
  reason: z.string().nullable(),
})
export type JavaDownloadSuggestion = z.infer<typeof JavaDownloadSuggestionSchema>

export const JavaMatchSchema = z.object({
  versionId: z.string(),
  requiredMajor: z.number().int().nullable(),
  requiredSource: JavaRequiredSource,
  selected: JavaCandidateSchema.nullable(),
  /** Which layer supplied the choice. */
  scope: z.enum(['instance', 'global', 'auto']),
  reason: JavaReasonSchema,
  alternatives: z.array(JavaCandidateSchema),
  download: JavaDownloadSuggestionSchema,
  warnings: z.array(z.string()),
})
export type JavaMatch = z.infer<typeof JavaMatchSchema>

export const JavaManagedSchema = z.object({
  path: z.string(),
  home: z.string().nullable(),
  major: z.number().int(),
  version: z.string(),
  vendor: z.string().nullable(),
  /** Directory name below dataRoot/java. */
  managedDir: z.string(),
})
export type JavaManaged = z.infer<typeof JavaManagedSchema>

export const JavaProviderInfoSchema = z.object({
  id: JavaProviderId,
  displayName: z.string(),
  homepage: z.string(),
  available: z.boolean(),
  note: z.string(),
})
export type JavaProviderInfo = z.infer<typeof JavaProviderInfoSchema>

export const JavaDownloadInputSchema = z.object({
  major: z.number().int().min(8).max(30),
  source: z.enum(['auto', 'adoptium', 'microsoft']).default('auto'),
  /** Re-download even when a managed runtime of this major already exists. */
  force: z.boolean().default(false),
})
export type JavaDownloadInput = z.infer<typeof JavaDownloadInputSchema>

export const JavaInstallJobSchema = z.object({
  jobId: z.string(),
  major: z.number().int(),
  source: JavaProviderId,
})
export type JavaInstallJob = z.infer<typeof JavaInstallJobSchema>

export const JavaInstallState = z.enum([
  'queued',
  'resolving',
  'downloading',
  'verifying',
  'extracting',
  'validating',
  'done',
  'failed',
  'cancelled',
])
export type JavaInstallState = z.infer<typeof JavaInstallState>

export const JavaInstallStage = z.enum([
  'resolve',
  'download',
  'verify',
  'extract',
  'validate',
  'done',
])
export type JavaInstallStage = z.infer<typeof JavaInstallStage>

export const JavaInstallProgressSchema = z.object({
  jobId: z.string(),
  major: z.number().int(),
  source: JavaProviderId,
  state: JavaInstallState,
  stage: JavaInstallStage,
  percent: z.number().min(0).max(100).nullable(),
  downloadedBytes: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  entriesDone: z.number().int().nonnegative(),
  entriesTotal: z.number().int().nonnegative(),
  currentFile: z.string().nullable(),
  message: z.string().nullable(),
  updatedAt: z.number().int().nonnegative(),
})
export type JavaInstallProgress = z.infer<typeof JavaInstallProgressSchema>

export const JavaErrorShapeSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
})

export const JavaInstallFinishedSchema = z.object({
  jobId: z.string(),
  ok: z.boolean(),
  major: z.number().int(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  error: JavaErrorShapeSchema.nullable(),
})
export type JavaInstallFinished = z.infer<typeof JavaInstallFinishedSchema>

export const contract = defineContract({
  id: 'java',
  methods: {
    detect: {
      input: z.object({ force: z.boolean().default(false) }).default({ force: false }),
      output: JavaDetectResultSchema,
    },
    candidates: {
      input: z.void(),
      output: z.array(JavaCandidateSchema),
    },
    choose: {
      input: JavaChooseInputSchema,
      output: JavaChoiceSchema,
    },
    requirement: {
      input: z.object({ versionId: z.string().min(1) }),
      output: JavaRequirementSchema,
    },
    match: {
      input: z.object({ versionId: z.string().min(1) }),
      output: JavaMatchSchema,
    },
    settings: {
      input: z.void(),
      output: JavaSettingsSchema,
    },
    updateSettings: {
      input: JavaSettingsPatchSchema,
      output: JavaSettingsSchema,
    },
    providers: {
      input: z.void(),
      output: z.array(JavaProviderInfoSchema),
    },
    managed: {
      input: z.void(),
      output: z.array(JavaManagedSchema),
    },
    download: {
      input: JavaDownloadInputSchema,
      output: JavaInstallJobSchema,
    },
    downloadStatus: {
      input: z.object({ jobId: z.string().min(1) }),
      output: JavaInstallProgressSchema.nullable(),
    },
    cancelDownload: {
      input: z.object({ jobId: z.string().min(1) }),
      output: z.object({ cancelled: z.boolean() }),
    },
  },
  events: {
    detectProgress: {
      payload: z.object({ done: z.number().int(), total: z.number().int() }),
      throttleMs: 100,
    },
    installProgress: {
      payload: JavaInstallProgressSchema,
      throttleMs: 100,
    },
    installFinished: {
      payload: JavaInstallFinishedSchema,
    },
  },
})

export const javaContract = contract

export interface JavaService {
  detect(input?: { force?: boolean }): Promise<JavaDetectResult>
  candidates(): Promise<JavaCandidate[]>
  choose(input?: z.infer<typeof JavaChooseInputSchema>): Promise<JavaChoice>
  requirement(input: { versionId: string }): Promise<JavaRequirement>
  match(input: { versionId: string }): Promise<JavaMatch>
  settings(): JavaSettings
  updateSettings(patch: JavaSettingsPatch): Promise<JavaSettings>
  providers(): JavaProviderInfo[]
  managed(): Promise<JavaManaged[]>
  download(input: JavaDownloadInput): Promise<JavaInstallJob>
  downloadStatus(jobId: string): JavaInstallProgress | null
  cancelDownload(jobId: string): Promise<{ cancelled: boolean }>
}
