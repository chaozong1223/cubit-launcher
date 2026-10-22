import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { CoreError } from '../errors'
import { createRuleContext, evaluateArguments, splitLegacyArguments } from '../version/rules'
import {
  joinClasspath,
  resolveLibraries,
  classpathSeparator,
  type NativeSource,
} from '../version/classpath'
import { encodingForCodePage, fileEncodingForJava, parseMinecraftVersion } from '../java/version'
import type { FlattenedVersionJson, VersionArgument } from '../version/types'

export interface LaunchAccount {
  kind: 'offline' | 'microsoft' | 'authlib'
  name: string
  uuid: string
  accessToken: string
  userType: 'legacy' | 'msa'
  xuid?: string | null
  clientId?: string | null
}

export interface AuthlibInjection {
  javaagentPath: string
  apiRoot: string
  prefetched?: string | null
}

export interface LaunchPaths {
  mcRoot: string
  versionDir: string
  gameDir: string
  assetsDir: string
  librariesDir: string
  nativesDir: string
  clientJar: string | null
}

export interface LaunchSettings {
  javaPath: string
  javaMajor: number
  minMemoryMb: number
  maxMemoryMb: number
  width: number
  height: number
  fullscreen: boolean
  extraJvmArgs: string[]
  server: { host: string; port: number } | null
  authlib: AuthlibInjection | null
  /** Windows ANSI code page; 936 on the local acceptance machine. */
  codePage: number
  launcherName: string
  launcherVersion: string
  /** Optional GC override: skip the default G1 block. */
  customGc?: boolean
}

export interface BuildLaunchPlanInput {
  version: FlattenedVersionJson
  /** Value passed to `--version`; defaults to `version.id`. */
  versionName?: string
  /** Detected Minecraft version; drives quick-play vs --server selection. */
  mcVersion?: string | null
  account: LaunchAccount
  paths: LaunchPaths
  settings: LaunchSettings
  platform?: NodeJS.Platform
  arch?: string
  dryRun?: boolean
  sessionId?: string
  now?: () => number
  env?: NodeJS.ProcessEnv
  /** Injected existence check; defaults to "everything exists". */
  exists?: (target: string) => boolean
  features?: Record<string, boolean>
  /**
   * Replaces the JVM's `java.io.tmpdir`. On machines where the launcher runs at
   * low integrity (Chromium falls back to that when its sandbox cannot start),
   * the game inherits that level and mods unpacking themselves into %TEMP% hit
   * AccessDeniedException. Pointing the JVM temp dir at a folder the launcher
   * created itself fixes that without elevating anything.
   */
  tempDir?: string
}

export interface LaunchPlanCore {
  sessionId: string
  dryRun: boolean
  versionId: string
  mcVersion: string | null
  javaPath: string
  javaMajor: number
  cwd: string
  argv: string[]
  env: Record<string, string>
  classpath: string[]
  natives: NativeSource[]
  nativesDir: string
  warnings: string[]
  createdAt: number
}

/** Arguments the launcher owns; user-supplied duplicates are rejected (R4.7). */
export const MANAGED_JVM_PREFIXES = [
  '-Xmx',
  '-Xms',
  '-cp',
  '-classpath',
  '-jar',
  '-javaagent',
  '-Djava.library.path=',
  '-Djna.tmpdir=',
  '-Dorg.lwjgl.system.SharedLibraryExtractPath=',
  '-Dio.netty.native.workdir=',
  '-Dlog4j2.formatMsgNoLookups=',
  '-Dminecraft.launcher.brand=',
  '-Dminecraft.launcher.version=',
] as const

export const MANAGED_GAME_FLAGS = [
  '--username',
  '--uuid',
  '--accessToken',
  '--userType',
  '--version',
  '--versionType',
  '--gameDir',
  '--assetsDir',
  '--assetIndex',
  '--width',
  '--height',
  '--fullscreen',
  '--server',
  '--port',
  '--quickPlayMultiplayer',
] as const

const G1_DEFAULTS = [
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+UseG1GC',
  '-XX:G1NewSizePercent=20',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapRegionSize=32M',
  '-XX:MaxGCPauseMillis=50',
  '-XX:+PerfDisableSharedMem',
  '-XX:MinHeapFreeRatio=25',
  '-XX:MaxHeapFreeRatio=40',
  '-Dlog4j2.formatMsgNoLookups=true',
] as const

const NATIVE_JVM_KEYS = [
  '-Djava.library.path=',
  '-Djna.tmpdir=',
  '-Dorg.lwjgl.system.SharedLibraryExtractPath=',
  '-Dio.netty.native.workdir=',
] as const

