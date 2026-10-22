// electron-builder recreates release/win-unpacked from scratch, which deletes
// the portable data directory living next to the executable (accounts, config,
// logs, downloaded runtimes). This wrapper stashes it before packaging and puts
// it back afterwards so `npm run pack` is safe for local testing.
//
// Safety rules learned the hard way (2026-10-22): a locked data directory must
// abort the run *before* anything is touched, and a stash is only ever removed
// after its replacement has been written and verified.
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const unpacked = path.join(root, 'release', 'win-unpacked')
const dataDir = path.join(unpacked, 'data')
const stash = path.join(root, 'release', '.data-stash')

function countFiles(dir) {
  let total = 0
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const next = path.join(current, entry.name)
      if (entry.isDirectory()) walk(next)
      else total += 1
    }
  }
  walk(dir)
  return total
}

/** True when the app still holds a handle in the data directory. */
function dataDirectoryIsBusy() {
  const probe = `${dataDir}.lock-probe-${process.pid}`
  try {
    fs.renameSync(dataDir, probe)
    fs.renameSync(probe, dataDir)
    return false
  } catch {
    try {
      if (fs.existsSync(probe) && !fs.existsSync(dataDir)) fs.renameSync(probe, dataDir)
    } catch {
      // Nothing else to do; the checks below will fail loudly.
    }
    return true
  }
}

/**
 * Copy first, verify the copy, and only then delete the source. `fs.renameSync`
 * is still attempted first because it is atomic and free on the same volume.
 */
function move(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  try {
    fs.renameSync(source, target)
    return
  } catch {
    // Different volume, or a handle denies the rename: fall back to a copy.
  }
  const sourceFiles = countFiles(source)
  fs.cpSync(source, target, { recursive: true, force: true, errorOnExist: false })
  const targetFiles = countFiles(target)
  if (targetFiles !== sourceFiles) {
    throw new Error(
      `stash copy incomplete (${targetFiles}/${sourceFiles} files); source left untouched`,
    )
  }
  fs.rmSync(source, { recursive: true, force: true })
}

const hadData = fs.existsSync(dataDir)

if (hadData && dataDirectoryIsBusy()) {
  console.error(
    '[pack] release/win-unpacked/data is locked — close every mc-launcher.exe window first.\n' +
      '[pack] nothing was moved or deleted.',
  )
  process.exit(2)
}

// A leftover stash means a previous run aborted mid-way. Restore it instead of
// deleting it: that is the only copy of the user's data.
if (hadData && fs.existsSync(stash)) {
  const stale = `${stash}.stale-${Date.now()}`
  fs.renameSync(stash, stale)
  console.warn(`[pack] kept a previous stash as ${path.relative(root, stale)} instead of deleting it`)
}

if (hadData) {
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
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {
      // Keep the stash: losing the backup is worse than a stale directory.
      console.error('[pack] could not clear the fresh data directory; stash kept for manual restore')
    }
    if (!fs.existsSync(dataDir)) {
      move(stash, dataDir)
      console.log('[pack] restored portable data')
    }
  }
}

if (failed) {
  console.error('[pack] build failed; data was restored')
  process.exit(1)
}
