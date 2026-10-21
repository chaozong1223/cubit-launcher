import type { CrashAnalysis, FixAction, FixResult } from '@shared/crash'
import type { CrashModuleService } from './service'

export function makeHandlers(service: CrashModuleService) {
  return {
    analyze: (input: {
      instanceId?: string
      exitCode?: number | null
      logText?: string
      maxLines?: number
    }) => service.analyze(input),
    applyFix: (input: { instanceId: string; action: FixAction }) => service.applyFix(input),
    exportReport: (input: {
      analysis: CrashAnalysis
      logText?: string
      outPath?: string
    }) => service.exportReport(input),
    format: (input: { analysis: CrashAnalysis }): Promise<{ markdown: string; plain: string }> =>
      Promise.resolve(service.format(input.analysis)),
  }
}

export type CrashHandlers = ReturnType<typeof makeHandlers>
