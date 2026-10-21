import type { LoaderType } from '@shared/loader'
import type { LoaderService } from './service'

/** Contract methods → service (constructed at register time so drift fails at boot). */
export function makeHandlers(service: LoaderService) {
  return {
    list: async (input: { type: LoaderType; mcVersion: string; force: boolean }) =>
      service.list(input),
    plan: async (input: { type: LoaderType; mcVersion: string; loaderVersion?: string }) =>
      service.plan(input),
    install: async (input: {
      type: LoaderType
      mcVersion: string
      loaderVersion?: string
      javaPath?: string
      confirmSha1?: string | null
      allowUnverifiedInstaller: boolean
    }) => service.install(input),
    cancel: async (input: { jobId: string }) => service.cancel(input.jobId),
    status: async (input: { jobId: string }) => service.status(input.jobId),
    listJobs: async () => service.listJobs(),
    verify: async (input: { versionId: string }) => service.verify(input),
    dryRun: async (input: { versionId: string; javaPath?: string }) => service.dryRun(input),
  }
}

export type LoaderHandlers = ReturnType<typeof makeHandlers>
