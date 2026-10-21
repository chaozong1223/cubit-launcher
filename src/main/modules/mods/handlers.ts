import type { ModsModuleService } from './service'

/** Contract methods → service. Kernel validates inputs/outputs and wraps Result. */
export function makeHandlers(service: ModsModuleService) {
  return {
    scan: (input: { instanceId: string; kind?: 'mods' | 'resourcepacks' | 'shaderpacks' }) =>
      service.scan(input),
    setEnabled: (input: {
      instanceId: string
      kind: 'mods' | 'resourcepacks' | 'shaderpacks'
      names: string[]
      enabled: boolean
    }) => service.setEnabled(input),
    remove: (input: {
      instanceId: string
      kind: 'mods' | 'resourcepacks' | 'shaderpacks'
      names: string[]
    }) => service.remove(input),
    installLocalFile: (input: {
      instanceId: string
      path: string
      kind?: 'mods' | 'resourcepacks' | 'shaderpacks'
    }) => service.installLocalFile(input),
    analyzeDependencies: (input: { instanceId: string }) => service.analyzeDependencies(input),
    importModpack: (input: { filePath: string; name?: string }) => service.importModpack(input),
    exportModpack: (input: { instanceId: string; outPath?: string }) =>
      service.exportModpack(input),
    openFolder: (input: {
      instanceId: string
      kind: 'mods' | 'resourcepacks' | 'shaderpacks'
    }) => service.openFolder(input),
  }
}

export type ModsHandlers = ReturnType<typeof makeHandlers>
