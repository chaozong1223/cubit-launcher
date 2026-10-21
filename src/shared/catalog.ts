import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Catalog + mod-update contract (t41).
 *
 * P0: Modrinth is the only live search/install source. CurseForge is a
 * "open project page" link only — no CurseForge API calls are made.
 *
 * API constraints (docs/02 API-01..): descriptive unique User-Agent, <=300 rpm,
 * sha1/sha512 verification for every downloaded file, and no mirroring of
 * metadata/artifacts.
 */

export const CatalogProvider = z.enum(['modrinth', 'curseforge'])
export type CatalogProvider = z.infer<typeof CatalogProvider>

export const CatalogProjectType = z.enum(['mod', 'resourcepack', 'shader', 'modpack'])
export type CatalogProjectType = z.infer<typeof CatalogProjectType>

export const CatalogSearchHitSchema = z.object({
  projectId: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  author: z.string().nullable(),
  downloads: z.number().int().nonnegative(),
  follows: z.number().int().nonnegative(),
  iconUrl: z.string().nullable(),
  projectType: CatalogProjectType,
  loaders: z.array(z.string()),
  gameVersions: z.array(z.string()),
  latestVersion: z.string().nullable(),
  dateModified: z.string().nullable(),
  categories: z.array(z.string()),
  pageUrl: z.string(),
})
export type CatalogSearchHit = z.infer<typeof CatalogSearchHitSchema>

export const CatalogSearchResultSchema = z.object({
  query: z.string(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  total: z.number().int().nonnegative(),
  source: z.literal('modrinth'),
  cached: z.boolean(),
  hits: z.array(CatalogSearchHitSchema),
})
export type CatalogSearchResult = z.infer<typeof CatalogSearchResultSchema>

export const CatalogProjectSchema = z.object({
  id: z.string(),
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  body: z.string(),
  projectType: CatalogProjectType,
  downloads: z.number().int().nonnegative(),
  follows: z.number().int().nonnegative(),
  iconUrl: z.string().nullable(),
  categories: z.array(z.string()),
  gameVersions: z.array(z.string()),
  loaders: z.array(z.string()),
  pageUrl: z.string(),
})
export type CatalogProject = z.infer<typeof CatalogProjectSchema>

export const CatalogVersionFileSchema = z.object({
  filename: z.string().min(1),
  url: z.string().min(1),
  size: z.number().int().nonnegative(),
  sha1: z.string().nullable(),
  sha512: z.string().nullable(),
  primary: z.boolean(),
})
export type CatalogVersionFile = z.infer<typeof CatalogVersionFileSchema>

export const CatalogVersionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  versionNumber: z.string(),
  changelog: z.string().nullable(),
  gameVersions: z.array(z.string()),
  loaders: z.array(z.string()),
  versionType: z.enum(['release', 'beta', 'alpha']),
  datePublished: z.string().nullable(),
  downloads: z.number().int().nonnegative(),
  files: z.array(CatalogVersionFileSchema),
})
export type CatalogVersion = z.infer<typeof CatalogVersionSchema>

export const CatalogInstallInputSchema = z.object({
  instanceId: z.string().min(1),
  projectId: z.string().min(1),
  versionId: z.string().min(1).optional(),
  /** Allow a beta/alpha version; loader/game-version mismatches stay blocked. */
  allowPrerelease: z.boolean().default(false),
})
export type CatalogInstallInput = z.infer<typeof CatalogInstallInputSchema>

export const CatalogInstallResultSchema = z.object({
  instanceId: z.string(),
  projectId: z.string(),
  versionId: z.string(),
  filename: z.string(),
  targetPath: z.string(),
  sha1: z.string().nullable(),
  sha512: z.string().nullable(),
  size: z.number().int().nonnegative(),
  versionType: z.enum(['release', 'beta', 'alpha']),
  warnings: z.array(z.string()),
})
export type CatalogInstallResult = z.infer<typeof CatalogInstallResultSchema>

export const CatalogRiskSchema = z.enum(['ok', 'warning', 'blocked'])
export type CatalogRisk = z.infer<typeof CatalogRiskSchema>

export const CatalogUpdateItemSchema = z.object({
  projectId: z.string(),
  slug: z.string(),
  title: z.string(),
  currentFile: z.string(),
  currentEnabled: z.boolean(),
  currentVersionId: z.string().nullable(),
  currentVersion: z.string().nullable(),
  latestVersionId: z.string(),
  latestVersion: z.string(),
  latestVersionType: z.enum(['release', 'beta', 'alpha']),
  changelogSummary: z.string().nullable(),
  downloadUrl: z.string(),
  filename: z.string(),
  sha1: z.string().nullable(),
  sha512: z.string().nullable(),
  size: z.number().int().nonnegative(),
  risk: CatalogRiskSchema,
  warnings: z.array(z.string()),
  reason: z.string().nullable(),
})
export type CatalogUpdateItem = z.infer<typeof CatalogUpdateItemSchema>

export const CatalogSkippedSchema = z.object({
  file: z.string(),
  reason: z.string(),
})
export type CatalogSkipped = z.infer<typeof CatalogSkippedSchema>

export const CatalogErrorItemSchema = z.object({
  file: z.string(),
  message: z.string(),
})
export type CatalogErrorItem = z.infer<typeof CatalogErrorItemSchema>

