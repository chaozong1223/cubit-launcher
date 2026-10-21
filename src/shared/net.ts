import { z } from 'zod'
import { defineContract } from './kernel'

/**
 * Link / multiplayer contract (docs/04 §8.2).
 *
 * The short `invite` code is only a display / LAN-discovery key. The copyable
 * capability is the full `MCL1.<code>.<payload>.<sig>` ticket returned by
 * `copyInvite`; it must never be logged or used as a React prop.
 */

export const LINK_ERROR_CODES = [
  'INVITE_INVALID',
  'INVITE_EXPIRED',
  'INVITE_INCOMPLETE',
  'TICKET_SIGNATURE_INVALID',
  'TICKET_MALFORMED',
  'ROOM_NOT_FOUND',
  'ROOM_FULL',
  'ROOM_CLOSED',
  'VERSION_MISMATCH',
  'LOADER_MISMATCH',
  'AUTH_FAILED',
  'HEARTBEAT_TIMEOUT',
  'NETWORK_UNREACHABLE',
  'HOST_LEFT',
  'TUNNEL_FAILED',
  'TUNNEL_DOWNLOAD_FAILED',
  'TUNNEL_HASH_MISMATCH',
  'TUNNEL_START_FAILED',
  'TUNNEL_PERMISSION_DENIED',
  'RELAY_UNAVAILABLE',
  'RELAY_REQUIRED',
  'PORT_MAPPING_REQUIRED',
  'FIREWALL_BLOCKED',
  'WORLD_NOT_FOUND',
  'ADMIN_REQUIRED',
  'LAUNCH_FAILED',
  'INTERNAL',
] as const

export type LinkErrorCode = (typeof LINK_ERROR_CODES)[number]

export const LINK_ERROR_MESSAGES: Record<LinkErrorCode, string> = {
  INVITE_INVALID: '邀请码不正确或已过期',
  INVITE_EXPIRED: '邀请码已过期，请让房主重新生成',
  INVITE_INCOMPLETE: '跨网联机需要完整邀请码，不是 6 位房间号',
  TICKET_SIGNATURE_INVALID: '邀请码被修改，无法验证',
  TICKET_MALFORMED: '邀请码格式不正确',
  ROOM_NOT_FOUND: '房间不存在或已关闭',
  ROOM_FULL: '房间人数已满',
  ROOM_CLOSED: '房主已关闭房间',
  VERSION_MISMATCH: '双方游戏版本不一致，暂时不能加入',
  LOADER_MISMATCH: '双方加载器不一致，暂时不能加入',
  AUTH_FAILED: '无法验证房间身份',
  HEARTBEAT_TIMEOUT: '与房主失去连接，请重试',
  NETWORK_UNREACHABLE: '无法连接到房主，请检查网络',
  HOST_LEFT: '房主已离开',
  TUNNEL_FAILED: '联机组件未能启动，已退回直连',
  TUNNEL_DOWNLOAD_FAILED: '联机组件下载失败',
  TUNNEL_HASH_MISMATCH: '联机组件校验失败，已拒绝运行',
  TUNNEL_START_FAILED: '联机组件启动失败',
  TUNNEL_PERMISSION_DENIED: '该模式需要管理员权限',
  RELAY_UNAVAILABLE: '中继节点不可用',
  RELAY_REQUIRED: '当前网络无法直连，需要中继或手动映射',
  PORT_MAPPING_REQUIRED: '需要手动映射端口',
  FIREWALL_BLOCKED: 'Windows 防火墙可能拦截了 Java',
  WORLD_NOT_FOUND: '未检测到 LAN 世界，请在游戏内“对局域网开放”',
  ADMIN_REQUIRED: '此操作需要管理员权限',
  LAUNCH_FAILED: '启动游戏失败',
  INTERNAL: '联机模块内部错误',
}

