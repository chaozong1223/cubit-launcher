import { describe, expect, it } from 'vitest'
import { CHANNELS, EVENT_CHANNELS, INVOKE_CHANNELS } from './channels'

describe('IPC channel catalog', () => {
  it('contains no duplicates', () => {
    expect(new Set(INVOKE_CHANNELS).size).toBe(INVOKE_CHANNELS.length)
    expect(new Set(EVENT_CHANNELS).size).toBe(EVENT_CHANNELS.length)
  })

  it('uses the documented prefixes', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(channel.startsWith('mc:') || channel.startsWith('app:')).toBe(true)
    }
  })

  it('exposes the t5 acceptance channel', () => {
    expect(INVOKE_CHANNELS).toContain(CHANNELS.appGetVersion)
    expect(CHANNELS.appGetVersion).toBe('app:getVersion')
  })

  it('does not accidentally expose Node primitives as channels', () => {
    for (const channel of INVOKE_CHANNELS) {
      expect(channel).not.toContain('fs:')
      expect(channel).not.toContain('child_process')
    }
  })
})
