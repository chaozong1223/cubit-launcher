import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import { nodeFsPort } from '../../../core/ports'
import { resolveVersion } from '../../../core/version/load'
import { resolveLibraries } from '../../../core/version/classpath'
import { openZipFile } from '../../../core/zip/reader'
import { createStoredZip } from '../archive'
import { ModsModuleService } from '../service'
import { makeHandlers } from '../handlers'
import { compareVersions, satisfiesRange } from '../metadata'
import type { FileDownloadOptions } from '../downloader'
import { AppError } from '@shared/errors'
import { contract as modsContract } from '@shared/mods'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
} as unknown as ScopedLogger

interface Fixture {
  root: string
  mcRoot: string
  dataRoot: string
  instanceDir: string
  service: ModsModuleService
}

function writeFile(target: string, data: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
}

function makeZip(target: string, entries: Array<{ name: string; data: string | Buffer }>): void {
  writeFile(target, createStoredZip(entries.map((entry) => ({ name: entry.name, data: Buffer.from(entry.data) }))))
}

function fabricMod(id: string, version: string, depends: Record<string, string> = {}): Buffer {
  return createStoredZip([
    {
      name: 'fabric.mod.json',
      data: Buffer.from(
        JSON.stringify({ schemaVersion: 1, id, name: `${id} display`, version, depends }),
      ),
    },
    { name: `${id}.class`, data: Buffer.from(`class ${id}`) },
  ])
}

function forgeMod(versionRange = '[2.0,3.0)'): Buffer {
  const toml = `modLoader="javafml"
loaderVersion="[47,)"
license="MIT"
[[mods]]
modId="forgeexample"
version="1.0.0"
displayName="Forge Example"
[[dependencies.forgeexample]]
modId="forge"
mandatory=true
versionRange="[47,)"
ordering="NONE"
side="BOTH"
[[dependencies.forgeexample]]
modId="missinglib"
mandatory=true
versionRange="${versionRange}"
ordering="NONE"
side="BOTH"
`
  return createStoredZip([
    { name: 'META-INF/mods.toml', data: Buffer.from(toml) },
    { name: 'forgeexample.class', data: Buffer.from('class forgeexample') },
  ])
}

function versionJson(id = '1.20.1'): string {
  return JSON.stringify({
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: id,
    assetIndex: {
      id,
      sha1: '0'.repeat(40),
      size: 0,
      totalSize: 0,
      url: 'https://example.invalid/assets.json',
    },
    downloads: {
      client: {
        sha1: '0'.repeat(40),
        size: 0,
        url: 'https://example.invalid/client.jar',
      },
    },
    libraries: [],
    arguments: { game: [], jvm: [] },
  })
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-mods-'))
  cleanup.push(root)
  const mcRoot = path.join(root, 'mc')
  const dataRoot = path.join(root, 'data')
  const versionDir = path.join(mcRoot, 'versions', '1.20.1')
  writeFile(path.join(versionDir, '1.20.1.json'), versionJson())
  writeFile(path.join(versionDir, '1.20.1.jar'), 'client-jar')
  // Installed loader profiles used by import tests. A real loader installer
  // creates versions/<loader-dir>/<loader-dir>.json with inheritsFrom base.
  writeFile(
    path.join(
      mcRoot,
      'versions',
      'fabric-loader-0.15.0-1.20.1',
      'fabric-loader-0.15.0-1.20.1.json',
    ),
    JSON.stringify({
      id: 'fabric-loader-0.15.0-1.20.1',
      type: 'release',
      inheritsFrom: '1.20.1',
      mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
      libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }],
      arguments: {
        game: [],
        jvm: ['-DFabricMcEmu=net.minecraft.client.main.Main', '-Dfabric.side=client'],
      },
    }),
  )
  writeFile(
    path.join(mcRoot, 'versions', 'forge-47.2.0-1.20.1', 'forge-47.2.0-1.20.1.json'),
    JSON.stringify({
      id: 'forge-47.2.0-1.20.1',
      type: 'release',
      inheritsFrom: '1.20.1',
      mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
      libraries: [{ name: 'net.minecraftforge:fmlloader:1.20.1-47.2.0' }],
      arguments: { game: [], jvm: ['-Dforge.logging.console.level=debug'] },
    }),
  )
  writeFile(
    path.join(versionDir, 'instance.json'),
    JSON.stringify({
      schemaVersion: 1,
      id: '1.20.1',
      dirName: '1.20.1',
      name: 'Test Instance',
      mcVersion: '1.20.1',
      loader: { type: 'fabric', version: '0.15.0' },
      isolation: 'isolated',
      createdAt: 1,
    }),
  )
  const service = new ModsModuleService({
    roots: { dataRoot, mcRoot },
    log: logger,
    fs: nodeFsPort(),
    now: () => 1_700_000_000_000,
  })
  return { root, mcRoot, dataRoot, instanceDir: versionDir, service }
}

