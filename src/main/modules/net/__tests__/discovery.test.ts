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

  it('handles log rotation by reading only the newest log and the tail of a large file', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-lan-'))
    roots.push(dataRoot)
    const dir = path.join(dataRoot, 'logs', 'game', '1.20.1')
    fs.mkdirSync(dir, { recursive: true })
    const older = path.join(dir, '20261021-190000.log')
    fs.writeFileSync(older, '[19:00:00] [Server thread/INFO]: Started serving on 11111\n', 'utf8')
    const oldTime = new Date(Date.now() - 60_000)
    fs.utimesSync(older, oldTime, oldTime)
    const newest = path.join(dir, '20261021-200000.log')
    fs.writeFileSync(
      newest,
      `${'[20:00:00] [Render thread/INFO]: filler\n'.repeat(20_000)}[20:10:00] [Server thread/INFO]: Started serving on 51234\n`,
      'utf8',
    )
    const discovery = new LanWorldDiscovery({ dataRoot, log: silentLog, now: Date.now })
    const worlds = discovery.localWorlds()
    expect(worlds).toHaveLength(1)
    expect(worlds[0].port).toBe(51234)
    expect(worlds.some((world) => world.port === 11111)).toBe(false)
  })

  it('does not report a port from a truncated/new log with no LAN line', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-lan-'))
    roots.push(dataRoot)
    const dir = path.join(dataRoot, 'logs', 'game', '1.20.1')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, '20261021-200000.log'),
      '[20:00:00] [Render thread/INFO]: Started serving on 12345\n',
      'utf8',
    )
    const newest = path.join(dir, '20261021-210000.log')
    fs.writeFileSync(newest, '[21:00:00] [Render thread/INFO]: only menu output\n', 'utf8')
    const discovery = new LanWorldDiscovery({ dataRoot, log: silentLog, now: Date.now })
    expect(discovery.localWorlds()).toEqual([])
  })

  it('returns no worlds for a missing/old log tree without throwing', async () => {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-lan-'))
    roots.push(dataRoot)
    const discovery = new LanWorldDiscovery({ dataRoot, log: silentLog })
    await expect(discovery.discover(250)).resolves.toEqual([])
  })
})
