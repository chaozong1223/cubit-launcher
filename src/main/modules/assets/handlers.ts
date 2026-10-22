import type {
  AssetArea,
  LogLevel,
  SaveConflictStrategy,
  SchematicConflictStrategy,
} from '@shared/assets'
import type { AssetsModuleService } from './service'

export function makeHandlers(service: AssetsModuleService) {
  return {
    listSaves: (input: { instanceId: string }) => service.listSaves(input),
    backupSave: (input: { instanceId: string; name: string; outPath?: string }) =>
      service.backupSave(input),
    deleteSaves: (input: { instanceId: string; names: string[] }) => service.deleteSaves(input),
    copySaveJob: (input: {
      instanceId: string
      name: string
      targetInstanceId: string
      targetName?: string
      conflict?: SaveConflictStrategy
    }) => service.copySaveJob(input),
    cancelCopySave: (input: { jobId: string }) => service.cancelCopySave(input.jobId),
    copySaveStatus: (input: { jobId: string }) => service.copySaveStatus(input.jobId),
    copySaveResult: (input: { jobId: string }) => service.copySaveResult(input.jobId),
    listSchematics: (input: { instanceId: string }) => service.listSchematics(input),
    importSchematic: (input: {
      instanceId: string
      filePath: string
      targetName?: string
    }) => service.importSchematic(input),
    deleteSchematics: (input: { instanceId: string; names: string[] }) =>
      service.deleteSchematics(input),
    copySchematic: (input: {
      instanceId: string
      name: string
      targetInstanceId: string
      mode?: 'copy' | 'move'
      targetName?: string
      conflict?: SchematicConflictStrategy
    }) => service.copySchematic(input),
    listScreenshots: (input: { instanceId: string }) => service.listScreenshots(input),
    previewScreenshot: (input: { instanceId: string; name: string }) =>
      service.previewScreenshot(input),
    deleteScreenshots: (input: { instanceId: string; names: string[] }) =>
      service.deleteScreenshots(input),
    listLogs: (input: { instanceId?: string }) => service.listLogs(input),
    queryLogs: (input: {
      instanceId?: string
      level?: LogLevel
      minLevel?: LogLevel
      since?: number
      until?: number
      search?: string
      limit?: number
      offset?: number
    }) => service.queryLogs(input),
    exportLogs: (input: { instanceId?: string; outPath?: string }) => service.exportLogs(input),
    exportDiagnostics: (input: { instanceId?: string; outPath?: string }) =>
      service.exportDiagnostics(input),
    openFolder: (input: { instanceId?: string; area: AssetArea }) => service.openFolder(input),
    showInFolder: (input: {
      instanceId: string
      kind: 'save' | 'screenshot' | 'schematic'
      name: string
    }) => service.showInFolder(input),
    openFile: (input: {
      instanceId: string
      kind: 'save' | 'screenshot' | 'schematic'
      name: string
    }) => service.openFile(input),
    listTrash: () => service.listTrash(),
    restoreTrash: (input: { ids?: string[] }) => service.restoreTrash(input),
    purgeTrash: (input: { ids?: string[] }) => service.purgeTrash(input),
  }
}

export type AssetsHandlers = ReturnType<typeof makeHandlers>
