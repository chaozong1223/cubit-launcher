import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageFile = path.join(root, 'package.json')
if (!fs.existsSync(packageFile)) {
  throw new Error('clean.mjs must run from the mc-launcher package root')
}

const targets = ['out', 'release', 'coverage', '.vite']
if (process.argv.includes('--data')) targets.push('data')

for (const target of targets) {
  const absolute = path.join(root, target)
  if (fs.existsSync(absolute)) {
    fs.rmSync(absolute, { recursive: true, force: true })
    console.log(`removed ${target}/`)
  }
}
console.log('clean complete')
