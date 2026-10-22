import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import {
  ShareExportResultSchema,
  ShareImportResultSchema,
} from '@shared/instance'
import { nodeFsPort } from '../ports'
import { defaultInstanceSettings } from '../instance/settings'
import { createSharePack } from '../instance/share/export'
import { extractSharePack } from '../instance/share/import'
import { readShareManifest, SHARE_PACK_EXTENSION } from '../instance/share/manifest'
import { readInstanceSettings } from '../instance/settings'
import { scanInstances } from '../instance/scan'
import { resolveVersion } from '../version/load'
import { createStoredZip } from '../zip/writer'
import { openZipFile } from '../zip/reader'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

const fsPort = nodeFsPort()
const logs: string[] = []
const log = {
  info: (message: string) => {
    logs.push(`info:${message}`)
  },
  warn: (message: string) => {
    logs.push(`warn:${message}`)
  },
}

function writeFile(target: string, contents: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, contents)
}

function vanillaVersionJson(id = '1.20.1'): string {
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
      client: { sha1: '0'.repeat(40), size: 0, url: 'https://example.invalid/client.jar' },
    },
    libraries: [],
    arguments: { game: [], jvm: [] },
  })
}

function fabricProfile(id: string): string {
  return JSON.stringify({
    id,
    type: 'release',
    inheritsFrom: '1.20.1',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [{ name: 'net.fabricmc:fabric-loader:0.15.0' }],
    arguments: { game: [], jvm: [] },
  })
}

interface Fixture {
  root: string
  mcRoot: string
  dataRoot: string
  instanceDir: string
  dirName: string
}

function createFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-share-'))
  cleanup.push(root)
  const mcRoot = path.join(root, 'mc')
  const dataRoot = path.join(root, 'data')

  const baseDir = path.join(mcRoot, 'versions', '1.20.1')
  writeFile(path.join(baseDir, '1.20.1.json'), vanillaVersionJson())
  writeFile(path.join(baseDir, '1.20.1.jar'), 'client-jar')
  writeFile(
    path.join(mcRoot, 'versions', 'fabric-loader-0.15.0-1.20.1', 'fabric-loader-0.15.0-1.20.1.json'),
    fabricProfile('fabric-loader-0.15.0-1.20.1'),
  )
  writeFile(
    path.join(mcRoot, 'libraries', 'net', 'fabricmc', 'fabric-loader', '0.15.0', 'fabric-loader-0.15.0.jar'),
    'loader-jar',
  )

  const dirName = 'Example'
  const instanceDir = path.join(mcRoot, 'versions', dirName)
  writeFile(path.join(instanceDir, `${dirName}.json`), fabricProfile(dirName))
  const settings = {
    ...defaultInstanceSettings({
      dirName,
      id: dirName,
      name: 'Example',
      mcVersion: '1.20.1',
      loader: { type: 'fabric', version: '0.15.0' },
      isolation: 'isolated',
      source: 'ours',
      now: 1,
    }),
    java: { mode: 'path' as const, value: 'C:\\evil.exe' },
    jvmArgs: ['-javaagent:C:\\evil.jar'],
  }
  writeFile(path.join(instanceDir, 'instance.json'), JSON.stringify(settings))

  writeFile(path.join(instanceDir, 'mods', 'example.jar'), 'mod-bytes')
  writeFile(
    path.join(instanceDir, 'config', 'settings.json'),
    JSON.stringify({
      serverName: 'Public Server',
      apiKey: 'public-value',
      accessToken: 'TOKEN-SECRET-ACCESS',
      refreshToken: 'TOKEN-SECRET-REFRESH',
      nested: { cookie: 'COOKIE-SECRET' },
    }),
  )
  writeFile(
    path.join(instanceDir, 'config', 'raw.cfg'),
    'accessToken=TOKEN-SECRET-CFG\nCookie: session=COOKIE-SECRET-CFG\nkeep=this\n',
  )
  writeFile(
    path.join(instanceDir, 'config', 'launcher_accounts.json'),
    '{"accessToken":"TOKEN-SECRET-FILE"}',
  )
  writeFile(path.join(instanceDir, 'resourcepacks', 'rp.zip'), 'resource-pack')
  writeFile(path.join(instanceDir, 'shaderpacks', 'shader.zip'), 'shader-pack')
  writeFile(path.join(instanceDir, 'saves', 'world', 'level.dat'), 'level-bytes')
  writeFile(path.join(instanceDir, 'logs', 'latest.log'), 'should never be exported')
  writeFile(path.join(instanceDir, 'options.txt'), 'lang:zh_CN\n')

  return { root, mcRoot, dataRoot, instanceDir, dirName }
}

