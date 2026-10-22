// electron-builder recreates release/win-unpacked from scratch, which deletes
// the portable data directory living next to the executable (accounts, config,
// logs, downloaded runtimes). This wrapper stashes it before packaging and puts
// it back afterwards so `npm run pack` is safe for local testing.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const unpacked = path.join(root, 'release', 'win-unpacked')
const dataDir = path.join(unpacked, 'data')
const stash = path.join(root, 'release', '.data-stash')

function move(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.renameSync(source, target)
  } catch {
    // Different volume or locked file: fall back to a recursive copy.
    fs.cpSync(source, target, { recursive: true })
    fs.rmSync(source, { recursive: true, force: true })
  }
}

const hadData = fs.existsSync(dataDir)
if (hadData) {
  fs.rmSync(stash, { recursive: true, force: true })
  move(dataDir, stash)
  console.log(`[pack] stashed portable data (${path.relative(root, stash)})`)
}

let failed = null
try {
  execSync('npx electron-vite build && npx electron-builder --dir --win', {
    cwd: root,
    stdio: 'inherit',
  })
} catch (error) {
  failed = error
} finally {
  if (hadData && fs.existsSync(stash)) {
    fs.mkdirSync(unpacked, { recursive: true })
    fs.rmSync(dataDir, { recursive: true, force: true })
    move(stash, dataDir)
    console.log('[pack] restored portable data')
  }
}

if (failed) {
  console.error('[pack] build failed; data was restored')
  process.exit(1)
}
