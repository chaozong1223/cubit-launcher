import type { FlattenResult, VersionInspection, VersionSummary } from '@shared/version'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { requireMcRoot } from '../_context'
import { nodeFsPort } from '../../core/ports'
import { flattenVersionFile, inspectVersion } from '../../core/version/inspect'
import { scanVersionDirs } from '../../core/version/scan'

/** Adapter: contract-shaped reads/writes over the pure version kernel. */
export class VersionModuleService {
  private readonly fs = nodeFsPort()

  constructor(
    private readonly roots: ModuleRoots,
    private readonly log: ScopedLogger,
  ) {}

  private root(override?: string): string {
    return override && override.trim().length > 0 ? override : requireMcRoot(this.roots)
  }

  async listVersions(mcRoot?: string): Promise<VersionSummary[]> {
    const root = this.root(mcRoot)
    return scanVersionDirs(this.fs, root).map((entry) => ({
      id: entry.id,
      dirName: entry.dirName,
      state: entry.state,
      reason: entry.reason,
      type: entry.type,
      mainClass: entry.mainClass,
      mcVersion: entry.mcVersion,
      loader: entry.loader,
      javaMajor: entry.javaMajor,
      chain: entry.chain,
      clientJar: entry.clientJar,
      clientJarExists: entry.clientJarExists,
      flattened: entry.flattened,
    }))
  }

  async inspect(versionId: string): Promise<VersionInspection> {
    const root = this.root()
    const inspection = inspectVersion(this.fs, root, versionId)
    this.log.info('version inspected', {
      versionId: inspection.id,
      chain: inspection.chain,
      libs: inspection.libraries,
    })
    return inspection
  }

  async flatten(input: {
    versionId: string
    write?: boolean
    includeJson?: boolean
  }): Promise<FlattenResult> {
    const root = this.root()
    const result = flattenVersionFile(this.fs, root, input.versionId, {
      write: Boolean(input.write),
    })
    this.log.info('version flattened', {
      versionId: result.id,
      chain: result.chain,
      written: result.written,
    })
    return {
      id: result.id,
      chain: result.chain,
      written: result.written,
      file: result.file,
      ...(input.includeJson ? { json: result.json } : {}),
    }
  }
}

export function createVersionService(roots: ModuleRoots, log: ScopedLogger): VersionModuleService {
  return new VersionModuleService(roots, log)
}
