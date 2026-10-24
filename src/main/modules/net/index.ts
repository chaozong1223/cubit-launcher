import type { ModuleContext } from '../_registry'
import { getService, publishService } from '../_services'
import { EasyTierManager, EasyTierTunnel } from './easytier'
import { loadNetConfig } from './config'
import { makeHandlers } from './handlers'
import { RoomService, type InstancePort, type LaunchPort } from './room'

export const moduleId = 'net'
export const dependsOn = ['launch', 'instance'] as const

/**
 * Link / multiplayer module (docs/04). Registered automatically by the t5
 * filesystem registry; does not touch src/main/index.ts, package.json or the
 * frozen IPC/preload files.
 *
 * The UI reaches it through the published `net` / `link` service (or the
 * `net.handlers` object) once t10 opens the IPC whitelist.
 */
export function register(ctx: ModuleContext): void {
  const config = loadNetConfig(ctx.dataRoot)
  const envRelays = (process.env.MCL_LINK_RELAY ?? '')
    .split(',')
    .map((peer) => peer.trim())
    .filter(Boolean)
  const relayPeers = [...new Set([...config.relayPeers, ...envRelays])].slice(0, 4)

  const launch = getService<LaunchPort>('launch')
  const instance = getService<InstancePort>('instance')
  const manager = new EasyTierManager({ dataRoot: ctx.dataRoot, log: ctx.log })
  const service = new RoomService({
    dataRoot: ctx.dataRoot,
    log: ctx.log,
    launch,
    instance,
    tunnel: new EasyTierTunnel(manager),
    lanIp: process.env.MCL_LINK_LAN_IP ?? config.lanIp ?? undefined,
    aliasIp: process.env.MCL_LINK_ALIAS ?? config.aliasIp ?? undefined,
    maxMembers: config.maxMembers,
    relayPeers,
    publicIp: process.env.MCL_LINK_PUBLIC_IP ?? config.publicIp,
    autoProbe: config.autoProbe,
  })

  publishService(moduleId, service)
  // Compatibility id from docs/03 (module map calls it `link`).
  publishService('link', service)
  publishService('net.handlers', makeHandlers(service))

  ctx.log.info('module registered', {
    deps: dependsOn,
    relayPeers: relayPeers.length,
    maxMembers: config.maxMembers,
    launch: launch !== null,
    instance: instance !== null,
  })

  process.once('exit', () => {
    // Async cleanup cannot run after 'exit'; kill the sidecar synchronously so
    // no EasyTier process survives the launcher (H4).
    service.disposeSync()
  })
}