async function exportFixture(fixture: Fixture, include?: Record<string, boolean>) {
  const settings = readInstanceSettings(fsPort, fixture.instanceDir).settings!
  return createSharePack({
    fs: fsPort,
    mcRoot: fixture.mcRoot,
    dataRoot: fixture.dataRoot,
    instanceDir: fixture.instanceDir,
    dirName: fixture.dirName,
    settings,
    outPath: path.join(fixture.root, `share${SHARE_PACK_EXTENSION}`),
    include,
    now: () => 1_700_000_000_000,
    log,
  })
}

describe('share pack export', () => {
  it('packs the instance, strips credentials and keeps evidence without values', async () => {
    const fixture = createFixture()
    const result = await exportFixture(fixture, { saves: true })
    expect(result.format).toBe('cubitpack')
    expect(result.files).toBeGreaterThan(0)
    expect(fs.existsSync(result.path)).toBe(true)
    expect(ShareExportResultSchema.safeParse(result).success).toBe(true)

    const archive = openZipFile(fsPort, result.path)
    const manifest = readShareManifest(archive)
    expect(manifest).toMatchObject({
      kind: 'cubit-launcher-share',
      name: 'Example',
      mcVersion: '1.20.1',
      loader: { type: 'fabric', version: '0.15.0' },
      isolation: 'isolated',
      selection: { saves: true },
    })
    expect(manifest.counts.mods).toBe(1)
    expect(manifest.counts.saves).toBe(1)
    expect(manifest.counts.options).toBe(1)

    // Credential stores and non-selected areas never enter the archive.
    expect(archive.has('game/config/launcher_accounts.json')).toBe(false)
    expect(archive.has('game/logs/latest.log')).toBe(false)

    const packedSettings = JSON.parse(
      archive.read('game/config/settings.json').toString('utf8'),
    ) as Record<string, unknown>
    expect(packedSettings.serverName).toBe('Public Server')
    expect(packedSettings.apiKey).toBe('<redacted>')
    expect(packedSettings.accessToken).toBe('<redacted>')
    expect(packedSettings.refreshToken).toBe('<redacted>')
    expect((packedSettings.nested as Record<string, unknown>).cookie).toBe('<redacted>')

    const raw = archive.read('game/config/raw.cfg').toString('utf8')
    expect(raw).not.toContain('TOKEN-SECRET-CFG')
    expect(raw).not.toContain('COOKIE-SECRET-CFG')
    expect(raw).toContain('keep=this')
    expect(raw).toContain('<redacted>')

    // No archive entry (text or binary) contains any known secret literal.
    for (const entry of archive.entries) {
      if (entry.isDirectory) continue
      const text = archive.readEntry(entry).toString('latin1')
      expect(text).not.toContain('TOKEN-SECRET')
      expect(text).not.toContain('COOKIE-SECRET')
    }

    expect(
      result.redactions.some(
        (record) => record.path === 'game/config/settings.json' && record.action === 'redacted',
      ),
    ).toBe(true)
    expect(
      result.redactions.some(
        (record) =>
          record.path === 'game/config/launcher_accounts.json' && record.action === 'skipped',
      ),
    ).toBe(true)
    // The evidence log records field names/paths only.
    expect(JSON.stringify(result.redactions)).not.toContain('TOKEN-SECRET')
    expect(logs.some((line) => line.startsWith('warn:share pack credentials stripped'))).toBe(true)
  })

  it('redacts apiKey/clientSecret/accessKey/session keys across JSON/properties/toml/yaml/.env/txt', async () => {
    const fixture = createFixture()
    const secrets: Array<[string, string]> = [
      ['F3-API-KEY-VALUE', 'apiKey'],
      ['F3-API-UNDERSCORE-VALUE', 'api_key'],
      ['F3-CLIENT-SECRET-VALUE', 'clientSecret'],
      ['F3-CLIENT-UNDERSCORE-VALUE', 'client_secret'],
      ['F3-ACCESS-KEY-VALUE', 'accessKey'],
      ['F3-SECRET-KEY-VALUE', 'secretKey'],
      ['F3-PRIVATE-KEY-VALUE', 'privateKey'],
      ['F3-SESSION-TOKEN-VALUE', 'sessionToken'],
      ['F3-SESSION-ID-VALUE', 'sessionId'],
    ]
    writeFile(
      path.join(fixture.instanceDir, 'config', 'credentials.json'),
      JSON.stringify(Object.fromEntries(secrets.map(([value, key]) => [key, value]))),
    )
    writeFile(
      path.join(fixture.instanceDir, 'config', 'app.properties'),
      `apiKey=${secrets[0][0]}\nclientSecret=${secrets[2][0]}\nkeep=this\n`,
    )
    writeFile(
      path.join(fixture.instanceDir, 'config', 'app.toml'),
      `accessKey = "${secrets[4][0]}"\nsecretKey = "${secrets[5][0]}"\n`,
    )
    writeFile(
      path.join(fixture.instanceDir, 'config', 'app.yaml'),
      `privateKey: ${secrets[6][0]}\nsessionToken: ${secrets[7][0]}\n`,
    )
    writeFile(
      path.join(fixture.instanceDir, 'config', '.env'),
      `ACCESS_KEY=${secrets[4][0]}\nSECRET_KEY=${secrets[5][0]}\n`,
    )
    writeFile(
      path.join(fixture.instanceDir, 'config', 'notes.txt'),
      `sessionId=${secrets[8][0]}\npublic=kept\n`,
    )

    const result = await exportFixture(fixture)
    const archive = openZipFile(fsPort, result.path)
    const serialized = archive.entries
      .filter((entry) => !entry.isDirectory)
      .map((entry) => archive.readEntry(entry).toString('utf8'))
      .join('\n')
    for (const [value, key] of secrets) {
      const leaked = archive.entries
        .filter((entry) => !entry.isDirectory)
        .filter((entry) => archive.readEntry(entry).toString('utf8').includes(value))
        .map((entry) => entry.name)
      expect(leaked, `leaked ${key}`).toEqual([])
    }
    expect(serialized).toContain('<redacted>')
    expect(serialized).toContain('public=kept')
    expect(result.redactions.some((record) => record.path.endsWith('credentials.json'))).toBe(true)
    expect(result.redactions.some((record) => record.path.endsWith('.env'))).toBe(true)
    const recordedFields = new Set(
      result.redactions.flatMap((record) => record.fields.map((field) => field.toLowerCase())),
    )
    for (const [, key] of secrets) {
      expect(recordedFields.has(key.toLowerCase()), `missing field ${key}`).toBe(true)
    }
    const evidence = JSON.stringify(result.redactions)
    for (const [value] of secrets) expect(evidence).not.toContain(value)
    expect(result.warnings).not.toContain(secrets[0][0])
  })

  it('honours the content selection', async () => {
    const fixture = createFixture()
    const result = await exportFixture(fixture, {
      mods: false,
      config: false,
      resourcepacks: false,
      shaderpacks: false,
      saves: false,
      options: false,
    })
    const archive = openZipFile(fsPort, result.path)
    expect(archive.has('game/mods/example.jar')).toBe(false)
    expect(archive.has('game/config/settings.json')).toBe(false)
    expect(archive.has('game/options.txt')).toBe(false)
    expect(archive.has('version/profile.json')).toBe(true)
    expect(archive.has('instance/instance.json')).toBe(true)
    expect(result.files).toBe(2)
  })
})

