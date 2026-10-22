import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Local skin management (P2). Skins are cached per account under dataRoot and
 * never uploaded to Microsoft/authlib; account switching selects a different
 * cache key, so skins cannot leak between accounts.
 */
export const SkinSourceSchema = z.enum(['local', 'remote', 'default'])
export type SkinSource = z.infer<typeof SkinSourceSchema>

export const SkinInfoSchema = z.object({
  accountId: z.string().min(1),
  source: SkinSourceSchema,
  /** CSP-safe PNG data URL; null for the "default" (no local cache) state. */
  dataUrl: z.string().nullable(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  updatedAt: z.number().int().nonnegative().nullable(),
  /** Remote source URL, when imported from a link/skin site (metadata only). */
  remoteUrl: z.string().nullable(),
})
export type SkinInfo = z.infer<typeof SkinInfoSchema>

export const SkinAccountInputSchema = z.object({ accountId: z.string().min(1).max(128) })
export type SkinAccountInput = z.infer<typeof SkinAccountInputSchema>

export const SkinImportFileInputSchema = z.object({
  accountId: z.string().min(1).max(128),
  filePath: z.string().min(1).max(4096),
})
export type SkinImportFileInput = z.infer<typeof SkinImportFileInputSchema>

export const SkinImportUrlInputSchema = z.object({
  accountId: z.string().min(1).max(128),
  url: z.string().url().max(2048),
})
export type SkinImportUrlInput = z.infer<typeof SkinImportUrlInputSchema>

export const contract = defineContract({
  id: 'skin',
  methods: {
    get: { input: SkinAccountInputSchema, output: SkinInfoSchema },
    importFile: { input: SkinImportFileInputSchema, output: SkinInfoSchema },
    importUrl: { input: SkinImportUrlInputSchema, output: SkinInfoSchema },
    /** Imports the current authlib/Microsoft profile skin URL into the local cache. */
    importFromAccount: { input: SkinAccountInputSchema, output: SkinInfoSchema },
    restore: { input: SkinAccountInputSchema, output: SkinInfoSchema },
  },
  events: {},
})

export const skinContract = contract
export type SkinContract = typeof contract
