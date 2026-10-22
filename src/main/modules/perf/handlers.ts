import type { PerfApplyInput, PerfCacheCleanInput, PerfRecommendInput } from '@shared/perf'
import type { PerfService } from './service'

export function makeHandlers(service: PerfService) {
  return {
    hardware: async () => service.hardware(),
    recommend: async (input: PerfRecommendInput) => service.recommend(input),
    apply: async (input: PerfApplyInput) => service.apply(input),
    processes: async () => service.processes(),
    scanCache: async () => service.scanCache(),
    cleanCache: async (input: PerfCacheCleanInput) => service.cleanCache(input),
  }
}

export type PerfHandlers = ReturnType<typeof makeHandlers>
