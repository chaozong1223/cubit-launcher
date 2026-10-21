import type { JavaProviderId, JavaSettingsPatch } from '@shared/java'
import type { JavaModuleService } from './service'

/** Contract methods → service (java is auto-wired by the t20 kernel bridge). */
export function makeHandlers(service: JavaModuleService) {
  return {
    detect: async (input: { force: boolean }) => service.detect(input),
    candidates: async () => service.candidates(),
    choose: async (input: {
      requiredMajor?: number | null
      forcedPath?: string | null
      forcedMajor?: number | null
    }) => service.choose(input),
    requirement: async (input: { versionId: string }) => service.requirement(input),
    match: async (input: { versionId: string }) => service.match(input),
    settings: async () => service.settings(),
    updateSettings: async (input: JavaSettingsPatch) => service.updateSettings(input),
    providers: async () => service.providers(),
    managed: async () => service.managed(),
    download: async (input: {
      major: number
      source: 'auto' | JavaProviderId
      force: boolean
    }) => service.download(input),
    downloadStatus: async (input: { jobId: string }) => service.downloadStatus(input.jobId),
    cancelDownload: async (input: { jobId: string }) => service.cancelDownload(input.jobId),
  }
}

export type JavaHandlers = ReturnType<typeof makeHandlers>
