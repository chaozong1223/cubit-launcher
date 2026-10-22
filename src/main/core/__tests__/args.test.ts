import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CoreError } from '../errors'
import { flattenVersionChain } from '../version/inherit'
import {
  buildLaunchPlan,
  substitutePlaceholders,
  type BuildLaunchPlanInput,
  type LaunchSettings,
} from '../launch/args'
import {
  basePaths,
  forgeVersion,
  legacyVanillaVersion,
  offlineAccount,
  vanillaVersion,
} from '../__tests__/helpers'

const MC_ROOT = path.join('C:\\Games', '.minecraft')
const DIR = '1.20.1'

function flattened(...versions: Parameters<typeof flattenVersionChain>[0]) {
  return flattenVersionChain(versions, { now: () => 1_700_000_000_000 }).json
}

function settings(overrides: Partial<LaunchSettings> = {}): LaunchSettings {
  return {
    javaPath: 'C:\\Java\\jdk-17\\bin\\java.exe',
    javaMajor: 17,
    minMemoryMb: 1024,
    maxMemoryMb: 4096,
    width: 1280,
    height: 720,
    fullscreen: false,
    extraJvmArgs: [],
    server: null,
    authlib: null,
    codePage: 936,
    launcherName: 'mc-launcher',
    launcherVersion: '0.1.0',
    ...overrides,
  }
}

function build(overrides: Partial<BuildLaunchPlanInput> = {}) {
  return buildLaunchPlan({
    version: flattened(vanillaVersion()),
    versionName: '1.20.1',
    mcVersion: '1.20.1',
    account: offlineAccount(),
    paths: basePaths(MC_ROOT, DIR),
    settings: settings(),
    platform: 'win32',
    arch: 'x64',
    exists: () => true,
    sessionId: 'session-fixed',
    now: () => 1_700_000_000_000,
    env: {
      SystemRoot: 'C:\\Windows',
      PATH: 'C:\\Windows\\system32',
      USERPROFILE: 'C:\\Users\\tester',
      JAVA_TOOL_OPTIONS: '-javaagent:C:\\evil.jar',
      _JAVA_OPTIONS: '-Xmx8G',
      JDK_JAVA_OPTIONS: '-Xmx8G',
      CLASSPATH: 'C:\\evil.jar',
    },
    ...overrides,
  })
}

function count(argv: string[], prefix: string): number {
  return argv.filter((token) => token === prefix || token.startsWith(prefix)).length
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}

