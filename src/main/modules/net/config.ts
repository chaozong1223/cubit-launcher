import fs from 'node:fs'
import path from 'node:path'

/** Optional per-machine link config (`dataRoot/modules/net/config.json`). */
export interface NetModuleConfig {
  relayPeers: string[]
  maxMembers: number
  lanIp: string | null
  aliasIp: string | null
  describe: string
}

export const DEFAULT_NET_CONFIG: NetModuleConfig = {
  relayPeers: [],
  maxMembers: 8,
  lanIp: null,
  aliasIp: null,
  describe: 'mc-launcher link module',
}

export function configFile(dataRoot: string): string {
  return path.join(dataRoot, 'modules', 'net', 'config.json')
}

export function loadNetConfig(dataRoot: string): NetModuleConfig {
  const file = configFile(dataRoot)
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_NET_CONFIG }
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<NetModuleConfig>
    return sanitize({ ...DEFAULT_NET_CONFIG, ...raw })
  } catch {
    return { ...DEFAULT_NET_CONFIG }
  }
}

export function saveNetConfig(dataRoot: string, config: NetModuleConfig): void {
  const file = configFile(dataRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  fs.writeFileSync(temp, JSON.stringify(sanitize(config), null, 2), 'utf8')
  fs.renameSync(temp, file)
}

function sanitize(config: NetModuleConfig): NetModuleConfig {
  const relayPeers = Array.isArray(config.relayPeers)
    ? config.relayPeers
        .filter((peer) => typeof peer === 'string')
        .map((peer) => peer.trim())
        .filter((peer) => /^(?:tcp|udp):\/\/[^\s/:]+:\d{1,5}$/.test(peer))
        .slice(0, 4)
    : []
  const maxMembers =
    Number.isInteger(config.maxMembers) && config.maxMembers >= 2 && config.maxMembers <= 8
      ? config.maxMembers
      : 8
  return {
    relayPeers,
    maxMembers,
    lanIp: typeof config.lanIp === 'string' && config.lanIp.length > 0 ? config.lanIp : null,
    aliasIp: typeof config.aliasIp === 'string' && config.aliasIp.length > 0 ? config.aliasIp : null,
    describe: typeof config.describe === 'string' ? config.describe.slice(0, 120) : 'mc-launcher link module',
  }
}
