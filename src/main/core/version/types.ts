/**
 * Types for the launcher version JSON (`versions/<id>/<id>.json`).
 *
 * These mirror the public `client.json` format; unknown extra keys are kept
 * untouched so a flattened file stays forward compatible. No PCL2 code or data
 * was consulted — the shape below is derived from the public format and the
 * real files in the local `.minecraft` (read-only evidence in docs).
 */

export type RuleAction = 'allow' | 'disallow'

export interface OsRule {
  name?: 'windows' | 'osx' | 'linux'
  version?: string
  arch?: string
}

export interface Rule {
  action: RuleAction
  os?: OsRule
  features?: Record<string, boolean>
}

export interface ConditionalArgument {
  rules: Rule[]
  value: string | string[]
}

export type VersionArgument = string | ConditionalArgument

export interface VersionArguments {
  game?: VersionArgument[]
  jvm?: VersionArgument[]
}

export interface DownloadInfo {
  path?: string
  sha1?: string
  sha256?: string
  size?: number
  url: string
}

export interface VersionDownloads {
  client?: DownloadInfo
  server?: DownloadInfo
  client_mappings?: DownloadInfo
  server_mappings?: DownloadInfo
  windows_server?: DownloadInfo
  [key: string]: DownloadInfo | undefined
}

export interface AssetIndex extends DownloadInfo {
  id: string
  totalSize?: number
}

export interface JavaVersionInfo {
  component: string
  majorVersion: number
}

export interface LoggingFile extends DownloadInfo {
  id: string
}

export interface LoggingConfig {
  client?: {
    argument: string
    file: LoggingFile
    type?: string
  }
  [key: string]: unknown
}

export interface LibraryDownloads {
  artifact?: DownloadInfo
  classifiers?: Record<string, DownloadInfo>
}

export interface VersionLibrary {
  name: string
  downloads?: LibraryDownloads
  /** Legacy natives map: `{ windows: 'natives-windows', osx: 'natives-osx' }`. */
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  rules?: Rule[]
  url?: string
  checksums?: string[]
  serverreq?: boolean
  clientreq?: boolean
  [key: string]: unknown
}

export interface FlattenMetadata {
  flattenedAt: string
  /** Version ids from root to leaf, for troubleshooting. */
  flattenedFrom: string[]
  flattenedBy?: string
}

export interface VersionJson {
  id: string
  inheritsFrom?: string
  /** Legacy: the version id whose jar is used (Forge 1.7.10 style). */
  jar?: string
  type?: string
  mainClass?: string
  /** Pre-1.13 argument string. Mutually exclusive with `arguments` in practice. */
  minecraftArguments?: string
  arguments?: VersionArguments
  libraries?: VersionLibrary[]
  downloads?: VersionDownloads
  assetIndex?: AssetIndex
  assets?: string
  javaVersion?: JavaVersionInfo
  logging?: LoggingConfig
  complianceLevel?: number
  releaseTime?: string
  time?: string
  minimumLauncherVersion?: number
  /** Written by our flatten step; never present in a Mojang file. */
  'x-mc-launcher'?: FlattenMetadata
  [key: string]: unknown
}

/**
 * Output of `flattenVersionChain`: self contained JSON without `inheritsFrom`.
 * The index signature keeps vendor extensions alive through a round trip.
 */
export interface FlattenedVersionJson extends VersionJson {
  id: string
  inheritsFrom?: undefined
  'x-mc-launcher': FlattenMetadata
}

export type LoaderType = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge' | 'unknown'

export interface LoaderInfo {
  type: LoaderType
  version: string | null
}

export type PlatformName = 'windows' | 'linux' | 'osx'
export type PlatformArch = 'x86' | 'x86_64' | 'arm64'

export interface RuleContext {
  os: {
    name: PlatformName
    /** Free-form OS version; the rule value is a regular expression. */
    version: string
    arch: PlatformArch
  }
  features: Record<string, boolean>
}

export interface VersionChainNode {
  id: string
  dirName: string
  dir: string
  jsonPath: string
  json: VersionJson
}

export interface ResolvedVersion {
  /** Version id read from the leaf JSON (may differ from the directory name). */
  id: string
  /** Directory under `versions/` that was resolved. */
  dirName: string
  dir: string
  chain: VersionChainNode[]
  /** Root-to-leaf ids, handy for logs and dry-run artifacts. */
  chainIds: string[]
  json: FlattenedVersionJson
  /** Version folder owning the client jar (leaf when it has one). */
  jarVersionId: string | null
  clientJar: string | null
  clientJarExists: boolean
  /** Best-effort Minecraft version (null for reshaped modpacks). */
  mcVersion: string | null
  loader: LoaderInfo
  javaMajor: number | null
  /** Non-fatal findings worth surfacing to the user. */
  warnings: string[]
}