describe('buildLaunchPlan — vanilla 1.20.1 + offline account', () => {
  it('emits classpath, natives, -D flags and offline credentials', () => {
    const plan = build()
    const argv = plan.argv
    const paths = basePaths(MC_ROOT, DIR)

    expect(plan.sessionId).toBe('session-fixed')
    expect(plan.dryRun).toBe(false)
    expect(plan.cwd).toBe(paths.gameDir)
    expect(argv).toContain('net.minecraft.client.main.Main')

    // Managed arguments appear exactly once.
    expect(count(argv, '-Xmx')).toBe(1)
    expect(argv).toContain('-Xmx4096m')
    expect(argv).toContain('-Xms1024m')
    expect(count(argv, '--username')).toBe(1)
    expect(count(argv, '--uuid')).toBe(1)
    expect(count(argv, '--accessToken')).toBe(1)
    expect(count(argv, '--userType')).toBe(1)
    expect(count(argv, '--width')).toBe(1)
    expect(count(argv, '--height')).toBe(1)

    // Offline four-piece contract (R2.4) and no fake clientId/xuid.
    expect(valueAfter(argv, '--username')).toBe('TestUser')
    expect(valueAfter(argv, '--uuid')).toBe('097d3392-865a-3f3c-8b4a-da1c3473466c')
    expect(valueAfter(argv, '--accessToken')).toBe('0')
    expect(valueAfter(argv, '--userType')).toBe('legacy')
    expect(argv).not.toContain('--clientId')
    expect(argv).not.toContain('--xuid')

    // Game/asset paths.
    expect(valueAfter(argv, '--version')).toBe('1.20.1')
    expect(valueAfter(argv, '--gameDir')).toBe(paths.gameDir)
    expect(valueAfter(argv, '--assetsDir')).toBe(paths.assetsDir)
    expect(valueAfter(argv, '--assetIndex')).toBe('5')
    expect(valueAfter(argv, '--versionType')).toBe('release')
    expect(valueAfter(argv, '--width')).toBe('1280')
    expect(valueAfter(argv, '--height')).toBe('720')
    expect(argv).not.toContain('--fullscreen')

    // Classpath: `-cp` followed by one separator-joined value ending in the jar.
    const cpIndex = argv.indexOf('-cp')
    expect(cpIndex).toBeGreaterThan(0)
    const classpath = argv[cpIndex + 1]
    expect(classpath).toContain(';')
    expect(classpath).toContain('logging-1.1.1.jar')
    expect(classpath).toContain('lwjgl-3.3.1.jar')
    expect(classpath).not.toContain('natives-windows.jar')
    expect(classpath.endsWith(`${DIR}.jar`)).toBe(true)
    expect(classpath).not.toContain('"')

    // Four native directories all point at the instance natives folder.
    for (const key of [
      '-Djava.library.path=',
      '-Djna.tmpdir=',
      '-Dorg.lwjgl.system.SharedLibraryExtractPath=',
      '-Dio.netty.native.workdir=',
    ]) {
      const token = argv.find((value) => value.startsWith(key))
      expect(token?.endsWith(`${DIR}-natives`)).toBe(true)
    }

    // GC, encoding, brand and log4j hardening.
    expect(argv).toContain('-XX:+UnlockExperimentalVMOptions')
    expect(argv).toContain('-XX:+UseG1GC')
    expect(argv).toContain('-XX:MaxGCPauseMillis=50')
    expect(argv).toContain('-Dlog4j2.formatMsgNoLookups=true')
    expect(argv).toContain('-Dstdout.encoding=GBK')
    expect(argv).toContain('-Dstderr.encoding=GBK')
    expect(argv).toContain('-Dfile.encoding=GBK')
    expect(argv).toContain('-Dminecraft.launcher.brand=mc-launcher')
    expect(argv).toContain('-Dminecraft.launcher.version=0.1.0')
    expect(argv).toContain(
      `-Dlog4j.configurationFile=${path.join(MC_ROOT, 'assets', 'log_configs', 'client-1.12.xml')}`,
    )

    // No leftover placeholders anywhere (R1.8).
    expect(argv.some((token) => token.includes('${'))).toBe(false)
  })

  it('scrubs Java agent/classpath environment variables', () => {
    const plan = build()
    expect(plan.env.JAVA_TOOL_OPTIONS).toBeUndefined()
    expect(plan.env._JAVA_OPTIONS).toBeUndefined()
    expect(plan.env.JDK_JAVA_OPTIONS).toBeUndefined()
    expect(plan.env.CLASSPATH).toBeUndefined()
    expect(plan.env.USERPROFILE).toBe('C:\\Users\\tester')
    expect(plan.env.PATH).toBe('C:\\Windows\\system32')
  })

  it('does not leak MCL_* internals or arbitrary secrets into the game env', () => {
    const plan = build({
      env: {
        SystemRoot: 'C:\\Windows',
        PATH: 'C:\\Windows\\system32',
        USERPROFILE: 'C:\\Users\\tester',
        MCL_DATA_DIR: 'C:\\secret-data',
        MCL_REAL_JAVA: '1',
        MCL_CF_API_KEY: 'cf-secret',
        OPENAI_API_KEY: 'secret',
        USERNAME: 'tester',
        COMPUTERNAME: 'DEVBOX',
        NUMBER_OF_PROCESSORS: '8',
        SystemDrive: 'C:',
      },
    })
    expect(plan.env.MCL_DATA_DIR).toBeUndefined()
    expect(plan.env.MCL_REAL_JAVA).toBeUndefined()
    expect(plan.env.MCL_CF_API_KEY).toBeUndefined()
    expect(plan.env.OPENAI_API_KEY).toBeUndefined()
    expect(plan.env.PATH).toBe('C:\\Windows\\system32')
    expect(plan.env.USERNAME).toBe('tester')
    expect(plan.env.COMPUTERNAME).toBe('DEVBOX')
    expect(plan.env.NUMBER_OF_PROCESSORS).toBe('8')
    expect(plan.env.SystemDrive).toBe('C:')
  })

  it('warns about missing files but still builds the dry-run command', () => {
    const plan = build({
      exists: (target) => !target.includes('lwjgl-3.3.1.jar'),
    })
    expect(plan.warnings.length).toBeGreaterThan(0)
    expect(plan.argv).toContain('-cp')
  })
})

