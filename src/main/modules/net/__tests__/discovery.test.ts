import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { LanWorldDiscovery } from '../discovery'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ScopedLogger

describe('LAN world discovery', () => {
  it('reads the newest local game log and returns a one-click world', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-lan-'))
    roots.push(dataRoot)
    const dir = path.join(dataRoot, 'logs', 'game', '1.20.1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, '20261021-200000.log'),
      [
        '[20:00:00] [Server thread/INFO]: Starting integrated minecraft server version 1.20.1',
        '[20:00:01] [Server thread/INFO]: Started serving on 51234',
      ].join('\n'),
      'utf8',
    )
    const discovery = new LanWorldDiscovery({ dataRoot, log: silentLog, now: Date.now })
    const worlds = discovery.localWorlds()
    expect(worlds).toHaveLength(1)
    expect(worlds[0]).toMatchObject({
      host: '127.0.0.1',
      port: 51234,
      source: 'local-log',
    })
    expect(worlds[0].motd).toContain('1.20.1')
  })

  it('returns no worlds for a missing/old log tree without throwing', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-lan-'))
    roots.push(dataRoot)
    const discovery = new LanWorldDiscovery({ dataRoot, log: silentLog })
    await expect(discovery.discover(250)).resolves.toEqual([])
  })
})
