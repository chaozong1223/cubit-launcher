import type { InstanceModuleService } from './service'

export function makeHandlers(service: InstanceModuleService) {
  return {
    list: async () => service.list(),
    get: async (input: { id: string }) => service.get(input.id),
    remove: async (input: { id: string }) => service.removeInstance(input.id),
    removeInstance: async (input: { instanceId: string }) =>
      service.removeInstance(input.instanceId),
    restore: async (input: { trashId: string }) => service.restoreInstance(input.trashId),
    update: async (input: { id: string; patch: Parameters<InstanceModuleService['update']>[1] }) =>
      service.update(input.id, input.patch),
    scan: async (input: { mcRoot?: string }) => service.scan(input),
    create: async (input: {
      dirName: string
      name?: string
      mcVersion: string
      loader: Parameters<InstanceModuleService['create']>[0]['loader']
      isolation: 'shared' | 'isolated'
    }) => service.create(input),
    copyInstance: async (input: { id: string; newName?: string; includeWorlds?: boolean }) =>
      service.copyInstance(input.id, { newName: input.newName, includeWorlds: input.includeWorlds }),
    cancelCopy: async (input: { jobId: string }) => service.cancelCopy(input.jobId),
    pauseCopy: async (input: { jobId: string }) => service.pauseCopy(input.jobId),
    resumeCopy: async (input: { jobId: string }) => service.resumeCopy(input.jobId),
    copyStatus: async (input: { jobId: string }) => service.copyStatus(input.jobId),
    copyResult: async (input: { jobId: string }) => service.copyResult(input.jobId),
    discover: async () => service.discover(),
    setGameDir: async (input: { path: string }) => service.setGameDir(input),
    import: async (input: { path: string }) => service.importRoot(input),
  }
}

export type InstanceHandlers = ReturnType<typeof makeHandlers>