function writeFiles(fixture: Fixture): void {
  writeFile(path.join(fixture.instanceDir, 'mods', 'example.jar'), fabricMod('examplemod', '1.0.0', {
    fabricloader: '>=0.15.0',
    minecraft: '1.19.x',
    'fabric-api': '>=0.90.0',
    missinglib: '>=2.0.0',
  }))
  writeFile(path.join(fixture.instanceDir, 'mods', 'fabric-api.jar'), fabricMod('fabric-api', '0.80.0'))
  writeFile(path.join(fixture.instanceDir, 'mods', 'forgeexample.jar'), forgeMod())
  writeFile(path.join(fixture.instanceDir, 'mods', 'old.jar.disabled'), fabricMod('oldmod', '1.0.0'))
  makeZip(path.join(fixture.instanceDir, 'resourcepacks', 'pack.zip'), [
    { name: 'pack.mcmeta', data: JSON.stringify({ pack: { pack_format: 15 } }) },
  ])
  makeZip(path.join(fixture.instanceDir, 'resourcepacks', 'off.zip.disabled'), [
    { name: 'pack.mcmeta', data: JSON.stringify({ pack: { pack_format: 15 } }) },
  ])
  makeZip(path.join(fixture.instanceDir, 'shaderpacks', 'shader.zip'), [
    { name: 'shaders/shader.frag', data: 'void main() {}' },
  ])
}

/** Runs an import job to completion (the RPC itself only returns a jobId). */
async function runImport(
  service: ModsModuleService,
  input: { filePath: string; name?: string },
) {
  const started = await service.importModpack(input)
  const outcome = await service.waitForImport(started.jobId, 30_000)
  return { started, outcome }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const began = Date.now()
  while (!predicate()) {
    if (Date.now() - began > timeoutMs) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function listPartFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { recursive: true }) as string[]
  return entries.filter((name) => name.endsWith('.part'))
}

describe('mods contract wiring', () => {
  it('exposes one handler per contract method (kernel binding would fail otherwise)', () => {
    const handlers = makeHandlers({} as unknown as ModsModuleService) as Record<string, unknown>
    for (const method of Object.keys(modsContract.methods)) {
      expect(typeof handlers[method]).toBe('function')
    }
    expect(Object.keys(modsContract.methods)).toEqual(
      expect.arrayContaining([
        'importModpack',
        'cancelImport',
        'pauseImport',
        'resumeImport',
        'importStatus',
        'importResult',
      ]),
    )
  })
})

describe('scan and dependency analysis', () => {
  it('classifies enabled/disabled resources and reports metadata dependency issues', async () => {
    const fixture = createFixture()
    writeFiles(fixture)
    const scan = await fixture.service.scan({ instanceId: '1.20.1' })

    expect(scan.totals).toEqual({ enabled: 5, disabled: 2 })
    expect(scan.files.mods.enabled.map((mod) => mod.name)).toEqual([
      'example.jar',
      'fabric-api.jar',
      'forgeexample.jar',
    ])
    expect(scan.files.mods.disabled[0]).toMatchObject({ name: 'old.jar', fileName: 'old.jar.disabled' })
    expect(scan.files.resourcepacks.disabled[0].name).toBe('off.zip')
    expect(scan.files.shaderpacks.enabled[0].name).toBe('shader.zip')
    expect(scan.files.mods.enabled[0].metadata).toMatchObject({
      id: 'examplemod',
      version: '1.0.0',
      loader: 'fabric',
    })

    const kinds = scan.issues.map((issue) => `${issue.kind}:${issue.dependency}`)
    expect(kinds).toContain('mc-mismatch:minecraft')
    expect(kinds).toContain('version-mismatch:fabric-api')
    expect(kinds).toContain('missing:missinglib')
    expect(kinds).toContain('loader-mismatch:forge')
    expect(scan.issues.find((issue) => issue.dependency === 'missinglib')?.message).toContain(
      '缺少前置',
    )
  })

  it('supports scanning a single kind', async () => {
    const fixture = createFixture()
    writeFiles(fixture)
    const scan = await fixture.service.scan({ instanceId: '1.20.1', kind: 'mods' })
    expect(scan.files.mods.enabled).toHaveLength(3)
    expect(scan.files.resourcepacks.enabled).toHaveLength(0)
    expect(scan.files.shaderpacks.enabled).toHaveLength(0)
  })

  it('parses NeoForge mods.toml and optional dependencies', async () => {
    const fixture = createFixture()
    const toml = `[[mods]]
modId="neomod"
version="2.0"
displayName="Neo"
[[dependencies.neomod]]
modId="neoforge"
mandatory=false
versionRange="[20.4,)"
[[dependencies.neomod]]
modId="optional-lib"
mandatory=false
versionRange="[1,)"
`
    makeZip(path.join(fixture.instanceDir, 'mods', 'neo.jar'), [
      { name: 'META-INF/neoforge.mods.toml', data: toml },
    ])
    const scan = await fixture.service.scan({ instanceId: '1.20.1' })
    expect(scan.files.mods.enabled[0].metadata).toMatchObject({
      id: 'neomod',
      loader: 'neoforge',
    })
    expect(scan.issues).toEqual([])
  })
})