describe('share pack import', () => {
  it('imports a pack as a launchable isolated instance and resets unsafe settings', async () => {
    const fixture = createFixture()
    const exported = await exportFixture(fixture, { saves: true })
    const result = await extractSharePack({
      fs: fsPort,
      mcRoot: fixture.mcRoot,
      filePath: exported.path,
      name: 'Imported',
      now: () => 1_700_000_000_000,
      log,
    })
    expect(result).toMatchObject({
      status: 'imported',
      instanceId: 'Imported',
      dirName: 'Imported',
      name: 'Imported',
      overwritten: false,
      renamed: false,
      needsBaseInstall: false,
      launchable: true,
      missingLibraries: 0,
    })
    expect(ShareImportResultSchema.safeParse(result).success).toBe(true)

    const importedDir = path.join(fixture.mcRoot, 'versions', 'Imported')
    expect(fs.existsSync(path.join(importedDir, 'mods', 'example.jar'))).toBe(true)
    expect(fs.existsSync(path.join(importedDir, 'config', 'settings.json'))).toBe(true)
    expect(fs.existsSync(path.join(importedDir, 'saves', 'world', 'level.dat'))).toBe(true)
    expect(fs.existsSync(path.join(importedDir, 'Imported.json'))).toBe(true)

    const settings = readInstanceSettings(fsPort, importedDir).settings!
    expect(settings).toMatchObject({
      id: 'Imported',
      dirName: 'Imported',
      name: 'Imported',
      isolation: 'isolated',
      source: 'pack',
      java: { mode: 'auto', value: null },
      jvmArgs: [],
    })
    // Security: a shared instance must never make the launcher spawn an
    // arbitrary executable or JVM agent from the pack.
    expect(result.warnings.some((warning) => warning.includes('JVM'))).toBe(true)

    const resolved = resolveVersion(fsPort, fixture.mcRoot, 'Imported')
    expect(resolved.json.mainClass).toBe('net.fabricmc.loader.impl.launch.knot.KnotClient')
    expect(resolved.clientJarExists).toBe(true)
    const scanned = scanInstances(fsPort, fixture.mcRoot).find(
      (entry) => entry.dirName === 'Imported',
    )
    expect(scanned?.state).toBe('ready')

    // The pack left no staging directory behind.
    const leftovers = fs
      .readdirSync(path.join(fixture.mcRoot, 'versions'))
      .filter((name) => name.startsWith('.share-'))
    expect(leftovers).toEqual([])
  })

  it('reports a conflict before touching disk and supports skip/rename/overwrite', async () => {
    const fixture = createFixture()
    const exported = await exportFixture(fixture)
    const versionsDir = path.join(fixture.mcRoot, 'versions')
    const sourceBefore = fs.readFileSync(
      path.join(fixture.instanceDir, 'mods', 'example.jar'),
    )

    const conflict = await extractSharePack({
      fs: fsPort,
      mcRoot: fixture.mcRoot,
      filePath: exported.path,
      name: 'Example',
    })
    expect(conflict).toMatchObject({ status: 'conflict', instanceId: null, dirName: 'Example' })
    expect(fs.readdirSync(versionsDir)).toEqual(expect.arrayContaining(['Example']))
    expect(fs.existsSync(path.join(versionsDir, 'Example-2'))).toBe(false)

    const skipped = await extractSharePack({
      fs: fsPort,
      mcRoot: fixture.mcRoot,
      filePath: exported.path,
      name: 'Example',
      conflict: 'skip',
    })
    expect(skipped).toMatchObject({ status: 'skipped', dirName: 'Example' })
    expect(fs.readdirSync(versionsDir).filter((name) => name.startsWith('Example-'))).toEqual([])

    const renamed = await extractSharePack({
      fs: fsPort,
      mcRoot: fixture.mcRoot,
      filePath: exported.path,
      name: 'Example',
      conflict: 'rename',
    })
    expect(renamed).toMatchObject({
      status: 'imported',
      instanceId: 'Example-2',
      renamed: true,
      overwritten: false,
    })
    expect(fs.existsSync(path.join(versionsDir, 'Example-2', 'instance.json'))).toBe(true)
    // The original instance is untouched by rename.
    expect(fs.readFileSync(path.join(fixture.instanceDir, 'mods', 'example.jar'))).toEqual(
      sourceBefore,
    )

    // Overwrite replaces the whole directory but restores it on failure paths;
    // here the import succeeds, so the marker that was never exported is gone.
    writeFile(path.join(fixture.instanceDir, 'marker.txt'), 'source-only')
    const overwritten = await extractSharePack({
      fs: fsPort,
      mcRoot: fixture.mcRoot,
      filePath: exported.path,
      name: 'Example',
      conflict: 'overwrite',
    })
    expect(overwritten).toMatchObject({
      status: 'imported',
      instanceId: 'Example',
      overwritten: true,
      renamed: false,
    })
    expect(fs.existsSync(path.join(fixture.instanceDir, 'marker.txt'))).toBe(false)
    expect(fs.existsSync(path.join(fixture.instanceDir, 'mods', 'example.jar'))).toBe(true)
    expect(fs.existsSync(path.join(versionsDir, '.share-backup-Example'))).toBe(false)
  })

  it('rolls back a failed overwrite and keeps the original instance intact', async () => {
    const fixture = createFixture()
    writeFile(path.join(fixture.instanceDir, 'marker.txt'), 'keep-me')

    const manifest = {
      schemaVersion: 1,
      kind: 'cubit-launcher-share',
      createdAt: 1,
      name: 'Broken',
      mcVersion: '1.20.1',
      loader: { type: 'vanilla', version: null },
      isolation: 'isolated',
      selection: {
        mods: true,
        config: true,
        resourcepacks: true,
        shaderpacks: true,
        saves: false,
        options: true,
      },
      counts: {
        files: 1,
        bytes: 4,
        mods: 1,
        config: 0,
        resourcepacks: 0,
        shaderpacks: 0,
        saves: 0,
        options: 0,
      },
      redactions: [],
      warnings: [],
      icon: null,
    }
    const brokenPath = path.join(fixture.root, 'broken.cubitpack')
    fs.writeFileSync(
      brokenPath,
      createStoredZip([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        { name: 'game/mods/partial.jar', data: Buffer.from('junk') },
        // Missing version/profile.json → the import must fail after staging.
      ]),
    )

    let caught: unknown
    try {
      await extractSharePack({
        fs: fsPort,
        mcRoot: fixture.mcRoot,
        filePath: brokenPath,
        name: 'Example',
        conflict: 'overwrite',
        log,
      })
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code).toBe('INSTANCE.SHARE_INVALID')

    // Existing instance intact, no staging leftovers.
    expect(fs.readFileSync(path.join(fixture.instanceDir, 'marker.txt'), 'utf8')).toBe('keep-me')
    expect(fs.existsSync(path.join(fixture.instanceDir, 'mods', 'partial.jar'))).toBe(false)
    const leftovers = fs
      .readdirSync(path.join(fixture.mcRoot, 'versions'))
      .filter((name) => name.startsWith('.share-'))
    expect(leftovers).toEqual([])
  })

  it('reports missing base versions without failing the import', async () => {
    const fixture = createFixture()
    const exported = await exportFixture(fixture)
    fs.rmSync(path.join(fixture.mcRoot, 'versions', '1.20.1'), { recursive: true, force: true })

    const result = await extractSharePack({
      fs: fsPort,
      mcRoot: fixture.mcRoot,
      filePath: exported.path,
      name: 'NoBase',
    })
    expect(result).toMatchObject({ status: 'imported', launchable: false, needsBaseInstall: true })
    expect(result.warnings.some((warning) => warning.includes('基础版本'))).toBe(true)
    expect(fs.existsSync(path.join(fixture.mcRoot, 'versions', 'NoBase', 'instance.json'))).toBe(
      true,
    )
  })

  it('rejects a non-share zip with a readable error', async () => {
    const fixture = createFixture()
    const other = path.join(fixture.root, 'other.cubitpack')
    fs.writeFileSync(other, createStoredZip([{ name: 'readme.txt', data: Buffer.from('hi') }]))
    await expect(
      extractSharePack({ fs: fsPort, mcRoot: fixture.mcRoot, filePath: other }),
    ).rejects.toMatchObject({ code: 'INSTANCE.SHARE_INVALID' })
  })
})
