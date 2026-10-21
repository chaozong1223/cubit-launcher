import { loadConfig } from '../kernel/config'
import { resolveMcRoot } from '../kernel/paths'

export interface ModuleRoots {
  dataRoot: string
  mcRoot: string | null
}

/**
 * The t5 scaffold's ModuleContext exposes only `log` + `dataRoot`, while the
 * architecture context also carries `paths`. Until the kernel grows that field,
 * adapters resolve the two roots here (same rules as the boot sequence, docs/03
 * §7.3/§7.4). Reading config is side-effect free when the file is valid.
 */
export function resolveModuleRoots(dataRoot: string): ModuleRoots {
  const loaded = loadConfig(dataRoot)
  const mcRoot = resolveMcRoot(
    { argv: process.argv, env: process.env, cwd: process.cwd() },
    loaded.config.paths.minecraftRoot,
  )
  return { dataRoot, mcRoot }
}

export function requireMcRoot(roots: ModuleRoots): string {
  if (!roots.mcRoot) {
    throw new Error('Minecraft directory is not configured; start with --mc-dir')
  }
  return roots.mcRoot
}