export const RoomState = z.enum([
  'idle',
  'creating',
  'waiting',
  'connecting',
  'connected',
  'closing',
  'closed',
  'error',
])
export type RoomState = z.infer<typeof RoomState>

export const Transport = z.enum(['lan', 'p2p', 'relay', 'manual', 'none'])
export type Transport = z.infer<typeof Transport>

export const TunnelState = z.enum([
  'idle',
  'downloading',
  'starting',
  'up',
  'degraded',
  'failed',
  'stopped',
])
export type TunnelState = z.infer<typeof TunnelState>

export const RoomMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: z.enum(['host', 'member']),
  mcVersion: z.string(),
  loader: z.string(),
  /** Numeric RTT when known; the host itself is always 0. */
  pingMs: z.number().int().nonnegative().nullable(),
  /** False until the first PONG/STATS sample; UI can render `pingLabel`. */
  pingKnown: z.boolean().default(false),
  pingLabel: z.string().default('未知'),
  status: z.enum(['connected', 'reconnecting', 'disconnected', 'unknown']).default('connected'),
  path: z.enum(['direct', 'relay', 'unknown']),
})
export type RoomMember = z.infer<typeof RoomMemberSchema>

/** A Minecraft LAN world discovered on the local network (UDP 4445). */
export const LanWorldSchema = z.object({
  id: z.string(),
  motd: z.string(),
  host: z.string(),
  port: z.number().int().min(1).max(65535),
  lastSeen: z.number().int(),
  source: z.enum(['multicast', 'local-log']),
})
export type LanWorld = z.infer<typeof LanWorldSchema>

export const LanWorldsInputSchema = z.object({
  timeoutMs: z.number().int().min(200).max(10_000).default(1_500),
})
export type LanWorldsInput = z.infer<typeof LanWorldsInputSchema>

export const LanWorldsOutputSchema = z.object({
  worlds: z.array(LanWorldSchema),
})
export type LanWorldsOutput = z.infer<typeof LanWorldsOutputSchema>

export const JoinLanWorldInputSchema = z.object({
  worldId: z.string().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  instanceId: z.string().min(1),
  accountId: z.string().nullable().default(null),
})
export type JoinLanWorldInput = z.infer<typeof JoinLanWorldInputSchema>

export const WorldSchema = z.object({
  port: z.number().int().min(1).max(65535).nullable(),
  state: z.enum(['pending', 'open', 'closed']),
  address: z.string().nullable(),
})
export type WorldInfo = z.infer<typeof WorldSchema>

export const TunnelInfoSchema = z.object({
  state: TunnelState,
  version: z.string().nullable(),
  relay: z.boolean(),
})
export type TunnelInfo = z.infer<typeof TunnelInfoSchema>

export const LinkErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
})
export type LinkErrorInfo = z.infer<typeof LinkErrorSchema>

export const RoomPortsSchema = z.object({
  control: z.number().int().nullable(),
  world: z.number().int().nullable(),
  peer: z.number().int().nullable(),
  localWorld: z.number().int().nullable(),
})
export type RoomPorts = z.infer<typeof RoomPortsSchema>

export const ManualGuideSchema = z.object({
  reason: z.string(),
  steps: z.array(z.string()),
})
export type ManualGuide = z.infer<typeof ManualGuideSchema>

export const RoomInfoSchema = z.object({
  code: z.string().length(6),
  invite: z.string().regex(/^MCL-[0-9A-HJKMNP-TV-Z]{6}$/),
  state: RoomState,
  transport: Transport,
  tunnel: TunnelInfoSchema,
  world: WorldSchema,
  ports: RoomPortsSchema,
  manual: ManualGuideSchema.nullable(),
  members: z.array(RoomMemberSchema),
  host: z.object({
    name: z.string(),
    mcVersion: z.string(),
    loader: z.string(),
  }),
  maxMembers: z.number().int().min(2).max(8),
  expiresAt: z.number().int().nullable(),
  error: LinkErrorSchema.nullable(),
})
export type RoomInfo = z.infer<typeof RoomInfoSchema>

