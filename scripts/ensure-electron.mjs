import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Electron 44 publishes its downloader as `install-electron` instead of a
 * package-level postinstall. Run it explicitly so a fresh `npm install` always
 * produces `node_modules/electron/dist` for dev/build/pack.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronDir = path.join(root, 'node_modules', 'electron')
const installer = path.join(electronDir, 'install.js')
const packageFile = path.join(electronDir, 'package.json')
const versionFile = path.join(electronDir, 'dist', 'version')
const exeFile = path.join(electronDir, 'dist', 'electron.exe')

if (!fs.existsSync(packageFile) || !fs.existsSync(installer)) {
  console.error('[ensure-electron] electron package is not installed; run npm install first')
  process.exit(1)
}

const version = JSON.parse(fs.readFileSync(packageFile, 'utf8')).version
const installed = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : ''
if (installed === version && fs.existsSync(exeFile)) {
  console.log(`[ensure-electron] Electron ${version} already present`)
  process.exit(0)
}

console.log(`[ensure-electron] downloading Electron ${version}…`)
function run(extraEnv) {
  const result = spawnSync(process.execPath, [installer], {
    cwd: electronDir,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
  })
  return result.status === 0
}

if (!run({})) {
  console.warn('[ensure-electron] default download failed; retrying with npmmirror')
  if (!run({ ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' })) {
    console.error('[ensure-electron] Electron download failed. Set ELECTRON_MIRROR and re-run npm install.')
    process.exit(1)
  }
}

const after = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8').trim() : ''
if (after !== version || !fs.existsSync(exeFile)) {
  console.error(`[ensure-electron] installed version mismatch: expected ${version}, got ${after || 'missing'}`)
  process.exit(1)
}
console.log(`[ensure-electron] Electron ${version} ready`)