describe('version ranges', () => {
  it('accepts Forge Maven ranges and Fabric comparators', () => {
    expect(satisfiesRange('1.20.1', '[1.20,1.21)')).toBe(true)
    expect(satisfiesRange('1.21', '[1.20,1.21)')).toBe(false)
    expect(satisfiesRange('1.20.1', '>=1.20 <1.21')).toBe(true)
    expect(satisfiesRange('1.21.1', '~1.20.1')).toBe(false)
    expect(satisfiesRange('1.20.5', '^1.20')).toBe(true)
    expect(satisfiesRange('1.20.1', '1.20.x')).toBe(true)
    expect(compareVersions('1.20.1', '1.20.0')).toBeGreaterThan(0)
    expect(compareVersions('0.80.0', '0.90.0')).toBeLessThan(0)
  })
})

describe('batch enable/disable/delete', () => {
  it('renames multiple files through .disabled and can restore/delete them', async () => {
    const fixture = createFixture()
    writeFiles(fixture)

    const disabled = await fixture.service.setEnabled({
      instanceId: '1.20.1',
      kind: 'mods',
      names: ['example.jar', 'forgeexample.jar'],
      enabled: false,
    })
    expect(disabled.changed.sort()).toEqual(['example.jar', 'forgeexample.jar'])
    expect(fs.existsSync(path.join(fixture.instanceDir, 'mods', 'example.jar.disabled'))).toBe(true)
    expect(fs.existsSync(path.join(fixture.instanceDir, 'mods', 'forgeexample.jar.disabled'))).toBe(true)

    const enabled = await fixture.service.setEnabled({
      instanceId: '1.20.1',
      kind: 'mods',
      names: ['example.jar.disabled', 'forgeexample.jar'],
      enabled: true,
    })
    expect(enabled.changed.sort()).toEqual(['example.jar', 'forgeexample.jar'])
    expect(fs.existsSync(path.join(fixture.instanceDir, 'mods', 'example.jar'))).toBe(true)

    const removed = await fixture.service.remove({
      instanceId: '1.20.1',
      kind: 'mods',
      names: ['forgeexample.jar'],
    })
    expect(removed.changed).toEqual(['forgeexample.jar'])
    expect(fs.existsSync(path.join(fixture.instanceDir, 'mods', 'forgeexample.jar'))).toBe(false)

    const missing = await fixture.service.remove({
      instanceId: '1.20.1',
      kind: 'mods',
      names: ['nope'],
    })
    expect(missing.errors[0].name).toBe('nope')
  })

  it('does not overwrite an existing enabled/disabled counterpart', async () => {
    const fixture = createFixture()
    writeFile(path.join(fixture.instanceDir, 'mods', 'clash.jar'), fabricMod('clash', '1.0.0'))
    writeFile(path.join(fixture.instanceDir, 'mods', 'clash.jar.disabled'), fabricMod('clash', '2.0.0'))
    const result = await fixture.service.setEnabled({
      instanceId: '1.20.1',
      kind: 'mods',
      names: ['clash'],
      enabled: false,
    })
    expect(result.errors[0].message).toContain('已存在')
    expect(fs.existsSync(path.join(fixture.instanceDir, 'mods', 'clash.jar'))).toBe(true)
  })
})

