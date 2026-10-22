import dgram from 'node:dgram'
import fs from 'node:fs'
import path from 'node:path'
import type { LanWorld } from '@shared/net'
import type { ScopedLogger } from '../../kernel/logger'

const MC_MULTICAST_GROUP = '224.0.2.60'
const MC_LAN_PORT = 4445

export interface LanDiscoveryOptions {
  dataRoot: string
  log: ScopedLogger
  now?: () => number
  port?: number
}

/**
 * Read-only Minecraft LAN discovery.
 *
 * Sources:
 *  1. the vanilla multicast announcement (`[MOTD]…[/MOTD][AD]port[/AD]` on
 *     224.0.2.60:4445);
 *  2. the newest local game log (`Started serving on …` / `Local game hosted on port …`).
 *
 * The listener never replies to packets (docs/02 SEC-NET-04) and only runs for
 * the duration of a `discover()` call.
 */
export class LanWorldDiscovery {
  private readonly now: () => number
  private readonly port: number

  constructor(private readonly options: LanDiscoveryOptions) {
    this.now = options.now ?? Date.now
    this.port = options.port ?? MC_LAN_PORT
  }

  async discover(timeoutMs = 1_500): Promise<LanWorld[]> {
    const [multicast, local] = await Promise.all([
      this.listenMulticast(timeoutMs),
      Promise.resolve(this.localWorlds()),
    ])
    const seen = new Set<string>()
    const merged: LanWorld[] = []
    for (const world of [...local, ...multicast]) {
      const key = `${world.host}:${world.port}`
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(world)
    }
    return merged.sort((left, right) => right.lastSeen - left.lastSeen)
  }

  private listenMulticast(timeoutMs: number): Promise<LanWorld[]> {
    return new Promise((resolve) => {
      const found = new Map<string, LanWorld>()
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      let finished = false
      const finish = (): void => {
        if (finished) return
        finished = true
        try {
          socket.close()
        } catch {
          // already closed
        }
        resolve([...found.values()])
      }
      const timer = setTimeout(finish, timeoutMs)
      timer.unref?.()
      socket.on('error', (error) => {
        this.options.log.debug('LAN discovery socket unavailable', { message: error.message })
        clearTimeout(timer)
        finish()
      })
      socket.on('message', (message, remote) => {
        if (message.length > 4096) return
        const text = message.toString('utf8')
        const motd = /\[MOTD\]([\s\S]*?)\[\/MOTD\]/.exec(text)?.[1]?.trim() ?? ''
        const portText = /\[AD\](\d{1,5})\[\/AD\]/.exec(text)?.[1]
        const port = portText ? Number(portText) : NaN
        if (!Number.isInteger(port) || port < 1 || port > 65535) return
        const host = remote.address.replace(/^::ffff:/, '')
        const id = `lan:${host}:${port}`
        found.set(id, {
          id,
          motd: motd.slice(0, 120) || 'Minecraft LAN 世界',
          host,
          port,
          lastSeen: this.now(),
          source: 'multicast',
        })
      })
      socket.bind(this.port, '0.0.0.0', () => {
        try {
          socket.addMembership(MC_MULTICAST_GROUP)
          socket.setMulticastLoopback(true)
        } catch (error) {
          this.options.log.debug('LAN multicast membership unavailable', {
            message: error instanceof Error ? error.message : String(error),
          })
        }
      })
    })
  }

  /** Local game logs only; used by the host to notice a world opened before the room. */
  localWorlds(): LanWorld[] {
    return this.readLocalLogs()
  }

  private readLocalLogs(): LanWorld[] {
    const base = path.join(this.options.dataRoot, 'logs', 'game')
    if (!fs.existsSync(base)) return []
    const worlds: LanWorld[] = []
    try {
      for (const instanceDir of fs.readdirSync(base, { withFileTypes: true })) {
        if (!instanceDir.isDirectory()) continue
        const dir = path.join(base, instanceDir.name)
        const logs = fs
          .readdirSync(dir)
          .filter((name) => name.endsWith('.log'))
          .map((name) => path.join(dir, name))
          .sort((left, right) => {
            try {
              const delta = fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs
              // Log filenames are timestamp ordered; mtime resolution can tie
              // when rotation happens inside the same millisecond.
              return delta !== 0 ? delta : path.basename(right).localeCompare(path.basename(left))
            } catch {
              return 0
            }
          })
        const latest = logs[0]
        if (!latest) continue
        const stat = fs.statSync(latest)
        // Only recent worlds (60 minutes) are useful for a one-click join.
        if (this.now() - stat.mtimeMs > 60 * 60 * 1000) continue
        const lines = readTail(latest).split(/\r?\n/)
        for (let index = lines.length - 1; index >= 0; index -= 1) {
          const port = parsePortFromLine(lines[index])
          if (!port) continue
          worlds.push({
            id: `local:${instanceDir.name}:${port}`,
            motd: `本机 LAN 世界（${instanceDir.name}）`,
            host: '127.0.0.1',
            port,
            lastSeen: stat.mtimeMs,
            source: 'local-log',
          })
          break
        }
      }
    } catch (error) {
      this.options.log.debug('local LAN log scan failed', {
        message: error instanceof Error ? error.message : String(error),
      })
    }
    return worlds
  }
}

function parsePortFromLine(line: string): number | null {
  const patterns = [
    /Started serving on\s+(\d{1,5})/i,
    /Local game hosted on port\s+(\d{1,5})/i,
    /Starting Minecraft server on\s+[^\s:]*:(\d{1,5})/i,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(line)
    if (match) {
      const port = Number(match[1])
      if (Number.isInteger(port) && port >= 1 && port <= 65535) return port
    }
  }
  return null
}

function readTail(file: string, maxBytes = 128 * 1024): string {
  try {
    const stat = fs.statSync(file)
    const start = Math.max(0, stat.size - maxBytes)
    const length = stat.size - start
    if (length <= 0) return ''
    const buffer = Buffer.alloc(length)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buffer, 0, length, start)
    } finally {
      fs.closeSync(fd)
    }
    return buffer.toString('utf8')
  } catch {
    return ''
  }
}
