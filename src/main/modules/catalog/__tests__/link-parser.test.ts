import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import { parsePackLink } from '../core/link'

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

describe('parsePackLink', () => {
  it('parses Modrinth canonical and legacy modpack URLs', () => {
    expect(parsePackLink('https://modrinth.com/modpack/fabulously-optimized')).toMatchObject({
      provider: 'modrinth',
      slug: 'fabulously-optimized',
      versionId: null,
      fileId: null,
      legacy: false,
      pageUrl: 'https://modrinth.com/modpack/fabulously-optimized',
    })
    expect(
      parsePackLink('https://modrinth.com/modpack/fabulously-optimized/version/abc123'),
    ).toMatchObject({ provider: 'modrinth', versionId: 'abc123', legacy: false })
    expect(parsePackLink('https://www.modrinth.com/modpacks/foo')).toMatchObject({
      provider: 'modrinth',
      slug: 'foo',
      legacy: true,
    })
    // No scheme, query string and trailing slash are tolerated.
    expect(parsePackLink('modrinth.com/modpack/foo/?tab=versions')).toMatchObject({
      provider: 'modrinth',
      slug: 'foo',
    })
  })

  it('parses CurseForge canonical URLs and pinned files', () => {
    expect(
      parsePackLink('https://www.curseforge.com/minecraft/modpacks/all-the-mods-9'),
    ).toMatchObject({
      provider: 'curseforge',
      slug: 'all-the-mods-9',
      fileId: null,
      legacy: false,
      pageUrl: 'https://www.curseforge.com/minecraft/modpacks/all-the-mods-9',
    })
    expect(
      parsePackLink('https://curseforge.com/minecraft/modpacks/atm9/files/5123456'),
    ).toMatchObject({ provider: 'curseforge', slug: 'atm9', fileId: 5123456 })
    expect(
      parsePackLink('https://legacy.curseforge.com/minecraft/modpacks/atm9'),
    ).toMatchObject({ provider: 'curseforge', legacy: true })
  })

  it('parses legacy minecraft.curseforge.com/projects URLs', () => {
    expect(
      parsePackLink('https://minecraft.curseforge.com/projects/atm9/files/42'),
    ).toMatchObject({ provider: 'curseforge', slug: 'atm9', fileId: 42, legacy: true })
    expect(parsePackLink('minecraft.curseforge.com/projects/atm9')).toMatchObject({
      provider: 'curseforge',
      slug: 'atm9',
    })
  })

  it('rejects non-modpack and unsupported links with readable codes', () => {
    expectCode(() => parsePackLink(''), 'CATALOG.LINK_INVALID')
    expectCode(() => parsePackLink('not a url at all'), 'CATALOG.LINK_INVALID')
    expectCode(() => parsePackLink('https://example.com/modpack/x'), 'CATALOG.LINK_UNSUPPORTED')
    expectCode(() => parsePackLink('https://modrinth.com/mod/sodium'), 'CATALOG.LINK_UNSUPPORTED')
    expectCode(
      () => parsePackLink('https://www.curseforge.com/minecraft/mc-mods/jei'),
      'CATALOG.LINK_UNSUPPORTED',
    )
    expectCode(
      () => parsePackLink('https://modrinth.com/modpack/foo/version/'),
      'CATALOG.LINK_UNSUPPORTED',
    )
    expectCode(
      () => parsePackLink('https://www.curseforge.com/minecraft/modpacks/atm9/files/abc'),
      'CATALOG.LINK_INVALID',
    )
    expectCode(() => parsePackLink('ftp://modrinth.com/modpack/foo'), 'CATALOG.LINK_INVALID')
  })
})
