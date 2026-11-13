import { describe, expect, it } from 'vitest'
import { createRoomIdentity } from '../ticket'
import {
  SHORT_CODE_WORLD_PORT,
  deriveRoomSecret,
  normalizeShortCode,
  shortCodeNetworkName,
} from '../shortcode'

describe('six-character room codes', () => {
  it('accepts the display form, lowercase and stray spaces', () => {
    expect(normalizeShortCode('A3K9QZ')).toBe('A3K9QZ')
    expect(normalizeShortCode('mcl-a3k9qz')).toBe('A3K9QZ')
    expect(normalizeShortCode(' a3k9 qz ')).toBe('A3K9QZ')
  })

  it('rejects wrong lengths and characters Crockford excludes', () => {
    expect(normalizeShortCode('A3K9Q')).toBeNull()
    expect(normalizeShortCode('A3K9QZZ')).toBeNull()
    expect(normalizeShortCode('A3K9QI')).toBeNull()
    expect(normalizeShortCode('A3K9QL')).toBeNull()
    expect(normalizeShortCode('A3K9QO')).toBeNull()
    expect(normalizeShortCode('A3K9QU')).toBeNull()
  })

  it('derives a stable 32-byte key from the code alone', () => {
    const a = deriveRoomSecret('A3K9QZ')
    const b = deriveRoomSecret('a3k9qz')
    expect(a).toHaveLength(32)
    expect(a.equals(b)).toBe(true)
    expect(a.equals(deriveRoomSecret('B3K9QZ'))).toBe(false)
  })

  it('uses the network name the host builds', () => {
    expect(shortCodeNetworkName('A3K9QZ')).toBe('mcl-a3k9qz')
  })

  it('keeps the agreed Minecraft port', () => {
    expect(SHORT_CODE_WORLD_PORT).toBe(25565)
  })

  it('gives the host the same secret a member derives from the code', () => {
    const identity = createRoomIdentity({
      hostName: 'host',
      mcVersion: '1.20.1',
      loader: 'forge',
      maxMembers: 4,
    })
    const derived = deriveRoomSecret(identity.code)
    expect(identity.netSecret.equals(derived)).toBe(true)
  })
})
