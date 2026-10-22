import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readSchematic } from '../schematic'

/**
 * Opt-in check against a *real* third-party .litematic file.
 *
 * The fixture is not committed (`.e2e/` is gitignored) because it is someone
 * else's build. Drop any real `.litematic` at `.e2e/samples/Lite.litematic` to
 * run this test; otherwise it skips and the synthetic fixtures in
 * `schematic.test.ts` remain the coverage.
 *
 * Purpose: the synthetic fixtures are built from `docs/11-schematic-format.md`,
 * so they prove the parser matches the spec but not that the spec matches real
 * files. This test closes that gap.
 */
const FIXTURE = path.join(__dirname, '..', '..', '..', '..', '.e2e', 'samples', 'Lite.litematic')

describe.skipIf(!fs.existsSync(FIXTURE))('real .litematic sample', () => {
  it('parses a third-party litematic without throwing and reports sane metadata', () => {
    const buffer = fs.readFileSync(FIXTURE)
    expect(buffer[0]).toBe(0x1f)
    expect(buffer[1]).toBe(0x8b)

    const parsed = readSchematic(buffer)

    expect(parsed.format).toBe('litematic')
    expect(parsed.size.x).toBeGreaterThan(0)
    expect(parsed.size.y).toBeGreaterThan(0)
    expect(parsed.size.z).toBeGreaterThan(0)
    expect(parsed.regionCount).not.toBeNull()
    expect(parsed.regionCount as number).toBeGreaterThan(0)
    expect(parsed.regions.length).toBe(parsed.regionCount)
    // Every region must report a positive extent even when Size is negative.
    for (const region of parsed.regions) {
      expect(region.size.x).toBeGreaterThan(0)
      expect(region.size.y).toBeGreaterThan(0)
      expect(region.size.z).toBeGreaterThan(0)
    }
    // Volume must be a positive integer derived from region extents.
    expect(parsed.volume).not.toBeNull()
    expect(parsed.volume as number).toBeGreaterThan(0)
  })
})
