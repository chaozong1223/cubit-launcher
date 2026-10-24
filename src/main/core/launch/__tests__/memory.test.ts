import { describe, expect, it } from 'vitest'
import { autoMaxMemoryMb } from '../settings'

const GB = 1024 * 1024 * 1024

describe('autoMaxMemoryMb', () => {
  it('scales with the mod count on a big machine', () => {
    // 32 GB host, 233-mod 1.12.2 pack: the old 25% rule gave 8 GB and stalled.
    expect(autoMaxMemoryMb(32 * GB, 233)).toBe(11368)
  })

  it('stays below 70% of physical memory', () => {
    expect(autoMaxMemoryMb(8 * GB, 400)).toBe(Math.round(8 * 1024 * 0.7))
  })

  it('falls back to the quarter rule without a mod count', () => {
    expect(autoMaxMemoryMb(32 * GB)).toBe(8192)
    expect(autoMaxMemoryMb(16 * GB)).toBe(4096)
  })

  it('never goes below 4 GB on a normal machine', () => {
    expect(autoMaxMemoryMb(16 * GB, 1)).toBe(4096)
  })

  it('respects a machine too small for the 4 GB floor', () => {
    // 2 GB host: 70% is ~1434 MiB, and going above that would starve Windows.
    expect(autoMaxMemoryMb(2 * GB)).toBe(Math.round(2048 * 0.7))
  })
})
