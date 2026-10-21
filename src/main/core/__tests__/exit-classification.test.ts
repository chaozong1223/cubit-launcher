import { describe, expect, it } from 'vitest'
import { classifyExit } from '../launch/process'
import {
  launchStateForClassification,
  reportReadyForClassification,
} from '../launch/orchestrator'

describe('exit classification and launch status', () => {
  it('maps a normal exit code 0 to ended, not crashed', () => {
    expect(classifyExit(0, null, true, 10_000, false)).toBe('normal')
    expect(launchStateForClassification('normal')).toBe('exited')
    expect(reportReadyForClassification('normal')).toBe(false)
  })

  it('maps non-zero exit and abnormal signals to crashed', () => {
    expect(classifyExit(1, null, true, 10_000, false)).toBe('crashed')
    expect(classifyExit(0, 'SIGSEGV', true, 10_000, false)).toBe('crashed')
    expect(launchStateForClassification('crashed')).toBe('crashed')
    expect(reportReadyForClassification('crashed')).toBe(true)
  })

  it('maps a launcher-requested kill to killed and ended status', () => {
    expect(classifyExit(0, null, true, 10_000, true)).toBe('killed')
    expect(classifyExit(1, 'SIGTERM', true, 10_000, true)).toBe('killed')
    expect(launchStateForClassification('killed')).toBe('exited')
    expect(reportReadyForClassification('killed')).toBe(false)
  })

  it('keeps a fast exit-0 anomaly out of the crash panel', () => {
    expect(classifyExit(0, null, false, 1_000, false)).toBe('suspect')
    expect(launchStateForClassification('suspect')).toBe('exited')
    expect(reportReadyForClassification('suspect')).toBe(false)
  })
})
