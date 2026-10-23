import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { RestoreResult, TrashItem } from '@shared/assets'
import { AppError } from '@shared/errors'
import type { FsPort } from '../../core/ports'
import { nodeFsPort } from '../../core/ports'

export interface TrashManifest extends TrashItem {
  payloadName: string
  /**
   * Absolute path of the moved directory. Payloads are stored on the SAME
   * volume as the original file (`.mc-launcher-trash/<id>/payload` inside the
   * game root), so the move is a rename: instant, no double disk usage, and an
   * interrupted move cannot leave a half-copied instance behind.
   * Older entries have no such field and fall back to `<dataRoot>/trash/<id>`.
   */
  payloadPath?: string
}

export class TrashStore {
  private readonly fs: FsPort
  private readonly root: string
  private readonly allowedRoots: string[]
  private readonly rawRoots: string[]
  private readonly now: () => number

  constructor(
    dataRoot: string,
    allowedRoots: string[],
    options: { fs?: FsPort; now?: () => number } = {},
  ) {
    this.fs = options.fs ?? nodeFsPort()
    this.root = path.join(dataRoot, 'trash')
    this.now = options.now ?? Date.now
    this.rawRoots = allowedRoots.filter(Boolean).map((entry) => path.resolve(entry))
    this.allowedRoots = allowedRoots
      .filter(Boolean)
      .flatMap((entry) => {
        try {
          return [fs.realpathSync.native(path.resolve(entry)).toLowerCase()]
        } catch {
          return []
        }
      })
  }