const ENV_VARS_TO_SCRUB = [
  '_JAVA_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'CLASSPATH',
] as const

/** Explicit game-process allow-list; never inherit unrelated secrets. */
const SAFE_GAME_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemDrive',
  'SystemRoot',
  'windir',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'PUBLIC',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'LOGONSERVER',
  'SESSIONNAME',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROCESSOR_LEVEL',
  'PROCESSOR_REVISION',
  'TEMP',
  'TMP',
  'OS',
  'LANG',
  'LC_ALL',
  'TZ',
] as const

export function assertNoManagedJvmArgs(args: string[]): void {
  for (const arg of args) {
    if (!arg) continue
    if (MANAGED_JVM_PREFIXES.some((prefix) => arg === prefix || arg.startsWith(prefix))) {
      throw new CoreError('LAUNCH.PLAN_INVALID', {
        message: `managed JVM argument in custom list: ${arg}`,
        userMessage: '受管参数请在上方设置',
        hint: `不能把 ${arg} 写进自定义 JVM 参数`,
        details: { argument: arg },
      })
    }
  }
}

function hasAny(args: string[], predicate: (arg: string) => boolean): boolean {
  return args.some(predicate)
}

function stripArgs(args: string[], predicate: (arg: string) => boolean): string[] {
  return args.filter((arg) => !predicate(arg))
}

function pushIfMissing(args: string[], predicate: (arg: string) => boolean, values: string[]): void {
  if (!hasAny(args, predicate)) args.push(...values)
}

function cleanEnvironment(base: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  // Whitelist + explicit blacklist (defence in depth): launcher internals,
  // Java option injection and classpath hijacking are always excluded.
  for (const key of SAFE_GAME_ENV_KEYS) {
    const value = base[key]
    if (value === undefined) continue
    if (
      /^MCL_/i.test(key) ||
      /_OPTIONS$/i.test(key) ||
      key.toUpperCase() === 'CLASSPATH' ||
      (ENV_VARS_TO_SCRUB as readonly string[]).includes(key)
    ) {
      continue
    }
    env[key] = value
  }
  return env
}

interface PlaceholderResult {
  values: Record<string, string | null>
}

function buildPlaceholders(input: BuildLaunchPlanInput, classpath: string, clientJar: string | null): PlaceholderResult {
  const { version, account, paths, settings } = input
  const separator = classpathSeparator(input.platform ?? process.platform)
  const assetIndexName = version.assetIndex?.id ?? version.assets ?? 'legacy'
  const offline = account.kind === 'offline'
  const server = settings.server

  return {
    values: {
      auth_player_name: account.name,
      auth_uuid: account.uuid,
      auth_access_token: account.accessToken,
      auth_session: account.accessToken,
      user_type: account.userType,
      version_name: input.versionName ?? version.id,
      version_type: typeof version.type === 'string' ? version.type : 'release',
      game_directory: paths.gameDir,
      assets_root: paths.assetsDir,
      assets_index_name: assetIndexName,
      game_assets: paths.assetsDir,
      user_properties: '{}',
      clientid: offline ? null : account.clientId ?? null,
      auth_xuid: offline ? null : account.xuid ?? null,
      natives_directory: paths.nativesDir,
      launcher_name: settings.launcherName,
      launcher_version: settings.launcherVersion,
      classpath,
      classpath_separator: separator,
      library_directory: paths.librariesDir,
      resolution_width: String(settings.width),
      resolution_height: String(settings.height),
      // Client jar placeholder appears in a few Forge variants.
      client_jar: clientJar,
      quickPlayPath: null,
      quickPlaySingleplayer: null,
      quickPlayMultiplayer: server ? `${server.host}:${server.port}` : null,
      quickPlayRealms: null,
    },
  }
}

/**
 * Replaces `${...}` tokens. A placeholder resolving to `null` removes its value
 * token and the preceding `--flag` (offline accounts must not carry fake
 * `--clientId` / `--xuid`, docs/01 R2.4). Unknown placeholders are a hard error:
 * the command line must never contain a leftover `${...}` (R1.8).
 */
