import type { LaunchModuleService } from './service'

export function makeHandlers(service: LaunchModuleService) {
  return {
    plan: async (input: {
      instanceId: string
      accountId: string | null
      server: { host: string; port: number } | null
      dryRun?: boolean
    }) => service.plan(input),
    start: async (input: {
      instanceId: string
      accountId: string | null
      server: { host: string; port: number } | null
    }) => service.start(input),
    stop: async (input: { sessionId: string }) => service.stop(input.sessionId),
    status: async (input: { instanceId: string }) => service.status(input.instanceId),
    lastReport: async (input: { instanceId: string }) => service.lastReport(input.instanceId),
  }
}

export type LaunchHandlers = ReturnType<typeof makeHandlers>
