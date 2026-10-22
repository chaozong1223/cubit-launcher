import type {
  CatalogCheckInput,
  CatalogInstallInput,
  CatalogPageInput,
  CatalogSearchInput,
  CatalogVersionsInput,
  CatalogUpdateInput,
  CurseForgeConfigPatch,
  LinkImportInput,
} from '@shared/catalog'
import type { CatalogModuleService } from './service'

/** Contract methods → service (catalog self-registers through moduleIpc). */
export function makeHandlers(service: CatalogModuleService) {
  return {
    search: async (input: CatalogSearchInput) => service.search(input),
    project: async (input: { idOrSlug: string }) => service.project(input),
    versions: async (input: CatalogVersionsInput) => service.versions(input),
    install: async (input: CatalogInstallInput) => service.install(input),
    checkUpdates: async (input: CatalogCheckInput) => service.checkUpdates(input),
    update: async (input: CatalogUpdateInput) => service.update(input),
    pageUrl: async (input: CatalogPageInput) => service.pageUrl(input),
    openPage: async (input: CatalogPageInput) => service.openPage(input),
    getCurseForgeConfig: async () => service.getCurseForgeConfig(),
    updateCurseForgeConfig: async (input: CurseForgeConfigPatch) =>
      service.updateCurseForgeConfig(input),
    planLinkImport: async (input: { link: string }) => service.planLinkImport(input),
    startLinkImport: async (input: LinkImportInput) => service.startLinkImport(input),
    cancelLinkImport: async (input: { jobId: string }) => service.cancelLinkImport(input.jobId),
    linkImportStatus: async (input: { jobId: string }) => service.linkImportStatus(input.jobId),
    linkImportResult: async (input: { jobId: string }) => service.linkImportResult(input.jobId),
  }
}

export type CatalogHandlers = ReturnType<typeof makeHandlers>
