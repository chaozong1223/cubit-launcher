import { z } from 'zod'
import { defineContract } from './kernel'

export const LaunchState = z.enum([
  'idle',
  'precheck',
  'java',
  'args',
  'spawning',
  'running',
  'exited',
  'crashed',
])
export type LaunchState = z.infer<typeof LaunchState>

export const LaunchAccountSchema = z.object({
  kind: z.enum(['offline', 'microsoft', 'authlib']),
  name: z.string(),
  uuid: z.string(),
  accessToken: z.string(),
  userType: z.enum(['legacy', 'msa']),
  xuid: z.string().nullable().optional(),
  clientId: z.string().nullable().optional(),
})
export type LaunchAccount = z.infer<typeof LaunchAccountSchema>

export const LaunchPlanSchema = z.object({
  sessionId: z.string(),
  dryRun: z.boolean(),
  versionId: z.string(),
  mcVersion: z.string().nullable(),
  javaPath: z.string(),
  javaMajor: z.number().int().nullable(),
  cwd: z.string(),
  argv: z.array(z.string()),
  env: z.record(z.string(), z.string()),
  classpath: z.array(z.string()),
  nativesDir: z.string(),
  logFile: z.string(),
  warnings: z.array(z.string()),
})
export type LaunchPlan = z.infer<typeof LaunchPlanSchema>

/** null/absent means "follow the game" and leaves options.txt untouched. */
export const GameLanguageSchema = z.string().regex(/^[a-z]{2,3}(?:_[A-Za-z0-9]+)?$/)

export const LaunchSettingsSchema = z.object({
  language: GameLanguageSchema.nullable(),
  defaultLanguage: z.string(),
  note: z.string(),
})
export type LaunchSettings = z.infer<typeof LaunchSettingsSchema>

export const LaunchSettingsPatchSchema = z.object({
  language: GameLanguageSchema.nullable(),
})
export type LaunchSettingsPatch = z.infer<typeof LaunchSettingsPatchSchema>

export const LaunchStatusSchema = z.object({
  instanceId: z.string(),
  state: LaunchState,
  sessionId: z.string().nullable(),
  startedAt: z.number().int().nullable(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  reportReady: z.boolean(),
})
export type LaunchStatus = z.infer<typeof LaunchStatusSchema>

export const CrashHintSchema = z.object({
  id: z.string(),
  category: z.enum(['java', 'memory', 'classpath', 'mods', 'graphics', 'jvm-args', 'unknown']),
  confidence: z.enum(['high', 'medium', 'low']),
  title: z.string(),
  detail: z.string(),
  evidence: z.string(),
})
export type CrashHint = z.infer<typeof CrashHintSchema>

export const LaunchExitReportSchema = z.object({
  sessionId: z.string(),
  instanceId: z.string(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  startedAt: z.number().int(),
  exitedAt: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  classification: z.enum(['normal', 'crashed', 'suspect', 'killed']),
  crashHints: z.array(CrashHintSchema),
  logFile: z.string(),
  lastLines: z.array(z.string()),
})
export type LaunchExitReport = z.infer<typeof LaunchExitReportSchema>

export const LaunchRequestSchema = z.object({
  instanceId: z.string(),
  accountId: z.string().nullable().default(null),
  server: z
    .object({ host: z.string(), port: z.number().int().min(1).max(65535) })
    .nullable()
    .default(null),
  /** Open this world directly on start (`saves/<world>`, Minecraft 1.20+). */
  world: z.string().min(1).max(128).nullable().default(null),
})

export const contract = defineContract({
  id: 'launch',
  methods: {
    plan: {
      input: LaunchRequestSchema.extend({ dryRun: z.boolean().default(false) }),
      output: LaunchPlanSchema,
    },
    start: {
      input: LaunchRequestSchema,
      output: z.object({ sessionId: z.string() }),
    },
    stop: {
      input: z.object({ sessionId: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    status: {
      input: z.object({ instanceId: z.string() }),
      output: LaunchStatusSchema,
    },
    lastReport: {
      input: z.object({ instanceId: z.string() }),
      output: LaunchExitReportSchema.nullable(),
    },
    getSettings: {
      input: z.void(),
      output: LaunchSettingsSchema,
    },
    setLanguage: {
      input: LaunchSettingsPatchSchema,
      output: LaunchSettingsSchema,
    },
  },
  events: {
    status: {
      payload: z.object({
        instanceId: z.string(),
        state: LaunchState,
        sessionId: z.string().nullable(),
        startedAt: z.number().int().nullable(),
        exitCode: z.number().int().nullable(),
      }),
    },
    stage: {
      payload: z.object({
        instanceId: z.string(),
        stage: z.enum(['precheck', 'java', 'args', 'spawn']),
        detail: z.string().nullable(),
      }),
    },
    output: {
      payload: z.object({ sessionId: z.string(), line: z.string() }),
      throttleMs: 100,
    },
    exited: {
      payload: z.object({
        sessionId: z.string(),
        exitCode: z.number().int().nullable(),
        reportId: z.string().nullable(),
      }),
    },
  },
})

export const launchContract = contract

export interface LaunchService {
  plan(input: z.infer<typeof contract.methods.plan.input>): Promise<LaunchPlan>
  start(input: z.infer<typeof contract.methods.start.input>): Promise<{ sessionId: string }>
  stop(sessionId: string): Promise<{ ok: boolean }>
  status(instanceId: string): LaunchStatus
  lastReport(instanceId: string): LaunchExitReport | null
  getSettings(): LaunchSettings
  setLanguage(input: LaunchSettingsPatch): LaunchSettings
}
