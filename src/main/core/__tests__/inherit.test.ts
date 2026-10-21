import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CoreError } from '../errors'
import { flattenVersionChain } from '../version/inherit'
import { detectLoader, detectMinecraftVersion, loadVersionChain, resolveVersion } from '../version/load'
import { joinClasspath, resolveLibraries } from '../version/classpath'
import { isRuleSetAllowed, createRuleContext, evaluateArguments } from '../version/rules'
import { nodeFsPort } from '../ports'
import { makeTempRoot, vanillaVersion, forgeVersion, fabricVersion, legacyVanillaVersion, legacyForgeVersion, writeVersion } from '../__tests__/helpers'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = makeTempRoot()
  cleanup.push(root)
  return root
}

describe('flattenVersionChain', () => {
  it('merges a Forge-style child: mainClass, libraries, arguments', () => {
    const { json, chainIds } = flattenVersionChain([vanillaVersion(), forgeVersion()], {
      now: () => Date.UTC(2026, 9, 21, 5, 0, 0),
    })

    expect(chainIds).toEqual(['1.20.1', '1.20.1-forge-47.2.0'])
    expect(json.id).toBe('1.20.1-forge-47.2.0')
    expect(json.mainClass).toBe('cpw.mods.bootstraplauncher.BootstrapLauncher')
    expect('inheritsFrom' in json).toBe(false)
    expect(json['x-mc-launcher'].flattenedFrom).toEqual(['1.20.1', '1.20.1-forge-47.2.0'])

    // Parent scalar fields survive unless the child overrides them.
    expect(json.assetIndex?.id).toBe('5')
    expect(json.javaVersion?.majorVersion).toBe(17)

    // 6 parent libraries + 1 Forge library; the duplicate logging entry is
    // replaced in place, not appended.
    expect(json.libraries).toHaveLength(7)
    expect(json.libraries?.[0].name).toBe('com.mojang:logging:1.1.1')
    expect(json.libraries?.[0].downloads?.artifact?.path).toContain('logging-1.1.1-forge.jar')
    expect(json.libraries?.at(-1)?.name).toBe('net.minecraftforge:forge:1.20.1-47.2.0')

    const game = json.arguments?.game ?? []
    expect(game).toContain('--launchTarget')
    expect(game).toContain('forgeclient')
    expect(game.filter((value) => value === '--username')).toHaveLength(1)
    expect(json.arguments?.jvm).toContain('-Dforge.logging.markers=REGISTRY,SCAN')
    expect(json.arguments?.jvm).toContain('-cp')
  })

  it('merges a Fabric-style child without losing parent arguments', () => {
    const { json } = flattenVersionChain([vanillaVersion(), fabricVersion()])
    expect(json.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(json.arguments?.jvm).toContain('-DFabricMcEmu=net.minecraft.client.main.Main')
    expect(json.arguments?.jvm).toContain('-Djava.library.path=${natives_directory}')
    expect(json.arguments?.game).toContain('fabricclient')
    expect(json.libraries?.some((library) => library.name === 'net.fabricmc:fabric-loader:0.15.11')).toBe(true)
  })

  it('lets a legacy child replace minecraftArguments instead of concatenating them', () => {
    const { json } = flattenVersionChain([legacyVanillaVersion(), legacyForgeVersion()])
    expect(json.minecraftArguments).toContain('--tweakClass cpw.mods.fml.common.launcher.FMLTweaker')
    expect(json.minecraftArguments?.match(/--username/g)).toHaveLength(1)
    expect(json.jar).toBe('1.7.10')
    expect(json.mainClass).toBe('net.minecraft.launchwrapper.Launch')
  })

  it('is idempotent: flattening an already flattened JSON changes no bytes', () => {
    const now = () => Date.UTC(2026, 9, 21, 5, 0, 0)
    const first = flattenVersionChain([vanillaVersion(), forgeVersion()], { now }).json
    const second = flattenVersionChain([first], { now }).json
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
    expect(second['x-mc-launcher'].flattenedFrom).toEqual(['1.20.1', '1.20.1-forge-47.2.0'])
  })

  it('keeps native classifier variants while merging by group:artifact', () => {
    const { json } = flattenVersionChain([vanillaVersion(), forgeVersion()])
    const lwjgl = (json.libraries ?? [])
      .filter((library) => library.name.startsWith('org.lwjgl:lwjgl:'))
      .map((library) => library.name)
    expect(lwjgl).toContain('org.lwjgl:lwjgl:3.3.1')
    expect(lwjgl).toContain('org.lwjgl:lwjgl:3.3.1:natives-windows')
  })
})

describe('loadVersionChain / resolveVersion', () => {
  it('loads an unflattened chain and resolves the inherited jar', () => {
    const root = tempRoot()
    writeVersion(root, '1.20.1', vanillaVersion(), { jarBytes: 128 })
    writeVersion(root, '1.20.1-forge-47.2.0', forgeVersion())

    const fsPort = nodeFsPort()
    const chain = loadVersionChain(fsPort, root, '1.20.1-forge-47.2.0')
    expect(chain.map((node) => node.id)).toEqual(['1.20.1', '1.20.1-forge-47.2.0'])

    const resolved = resolveVersion(fsPort, root, '1.20.1-forge-47.2.0')
    expect(resolved.loader).toEqual({ type: 'forge', version: '47.2.0' })
    expect(resolved.mcVersion).toBe('1.20.1')
    expect(resolved.javaMajor).toBe(17)
    expect(resolved.clientJar).toBe(path.join(root, 'versions', '1.20.1', '1.20.1.jar'))
    expect(resolved.clientJarExists).toBe(true)
  })

  it('uses the jar field for legacy inheritance', () => {
    const root = tempRoot()
    writeVersion(root, '1.7.10', legacyVanillaVersion(), { jarBytes: 64 })
    writeVersion(root, '1.7.10-forge10.13.4.1614', legacyForgeVersion())

    const resolved = resolveVersion(nodeFsPort(), root, '1.7.10-forge10.13.4.1614')
    expect(resolved.jarVersionId).toBe('1.7.10')
    expect(resolved.loader.type).toBe('forge')
    expect(resolved.mcVersion).toBe('1.7.10')
    expect(resolved.javaMajor).toBe(8)
  })

  it('reports a missing parent with VERSION_PARENT_NOT_FOUND', () => {
    const root = tempRoot()
    writeVersion(root, 'child', { id: 'child', inheritsFrom: 'no-such-parent', mainClass: 'x.Y' })
    let error: unknown
    try {
      loadVersionChain(nodeFsPort(), root, 'child')
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(CoreError)
    expect((error as CoreError).code).toBe('VERSION_PARENT_NOT_FOUND')
  })

  it('detects inheritance cycles', () => {
    const root = tempRoot()
    writeVersion(root, 'a', { id: 'a', inheritsFrom: 'b', mainClass: 'x.Y' })
    writeVersion(root, 'b', { id: 'b', inheritsFrom: 'a', mainClass: 'x.Y' })
    try {
      loadVersionChain(nodeFsPort(), root, 'a')
      throw new Error('expected a cycle error')
    } catch (error) {
      expect((error as CoreError).code).toBe('VERSION.INHERIT_CYCLE')
    }
  })

  it('detects loader metadata from a flattened modpack folder', () => {
    const root = tempRoot()
    const forge = forgeVersion()
    delete forge.inheritsFrom
    forge.id = '史前世界 2'
    writeVersion(root, '史前世界 2', forge, { jarBytes: 16 })

    const resolved = resolveVersion(nodeFsPort(), root, '史前世界 2')
    expect(resolved.loader).toEqual({ type: 'forge', version: '47.2.0' })
    // The Forge library carries the Minecraft version even when the folder name does not.
    expect(resolved.mcVersion).toBe('1.20.1')
  })
})

describe('rules and classpath', () => {
  const windows = createRuleContext('win32', 'x64', { has_custom_resolution: true })

  it('allows an empty rule list and applies OS/arch/features rules', () => {
    expect(isRuleSetAllowed(undefined, windows)).toBe(true)
    expect(isRuleSetAllowed([{ action: 'allow', os: { name: 'windows' } }], windows)).toBe(true)
    expect(isRuleSetAllowed([{ action: 'allow', os: { name: 'linux' } }], windows)).toBe(false)
    expect(
      isRuleSetAllowed([{ action: 'allow', os: { arch: 'x86' } }], windows),
    ).toBe(false)
    expect(
      isRuleSetAllowed(
        [{ action: 'allow', features: { has_custom_resolution: true } }],
        windows,
      ),
    ).toBe(true)
  })

  it('evaluates conditional game arguments', () => {
    const values = evaluateArguments(vanillaVersion().arguments?.game, windows)
    expect(values).toContain('--width')
    expect(values).not.toContain('--demo')
    expect(values).not.toContain('--quickPlayMultiplayer')
  })

  it('builds the Windows classpath and natives plan', () => {
    const root = tempRoot()
    const { json } = flattenVersionChain([vanillaVersion()])
    const libraries = resolveLibraries(json, {
      librariesDir: path.join(root, 'libraries'),
      clientJar: path.join(root, 'versions', '1.20.1', '1.20.1.jar'),
      platform: 'win32',
      arch: 'x64',
      features: { has_custom_resolution: true },
      exists: () => true,
    })

    expect(libraries.allowed).toHaveLength(4) // logging, lwjgl, windows natives, classic native
    expect(libraries.skipped).toHaveLength(2) // linux + macos natives
    expect(libraries.classpath).toHaveLength(4) // 3 libraries + client jar
    expect(libraries.classpath.at(-1)).toContain('1.20.1.jar')
    expect(libraries.natives).toHaveLength(2)
    expect(libraries.natives[0].jarPath).toContain('natives-windows.jar')
    expect(libraries.natives[1].jarPath).toContain('natives-windows-64.jar')
    expect(joinClasspath(libraries.classpath, 'win32')).toContain(';')
    expect(joinClasspath(libraries.classpath, 'win32')).not.toContain('"')
    expect(libraries.missing).toHaveLength(0)
  })

  it('reports missing files when asked to verify existence', () => {
    const root = tempRoot()
    const { json } = flattenVersionChain([vanillaVersion()])
    const libraries = resolveLibraries(json, {
      librariesDir: path.join(root, 'libraries'),
      clientJar: path.join(root, 'versions', '1.20.1', '1.20.1.jar'),
      platform: 'win32',
      arch: 'x64',
      exists: () => false,
    })
    expect(libraries.missing.length).toBe(6) // 5 library jars + client jar
  })
})

describe('loader detection helpers', () => {
  it('recognises NeoForge by its libraries', () => {
    const root = tempRoot()
    const neoforge = {
      id: '1.21.1-NeoForge',
      mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
      libraries: [
        { name: 'net.neoforged:neoforge:21.1.233', url: 'https://example.invalid/' },
      ],
    }
    writeVersion(root, '1.21.1-NeoForge', neoforge, { jarBytes: 8 })
    const resolved = resolveVersion(nodeFsPort(), root, '1.21.1-NeoForge')
    expect(resolved.loader).toEqual({ type: 'neoforge', version: '21.1.233' })
    expect(resolved.mcVersion).toBe('1.21.1')
  })

  it('falls back to vanilla when no loader evidence exists', () => {
    const loader = detectLoader(vanillaVersion())
    expect(loader).toEqual({ type: 'vanilla', version: null })
    const flattened = flattenVersionChain([vanillaVersion()]).json
    const node = {
      id: '1.20.1',
      dirName: '1.20.1',
      dir: '',
      jsonPath: '',
      json: flattened,
    }
    expect(
      detectMinecraftVersion([node], loader, flattened),
    ).toBe('1.20.1')
  })
})