export const CatalogUpdateCheckSchema = z.object({
  jobId: z.string(),
  instanceId: z.string(),
  mcVersion: z.string().nullable(),
  loader: z.string().nullable(),
  checked: z.number().int().nonnegative(),
  matched: z.number().int().nonnegative(),
  updates: z.array(CatalogUpdateItemSchema),
  skipped: z.array(CatalogSkippedSchema),
  errors: z.array(CatalogErrorItemSchema),
  durationMs: z.number().int().nonnegative(),
  checkedAt: z.number().int().nonnegative(),
})
export type CatalogUpdateCheck = z.infer<typeof CatalogUpdateCheckSchema>

export const CatalogCheckInputSchema = z.object({
  instanceId: z.string().min(1),
  includeDisabled: z.boolean().default(false),
})
export type CatalogCheckInput = z.infer<typeof CatalogCheckInputSchema>

export const CatalogUpdateInputSchema = z.object({
  instanceId: z.string().min(1),
  projectId: z.string().min(1),
  versionId: z.string().min(1),
  /** Local file name from checkUpdates; defaults to the project's primary file. */
  currentFile: z.string().min(1).optional(),
  allowPrerelease: z.boolean().default(false),
})
export type CatalogUpdateInput = z.infer<typeof CatalogUpdateInputSchema>

export const CatalogUpdateResultSchema = CatalogInstallResultSchema.extend({
  recycledPath: z.string().nullable(),
  previousFile: z.string().nullable(),
})
export type CatalogUpdateResult = z.infer<typeof CatalogUpdateResultSchema>

export const CatalogPageInputSchema = z.object({
  provider: CatalogProvider,
  /** Modrinth slug/id or CurseForge slug; no API lookup is performed. */
  slug: z.string().min(1).max(200),
})
export type CatalogPageInput = z.infer<typeof CatalogPageInputSchema>

export const CatalogPageResultSchema = z.object({
  provider: CatalogProvider,
  url: z.string(),
  opened: z.boolean(),
})
export type CatalogPageResult = z.infer<typeof CatalogPageResultSchema>

export const CatalogSearchInputSchema = z.object({
  query: z.string().max(100).default(''),
  loaders: z.array(z.string().min(1).max(32)).default([]),
  gameVersion: z.string().max(32).optional(),
  projectType: CatalogProjectType.default('mod'),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().nonnegative().default(0),
})
export type CatalogSearchInput = z.infer<typeof CatalogSearchInputSchema>

export const CatalogProjectInputSchema = z.object({ idOrSlug: z.string().min(1).max(200) })
export const CatalogVersionsInputSchema = z.object({
  projectId: z.string().min(1),
  gameVersion: z.string().max(32).optional(),
  loader: z.string().max(32).optional(),
})
export type CatalogVersionsInput = z.infer<typeof CatalogVersionsInputSchema>

export const contract = defineContract({
  id: 'catalog',
  methods: {
    search: {
      input: CatalogSearchInputSchema,
      output: CatalogSearchResultSchema,
    },
    project: {
      input: CatalogProjectInputSchema,
      output: CatalogProjectSchema,
    },
    versions: {
      input: CatalogVersionsInputSchema,
      output: z.array(CatalogVersionSchema),
    },
    install: {
      input: CatalogInstallInputSchema,
      output: CatalogInstallResultSchema,
    },
    checkUpdates: {
      input: CatalogCheckInputSchema,
      output: CatalogUpdateCheckSchema,
    },
    update: {
      input: CatalogUpdateInputSchema,
      output: CatalogUpdateResultSchema,
    },
    pageUrl: {
      input: CatalogPageInputSchema,
      output: CatalogPageResultSchema,
    },
    openPage: {
      input: CatalogPageInputSchema,
      output: CatalogPageResultSchema,
    },
  },
  events: {
    checkProgress: {
      payload: z.object({
        jobId: z.string(),
        done: z.number().int().nonnegative(),
        total: z.number().int().nonnegative(),
        currentFile: z.string().nullable(),
        phase: z.enum(['scan', 'hash', 'lookup', 'versions', 'compare']),
      }),
      throttleMs: 100,
    },
    installProgress: {
      payload: z.object({
        projectId: z.string(),
        versionId: z.string(),
        stage: z.enum(['resolve', 'download', 'verify', 'install', 'done']),
        percent: z.number().min(0).max(100).nullable(),
        bytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
      }),
      throttleMs: 100,
    },
    updated: {
      payload: z.object({
        instanceId: z.string(),
        projectId: z.string(),
        versionId: z.string(),
        recycledPath: z.string().nullable(),
      }),
    },
  },
})

export const catalogContract = contract

export interface CatalogService {
  search(input: CatalogSearchInput): Promise<CatalogSearchResult>
  project(input: { idOrSlug: string }): Promise<CatalogProject>
  versions(input: CatalogVersionsInput): Promise<CatalogVersion[]>
  install(input: CatalogInstallInput): Promise<CatalogInstallResult>
  checkUpdates(input: CatalogCheckInput): Promise<CatalogUpdateCheck>
  update(input: CatalogUpdateInput): Promise<CatalogUpdateResult>
  pageUrl(input: CatalogPageInput): Promise<CatalogPageResult>
  openPage(input: CatalogPageInput): Promise<CatalogPageResult>
}
