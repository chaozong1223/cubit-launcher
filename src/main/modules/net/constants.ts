/** Pinned EasyTier release used by the link module (docs/04 §5.3, §7.6). */
export const EASYTIER_VERSION = '2.7.0'
export const EASYTIER_RELEASE_TAG = 'v2.7.0'
export const EASYTIER_ZIP_NAME = `easytier-windows-x86_64-v${EASYTIER_VERSION}.zip`
export const EASYTIER_ZIP_SHA256 =
  '790fd9be347b00753570ac2b65f874a591ede9427603fe34e74a86b2b084847f'
export const EASYTIER_CORE_SHA256 =
  '6490c6f5b5b809065517bb3324ca34c0f1f367f81b7fda04a6352391508b8ff8'
export const EASYTIER_CLI_SHA256 =
  '3afdf2e4306c3f8d65408ddd230c7e4118ffdb5d550921022aed9966693c82ba'
export const EASYTIER_WINTUN_SHA256 =
  'e5da8447dc2c320edc0fc52fa01885c103de8c118481f683643cacc3220dafce'
export const EASYTIER_ZIP_URL =
  `https://github.com/EasyTier/EasyTier/releases/download/${EASYTIER_RELEASE_TAG}/${EASYTIER_ZIP_NAME}`
export const EASYTIER_SOURCE_URL = `https://github.com/EasyTier/EasyTier/tree/${EASYTIER_RELEASE_TAG}`
export const EASYTIER_LICENSE_URL =
  `https://raw.githubusercontent.com/EasyTier/EasyTier/${EASYTIER_RELEASE_TAG}/LICENSE`

/** Fixed virtual-network map. The host alias is per-room; this is the mapped side. */
export const MAPPED_CIDR = '192.168.77.1/32'
export const HOST_VIP = '10.144.144.1'
export const MEMBER_VIP = '10.144.144.2'
export const DEFAULT_CONTROL_PORT = 25998
export const DISCOVERY_PORT = 25999
export const MAX_MEMBERS = 8
export const MAX_PLAYERS_LIMIT = 8
export const TICKET_TTL_SECONDS = 600
export const HEARTBEAT_INTERVAL_MS = 5_000
export const HEARTBEAT_TIMEOUT_MS = 15_000
export const TUNNEL_START_TIMEOUT_MS = 20_000
export const TUNNEL_STOP_GRACE_MS = 2_000
