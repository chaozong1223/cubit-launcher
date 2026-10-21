import { z } from 'zod'
import { defineContract } from './kernel'

export const CrashCategory = z.enum([
  'java-version',
  'missing-library',
  'mod-conflict',
  'out-of-memory',
  'graphics-driver',
  'auth-failed',
  'corrupt-files',
  'port-in-use',
  'jvm-args',
  'unknown',
])
export type CrashCategory = z.infer<typeof CrashCategory>

export const FixActionKind = z.enum([
  'set-java',
  'set-memory',
  'disable-mods',
  'restore-mods',
  'repair-files',
  'open-url',
  'open-folder',
  'copy-text',
  'export-diagnostics',
  'manual',
])
export type FixActionKind = z.infer<typeof FixActionKind>

export const FixActionSchema = z.object({
  id: z.string().min(1),
  kind: FixActionKind,
  label: z.string().min(1),
  description: z.string().min(1),
  risk: z.enum(['safe', 'caution', 'manual']),
  automatic: z.boolean(),
  params: z.record(z.string(), z.unknown()).default({}),
})
export type FixAction = z.infer<typeof FixActionSchema>

export const CrashContextSchema = z.object({
  exitCode: z.number().int().nullable(),
  javaVersion: z.string().nullable(),
  javaMajor: z.number().int().nullable(),
  memory: z
    .object({ minMb: z.number().int(), maxMb: z.number().int() })
    .nullable(),
  modCount: z.number().int().nonnegative(),
  mcVersion: z.string().nullable(),
  loader: z.string().nullable(),
})
export type CrashContext = z.infer<typeof CrashContextSchema>

export const CrashAnalysisSchema = z.object({
  id: z.string(),
  instanceId: z.string().nullable(),
  category: CrashCategory,
  confidence: z.enum(['high', 'medium', 'low']),
  /** True when the launcher cannot name a cause honestly (unknown / weak match). */
  uncertain: z.boolean(),
  phenomenon: z.string(),
  likelyCause: z.string(),
  evidence: z.array(z.string()),
  alternatives: z.array(
    z.object({
      category: CrashCategory,
      confidence: z.enum(['high', 'medium', 'low']),
      title: z.string(),
    }),
  ),
  actions: z.array(FixActionSchema),
  diagnostics: z.array(z.string()),
  context: CrashContextSchema,
  logTail: z.array(z.string()),
  createdAt: z.number().int(),
})
export type CrashAnalysis = z.infer<typeof CrashAnalysisSchema>

export const FixResultSchema = z.object({
  ok: z.boolean(),
  actionId: z.string(),
  message: z.string(),
  changed: z.array(z.string()),
  restartRequired: z.boolean(),
  clipboard: z.string().optional(),
  jobId: z.string().optional(),
})
export type FixResult = z.infer<typeof FixResultSchema>

export const CrashExportResultSchema = z.object({
  path: z.string(),
  bytes: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
})
export type CrashExportResult = z.infer<typeof CrashExportResultSchema>

export const CrashTextSchema = z.object({
  markdown: z.string(),
  plain: z.string(),
})
export type CrashText = z.infer<typeof CrashTextSchema>

export const CrashReportResultSchema = z.object({
  analysis: CrashAnalysisSchema,
  /** `$DATA/crash-reports/<yyyyMMdd-HHmmss>-<instance>.txt` (R5.7). */
  reportPath: z.string(),
  /** A second copy under the instance's own crash-reports/ directory. */
  instanceReportPath: z.string(),
  fileName: z.string(),
})
export type CrashReportResult = z.infer<typeof CrashReportResultSchema>

export const contract = defineContract({
  id: 'crash',
  methods: {
    analyze: {
      input: z.object({
        instanceId: z.string().optional(),
        exitCode: z.number().int().nullable().optional(),
        /** Explicit tail supplied by tests/UI; otherwise the latest game log is read. */
        logText: z.string().max(2 * 1024 * 1024).optional(),
        maxLines: z.number().int().min(20).max(2_000).optional(),
      }),
      output: CrashAnalysisSchema,
    },
    applyFix: {
      input: z.object({
        instanceId: z.string().min(1),
        action: FixActionSchema,
      }),
      output: FixResultSchema,
    },
    exportReport: {
      input: z.object({
        analysis: CrashAnalysisSchema,
        logText: z.string().max(8 * 1024 * 1024).optional(),
        outPath: z.string().min(1).optional(),
      }),
      output: CrashExportResultSchema,
    },
    format: {
      input: z.object({ analysis: CrashAnalysisSchema }),
      output: CrashTextSchema,
    },
  },
  events: {
    changed: { payload: z.object({ instanceId: z.string().nullable() }) },
    detected: {
      payload: z.object({
        instanceId: z.string(),
        analysis: CrashAnalysisSchema,
        reportPath: z.string(),
        instanceReportPath: z.string(),
        fileName: z.string(),
      }),
    },
  },
})

export const crashContract = contract
export type CrashContract = typeof contract
