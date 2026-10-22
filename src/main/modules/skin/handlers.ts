import type {
  SkinAccountInput,
  SkinImportFileInput,
  SkinImportUrlInput,
} from '@shared/skin'
import type { SkinService } from './service'

export function makeHandlers(service: SkinService) {
  return {
    get: async (input: SkinAccountInput) => service.get(input),
    importFile: async (input: SkinImportFileInput) => service.importFile(input),
    importUrl: async (input: SkinImportUrlInput) => service.importUrl(input),
    importFromAccount: async (input: SkinAccountInput) => service.importFromAccount(input),
    restore: async (input: SkinAccountInput) => service.restore(input),
  }
}

export type SkinHandlers = ReturnType<typeof makeHandlers>
