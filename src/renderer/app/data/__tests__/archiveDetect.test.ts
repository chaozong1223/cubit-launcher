import { describe, expect, it } from 'vitest'
import { detectArchive } from '../archiveDetect'

/**
 * Renderer-side tests must not import `src/main` (the web tsconfig has no Node
 * types and would fail), so this builds the smallest stored ZIP the sniffer can
 * read: local headers + central directory + EOCD, no compression, CRC left at 0
 * because `detectArchive` only walks the central directory.
 */
function u16(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff]
}
function u32(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff]
}

function storedZip(entries: Array<{ name: string; data: string | Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder()
  const locals: number[] = []
  const centrals: number[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data
    const localStart = offset
    const local = [
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
      ...Array.from(name), ...Array.from(data),
    ]
    locals.push(...local)
    offset += local.length
    centrals.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
      ...u32(0), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0),
      ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(localStart), ...Array.from(name),
    )
  }
  const centralOffset = offset
  const out = [...locals, ...centrals]
  out.push(
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(centrals.length), ...u32(centralOffset), ...u16(0),
  )
  return new Uint8Array(out)
}

function mrpackBytes(name = '超限征伐'): Uint8Array {
  return storedZip([
    {
      name: 'modrinth.index.json',
      data: JSON.stringify({
        formatVersion: 1,
        game: 'minecraft',
        versionId: '1.0.0',
        name,
        files: [],
        dependencies: { minecraft: '1.20.1', forge: '47.4.23' },
      }),
    },
    { name: 'overrides/config/example.toml', data: 'x = 1\n' },
  ])
}

describe('detectArchive', () => {
  it('recognises a plain Modrinth pack', async () => {
    const detection = await detectArchive(mrpackBytes(), 'pack.mrpack')
    expect(detection.kind).toBe('modpack')
    if (detection.kind !== 'modpack') return
    expect(detection.format).toBe('modrinth')
    expect(detection.gameVersion).toBe('1.20.1')
    expect(detection.nested).toBeUndefined()
  })

  it('recognises a launcher installer and names the inner pack', async () => {
    const outer = storedZip([
      { name: 'modpack.mrpack', data: mrpackBytes() },
      { name: 'Plain Craft Launcher.exe', data: 'MZ fake' },
      { name: 'PCL/Setup.ini', data: '[launcher]' },
    ])
    const detection = await detectArchive(outer, '超限征伐1.1.zip')
    expect(detection.kind).toBe('modpack')
    if (detection.kind !== 'modpack') return
    expect(detection.nested?.entry).toBe('modpack.mrpack')
    expect(detection.gameVersion).toBeNull()
    expect(detection.evidence.join('；')).toContain('启动器安装包')
  })

  it('does not guess when several inner archives are present', async () => {
    const outer = storedZip([
      { name: 'a.mrpack', data: mrpackBytes('A') },
      { name: 'b.zip', data: mrpackBytes('B') },
    ])
    const detection = await detectArchive(outer, 'ambiguous.zip')
    expect(detection.kind).toBe('unknown')
  })

  it('never treats a launcher binary as the inner pack', async () => {
    const outer = storedZip([
      { name: 'modpack.mrpack', data: mrpackBytes() },
      { name: 'evil.bat', data: 'del /f /q C:\\' },
    ])
    const detection = await detectArchive(outer, 'wrapper.zip')
    expect(detection.kind).toBe('modpack')
    if (detection.kind !== 'modpack') return
    expect(detection.nested?.entry).toBe('modpack.mrpack')
    expect(detection.evidence.join('；')).not.toContain('evil.bat')
  })
})
