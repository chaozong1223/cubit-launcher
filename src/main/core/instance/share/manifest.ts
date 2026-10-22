import path from 'node:path'
import { z } from 'zod'
import { AppError } from '@shared/errors'
import {
  LoaderSchema,
  ShareContentSelectionSchema,
  ShareRedactionSchema,
  type ShareContentSelection,
  type ShareRedaction,
} from '@shared/instance'
import type { ZipArchive } from '../../zip/reader'

/**
 * `manifest.json` inside a `.cubitpack` share archive.
 *
 * The manifest is the only trusted description of the pack: settings and game
 * files are validated on import, but the pack identity/requirements come from
 * here so a malformed archive fails before anything is written.
 */

export const SHARE_PACK_EXTENSION = '.cubitpack'
export const SHARE_PACK_KIND = 'cubit-launcher-share'
export const SHARE_MANIFEST_ENTRY = 'manifest.json'
export const SHARE_MANIFEST_SCHEMA_VERSION = 1

export interface ShareTransferProgress {
  phase: 'scan' | 'write' | 'import' | 'commit' | 'done'
  files: number
  totalFiles: number
  bytes: number
  totalBytes: number
  currentFile: string | null
}

export function abortIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AppError('INSTANCE.SHARE_CANCELLED', '分享包任务已取消')
  }
}

/** Yield to the event loop so IPC/UIs stay responsive during large packs. */
export function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

export const SHARE_SECTION_FOLDERS = {
  mods: ['mods'],
  config: ['config', 'defaultconfigs'],
  resourcepacks: ['resourcepacks'],
  shaderpacks: ['shaderpacks'],
  saves: ['saves'],
  options: [],
} as const satisfies Record<keyof ShareContentSelection, readonly string[]>

export const DEFAULT_SHARE_CONTENT: ShareContentSelection = {
  mods: true,
  config: true,
  resourcepacks: true,
  shaderpacks: true,
  saves: false,
  options: true,
}

export const ShareManifestSchema = z.object({
  schemaVersion: z.literal(SHARE_MANIFEST_SCHEMA_VERSION),
  kind: z.literal(SHARE_PACK_KIND),
  createdAt: z.number().int().nonnegative(),
  name: z.string().min(1).max(64),
  mcVersion: z.string().nullable(),
  loader: LoaderSchema,
  isolation: z.literal('isolated'),
  selection: ShareContentSelectionSchema,
  counts: z.object({
    files: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    mods: z.number().int().nonnegative(),
    config: z.number().int().nonnegative(),
    resourcepacks: z.number().int().nonnegative(),
    shaderpacks: z.number().int().nonnegative(),
    saves: z.number().int().nonnegative(),
    options: z.number().int().nonnegative(),
  }),
  redactions: z.array(ShareRedactionSchema),
  warnings: z.array(z.string()),
  /** Archive-relative icon path under `instance/`, e.g. `icon.png`. */
  icon: z.string().nullable(),
})
export type ShareManifest = z.infer<typeof ShareManifestSchema>

export function normalizeShareSelection(
  include?: Partial<ShareContentSelection>,
): ShareContentSelection {
  return {
    mods: include?.mods ?? DEFAULT_SHARE_CONTENT.mods,
    config: include?.config ?? DEFAULT_SHARE_CONTENT.config,
    resourcepacks: include?.resourcepacks ?? DEFAULT_SHARE_CONTENT.resourcepacks,
    shaderpacks: include?.shaderpacks ?? DEFAULT_SHARE_CONTENT.shaderpacks,
    saves: include?.saves ?? DEFAULT_SHARE_CONTENT.saves,
    options: include?.options ?? DEFAULT_SHARE_CONTENT.options,
  }
}

export function readShareManifest(archive: ZipArchive): ShareManifest {
  if (!archive.has(SHARE_MANIFEST_ENTRY)) {
    throw new AppError('INSTANCE.SHARE_INVALID', '这不是 Cubit 分享包（缺少 manifest.json）')
  }
  const data = archive.read(SHARE_MANIFEST_ENTRY)
  if (data.length > 1024 * 1024) {
    throw new AppError('INSTANCE.SHARE_INVALID', '分享包 manifest.json 过大')
  }
  let raw: unknown
  try {
    raw = JSON.parse(data.toString('utf8'))
  } catch {
    throw new AppError('INSTANCE.SHARE_INVALID', '分享包 manifest.json 不是有效 JSON')
  }
  const parsed = ShareManifestSchema.safeParse(raw)
  if (!parsed.success) {
    const fields = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}`)
      .join(', ')
    throw new AppError('INSTANCE.SHARE_INVALID', `分享包 manifest.json 不完整（${fields}）`)
  }
  if (parsed.data.kind !== SHARE_PACK_KIND) {
    throw new AppError('INSTANCE.SHARE_INVALID', '分享包类型不匹配')
  }
  return parsed.data
}

/** `Foo.cubitpack` -> `Foo`; used only for diagnostics, not for directory names. */
export function sharePackDisplayName(filePath: string): string {
  const base = path.basename(filePath)
  return base.toLowerCase().endsWith(SHARE_PACK_EXTENSION)
    ? base.slice(0, -SHARE_PACK_EXTENSION.length)
    : base
}

export function countRedactions(redactions: ShareRedaction[]): {
  redacted: number
  skipped: number
} {
  let redacted = 0
  let skipped = 0
  for (const record of redactions) {
    if (record.action === 'skipped') skipped += 1
    else redacted += 1
  }
  return { redacted, skipped }
}
