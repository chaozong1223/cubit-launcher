import { z } from 'zod'
import { defineContract } from './kernel'

export const VersionState = z.enum([
  'ready',
  'missing-json',
  'corrupt-json',
  'missing-jar',
  'unsupported',
])
export type VersionState = z.infer<typeof VersionState>

export const VersionLoaderSchema = z.object({
  type: z.enum(['vanilla', 'fabric', 'quilt', 'forge', 'neoforge', 'unknown']),
  version: z.string().nullable(),
})

export const VersionSummarySchema = z.object({
  id: z.string(),
  dirName: z.string(),
  state: VersionState,
  reason: z.string().nullable(),
  type: z.string().nullable(),
  mainClass: z.string().nullable(),
  mcVersion: z.string().nullable(),
  loader: VersionLoaderSchema,
  javaMajor: z.number().int().nullable(),
  chain: z.array(z.string()),
  clientJar: z.string().nullable(),
  clientJarExists: z.boolean(),
  flattened: z.boolean(),
})
export type VersionSummary = z.infer<typeof VersionSummarySchema>

export const VersionInspectionSchema = VersionSummarySchema.extend({
  warnings: z.array(z.string()),
  libraries: z.object({
    total: z.number().int(),
    allowed: z.number().int(),
    classpath: z.number().int(),
    /** All allowed native jars (all architectures) — the download footprint. */
    natives: z.number().int(),
    /** Subset extracted on this machine (arch filtered). */
    nativesExtract: z.number().int(),
  }),
  assetIndex: z
    .object({ id: z.string(), totalSize: z.number().int().nullable() })
    .nullable(),
  directories: z.object({
    versionDir: z.string(),
    gameDir: z.string(),
    librariesDir: z.string(),
    assetsDir: z.string(),
    nativesDir: z.string(),
  }),
})
export type VersionInspection = z.infer<typeof VersionInspectionSchema>

export const FlattenResultSchema = z.object({
  id: z.string(),
  chain: z.array(z.string()),
  written: z.boolean(),
  file: z.string().nullable(),
  /** Merged JSON; omitted from the IPC payload when `includeJson` is false. */
  json: z.unknown().optional(),
})
export type FlattenResult = z.infer<typeof FlattenResultSchema>

export const contract = defineContract({
  id: 'version',
  methods: {
    listVersions: {
      input: z.object({ mcRoot: z.string().optional() }).default({}),
      output: z.array(VersionSummarySchema),
    },
    inspect: {
      input: z.object({ versionId: z.string() }),
      output: VersionInspectionSchema,
    },
    flatten: {
      input: z.object({
        versionId: z.string(),
        write: z.boolean().default(false),
        includeJson: z.boolean().default(false),
      }),
      output: FlattenResultSchema,
    },
  },
  events: {
    installDone: {
      payload: z.object({ versionId: z.string(), ok: z.boolean() }),
    },
  },
})

export const versionContract = contract

export interface VersionService {
  listVersions(mcRoot?: string): Promise<VersionSummary[]>
  inspect(versionId: string): Promise<VersionInspection>
  flatten(input: { versionId: string; write?: boolean; includeJson?: boolean }): Promise<FlattenResult>
}