export function substitutePlaceholders(
  tokens: string[],
  values: Record<string, string | null>,
): string[] {
  const output: string[] = []

  for (const token of tokens) {
    const whole = /^\$\{([A-Za-z0-9_]+)\}$/.exec(token)
    if (whole) {
      const name = whole[1]
      if (!(name in values)) {
        throw new CoreError('LAUNCH.PLAN_INVALID', {
          message: `unresolved placeholder: \${${name}}`,
          details: { placeholder: name },
        })
      }
      const value = values[name]
      if (value === null) {
        // Drop the paired flag too (e.g. `--clientId ${clientid}`).
        const previous = output[output.length - 1]
        if (previous && previous.startsWith('--')) output.pop()
        continue
      }
      output.push(value)
      continue
    }

    if (token.includes('${')) {
      const replaced = token.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
        if (!(name in values)) {
          throw new CoreError('LAUNCH.PLAN_INVALID', {
            message: `unresolved placeholder: \${${name}}`,
            details: { placeholder: name },
          })
        }
        const value = values[name]
        if (value === null) {
          throw new CoreError('LAUNCH.PLAN_INVALID', {
            message: `placeholder \${${name}} has no value in a composite argument`,
            details: { placeholder: name, token },
          })
        }
        return value
      })
      if (replaced.includes('${')) {
        throw new CoreError('LAUNCH.PLAN_INVALID', {
          message: `unresolved placeholder in token: ${replaced}`,
        })
      }
      output.push(replaced)
      continue
    }

    output.push(token)
  }

  return output
}

function supportsQuickPlay(version: FlattenedVersionJson, mcVersion: string | null): boolean {
  const game = version.arguments?.game ?? []
  const hasQuickPlayArgument = game.some((argument: VersionArgument) =>
    typeof argument === 'object' &&
    Array.isArray(argument.value) &&
    argument.value.some((value) => value.startsWith('--quickPlay')),
  )
  if (hasQuickPlayArgument) return true
  const parsed = parseMinecraftVersion(mcVersion)
  if (parsed) {
    return parsed[0] > 1 || (parsed[0] === 1 && parsed[1] >= 20)
  }
  return false
}

function dedupeManagedGameFlags(args: string[]): string[] {
  const managed = new Set<string>(MANAGED_GAME_FLAGS)
  const seen = new Set<string>()
  const output: string[] = []

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]
    if (!managed.has(token)) {
      output.push(token)
      continue
    }
    if (seen.has(token)) {
      const next = args[index + 1]
      if (next !== undefined && !next.startsWith('-')) index += 1
      continue
    }
    seen.add(token)
    output.push(token)
  }

  return output
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag)
}

function ensureFlagValue(args: string[], flag: string, value: string): void {
  if (hasFlag(args, flag)) return
  args.push(flag, value)
}

function ensureNativesArgs(jvmArgs: string[], nativesDir: string): void {
  for (const key of NATIVE_JVM_KEYS) {
    if (hasAny(jvmArgs, (arg) => arg.startsWith(key))) continue
    jvmArgs.push(`${key}${nativesDir}`)
  }
}

function ensureBrandArgs(jvmArgs: string[], launcherName: string, launcherVersion: string): void {
  if (!hasAny(jvmArgs, (arg) => arg.startsWith('-Dminecraft.launcher.brand='))) {
    jvmArgs.push(`-Dminecraft.launcher.brand=${launcherName}`)
  }
  if (!hasAny(jvmArgs, (arg) => arg.startsWith('-Dminecraft.launcher.version='))) {
    jvmArgs.push(`-Dminecraft.launcher.version=${launcherVersion}`)
  }
}

function validateSettings(settings: LaunchSettings): void {
  if (!settings.javaPath) {
    throw new CoreError('JAVA.NOT_FOUND', { message: 'java path is empty' })
  }
  if (
    !Number.isFinite(settings.minMemoryMb) ||
    !Number.isFinite(settings.maxMemoryMb) ||
    settings.minMemoryMb < 512 ||
    settings.maxMemoryMb > 65_536 ||
    settings.maxMemoryMb < settings.minMemoryMb
  ) {
    throw new CoreError('LAUNCH.PLAN_INVALID', {
      message: `invalid memory range: ${settings.minMemoryMb}-${settings.maxMemoryMb}`,
      userMessage: '内存设置不合法',
      details: { minMb: settings.minMemoryMb, maxMb: settings.maxMemoryMb },
    })
  }
}

/**
 * Pure launch-plan builder. No disk writes, no process: everything the plan
 * needs is passed in, which is what makes `dry-run` and unit tests trustworthy.
 */
