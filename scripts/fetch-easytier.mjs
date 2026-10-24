#!/usr/bin/env node
/**
 * Download the pinned EasyTier Windows build into build/extra/easytier so the
 * packaged app can ship it (no runtime download → cross-network rooms work even
 * on machines whose TLS chain cannot verify GitHub).
 *
 * Usage: node scripts/fetch-easytier.mjs [--mirror <base>]
 *
 * Verifies the archive SHA-256 against src/main/modules/net/constants.ts and
 * each extracted binary against its pinned hash before writing anything.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const constants = fs.readFileSync(
  path.join(root, 'src/main/modules/net/constants.ts'),
  'utf8',
)
const read = (name) => {
  const match = new RegExp(`${name}\\s*=\\s*'([0-9a-f]{64})'`).exec(constants)
  if (!match) throw new Error(`cannot read ${name} from constants.ts`)
  return match[1]
}
const version = /EASYTIER_VERSION = '([^']+)'/.exec(constants)?.[1]
if (!version) throw new Error('cannot read EASYTIER_VERSION')

const zipSha = read('EASYTIER_ZIP_SHA256')
const expected = {
  'easytier-core.exe': read('EASYTIER_CORE_SHA256'),
  'easytier-cli.exe': read('EASYTIER_CLI_SHA256'),
  'wintun.dll': read('EASYTIER_WINTUN_SHA256'),
}

const mirrorArg = process.argv.indexOf('--mirror')
const base = mirrorArg > -1 ? process.argv[mirrorArg + 1] : ''
const name = `easytier-windows-x86_64-v${version}.zip`
const url = `${base}${base && !base.endsWith('/') ? '/' : ''}https://github.com/EasyTier/EasyTier/releases/download/v${version}/${name}`

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'easytier-'))
const zip = path.join(tmp, name)
console.log(`downloading ${url}`)
execFileSync('curl.exe', ['-k', '-L', '--silent', '--show-error', '-o', zip, url], {
  stdio: 'inherit',
})

const sha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const actualZip = sha(zip)
if (actualZip !== zipSha) {
  throw new Error(`archive hash mismatch:\n  got      ${actualZip}\n  expected ${zipSha}`)
}

execFileSync(
  'powershell.exe',
  ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${path.join(tmp, 'x')}' -Force`],
  { stdio: 'inherit' },
)

const dest = path.join(root, 'build/extra/easytier')
fs.mkdirSync(dest, { recursive: true })
for (const [file, want] of Object.entries(expected)) {
  const found = fs
    .readdirSync(path.join(tmp, 'x'), { recursive: true })
    .map(String)
    .find((entry) => entry.toLowerCase().endsWith(file.toLowerCase()))
  if (!found) throw new Error(`${file} not found in the archive`)
  const source = path.join(tmp, 'x', found)
  const got = sha(source)
  if (got !== want) throw new Error(`${file} hash mismatch:\n  got      ${got}\n  expected ${want}`)
  fs.copyFileSync(source, path.join(dest, file))
  console.log(`ok ${file}`)
}
console.log(`\nwritten to ${dest}`)
console.log('reminder: LICENSE-LGPL-3.0.txt must stay next to these binaries (already committed).')
