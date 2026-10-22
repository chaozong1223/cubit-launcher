import type { DownloadSettingsPatch, DownloadTask } from '@shared/download'
import type { DownloadService } from './service'

/**
 * Contract method names → service calls (docs/03 §12.4).
 *
 * Kept separate from `ipc.ts` so the Electron-free registration test can assert
 * that every contract method has a handler (a missing method fails at boot, not
 * when a user clicks it).
 */
export function makeHandlers(service: DownloadService) {
  return {
    downloadCustomFile: async (input: { url: string; saveDir: string; fileName?: string }) =>
      service.downloadCustomFile(input),
    listSources: async () => service.listSources(),
    getSettings: async () => service.getSettings(),
    updateSettings: async (input: DownloadSettingsPatch) => service.updateSettings(input),
    fetchManifest: async (input: { force: boolean }) => service.fetchManifest(input),
    plan: async (input: { versionId: string; verifyExisting: boolean }) =>
      service.plan({
        versionId: input.versionId,
        verifyExisting: input.verifyExisting,
      }),
    install: async (input: { versionId: string; verifyExisting: 'size' | 'hash' }) =>
      service.install(input),
    repair: async (input: { versionId: string; verifyExisting: 'size' | 'hash' }) =>
      service.repair(input),
    enqueue: async (input: { tasks: DownloadTask[] }) => service.enqueue(input.tasks),
    cancel: async (input: { jobId: string }) => service.cancel(input.jobId),
    pause: async (input: { jobId: string }) => service.pause(input.jobId),
    resume: async (input: { jobId: string }) => service.resume(input.jobId),
    list: async () => service.list(),
    status: async (input: { jobId: string }) => service.status(input.jobId),
    listProviders: async () => service.listProviders(),
    projectPage: async (input: { provider: 'modrinth' | 'curseforge'; project: string }) =>
      service.projectPage(input),
  }
}

export type DownloadHandlers = ReturnType<typeof makeHandlers>
