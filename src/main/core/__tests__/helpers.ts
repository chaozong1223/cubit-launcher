import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { VersionJson } from '../version/types'
import type { LaunchAccount } from '../launch/args'
import type { LaunchPaths } from '../launch/args'

/** Temp root under the OS temp dir; cleaned by the caller. */
export function makeTempRoot(prefix = 'mcl-test-'): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export interface WriteVersionOptions {
  /** Omit to simulate a missing jar. */
  jarBytes?: number
  jsonOverride?: unknown
}

export function writeVersion(
  mcRoot: string,
  dirName: string,
  json: VersionJson,
  options: WriteVersionOptions = {},
): string {
  const dir = path.join(mcRoot, 'versions', dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${dirName}.json`),
    JSON.stringify(options.jsonOverride ?? json, null, 2),
    'utf8',
  )
  if (options.jarBytes !== undefined) {
    fs.writeFileSync(path.join(dir, `${dirName}.jar`), Buffer.alloc(options.jarBytes, 0))
  }
  return dir
}

export function writeRawVersion(mcRoot: string, dirName: string, text: string): void {
  const dir = path.join(mcRoot, 'versions', dirName)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${dirName}.json`), text, 'utf8')
}

function download(pathname: string): { path: string; url: string; sha1: string; size: number } {
  return {
    path: pathname,
    url: `https://example.invalid/${pathname}`,
    sha1: '0'.repeat(40),
    size: 100,
  }
}

/** Slim but structurally faithful 1.20.1 profile (88 libraries trimmed). */
export function vanillaVersion(): VersionJson {
  return {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: {
      id: '5',
      sha1: 'e1e23f09e9f518f5b8f76dac10524ebf07691d86',
      size: 413067,
      totalSize: 650564794,
      url: 'https://piston-meta.mojang.com/v1/packages/5.json',
    },
    downloads: {
      client: {
        sha1: '0c3ec587af28e5a785c0b4a7b8a30f9a8f78f838',
        size: 23028853,
        url: 'https://piston-data.mojang.com/v1/objects/client.jar',
      },
    },
    javaVersion: { component: 'java-runtime-beta', majorVersion: 17 },
    logging: {
      client: {
        argument: '-Dlog4j.configurationFile=${path}',
        file: {
          id: 'client-1.12.xml',
          sha1: 'bd65e7d2e3c237be76cfbef4c2405033d7f91521',
          size: 888,
          url: 'https://piston-data.mojang.com/v1/objects/client-1.12.xml',
        },
      },
    },
    libraries: [
      {
        name: 'com.mojang:logging:1.1.1',
        downloads: { artifact: download('com/mojang/logging/1.1.1/logging-1.1.1.jar') },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1',
        downloads: { artifact: download('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar') },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1:natives-windows',
        rules: [{ action: 'allow', os: { name: 'windows' } }],
        downloads: {
          artifact: download('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar'),
        },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1:natives-linux',
        rules: [{ action: 'allow', os: { name: 'linux' } }],
        downloads: {
          artifact: download('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar'),
        },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1:natives-macos',
        rules: [{ action: 'allow', os: { name: 'osx' } }],
        downloads: {
          artifact: download('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-macos.jar'),
        },
      },
      {
        name: 'org.example:classic-native:1.0',
        natives: { windows: 'natives-windows-${arch}' },
        extract: { exclude: ['META-INF/'] },
        downloads: {
          artifact: download('org/example/classic-native/1.0/classic-native-1.0.jar'),
          classifiers: {
            'natives-windows-64': download(
              'org/example/classic-native/1.0/classic-native-1.0-natives-windows-64.jar',
            ),
          },
        },
      },
    ],
    arguments: {
      game: [
        '--username',
        '${auth_player_name}',
        '--version',
        '${version_name}',
        '--gameDir',
        '${game_directory}',
        '--assetsDir',
        '${assets_root}',
        '--assetIndex',
        '${assets_index_name}',
        '--uuid',
        '${auth_uuid}',
        '--accessToken',
        '${auth_access_token}',
        '--clientId',
        '${clientid}',
        '--xuid',
        '${auth_xuid}',
        '--userType',
        '${user_type}',
        '--versionType',
        '${version_type}',
        {
          rules: [{ action: 'allow', features: { has_custom_resolution: true } }],
          value: ['--width', '${resolution_width}', '--height', '${resolution_height}'],
        },
        {
          rules: [{ action: 'allow', features: { is_quick_play_multiplayer: true } }],
          value: ['--quickPlayMultiplayer', '${quickPlayMultiplayer}'],
        },
      ],
      jvm: [
        '-Djava.library.path=${natives_directory}',
        '-Djna.tmpdir=${natives_directory}',
        '-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}',
        '-Dio.netty.native.workdir=${natives_directory}',
        '-Dminecraft.launcher.brand=${launcher_name}',
        '-Dminecraft.launcher.version=${launcher_version}',
        '-cp',
        '${classpath}',
        {
          rules: [{ action: 'allow', os: { name: 'osx' } }],
          value: ['-XstartOnFirstThread'],
        },
        {
          rules: [{ action: 'allow', os: { arch: 'x86' } }],
          value: ['-Xss1M'],
        },
      ],
    },
  }
}