export function buildLaunchPlan(input: BuildLaunchPlanInput): LaunchPlanCore {
  const { version, account, paths, settings } = input
  const platform = input.platform ?? process.platform
  const arch = input.arch ?? process.arch
  const now = input.now ?? Date.now
  validateSettings(settings)

  if (!version.mainClass) {
    throw new CoreError('LAUNCH.PLAN_INVALID', {
      message: 'version JSON has no mainClass',
      userMessage: '启动参数不完整（缺少主类），实例可能损坏',
    })
  }

  if (!account.name || !account.uuid || account.accessToken === undefined) {
    throw new CoreError('LAUNCH.ACCOUNT_REQUIRED', { message: 'incomplete account data' })
  }

  const features: Record<string, boolean> = {
    has_custom_resolution: true,
    ...(input.features ?? {}),
  }
  const server = settings.server
  const quickPlay = server !== null && supportsQuickPlay(version, input.mcVersion ?? null)
  if (quickPlay) features.is_quick_play_multiplayer = true

  const ruleContext = createRuleContext(platform, arch, features)

  const libraries = resolveLibraries(version, {
    librariesDir: paths.librariesDir,
    clientJar: paths.clientJar,
    platform,
    arch,
    features,
    exists: input.exists,
  })
  const classpath = joinClasspath(libraries.classpath, platform)

  const warnings: string[] = []
  if (libraries.missing.length > 0) {
    warnings.push(
      `${libraries.missing.length} file(s) missing (include ${path.basename(libraries.missing[0])})`,
    )
  }
  if (libraries.classpath.length === 0) {
    throw new CoreError('LAUNCH.PLAN_INVALID', {
      message: 'empty classpath',
      userMessage: '启动参数不完整（classpath 为空）',
    })
  }

  assertNoManagedJvmArgs(settings.extraJvmArgs)

  // --- JVM arguments -------------------------------------------------------
  let jvmArgs: string[] = version.arguments?.jvm
    ? evaluateArguments(version.arguments.jvm, ruleContext)
    : ['-Djava.library.path=${natives_directory}', '-cp', '${classpath}']

  const placeholders = buildPlaceholders(input, classpath, paths.clientJar)
  jvmArgs = substitutePlaceholders(jvmArgs, placeholders.values)

  // Log4j config: the launcher (not the version JSON) resolves `${path}` to the
  // downloaded file in `assets/log_configs/`.
  const logging = version.logging?.client
  if (logging?.argument && logging.file?.id) {
    const localLoggingFile = path.join(
      paths.mcRoot,
      'assets',
      'log_configs',
      path.basename(logging.file.id),
    )
    // Existing PCL-managed folders do not always carry the log config; adding a
    // `-D` pointing at a missing file makes Log4j complain on every launch.
    const usable = !input.exists || input.exists(localLoggingFile)
    if (usable && !hasAny(jvmArgs, (arg) => arg.startsWith('-Dlog4j.configurationFile='))) {
      jvmArgs.push(logging.argument.replaceAll('${path}', localLoggingFile))
    }
  }

  if (!jvmArgs.includes('-cp') && !jvmArgs.includes('-classpath')) {
    jvmArgs.push('-cp', classpath)
  }

  jvmArgs = stripArgs(jvmArgs, (arg) => arg.startsWith('-Xmx') || arg.startsWith('-Xms'))
  ensureNativesArgs(jvmArgs, paths.nativesDir)

  // Keep the JVM temp dir inside launcher-owned storage (see BuildLaunchPlanInput.tempDir).
  if (input.tempDir && !hasAny(jvmArgs, (arg) => arg.startsWith('-Djava.io.tmpdir='))) {
    jvmArgs.push(`-Djava.io.tmpdir=${input.tempDir}`)
  }

  const authlibArgs: string[] = []
  if (settings.authlib) {
    authlibArgs.push(`-javaagent:${settings.authlib.javaagentPath}=${settings.authlib.apiRoot}`)
    if (settings.authlib.prefetched) {
      authlibArgs.push(
        `-Dauthlibinjector.yggdrasil.prefetched=${settings.authlib.prefetched}`,
      )
    }
  }

  const extraGc = settings.extraJvmArgs.some(
    (arg) => /^-XX:\+Use.*GC$/.test(arg) || arg.startsWith('-XX:+UseZGC'),
  )
  const gcDefaults = settings.customGc || extraGc ? [] : [...G1_DEFAULTS]

  // Move the version's own `-D...` args behind our managed block but keep the
  // documented order: javaagent → memory/GC/encoding → version args.
  const encodingAdditions = ensureEncoding(
    [...jvmArgs, ...settings.extraJvmArgs, ...authlibArgs],
    settings.codePage,
    settings.javaMajor,
  )
  jvmArgs = [
    ...authlibArgs,
    `-Xms${settings.minMemoryMb}m`,
    `-Xmx${settings.maxMemoryMb}m`,
    ...gcDefaults,
    ...settings.extraJvmArgs,
    ...jvmArgs,
    ...encodingAdditions,
  ]

  // Do NOT deduplicate JVM args with a plain Set: Forge repeats the same
  // `--add-opens`/`--add-exports` flag for multiple package=module values.
  // Collapsing the flag leaves its values looking like JVM/main-class args.
  ensureNativesArgs(jvmArgs, paths.nativesDir)
  ensureBrandArgs(jvmArgs, settings.launcherName, settings.launcherVersion)

  // --- Game arguments ------------------------------------------------------
  let gameArgs: string[] = []
  if (version.arguments?.game && version.arguments.game.length > 0) {
    gameArgs = evaluateArguments(version.arguments.game, ruleContext)
  } else if (version.minecraftArguments) {
    gameArgs = splitLegacyArguments(version.minecraftArguments)
  }

  gameArgs = substitutePlaceholders(gameArgs, placeholders.values)

  const assetIndexName = version.assetIndex?.id ?? version.assets ?? 'legacy'
  ensureFlagValue(gameArgs, '--username', account.name)
  ensureFlagValue(gameArgs, '--uuid', account.uuid)
  ensureFlagValue(gameArgs, '--accessToken', account.accessToken)
  ensureFlagValue(gameArgs, '--userType', account.userType)
  ensureFlagValue(gameArgs, '--version', input.versionName ?? version.id)
  ensureFlagValue(gameArgs, '--gameDir', paths.gameDir)
  ensureFlagValue(gameArgs, '--assetsDir', paths.assetsDir)
  ensureFlagValue(gameArgs, '--assetIndex', assetIndexName)

  if (account.kind === 'offline') {
    // Defensive: some vendor JSONs hard-code empty clientId/xuid pairs.
    gameArgs = removePair(gameArgs, '--clientId')
    gameArgs = removePair(gameArgs, '--xuid')
  }

  if (settings.fullscreen) {
    if (!hasFlag(gameArgs, '--fullscreen')) gameArgs.push('--fullscreen')
  } else {
    gameArgs = stripArgs(gameArgs, (arg) => arg === '--fullscreen')
  }

  if (!hasFlag(gameArgs, '--width') || !hasFlag(gameArgs, '--height')) {
    gameArgs = removePair(gameArgs, '--width')
    gameArgs = removePair(gameArgs, '--height')
    gameArgs.push('--width', String(settings.width), '--height', String(settings.height))
  }

  if (server && !quickPlay) {
    gameArgs = removePair(gameArgs, '--server')
    gameArgs = removePair(gameArgs, '--port')
    gameArgs.push('--server', server.host, '--port', String(server.port))
  }

  gameArgs = dedupeManagedGameFlags(gameArgs)

  const argv = [...jvmArgs, version.mainClass, ...gameArgs]

  const leftover = argv.find((token) => token.includes('${'))
  if (leftover) {
    throw new CoreError('LAUNCH.PLAN_INVALID', {
      message: `unresolved placeholder survived: ${leftover}`,
      details: { token: leftover },
    })
  }

  const env = cleanEnvironment(input.env ?? process.env)

  return {
    sessionId: input.sessionId ?? randomUUID(),
    dryRun: input.dryRun ?? false,
    versionId: version.id,
    mcVersion: input.mcVersion ?? null,
    javaPath: settings.javaPath,
    javaMajor: settings.javaMajor,
    cwd: paths.gameDir,
    argv,
    env,
    classpath: libraries.classpath,
    natives: libraries.natives,
    nativesDir: paths.nativesDir,
    warnings,
    createdAt: now(),
  }
}

/** Adds encoding flags only when they are not already present. */
function ensureEncoding(jvmArgs: string[], codePage: number, javaMajor: number): string[] {
  const encoding = encodingForCodePage(codePage)
  const fileEncoding = fileEncodingForJava(javaMajor, encoding)
  const additions: string[] = []
  if (!hasAny(jvmArgs, (arg) => arg.startsWith('-Dstdout.encoding='))) {
    additions.push(`-Dstdout.encoding=${encoding}`)
  }
  if (!hasAny(jvmArgs, (arg) => arg.startsWith('-Dstderr.encoding='))) {
    additions.push(`-Dstderr.encoding=${encoding}`)
  }
  if (!hasAny(jvmArgs, (arg) => arg.startsWith('-Dfile.encoding='))) {
    additions.push(`-Dfile.encoding=${fileEncoding}`)
  }
  return additions
}

function removePair(args: string[], flag: string): string[] {
  const output: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const next = args[index + 1]
      if (next !== undefined && !next.startsWith('-')) index += 1
      continue
    }
    output.push(args[index])
  }
  return output
}

/** Export for tests that want to assert the exact GC block. */
export { G1_DEFAULTS, NATIVE_JVM_KEYS, cleanEnvironment, supportsQuickPlay }