describe('local file install', () => {
  it('installs a jar through the unified entry and avoids name collisions', async () => {
    const fixture = createFixture()
    const source = path.join(fixture.root, 'My Mod.jar')
    writeFile(source, fabricMod('mymod', '1.2.3'))
    const first = await fixture.service.installLocalFile({
      instanceId: '1.20.1',
      path: source,
    })
    expect(first.kind).toBe('mods')
    expect(first.file.metadata?.id).toBe('mymod')
    expect(first.targetPath).toBe(path.join(fixture.instanceDir, 'mods', 'My Mod.jar'))

    const second = await fixture.service.installLocalFile({
      instanceId: '1.20.1',
      path: source,
    })
    expect(second.file.fileName).toBe('My Mod (1).jar')
  })

  it('infers shaderpacks vs resourcepacks from zip content', async () => {
    const fixture = createFixture()
    const shader = path.join(fixture.root, 'shader.zip')
    makeZip(shader, [{ name: 'shaders/shader.frag', data: 'x' }])
    const shaderResult = await fixture.service.installLocalFile({
      instanceId: '1.20.1',
      path: shader,
    })
    expect(shaderResult.kind).toBe('shaderpacks')

    const resource = path.join(fixture.root, 'resource.zip')
    makeZip(resource, [{ name: 'pack.mcmeta', data: '{}' }])
    const resourceResult = await fixture.service.installLocalFile({
      instanceId: '1.20.1',
      path: resource,
      kind: 'resourcepacks',
    })
    expect(resourceResult.kind).toBe('resourcepacks')
  })

  it('rejects modpacks from installLocalFile so import remains explicit', async () => {
    const fixture = createFixture()
    const pack = path.join(fixture.root, 'test.mrpack')
    makeZip(pack, [
      {
        name: 'modrinth.index.json',
        data: JSON.stringify({ formatVersion: 1, game: 'minecraft', files: [], dependencies: {} }),
      },
    ])
    await expect(
      fixture.service.installLocalFile({ instanceId: '1.20.1', path: pack }),
    ).rejects.toMatchObject({ code: 'MODS.USE_IMPORT' })
  })
})

