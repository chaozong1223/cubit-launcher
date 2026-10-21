import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { RestoreResult, TrashItem } from '@shared/assets'
import { AppError } from '@shared/errors'
import type { FsPort } from '../../core/ports'
import { nodeFsPort } from '../../core/ports'

export interface TrashManifest extends TrashItem {
  payloadName: string
}

export class TrashStore {
  private readonly fs: FsPort
  private readonly root: string
  private readonly allowedRoots: string[]
  private readonly now: () => number

  constructor(
    dataRoot: string,
    allowedRoots: string[],
    options: { fs?: FsPort; now?: () => number } = {},
  ) {
    this.fs = options.fs ?? nodeFsPort()
    this.root = path.join(dataRoot, 'trash')
    this.now = options.now ?? Date.now
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

  private move(source: string, target: string): void {
    this.fs.mkdirp(path.dirname(target))
    try {
      this.fs.rename(source, target)
    } catch {
      // Trash may live on a different volume from the game directory.
      fs.cpSync(source, target, { recursive: true, force: true })
      this.fs.remove(source)
    }
  }

  private sizeOf(target: string): number {
    try {
      const stat = fs.statSync(target)
      if (stat.isFile()) return stat.size
      if (!stat.isDirectory()) return 0
      let total = 0
      for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue
        total += this.sizeOf(path.join(target, entry.name))
      }
      return total
    } catch {
      return 0
    }
  }

  delete(input: {
    kind: TrashItem['kind']
    name: string
    originalPath: string
    instanceId: string | null
  }): TrashItem {
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
    const payload = this.payloadPath(id, payloadName)
    const size = this.sizeOf(original)
    this.fs.mkdirp(itemDir)
    const manifest: TrashManifest = {
      id,
      kind: input.kind,
      name: input.name,
      originalPath: original,
      instanceId: input.instanceId,
      deletedAt: this.now(),
      size,
      canRestore: true,
      payloadName,
    }
    try {
      this.move(original, payload)
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
        if (!this.fs.exists(this.payloadPath(id, parsed.payloadName ?? 'payload'))) continue
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

  restore(ids?: string[]): RestoreResult {
    const wanted = ids && ids.length > 0 ? new Set(ids) : null
    const restored: TrashItem[] = []
    const failed: Array<{ id: string; message: string }> = []
    for (const item of this.list()) {
      if (wanted && !wanted.has(item.id)) continue
      const manifestFile = this.manifestPath(item.id)
      const payload = this.payloadPath(item.id)
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
        this.move(payload, item.originalPath)
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
}
