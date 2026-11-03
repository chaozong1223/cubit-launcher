import { describe, expect, it } from 'vitest'
import { buildFocusScript, focusGameWindow } from '../focus'

describe('game window focus helper', () => {
  it('targets the launched pid and calls the user32 APIs', () => {
    const script = buildFocusScript(4321, 10_000, 500)
    expect(script).toContain('$target = 4321')
    expect(script).toContain('GetWindowThreadProcessId')
    expect(script).toContain('SetForegroundWindow')
    expect(script).toContain('BringWindowToTop')
    expect(script).toContain('ShowWindow')
    // Picks the largest window regardless of visibility (a hidden or
    // off-screen window is exactly the case worth repairing) and forces it
    // back onto the screen instead of only raising it.
    expect(script).toContain('FindLargest')
    expect(script).toContain('SetWindowPos')
    expect(script).not.toContain('IsWindowVisible')
    // 10s / 500ms = 20 poll iterations
    expect(script).toContain('$i -lt 20')
  })

  it('scales the poll count with the timeout', () => {
    expect(buildFocusScript(1, 180_000, 500)).toContain('$i -lt 360')
    expect(buildFocusScript(1, 1_000, 500)).toContain('$i -lt 2')
  })

  it('ignores invalid pids instead of spawning powershell', () => {
    // Nothing to observe except "does not throw"; the helper is fire-and-forget.
    expect(() => focusGameWindow(0)).not.toThrow()
    expect(() => focusGameWindow(-5)).not.toThrow()
  })
})
