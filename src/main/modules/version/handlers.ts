import type { VersionModuleService } from './service'

/**
 * Contract methods → service. The kernel IPC layer (frozen in t5) does not yet
 * accept module contracts; keeping this map ready means wiring is one loop and
 * the signatures stay checked by the compiler.
 */
export function makeHandlers(service: VersionModuleService) {
  return {
    listVersions: async (input: { mcRoot?: string }) => service.listVersions(input.mcRoot),
    inspect: async (input: { versionId: string }) => service.inspect(input.versionId),
    flatten: async (input: { versionId: string; write?: boolean; includeJson?: boolean }) =>
      service.flatten(input),
  }
}

export type VersionHandlers = ReturnType<typeof makeHandlers>