describe('modpack import/export', () => {
  it('rejects a loader pack when the loader profile is not installed', async () => {
    const fixture = createFixture()
    fs.rmSync(path.join(fixture.mcRoot, 'versions', 'fabric-loader-0.15.0-1.20.1'), {
      recursive: true,
      force: true,
    })
    const pack = path.join(fixture.root, 'missing-loader.mrpack')
    makeZip(pack, [
      {
        name: 'modrinth.index.json',
        data: JSON.stringify({
          formatVersion: 1,
          game: 'minecraft',
          versionId: '1.0.0',
          name: 'Missing Loader',
          files: [],
          dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
        }),
      },
    ])
    await expect(fixture.service.importModpack({ filePath: pack })).rejects.toMatchObject({
      code: 'MODS.LOADER_NOT_INSTALLED',
    })
    expect(fs.existsSync(path.join(fixture.mcRoot, 'versions', 'Missing-Loader'))).toBe(false)
  })

  it('imports a Modrinth .mrpack, downloads hashed files and extracts overrides', async () => {
    const fixture = createFixture()
    const apiJar = fabricMod('fabric-api', '0.92.0')
    const url = 'https://cdn.example.invalid/fabric-api.jar'
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '1.0.0',
      name: 'Example Pack',
      files: [
        {
          path: 'mods/fabric-api.jar',
          hashes: {
            sha1: crypto.createHash('sha1').update(apiJar).digest('hex'),
            sha512: crypto.createHash('sha512').update(apiJar).digest('hex'),
          },
          downloads: [url],
          fileSize: apiJar.length,
        },
        {
          path: 'mods/server-only.jar',
          hashes: {},
          downloads: [],
          env: { client: 'unsupported' },
        },
      ],
      dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
    }
    const pack = path.join(fixture.root, 'example.mrpack')
    makeZip(pack, [
      { name: 'modrinth.index.json', data: JSON.stringify(index) },
      { name: 'overrides/config/auto.json', data: '{"auto":true}' },
    ])
    const service = new ModsModuleService({
      roots: { dataRoot: fixture.dataRoot, mcRoot: fixture.mcRoot },
      log: logger,
      fs: nodeFsPort(),
      downloader: { download: async () => apiJar },
      now: () => 1_700_000_000_000,
    })

    const { outcome } = await runImport(service, { filePath: pack })
    expect(outcome.ok).toBe(true)
    const result = outcome.result!
    expect(result).toMatchObject({
      format: 'modrinth',
      name: 'Example Pack',
      mcVersion: '1.20.1',
      loader: { type: 'fabric', version: '0.15.0' },
      downloaded: 1,
      skipped: 1,
      needsBaseInstall: false,
    })
    const importedDir = path.join(fixture.mcRoot, 'versions', result.dirName)
    const merged = JSON.parse(
      fs.readFileSync(path.join(importedDir, `${result.dirName}.json`), 'utf8'),
    ) as {
      mainClass: string
      inheritsFrom: string
      libraries: Array<{ name: string }>
      arguments: { jvm: string[] }
    }
    expect(merged.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(merged.inheritsFrom).toBe('1.20.1')
    expect(merged.libraries.map((library) => library.name)).toContain(
      'net.fabricmc:fabric-loader:0.15.0',
    )
    expect(merged.arguments.jvm).toContain('-DFabricMcEmu=net.minecraft.client.main.Main')
    // Dry-run resolves the same chain the launch orchestrator uses.
    const resolved = resolveVersion(nodeFsPort(), fixture.mcRoot, result.dirName)
    expect(resolved.json.mainClass).toBe(
      'net.fabricmc.loader.impl.launch.knot.KnotClient',
    )
    expect(resolved.json.libraries?.map((library) => library.name)).toContain(
      'net.fabricmc:fabric-loader:0.15.0',
    )
    const classpath = resolveLibraries(resolved.json, {
      librariesDir: path.join(fixture.mcRoot, 'libraries'),
      clientJar: path.join(importedDir, `${result.dirName}.jar`),
      platform: 'win32',
      exists: () => true,
    }).classpath
    expect(classpath.join(';')).toContain('fabric-loader')
    expect(fs.existsSync(path.join(importedDir, 'mods', 'fabric-api.jar'))).toBe(true)
    expect(fs.readFileSync(path.join(importedDir, 'config', 'auto.json'), 'utf8')).toBe(
      '{"auto":true}',
    )
    expect(fs.existsSync(path.join(importedDir, 'instance.json'))).toBe(true)
    expect(fs.existsSync(path.join(importedDir, `${result.dirName}.json`))).toBe(true)
    expect(fs.existsSync(path.join(importedDir, `${result.dirName}.jar`))).toBe(true)
  })

  it('imports a CurseForge manifest with resolver + overrides and skips optional failures', async () => {
    const fixture = createFixture()
    const modJar = fabricMod('cfmod', '1.0.0')
    const manifest = {
      minecraft: {
        version: '1.20.1',
        modLoaders: [{ id: 'forge-47.2.0', primary: true }],
      },
      manifestType: 'minecraftModpack',
      name: 'CF Pack',
      files: [
        { projectID: 111, fileID: 222, required: true },
        { projectID: 333, fileID: 444, required: false },
      ],
    }
    const pack = path.join(fixture.root, 'cf.zip')
    makeZip(pack, [
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      { name: 'overrides/config/cf.json', data: '{"cf":true}' },
    ])
    const service = new ModsModuleService({
      roots: { dataRoot: fixture.dataRoot, mcRoot: fixture.mcRoot },
      log: logger,
      fs: nodeFsPort(),
      downloader: { download: async () => modJar },
      curseResolver: async (projectID) => {
        if (projectID === 333) throw new Error('optional unavailable')
        return {
          fileName: 'cfmod.jar',
          downloadUrl: 'https://edge.example.invalid/cfmod.jar',
          hashes: { sha1: crypto.createHash('sha1').update(modJar).digest('hex') },
        }
      },
      now: () => 1_700_000_000_000,
    })
    const { outcome } = await runImport(service, { filePath: pack })
    expect(outcome.ok).toBe(true)
    const result = outcome.result!
    expect(result).toMatchObject({
      format: 'curseforge',
      mcVersion: '1.20.1',
      loader: { type: 'forge', version: '47.2.0' },
      downloaded: 1,
      skipped: 1,
    })
    expect(result.warnings.some((warning) => warning.includes('可选文件'))).toBe(true)
    const importedDir = path.join(fixture.mcRoot, 'versions', result.dirName)
    expect(fs.existsSync(path.join(importedDir, 'mods', 'cfmod.jar'))).toBe(true)
    expect(fs.existsSync(path.join(importedDir, 'config', 'cf.json'))).toBe(true)
  })

  it('exports enabled mods as index entries and all overrides, then re-imports reproducibly', async () => {
    const fixture = createFixture()
    writeFiles(fixture)
    const outPath = path.join(fixture.root, 'exported.mrpack')
    const exported = await fixture.service.exportModpack({
      instanceId: '1.20.1',
      outPath,
    })
    expect(exported.format).toBe('mrpack')
    expect(exported.files).toBeGreaterThan(0)

    const archive = openZipFile(nodeFsPort(), outPath)
    expect(archive.has('modrinth.index.json')).toBe(true)
    const index = JSON.parse(archive.read('modrinth.index.json').toString('utf8')) as {
      files: Array<{ path: string; downloads: string[] }>
      dependencies: Record<string, string>
    }
    expect(index.files.map((file) => file.path)).toContain('mods/example.jar')
    expect(index.files.some((file) => file.path.includes('old.jar.disabled'))).toBe(false)
    expect(index.dependencies.minecraft).toBe('1.20.1')
    expect(index.dependencies['fabric-loader']).toBe('0.15.0')
    expect(archive.has('overrides/mods/old.jar.disabled')).toBe(true)
    expect(archive.has('overrides/config/')).toBe(false)
    expect(archive.has('overrides/resourcepacks/pack.zip')).toBe(true)

    // The exported pack carries its jars in overrides, so an empty downloads
    // list is still reproducible for our own importer.
    const service = new ModsModuleService({
      roots: { dataRoot: fixture.dataRoot, mcRoot: fixture.mcRoot },
      log: logger,
      fs: nodeFsPort(),
      downloader: { download: async () => { throw new Error('must not download') } },
      now: () => 1_700_000_000_000,
    })
    const { outcome: reimportOutcome } = await runImport(service, { filePath: outPath })
    expect(reimportOutcome.ok).toBe(true)
    const reimported = reimportOutcome.result!
    expect(reimported.downloaded).toBe(0)
    expect(reimported.skipped).toBeGreaterThan(0)
    expect(
      fs.existsSync(path.join(fixture.mcRoot, 'versions', reimported.dirName, 'mods', 'example.jar')),
    ).toBe(true)
  })

  it('warns and skips a single CurseForge file that returns 404', async () => {
    const fixture = createFixture()
    const modJar = fabricMod('kept', '1.0.0')
    const manifest = {
      minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
      manifestType: 'minecraftModpack',
      name: 'Partial CF Pack',
      files: [
        { projectID: 111, fileID: 222, required: true },
        { projectID: 333, fileID: 444, required: true },
      ],
    }
    const pack = path.join(fixture.root, 'partial-cf.zip')
    makeZip(pack, [
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      { name: 'overrides/config/kept.json', data: '{"kept":true}' },
    ])
    const service = new ModsModuleService({
      roots: { dataRoot: fixture.dataRoot, mcRoot: fixture.mcRoot },
      log: logger,
      fs: nodeFsPort(),
      downloader: { download: async () => modJar },
      curseResolver: async (projectID) => {
        if (projectID === 111) {
          throw new AppError('MODS.CF_FILE_NOT_FOUND', 'CurseForge 文件不存在（可能已被作者删除）')
        }
        return {
          fileName: 'kept.jar',
          downloadUrl: 'https://edge.example.invalid/kept.jar',
          hashes: { sha1: crypto.createHash('sha1').update(modJar).digest('hex') },
        }
      },
    })
    const { outcome } = await runImport(service, { filePath: pack })
    expect(outcome.ok).toBe(true)
    expect(outcome.result).toMatchObject({ downloaded: 1, skipped: 1 })
    expect(outcome.result?.warnings.some((warning) => warning.includes('文件不存在'))).toBe(true)
    const importedDir = path.join(fixture.mcRoot, 'versions', outcome.result!.dirName)
    expect(fs.existsSync(path.join(importedDir, 'mods', 'kept.jar'))).toBe(true)
    expect(fs.existsSync(path.join(importedDir, 'config', 'kept.json'))).toBe(true)
  })

  it('keeps overrides and reports missing CurseForge API credentials honestly', async () => {
    const fixture = createFixture()
    const manifest = {
      minecraft: { version: '1.20.1', modLoaders: [{ id: 'forge-47.2.0', primary: true }] },
      manifestType: 'minecraftModpack',
      name: 'No Key Pack',
      files: [{ projectID: 1, fileID: 2, required: true }],
    }
    const pack = path.join(fixture.root, 'nokey.zip')
    makeZip(pack, [
      { name: 'manifest.json', data: JSON.stringify(manifest) },
      { name: 'overrides/config/kept.json', data: '{"kept":true}' },
    ])
    const service = new ModsModuleService({
      roots: { dataRoot: fixture.dataRoot, mcRoot: fixture.mcRoot },
      log: logger,
      fs: nodeFsPort(),
      downloader: { download: async () => { throw new Error('must not download') } },
      curseResolver: async () => {
        throw new AppError('MODS.CF_API_KEY_MISSING', '缺少 CurseForge API key')
      },
      now: () => 1_700_000_000_000,
    })
    const { outcome } = await runImport(service, { filePath: pack })
    expect(outcome.ok).toBe(true)
    const result = outcome.result!
    expect(result.downloaded).toBe(0)
    expect(result.skipped).toBe(1)
    expect(result.warnings.some((warning) => warning.includes('API key'))).toBe(true)
    const importedDir = path.join(fixture.mcRoot, 'versions', result.dirName)
    expect(fs.readFileSync(path.join(importedDir, 'config', 'kept.json'), 'utf8')).toBe(
      '{"kept":true}',
    )
  })

  it('rejects archive paths that escape the instance and cleans the partial instance', async () => {
    const fixture = createFixture()
    const pack = path.join(fixture.root, 'evil.mrpack')
    makeZip(pack, [
      {
        name: 'modrinth.index.json',
        data: JSON.stringify({
          formatVersion: 1,
          game: 'minecraft',
          versionId: '1',
          name: 'Evil',
          files: [
            {
              path: '../../escape.jar',
              hashes: {},
              downloads: ['https://example.invalid/x.jar'],
            },
          ],
          dependencies: { minecraft: '1.20.1' },
        }),
      },
    ])
    const started = await fixture.service.importModpack({ filePath: pack })
    const outcome = await fixture.service.waitForImport(started.jobId, 30_000)
    expect(outcome.ok).toBe(false)
    expect(outcome.state).toBe('failed')
    expect(outcome.error?.code).toBe('MODS.PACK_UNSAFE_PATH')
    expect(fs.readdirSync(path.join(fixture.mcRoot, 'versions')).some((name) => name === 'Evil')).toBe(false)
    expect(listPartFiles(fixture.mcRoot)).toEqual([])
  })
})