describe('buildLaunchPlan — window, server and loader variants', () => {
  it('adds --fullscreen only when requested', () => {
    const plan = build({ settings: settings({ fullscreen: true }) })
    expect(count(plan.argv, '--fullscreen')).toBe(1)
  })

  it('uses quickPlay on 1.20+ instead of the removed --server flag', () => {
    const plan = build({ settings: settings({ server: { host: '127.0.0.1', port: 25565 } }) })
    expect(valueAfter(plan.argv, '--quickPlayMultiplayer')).toBe('127.0.0.1:25565')
    expect(plan.argv).not.toContain('--server')
    expect(plan.argv).not.toContain('--port')
  })

  it('uses --server/--port on legacy versions', () => {
    const plan = build({
      version: flattened(legacyVanillaVersion()),
      versionName: '1.7.10',
      mcVersion: '1.7.10',
      settings: settings({ javaMajor: 8, server: { host: '127.0.0.1', port: 25565 } }),
    })
    expect(valueAfter(plan.argv, '--server')).toBe('127.0.0.1')
    expect(valueAfter(plan.argv, '--port')).toBe('25565')
    expect(plan.argv).not.toContain('--quickPlayMultiplayer')
    expect(valueAfter(plan.argv, '--session')).toBe('0')
    expect(valueAfter(plan.argv, '--assetsDir')).toBe(path.join(MC_ROOT, 'assets'))
  })

  it('keeps the child mainClass and parent libraries for Forge', () => {
    const plan = build({
      version: flattenVersionChain([vanillaVersion(), forgeVersion()]).json,
    })
    expect(plan.argv).toContain('cpw.mods.bootstraplauncher.BootstrapLauncher')
    expect(plan.argv).toContain('--launchTarget')
    expect(plan.argv).toContain('forgeclient')
    const classpath = plan.argv[plan.argv.indexOf('-cp') + 1]
    expect(classpath).toContain('forge-1.20.1-47.2.0-universal.jar')
    expect(classpath).toContain('logging-1.1.1-forge.jar')
    expect(classpath).toContain('lwjgl-3.3.1.jar')
  })

  it('keeps repeated add-opens/add-exports flag-value pairs intact (PCL Forge profile)', () => {
    const profile = {
      ...forgeVersion(),
      arguments: {
        jvm: [
          '-Djava.library.path=${natives_directory}',
          '-DignoreList=client-extra,fmlcore',
          '-Dwith.spaces=hello world',
          '--add-modules',
          'ALL-MODULE-PATH',
          '--add-opens',
          'java.base/java.util.jar=cpw.mods.securejarhandler',
          '--add-opens',
          'java.base/java.lang.invoke=cpw.mods.securejarhandler',
          '--add-exports',
          'java.base/sun.security.util=cpw.mods.securejarhandler',
          '--add-exports',
          'jdk.naming.dns/com.sun.jndi.dns=java.naming',
        ],
        game: ['--launchTarget', 'forgeclient'],
      },
    }
    const plan = build({ version: flattenVersionChain([vanillaVersion(), profile]).json })
    const argv = plan.argv
    const start = argv.indexOf('--add-modules')
    expect(argv.slice(start, start + 8)).toEqual([
      '--add-modules',
      'ALL-MODULE-PATH',
      '--add-opens',
      'java.base/java.util.jar=cpw.mods.securejarhandler',
      '--add-opens',
      'java.base/java.lang.invoke=cpw.mods.securejarhandler',
      '--add-exports',
      'java.base/sun.security.util=cpw.mods.securejarhandler',
    ])
    expect(argv).toContain('jdk.naming.dns/com.sun.jndi.dns=java.naming')
    expect(argv).toContain('-Dwith.spaces=hello world')
    expect(argv).not.toContain('java.base.java.lang.invoke=cpw.mods.securejarhandler')
    expect(count(argv, '--add-opens')).toBe(2)
    expect(count(argv, '--add-exports')).toBe(2)
    // The flag values must never become the main class.
    expect(argv.indexOf('cpw.mods.bootstraplauncher.BootstrapLauncher')).toBeGreaterThan(
      argv.indexOf('jdk.naming.dns/com.sun.jndi.dns=java.naming'),
    )
  })

  it('adds the x86-only argument when arch is x86', () => {
    const x86 = build({ arch: 'x86' })
    const x64 = build({ arch: 'x64' })
    expect(x86.argv).toContain('-Xss1M')
    expect(x64.argv).not.toContain('-Xss1M')
  })
})

