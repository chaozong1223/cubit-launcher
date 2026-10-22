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
    exportSharePackJob: async (input: {
      instanceId: string
      outPath?: string
      include?: Parameters<InstanceModuleService['exportSharePackJob']>[0]['include']
    }) => service.exportSharePackJob(input),
    cancelShareExport: async (input: { jobId: string }) => service.cancelShareExport(input.jobId),
    shareExportStatus: async (input: { jobId: string }) => service.shareExportStatus(input.jobId),
    shareExportResult: async (input: { jobId: string }) => service.shareExportResult(input.jobId),
    importSharePackJob: async (input: {
      filePath: string
      name?: string
      conflict?: Parameters<InstanceModuleService['importSharePackJob']>[0]['conflict']
    }) => service.importSharePackJob(input),
    cancelShareImport: async (input: { jobId: string }) => service.cancelShareImport(input.jobId),
    shareImportStatus: async (input: { jobId: string }) => service.shareImportStatus(input.jobId),
    shareImportResult: async (input: { jobId: string }) => service.shareImportResult(input.jobId),
    discover: async () => service.discover(),
    setGameDir: async (input: { path: string }) => service.setGameDir(input),
    import: async (input: { path: string }) => service.importRoot(input),
  }
}

export type InstanceHandlers = ReturnType<typeof makeHandlers>
