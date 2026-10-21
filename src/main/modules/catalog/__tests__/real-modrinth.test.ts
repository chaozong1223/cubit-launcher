import { describe, expect, it } from 'vitest'
import { ModrinthClient } from '../core/modrinth'

/**
 * Opt-in evidence against the real Modrinth API (no artifact download):
 *   MCL_REAL_MODRINTH=1 npm.cmd --prefix mc-launcher run test -- src/main/modules/catalog/__tests__/real-modrinth.test.ts
 */

const enabled = process.env.MCL_REAL_MODRINTH === '1'

describe.skipIf(!enabled)('real Modrinth catalog (2026-10-21)', () => {
  it('searches sodium and loads its project/version metadata', async () => {
    const client = new ModrinthClient({ minIntervalMs: 0 })
    const search = await client.search({
      query: 'sodium',
      loaders: ['fabric'],
      gameVersion: '1.20.1',
      projectType: 'mod',
      limit: 1,
      offset: 0,
    })
    expect(search.total).toBeGreaterThan(0)
    expect(search.hits[0]?.slug).toBe('sodium')
    expect(search.hits[0]?.pageUrl).toContain('modrinth.com/mod/')

    const project = await client.project('sodium')
    expect(project.id.length).toBeGreaterThan(0)
    expect(project.title.toLowerCase()).toContain('sodium')

    const versions = await client.versions({
      projectId: project.id,
      gameVersion: '1.20.1',
      loader: 'fabric',
    })
    expect(versions.length).toBeGreaterThan(0)
    expect(versions[0]?.files[0]?.sha512).toMatch(/^[a-f0-9]{128}$/)
    expect(versions[0]?.gameVersions).toContain('1.20.1')
  }, 60_000)
})
