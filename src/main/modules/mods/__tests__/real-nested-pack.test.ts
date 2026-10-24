import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { nodeFsPort } from '../../../core/ports'
import { openPackArchive } from '../modpack'

/**
 * Opt-in evidence with a real launcher-installer pack
 * (`MCL_REAL_NESTED_PACK=<path to the outer .zip>`).
 *
 * The unit tests build a tiny wrapper; this one unwraps a ~600 MB archive that
 * actually ships next to a launcher exe, which is the only way to know the
 * memory/time envelope and that the shipped pack parses.
 */

const packPath = process.env.MCL_REAL_NESTED_PACK
const runnable = Boolean(packPath && fs.existsSync(packPath))
const describeReal = runnable ? describe : describe.skip

const tempDirs: string[] = []
afterAll(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describeReal('real launcher-installer pack (opt-in: MCL_REAL_NESTED_PACK)', () => {
  it(
    'unwraps and reads the inner manifest',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-real-nested-'))
      tempDirs.push(dir)
      const started = Date.now()
      const opened = openPackArchive(nodeFsPort(), packPath as string, dir, 'real')

      console.log('[real-nested] nested entry:', opened.nested?.entry)
      console.log(
        '[real-nested] manifest:',
        JSON.stringify({
          format: opened.manifest.format,
          name: opened.manifest.name,
          mcVersion: opened.manifest.mcVersion,
          loader: opened.manifest.loader,
        }),
      )
      console.log(`[real-nested] took ${Date.now() - started}ms`)

      expect(opened.nested?.entry.toLowerCase().endsWith('.mrpack')).toBe(true)
      expect(opened.manifest.format).toBe('modrinth')
      expect(opened.manifest.mcVersion).toBeTruthy()
      expect(opened.archive.has('modrinth.index.json')).toBe(true)

      // The caller owns the temp file; drop it here too so the test leaves
      // nothing behind on a 600 MB unpack.
      if (opened.nested) fs.rmSync(opened.nested.tempFile, { force: true })
    },
    240_000,
  )
})
