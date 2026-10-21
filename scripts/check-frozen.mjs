import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = path.join(root, 'arch', 'frozen.manifest.json')
const writeMode = process.argv.includes('--write')

/**
 * Files that downstream tasks must not edit without an architecture decision.
 * Renderer UI files are intentionally excluded: t10 owns that layer.
 */
const FROZEN = [
  'package.json',
  'package-lock.json',
  'electron.vite.config.ts',
  'tsconfig.json',
  'tsconfig.node.json',
  'tsconfig.web.json',
  'src/main/index.ts',
  'src/main/kernel/config.ts',
  'src/main/kernel/ipc.ts',
  'src/main/kernel/logger.ts',
  'src/main/kernel/paths.ts',
  'src/main/kernel/security.ts',
  'src/main/modules/_registry.ts',
  'src/preload/index.ts',
  'src/shared/bridge.ts',
  'src/shared/channels.ts',
  'src/shared/errors.ts',
  'src/shared/kernel.ts',
  'src/shared/system.ts',
]

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function buildManifest() {
  const files = {}
  for (const relative of FROZEN) {
    const absolute = path.join(root, relative)
    if (!fs.existsSync(absolute)) {
      throw new Error(`frozen file missing: ${relative}`)
    }
    files[relative] = sha256(absolute)
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    files,
  }
}

if (writeMode || !fs.existsSync(manifestPath)) {
  const manifest = buildManifest()
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(`frozen manifest written: ${path.relative(root, manifestPath)} (${FROZEN.length} files)`)
} else {
  const expected = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const actual = buildManifest()
  const failures = []
  for (const relative of FROZEN) {
    if (!(relative in expected.files)) {
      failures.push(`${relative}: not listed in manifest`)
      continue
    }
    if (expected.files[relative] !== actual.files[relative]) {
      failures.push(`${relative}: hash mismatch`)
    }
  }
  if (failures.length > 0) {
    console.error('Frozen file guard failed:')
    for (const item of failures) console.error(`  - ${item}`)
    console.error('If the change is intentional, run: node scripts/check-frozen.mjs --write')
    process.exit(1)
  }
  console.log(`Frozen guard passed (${FROZEN.length} files).`)
}
