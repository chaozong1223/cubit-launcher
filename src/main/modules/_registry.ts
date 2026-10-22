/// <reference types="vite/client" />
import type { Logger, ScopedLogger } from '../kernel/logger'

export interface ModuleContext {
  /** Scoped logger so every line identifies the module. */
  log: ScopedLogger
  dataRoot: string
}

export interface ModuleDefinition {
  moduleId: string
  register(ctx: ModuleContext): Promise<void> | void
}

interface RegistryResult {
  ids: string[]
  failed: string[]
}

/**
 * Filesystem-as-registry: every `src/main/modules/<id>/index.ts` exporting
 * `moduleId` + `register` is discovered at build time. No central switch.
 *
 * Modules that own their IPC surface (catalog, assets, perf, ...) call
 * `moduleIpc.handle()` inside `register()`; the kernel auto-registration pass
 * skips any module that already registered and falls back to the frozen
 * `BUILTIN_CONTRACTS` map otherwise.
 */
const discovered = import.meta.glob<ModuleDefinition>('./*/index.ts', { eager: true })

export async function registerModules(
  logger: Logger,
  dataRoot: string,
): Promise<RegistryResult> {
  const ids: string[] = []
  const failed: string[] = []

  const entries = Object.entries(discovered).sort(([a], [b]) => a.localeCompare(b))
  for (const [file, definition] of entries) {
    const id = definition?.moduleId
    if (!id) {
      logger.error('module', 'module has no moduleId', { file })
      failed.push(file)
      continue
    }
    try {
      await definition.register({ log: logger.child(`module:${id}`), dataRoot })
      ids.push(id)
      logger.info('module', 'module registered', { moduleId: id })
    } catch (error) {
      failed.push(id)
      logger.error('module', 'module registration failed', {
        moduleId: id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { ids, failed }
}