export function forgeVersion(): VersionJson {
  return {
    id: '1.20.1-forge-47.2.0',
    inheritsFrom: '1.20.1',
    type: 'release',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [
      {
        name: 'net.minecraftforge:forge:1.20.1-47.2.0',
        downloads: {
          artifact: download(
            'net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0-universal.jar',
          ),
        },
      },
      {
        // Same group:artifact as the parent: must override in place.
        name: 'com.mojang:logging:1.1.1',
        downloads: {
          artifact: download('com/mojang/logging/1.1.1/logging-1.1.1-forge.jar'),
        },
      },
    ],
    arguments: {
      jvm: ['-Dforge.logging.markers=REGISTRY,SCAN'],
      game: ['--launchTarget', 'forgeclient'],
    },
  }
}

export function fabricVersion(): VersionJson {
  return {
    id: '1.20.1-fabric-0.15.11',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [
      {
        name: 'net.fabricmc:fabric-loader:0.15.11',
        downloads: {
          artifact: download(
            'net/fabricmc/fabric-loader/0.15.11/fabric-loader-0.15.11.jar',
          ),
        },
      },
      {
        name: 'net.fabricmc:intermediary:1.20.1',
        downloads: {
          artifact: download('net/fabricmc/intermediary/1.20.1/intermediary-1.20.1.jar'),
        },
      },
    ],
    arguments: {
      jvm: ['-DFabricMcEmu=net.minecraft.client.main.Main'],
      game: ['--launchTarget', 'fabricclient'],
    },
  }
}

export function legacyVanillaVersion(): VersionJson {
  return {
    id: '1.7.10',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    minecraftArguments:
      '--username ${auth_player_name} --session ${auth_session} --version ${version_name} --gameDir ${game_directory} --assetsDir ${game_assets}',
    libraries: [
      {
        name: 'net.minecraft:launchwrapper:1.11',
        url: 'https://libraries.minecraft.net/',
      },
    ],
    assetIndex: {
      id: '1.7.10',
      url: 'https://example.invalid/1.7.10.json',
    },
  }
}

export function legacyForgeVersion(): VersionJson {
  return {
    id: '1.7.10-forge10.13.4.1614',
    inheritsFrom: '1.7.10',
    jar: '1.7.10',
    mainClass: 'net.minecraft.launchwrapper.Launch',
    minecraftArguments:
      '--username ${auth_player_name} --session ${auth_session} --version ${version_name} --gameDir ${game_directory} --assetsDir ${game_assets} --tweakClass cpw.mods.fml.common.launcher.FMLTweaker',
    libraries: [
      {
        name: 'net.minecraftforge:forge:1.7.10-10.13.4.1614-1.7.10',
        url: 'https://files.minecraftforge.net/maven/',
      },
    ],
  }
}

export function offlineAccount(overrides: Partial<LaunchAccount> = {}): LaunchAccount {
  return {
    kind: 'offline',
    name: 'TestUser',
    uuid: '097d3392-865a-3f3c-8b4a-da1c3473466c',
    accessToken: '0',
    userType: 'legacy',
    ...overrides,
  }
}

export function basePaths(mcRoot: string, dirName: string): LaunchPaths {
  const versionDir = path.join(mcRoot, 'versions', dirName)
  return {
    mcRoot,
    versionDir,
    gameDir: versionDir,
    assetsDir: path.join(mcRoot, 'assets'),
    librariesDir: path.join(mcRoot, 'libraries'),
    nativesDir: path.join(versionDir, `${dirName}-natives`),
    clientJar: path.join(versionDir, `${dirName}.jar`),
  }
}

export const TEST_UUID = '097d3392-865a-3f3c-8b4a-da1c3473466c'