describe('modpack import job (cancel / pause / progress)', () => {
  function packFixture(): {
    fixture: Fixture
    pack: string
    jarA: Buffer
    jarB: Buffer
  } {
    const fixture = createFixture()
    const jarA = fabricMod('job-a', '1.0.0')
    const jarB = fabricMod('job-b', '2.0.0')
    const index = {
      formatVersion: 1,
      game: 'minecraft',
      versionId: '1.0.0',
      name: 'Job Pack',
      files: [
        {
          path: 'mods/a.jar',
          hashes: { sha1: crypto.createHash('sha1').update(jarA).digest('hex') },
          downloads: ['https://cdn.example.invalid/a.jar'],
          fileSize: jarA.length,
        },
        {
          path: 'mods/b.jar',
          hashes: { sha1: crypto.createHash('sha1').update(jarB).digest('hex') },
          downloads: ['https://cdn.example.invalid/b.jar'],
          fileSize: jarB.length,
        },
      ],
      dependencies: { minecraft: '1.20.1', 'fabric-loader': '0.15.0' },
    }
    const pack = path.join(fixture.root, 'job.mrpack')
    makeZip(pack, [
      { name: 'modrinth.index.json', data: JSON.stringify(index) },
      { name: 'overrides/config/job.json', data: '{"job":true}' },
    ])
    return { fixture, pack, jarA, jarB }
  }

  it('cancels a slow download within 3 s, removes all residue and can retry', async () => {
    const { fixture, pack, jarA, jarB } = packFixture()
    let mode: 'slow' | 'fast' = 'slow'
    const downloader = {
      download: async (url: string, _max?: number, options?: FileDownloadOptions) => {
        if (mode === 'fast') return url.endsWith('a.jar') ? jarA : jarB
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 15_000)
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true },
          )
        })
        return url.endsWith('a.jar') ? jarA : jarB
      },
    }
    const service = new ModsModuleService({
      roots: { dataRoot: fixture.dataRoot, mcRoot: fixture.mcRoot },
      log: logger,
      fs: nodeFsPort(),
      downloader,
      now: () => 1_700_000_000_000,
    })

    const started = await service.importModpack({ filePath: pack })
    expect(started.totalFiles).toBe(3)
    await waitUntil(() => service.importStatus(started.jobId)?.currentFile === 'mods/a.jar')

    const cancelledAt = Date.now()
    expect(service.cancelImport(started.jobId)).toEqual({ cancelled: true })
    const outcome = await service.waitForImport(started.jobId, 10_000)
    expect(Date.now() - cancelledAt).toBeLessThan(3_000)
    expect(outcome.state).toBe('cancelled')
    expect(outcome.ok).toBe(false)
    expect(outcome.result).toBeNull()

    // No instance, no temp extraction dir, no .part files anywhere.
    expect(fs.existsSync(path.join(fixture.mcRoot, 'versions', started.dirName))).toBe(false)
    expect(fs.existsSync(path.join(fixture.dataRoot, 'tmp', 'jobs', `mods-import-${started.jobId}`))).toBe(false)
    expect(listPartFiles(fixture.mcRoot)).toEqual([])
    expect(listPartFiles(fixture.dataRoot)).toEqual([])

    // Retry with a fast downloader: the same directory name must be free again.
    mode = 'fast'
    const retried = await runImport(service, { filePath: pack })
    expect(retried.outcome.ok).toBe(true)
    expect(retried.outcome.result).toMatchObject({ downloaded: 2, skipped: 0, overrides: 1 })
    expect(retried.started.dirName).toBe(started.dirName)
    const importedDir = path.join(fixture.mcRoot, 'versions', retried.started.dirName)
    expect(fs.existsSync(path.join(importedDir, 'mods', 'a.jar'))).toBe(true)
    expect(fs.existsSync(path.join(importedDir, 'mods', 'b.jar'))).toBe(true)
    expect(fs.existsSync(path.join(importedDir, 'config', 'job.json'))).toBe(true)
  })

  it('pauses between files and resumes without downloading the next file early', async () => {
    const { fixture, pack, jarA, jarB } = packFixture()
    let calls = 0
    let releaseFirst: (() => void) | null = null
    const downloader = {
      download: async (url: string) => {
        calls += 1
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve
          })
          return url.endsWith('a.jar') ? jarA : jarB
        }
        return url.endsWith('b.jar') ? jarB : jarA
      },
    }
    const service = new ModsModuleService({
      roots: { dataRoot: fixture.dataRoot, mcRoot: fixture.mcRoot },
      log: logger,
      fs: nodeFsPort(),
      downloader,
      now: () => 1_700_000_000_000,
    })

    const started = await service.importModpack({ filePath: pack })
    await waitUntil(() => calls === 1 && releaseFirst !== null)
    expect(service.pauseImport(started.jobId)).toEqual({ paused: true })
    expect(service.importStatus(started.jobId)?.state).toBe('paused')

    releaseFirst!()
    await new Promise((resolve) => setTimeout(resolve, 150))
    // The first file finished, but the paused job must not start the second.
    expect(calls).toBe(1)
    expect(service.importStatus(started.jobId)?.state).toBe('paused')

    expect(service.resumeImport(started.jobId)).toEqual({ resumed: true })
    const outcome = await service.waitForImport(started.jobId, 30_000)
    expect(outcome.ok).toBe(true)
    expect(calls).toBe(2)
    expect(outcome.result?.downloaded).toBe(2)
  })

  it('drives start → status → cancel through the contract handlers', async () => {
    const { fixture, pack, jarA, jarB } = packFixture()
    const downloader = {
      download: async (url: string, _max?: number, options?: FileDownloadOptions) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 10_000)
          options?.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer)
              const error = new Error('aborted')
              error.name = 'AbortError'
              reject(error)
            },
            { once: true },
          )
        })
        return url.endsWith('a.jar') ? jarA : jarB
      },
    }
    const service = new ModsModuleService({
      roots: { dataRoot: fixture.dataRoot, mcRoot: fixture.mcRoot },
      log: logger,
      fs: nodeFsPort(),
      downloader,
    })
    const handlers = makeHandlers(service)

    const started = await handlers.importModpack({ filePath: pack })
    expect(started.jobId).toBeTruthy()
    await waitUntil(() => handlers.importStatus({ jobId: started.jobId })?.stage === 'download')
    expect(handlers.importStatus({ jobId: started.jobId })).toMatchObject({
      instanceId: started.instanceId,
      format: 'modrinth',
      state: 'running',
    })
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(handlers.cancelImport({ jobId: started.jobId })).toEqual({ cancelled: true })
    await waitUntil(() => handlers.importResult({ jobId: started.jobId })?.state === 'cancelled')
    expect(handlers.importResult({ jobId: started.jobId })).toMatchObject({
      jobId: started.jobId,
      ok: false,
      state: 'cancelled',
      error: null,
      result: null,
    })
  })

  it('emits staged progress and a finished event with the composed result', async () => {
    const { fixture, pack, jarA, jarB } = packFixture()
    const service = new ModsModuleService({
      roots: { dataRoot: fixture.dataRoot, mcRoot: fixture.mcRoot },
      log: logger,
      fs: nodeFsPort(),
      downloader: {
        download: async (url: string) =>
          url.endsWith('a.jar') ? jarA : url.endsWith('b.jar') ? jarB : jarA,
      },
      now: () => 1_700_000_000_000,
    })
    const stages = new Set<string>()
    const finished: unknown[] = []
    const offProgress = service.onEvent('importProgress', (payload) => {
      stages.add((payload as { stage: string }).stage)
    })
    const offFinished = service.onEvent('importFinished', (payload) => finished.push(payload))

    const started = await service.importModpack({ filePath: pack })
    const outcome = await service.waitForImport(started.jobId, 30_000)
    offProgress()
    offFinished()

    expect(outcome.ok).toBe(true)
    expect([...stages]).toEqual(
      expect.arrayContaining(['prepare', 'overrides', 'download', 'finalize']),
    )
    expect(finished).toHaveLength(1)
    expect(finished[0]).toMatchObject({
      jobId: started.jobId,
      ok: true,
      state: 'done',
      instanceId: started.instanceId,
      result: { downloaded: 2, overrides: 1 },
    })
    expect(service.importStatus(started.jobId)).toMatchObject({
      jobId: started.jobId,
      instanceId: started.instanceId,
      state: 'done',
      stage: 'finalize',
    })
    expect(service.importResult(started.jobId)?.result?.instanceId).toBe(started.instanceId)
    const lastProgress = service.importStatus(started.jobId)
    expect(modsContract.events.importProgress.payload.safeParse(lastProgress).success).toBe(true)
    expect(modsContract.events.importFinished.payload.safeParse(finished[0]).success).toBe(true)
  })
})
