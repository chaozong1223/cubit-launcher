import type { SdkStartInput } from '@shared/sdk'
import type { SdkService } from './service'

export function makeHandlers(service: SdkService) {
  return {
    list: async () => service.list(),
    start: async (input: SdkStartInput) => service.start(input),
    stop: async (input: { id: string }) => service.stop(input),
    openFolder: async () => service.openFolder(),
  }
}

export type SdkHandlers = ReturnType<typeof makeHandlers>