export const CreateRoomInputSchema = z.object({
  instanceId: z.string().min(1),
  transport: z.enum(['lan', 'auto']).default('auto'),
  /** Explicit consent to download/start the LGPL tunnel sidecar. */
  consentTunnel: z.boolean().default(false),
})
export type CreateRoomInput = z.infer<typeof CreateRoomInputSchema>

export const JoinRoomInputSchema = z.object({
  ticket: z.string().min(1).max(4096),
  instanceId: z.string().nullable().default(null),
})
export type JoinRoomInput = z.infer<typeof JoinRoomInputSchema>

export const EnterWorldInputSchema = z.object({
  instanceId: z.string().nullable().default(null),
  accountId: z.string().nullable().default(null),
})
export type EnterWorldInput = z.infer<typeof EnterWorldInputSchema>

export const CopyInviteOutputSchema = z.object({
  code: z.string().length(6),
  ticket: z.string(),
  expiresAt: z.number().int(),
})
export type CopyInviteOutput = z.infer<typeof CopyInviteOutputSchema>

export const SetWorldPortInputSchema = z.object({
  port: z.number().int().min(1).max(65535),
})
export type SetWorldPortInput = z.infer<typeof SetWorldPortInputSchema>

export const DiagnoseOutputSchema = z.object({ json: z.string() })
export type DiagnoseOutput = z.infer<typeof DiagnoseOutputSchema>

export const contract = defineContract({
  id: 'net',
  methods: {
    create: { input: CreateRoomInputSchema, output: RoomInfoSchema },
    join: { input: JoinRoomInputSchema, output: RoomInfoSchema },
    leave: { input: z.void(), output: z.object({ ok: z.boolean() }) },
    status: { input: z.void(), output: RoomInfoSchema.nullable() },
    copyInvite: { input: z.void(), output: CopyInviteOutputSchema },
    setWorldPort: { input: SetWorldPortInputSchema, output: RoomInfoSchema },
    enterWorld: {
      input: EnterWorldInputSchema,
      output: z.object({
        sessionId: z.string(),
        server: z.object({ host: z.string(), port: z.number().int() }),
      }),
    },
    lanWorlds: { input: LanWorldsInputSchema, output: LanWorldsOutputSchema },
    joinLanWorld: {
      input: JoinLanWorldInputSchema,
      output: z.object({
        sessionId: z.string(),
        server: z.object({ host: z.string(), port: z.number().int() }),
      }),
    },
    diagnose: { input: z.void(), output: DiagnoseOutputSchema },
  },
  events: {
    state: {
      payload: z.object({
        state: RoomState,
        code: z.string().nullable(),
        error: LinkErrorSchema.nullable(),
      }),
    },
    members: { payload: z.array(RoomMemberSchema) },
    world: { payload: WorldSchema },
    error: { payload: LinkErrorSchema },
    lanWorlds: { payload: LanWorldsOutputSchema },
  },
})

export const netContract = contract

/** Structural service interface for t10/UI wiring and other modules. */
export interface LinkService {
  create(input: CreateRoomInput): Promise<RoomInfo>
  join(input: JoinRoomInput): Promise<RoomInfo>
  leave(): Promise<{ ok: boolean }>
  status(): RoomInfo | null
  copyInvite(): Promise<CopyInviteOutput>
  setWorldPort(input: SetWorldPortInput): Promise<RoomInfo>
  enterWorld(input: EnterWorldInput): Promise<{
    sessionId: string
    server: { host: string; port: number }
  }>
  lanWorlds(input?: LanWorldsInput): Promise<LanWorldsOutput>
  joinLanWorld(input: JoinLanWorldInput): Promise<{
    sessionId: string
    server: { host: string; port: number }
  }>
  diagnose(): Promise<DiagnoseOutput>
}
