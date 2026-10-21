import type { RepairScanInput, RepairStartInput } from '@shared/repair'
import type { RepairModuleService } from './service'

/** Contract methods → service (repair self-registers through the t20 bridge). */
export function makeHandlers(service: RepairModuleService) {
  return {
    scan: async (input: RepairScanInput) => service.scan(input),
    repair: async (input: RepairStartInput) => service.repair(input),
    status: async (input: { jobId: string }) => service.status(input.jobId),
    report: async (input: { jobId: string }) => service.report(input.jobId),
    cancel: async (input: { jobId: string }) => service.cancel(input.jobId),
    listJobs: async () => service.listJobs(),
  }
}

export type RepairHandlers = ReturnType<typeof makeHandlers>