  /** Allowed root that contains `target`, in its original (non-lowercased) form. */
  private rootFor(target: string): string | null {
    const resolved = path.resolve(target).toLowerCase()
    const index = this.allowedRoots.findIndex(
      (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
    )
    if (index < 0) return null
    return this.rawRoots[index] ?? null
  }

  private insideAllowed(target: string): boolean {
    const resolved = path.resolve(target).toLowerCase()
    return this.allowedRoots.some(
      (root) => resolved === root || resolved.startsWith(`${root}${path.sep}`),
    )
  }

  private manifestPath(id: string): string {
    return path.join(this.root, id, 'item.json')
  }

  private payloadPath(id: string, payloadName = 'payload'): string {
    return path.join(this.root, id, payloadName)
  }

  private readManifest(id: string): TrashManifest | null {
    try {
      const file = this.manifestPath(id)
      if (!this.fs.exists(file)) return null
      return JSON.parse(this.fs.readText(file)) as TrashManifest
    } catch {
      return null
    }
  }

  /** Where an entry's files actually live (new layout or legacy layout). */
  private resolvePayload(id: string, manifest?: TrashManifest | null): string {
    if (manifest?.payloadPath) return manifest.payloadPath
    return this.payloadPath(id, manifest?.payloadName ?? 'payload')
  }

  /**
   * Destination for a deleted directory: a hidden `.mc-launcher-trash` folder
   * inside the same root as the original, so `rename` works and nothing is
   * copied across volumes. Falls back to the data root when the path is not
   * inside any allowed root (should not happen; validated before the move).
   */
  private payloadTarget(originalPath: string, id: string): string {
    const root = this.rootFor(originalPath)
    if (!root) return this.payloadPath(id)
    return path.join(root, '.mc-launcher-trash', id, 'payload')
  }

  private async move(source: string, target: string): Promise<void> {
    this.fs.mkdirp(path.dirname(target))
    try {
      this.fs.rename(source, target)
      return
    } catch {
      // Trash may live on a different volume from the game directory, which
      // forces a real copy. Async so a multi-GB instance never freezes the app.
    }
    await fs.promises.cp(source, target, { recursive: true, force: true })
    await fs.promises.rm(source, { recursive: true, force: true })
  }

  private async sizeOf(target: string): Promise<number> {
    try {
      const stat = await fs.promises.stat(target)
      if (stat.isFile()) return stat.size
      if (!stat.isDirectory()) return 0
      let total = 0
      for (const entry of await fs.promises.readdir(target, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        total += await this.sizeOf(path.join(target, entry.name))
      }
      return total
    } catch {
      return 0
    }
  }

  async delete(input: {
    kind: TrashItem['kind']
    name: string
    originalPath: string
    instanceId: string | null
  }): Promise<TrashItem> {
    const original = path.resolve(input.originalPath)
    if (!this.insideAllowed(original)) {
      throw new AppError('ASSETS.TRASH_PATH_DENIED', '拒绝将目录外文件移入回收站', {
        details: { path: original },
      })
    }
    if (!this.fs.exists(original)) {
      throw new AppError('ASSETS.FILE_NOT_FOUND', `文件不存在: ${input.name}`, {
        details: { path: original },
      })
    }
    const id = crypto.randomUUID()
    const payloadName = 'payload'
    const itemDir = path.join(this.root, id)
    // Same-volume hidden folder keeps the move a rename (instant, no copy).
    const payload = this.payloadTarget(original, id)
    this.fs.mkdirp(itemDir)
    const manifest: TrashManifest = {
      id,
      kind: input.kind,
      name: input.name,
      originalPath: original,
      instanceId: input.instanceId,
      deletedAt: this.now(),
      size: 0,
      canRestore: true,
      payloadName,
      payloadPath: payload,
    }
    try {
      await this.move(original, payload)
      // Measure after the move: walking a multi-GB tree costs seconds and must
      // not delay the delete itself.
      manifest.size = await this.sizeOf(payload)
      this.fs.writeTextAtomic(this.manifestPath(id), `${JSON.stringify(manifest, null, 2)}\n`)
    } catch (error) {
      try {
        this.fs.remove(itemDir)
      } catch {
        /* keep original error */
      }
      throw error
    }
    const { payloadName: _payloadName, ...item } = manifest
    void _payloadName
    return item
  }

  list(): TrashItem[] {
    const items: TrashItem[] = []
    for (const id of this.fs.readDir(this.root)) {
      const manifestFile = this.manifestPath(id)
      try {
        if (!this.fs.exists(manifestFile)) continue
        const parsed = JSON.parse(this.fs.readText(manifestFile)) as TrashManifest
        if (!parsed || typeof parsed.originalPath !== 'string') continue
        if (!this.insideAllowed(parsed.originalPath)) continue
        if (!this.fs.exists(this.resolvePayload(id, parsed))) continue
        items.push({
          id: parsed.id ?? id,
          kind: parsed.kind ?? 'other',
          name: parsed.name ?? id,
          originalPath: parsed.originalPath,
          instanceId: parsed.instanceId ?? null,
          deletedAt: parsed.deletedAt ?? 0,
          size: parsed.size ?? 0,
          canRestore: !this.fs.exists(parsed.originalPath),
        })
      } catch {
        // A malformed trash entry must not hide the rest.
      }
    }
    return items.sort((left, right) => right.deletedAt - left.deletedAt)
  }

  async restore(ids?: string[]): Promise<RestoreResult> {
    const wanted = ids && ids.length > 0 ? new Set(ids) : null
    const restored: TrashItem[] = []
    const failed: Array<{ id: string; message: string }> = []
    for (const item of this.list()) {
      if (wanted && !wanted.has(item.id)) continue
      const manifestFile = this.manifestPath(item.id)
      const payload = this.resolvePayload(item.id, this.readManifest(item.id))
      if (!this.fs.exists(payload)) {
        failed.push({ id: item.id, message: '回收站内容已丢失' })
        continue
      }
      if (!this.insideAllowed(item.originalPath)) {
        failed.push({ id: item.id, message: '原始路径不在允许目录内' })
        continue
      }
      if (this.fs.exists(item.originalPath)) {
        failed.push({ id: item.id, message: '原位置已有同名文件，未覆盖' })
        continue
      }
      try {
        this.fs.mkdirp(path.dirname(item.originalPath))
        await this.move(payload, item.originalPath)
        this.fs.remove(path.dirname(manifestFile))
        restored.push({ ...item, canRestore: false })
      } catch (error) {
        failed.push({
          id: item.id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { restored, failed }
  }

  /**
   * Permanently delete trash entries (payload + manifest). Irreversible, so the
   * UI must confirm first.
   */
  async purge(ids?: string[]): Promise<{ purged: string[]; failed: Array<{ id: string; message: string }> }> {
    const wanted = ids && ids.length > 0 ? new Set(ids) : null
    const purged: string[] = []
    const failed: Array<{ id: string; message: string }> = []
    for (const item of this.list()) {
      if (wanted && !wanted.has(item.id)) continue
      try {
        const payload = this.resolvePayload(item.id, this.readManifest(item.id))
        // Async remove: a large payload must not block the main process.
        if (this.fs.exists(payload)) await fs.promises.rm(payload, { recursive: true, force: true })
        // Drop the now-empty same-volume container, if that layout was used.
        await fs.promises.rm(path.dirname(payload), { recursive: true, force: true }).catch(() => undefined)
        await fs.promises.rm(path.dirname(this.manifestPath(item.id)), { recursive: true, force: true })
        purged.push(item.id)
      } catch (error) {
        failed.push({ id: item.id, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { purged, failed }
  }
}