describe('buildLaunchPlan — custom JVM args and Authlib', () => {
  it('appends safe custom JVM arguments', () => {
    const plan = build({ settings: settings({ extraJvmArgs: ['-Dmcl.acceptance=1'] }) })
    expect(plan.argv).toContain('-Dmcl.acceptance=1')
  })

  it('rejects managed JVM arguments from the custom list', () => {
    for (const bad of ['-Xmx2G', '-cp', '-javaagent:x.jar', '-Djava.library.path=C:\\natives']) {
      try {
        build({ settings: settings({ extraJvmArgs: [bad] }) })
        throw new Error(`expected rejection for ${bad}`)
      } catch (error) {
        expect((error as CoreError).code).toBe('LAUNCH.PLAN_INVALID')
      }
    }
  })

  it('injects Authlib as the first JVM argument', () => {
    const plan = build({
      settings: settings({
        authlib: {
          javaagentPath: 'C:\\data\\authlib-injector.jar',
          apiRoot: 'https://auth.example.com/api/yggdrasil',
          prefetched: 'BASE64',
        },
      }),
    })
    expect(plan.argv[0]).toBe(
      '-javaagent:C:\\data\\authlib-injector.jar=https://auth.example.com/api/yggdrasil',
    )
    expect(plan.argv).toContain('-Dauthlibinjector.yggdrasil.prefetched=BASE64')
  })

  it('skips the default G1 block when a custom GC is requested', () => {
    const plan = build({
      settings: settings({ extraJvmArgs: ['-XX:+UseZGC'] }),
    })
    expect(plan.argv).toContain('-XX:+UseZGC')
    expect(plan.argv).not.toContain('-XX:+UseG1GC')
  })
})

describe('buildLaunchPlan — quick-play singleplayer (direct world launch)', () => {
  function worldLaunchVersion() {
    const version = structuredClone(vanillaVersion())
    const game = version.arguments?.game
    if (game) {
      game.push({
        rules: [{ action: 'allow', features: { is_quick_play_singleplayer: true } }],
        value: ['--quickPlaySingleplayer', '${quickPlaySingleplayer}'],
      })
    }
    return version
  }

  it('adds --quickPlaySingleplayer with the world folder name', () => {
    const plan = build({
      version: flattened(worldLaunchVersion()),
      settings: settings({ quickPlayWorld: 'World One' }),
    })
    expect(valueAfter(plan.argv, '--quickPlaySingleplayer')).toBe('World One')
    expect(plan.argv).not.toContain('${quickPlaySingleplayer}')
    expect(plan.warnings).toEqual([])
  })

  it('warns and launches normally when the version does not support quick play', () => {
    const plan = build({
      version: flattened(legacyVanillaVersion()),
      mcVersion: '1.7.10',
      settings: settings({ quickPlayWorld: 'World One' }),
    })
    expect(plan.argv).not.toContain('--quickPlaySingleplayer')
    expect(plan.warnings.some((warning) => warning.includes('不支持快速进入存档'))).toBe(true)
  })

  it('prefers the world over an auto-join server', () => {
    const plan = build({
      version: flattened(worldLaunchVersion()),
      settings: settings({
        quickPlayWorld: 'World One',
        server: { host: 'play.example.com', port: 25565 },
      }),
    })
    expect(plan.argv).not.toContain('--server')
    expect(plan.argv).not.toContain('--quickPlayMultiplayer')
    expect(valueAfter(plan.argv, '--quickPlaySingleplayer')).toBe('World One')
    expect(plan.warnings.some((warning) => warning.includes('优先直接进入存档'))).toBe(true)
  })
})

describe('substitutePlaceholders', () => {
  it('drops null placeholders together with their flag', () => {
    expect(
      substitutePlaceholders(
        ['--clientId', '${clientid}', '--xuid', '${auth_xuid}', '--username', '${auth_player_name}'],
        { clientid: null, auth_xuid: null, auth_player_name: 'TestUser' },
      ),
    ).toEqual(['--username', 'TestUser'])
  })

  it('rejects unknown or missing placeholders', () => {
    expect(() => substitutePlaceholders(['${unknown_thing}'], {})).toThrowError(/unresolved/)
    expect(() =>
      substitutePlaceholders(['-Dx=${missing}'], { missing: null }),
    ).toThrowError(/no value/)
  })
})
