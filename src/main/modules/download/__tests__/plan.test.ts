import { describe, expect, it } from 'vitest'
import type { VersionJson } from '../../../core/version/types'
import { DownloadError } from '../core/errors'
import {
  assetObjectRel,
  assetObjectUrl,
  buildAssetIndexTask,
  buildAssetTasks,
  buildClientTask,
  buildInstallPlan,
  buildLibraryTasks,
  buildVersionJsonTask,
  libraryTasks,
} from '../core/plan'
import { sha1 } from './support/http-server'

const CLIENT_SHA1 = sha1('client-bytes')
const LOGGING_SHA1 = sha1('logging-bytes')
const INDEX_SHA1 = sha1('index-bytes')

function artifact(path: string, hash: string, size = 100, host = 'https://libraries.minecraft.net') {
  return { path, sha1: hash, size, url: `${host}/${path}` }
}

function fixture(): VersionJson {
  return {
    id: '1.20.1',
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assetIndex: {
      id: '5',
      sha1: INDEX_SHA1,
      size: 413067,
      totalSize: 650564794,
      url: `https://piston-meta.mojang.com/v1/packages/${INDEX_SHA1}/5.json`,
    },
    downloads: {
      client: {
        sha1: CLIENT_SHA1,
        size: 1000,
        url: `https://piston-data.mojang.com/v1/objects/${CLIENT_SHA1}/client.jar`,
      },
    },
    logging: {
      client: {
        argument: '-Dlog4j.configurationFile=${path}',
        file: {
          id: 'client-1.12.xml',
          sha1: LOGGING_SHA1,
          size: 30,
          url: `https://piston-data.mojang.com/v1/objects/${LOGGING_SHA1}/client-1.12.xml`,
        },
      },
    },
    libraries: [
      {
        name: 'com.mojang:logging:1.1.1',
        downloads: { artifact: artifact('com/mojang/logging/1.1.1/logging-1.1.1.jar', sha1('a')) },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1',
        downloads: { artifact: artifact('org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1.jar', sha1('b')) },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1:natives-windows',
        rules: [{ action: 'allow', os: { name: 'windows' } }],
        downloads: {
          artifact: artifact(
            'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar',
            sha1('c'),
          ),
        },
      },
      {
        name: 'org.lwjgl:lwjgl:3.3.1:natives-linux',
        rules: [{ action: 'allow', os: { name: 'linux' } }],
        downloads: {
          artifact: artifact(
            'org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-linux.jar',
            sha1('d'),
          ),
        },
      },
      {
        name: 'org.example:classic-native:1.0',
        natives: { windows: 'natives-windows-${arch}' },
        extract: { exclude: ['META-INF/'] },
        downloads: {
          artifact: artifact('org/example/classic-native/1.0/classic-native-1.0.jar', sha1('e')),
          classifiers: {
            'natives-windows-64': artifact(
              'org/example/classic-native/1.0/classic-native-1.0-natives-windows-64.jar',
              sha1('f'),
            ),
          },
        },
      },
      {
        name: 'org.example:no-hash:1.0',
        downloads: {
          artifact: {
            path: 'org/example/no-hash/1.0/no-hash-1.0.jar',
            size: 42,
            url: 'https://libraries.minecraft.net/org/example/no-hash/1.0/no-hash-1.0.jar',
          },
        },
      },
      { name: 'not-a-coordinate' },
    ],
  }
}

const INDEX = {
  objects: {
    'icons/icon_128x128.png': { hash: 'b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356', size: 9101 },
    'texts/zh_cn.lang': { hash: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567', size: 20 },
  },
}

async function planWithFixture() {
  return buildInstallPlan({
    versionId: '1.20.1',
    mcRoot: 'C:/mc',
    version: fixture(),
    assetIndex: INDEX,
    platform: 'win32',
    arch: 'x64',
    stat: async () => null,
  })
}

describe('library tasks (rules + natives)', () => {
  it('filters by OS rules and resolves both classic and modern natives', () => {
    const result = buildLibraryTasks({
      version: fixture(),
      mcRoot: 'C:/mc',
      platform: 'win32',
      arch: 'x64',
    })
    expect(result.stats.total).toBe(7)
    expect(result.stats.allowed).toBe(5)
    expect(result.stats.skipped).toBe(2)
    expect(result.stats.natives).toBe(2)
    expect(result.tasks).toHaveLength(6)

    const paths = result.tasks.map((task) => task.destRel.replaceAll('\\', '/'))
    expect(paths).toContain('libraries/org/lwjgl/lwjgl/3.3.1/lwjgl-3.3.1-natives-windows.jar')
    expect(paths).toContain(
      'libraries/org/example/classic-native/1.0/classic-native-1.0-natives-windows-64.jar',
    )
    expect(paths.some((path) => path.includes('natives-linux'))).toBe(false)
  })

  it('marks hash-less official files unverified but refuses third-party ones (SEC-DL-04)', () => {
    const version = fixture()
    const noHash = version.libraries?.find((library) => library.name === 'org.example:no-hash:1.0')
    const result = libraryTasks(noHash!, {
      librariesDir: 'C:/mc/libraries',
      platform: 'win32',
      arch: 'x64',
      features: {},
      warnings: [],
    })
    expect(result.tasks[0].unverified).toBe(true)
    expect(result.tasks[0].sha1).toBeNull()

    const evil = {
      ...noHash!,
      downloads: {
        artifact: {
          path: 'org/example/no-hash/1.0/no-hash-1.0.jar',
          size: 42,
          url: 'https://evil.example/no-hash-1.0.jar',
        },
      },
    }
    expect(() =>
      libraryTasks(evil, {
        librariesDir: 'C:/mc/libraries',
        platform: 'win32',
        arch: 'x64',
        features: {},
        warnings: [],
      }),
    ).toThrowError(DownloadError)
    try {
      libraryTasks(evil, {
        librariesDir: 'C:/mc/libraries',
        platform: 'win32',
        arch: 'x64',
        features: {},
        warnings: [],
      })
    } catch (error) {
      expect((error as DownloadError).code).toBe('DOWNLOAD.HASH_REQUIRED')
    }
  })

  it('supports Forge-style libraries that only ship a repository base URL', () => {
    const result = libraryTasks(
      {
        name: 'net.minecraftforge:forge:1.20.1-47.2.0',
        url: 'https://maven.minecraftforge.net/',
      },
      {
        librariesDir: 'C:/mc/libraries',
        platform: 'win32',
        arch: 'x64',
        features: {},
        warnings: [],
      },
    )
    expect(result.tasks[0].url).toBe(
      'https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.2.0/forge-1.20.1-47.2.0.jar',
    )
    expect(result.tasks[0].unverified).toBe(true)
  })
})

describe('install plan', () => {
  it('counts client, libraries, logging and assets', async () => {
    const plan = await planWithFixture()
    expect(plan.summary.versionId).toBe('1.20.1')
    expect(plan.summary.clientJar?.destRel).toBe('versions/1.20.1/1.20.1.jar')
    expect(plan.summary.libraries).toMatchObject({
      total: 7,
      allowed: 5,
      skipped: 2,
      natives: 2,
      files: 6,
    })
    expect(plan.summary.assets).toMatchObject({ indexId: '5', objects: 2 })
    expect(plan.summary.logging).toBe(1)
    expect(plan.summary.files).toBe(10)
    expect(plan.summary.bytes).toBe(
      plan.tasks.reduce((total, task) => total + (task.size ?? 0), 0),
    )
    expect(plan.summary.missingFiles).toBe(10)
    expect(plan.summary.missingBytes).toBe(plan.summary.bytes)
  })

  it('marks already-present files as not missing', async () => {
    const plan = await buildInstallPlan({
      versionId: '1.20.1',
      mcRoot: 'C:/mc',
      version: fixture(),
      assetIndex: INDEX,
      platform: 'win32',
      arch: 'x64',
      stat: async (absolute) =>
        absolute.endsWith('1.20.1.jar') ? { size: 1000 } : null,
    })
    expect(plan.summary.missingFiles).toBe(9)
    expect(plan.summary.missingBytes).toBe(plan.summary.bytes - 1000)
  })
})

describe('task builders', () => {
  it('uses Mojang URLs and explicit mirror URLs', () => {
    const client = buildClientTask({
      versionId: '1.20.1',
      version: fixture(),
      warnings: [],
    })
    expect(client?.url).toContain('piston-data.mojang.com')
    expect(client?.mirrorUrl).toBe('https://bmclapi2.bangbang93.com/version/1.20.1/client')
    expect(client?.sha1).toBe(CLIENT_SHA1)
  })

  it('builds version JSON and asset index destinations (R1.7)', () => {
    const versionTask = buildVersionJsonTask({
      entry: {
        id: '1.20.1',
        type: 'release',
        url: `https://piston-meta.mojang.com/v1/packages/${sha1('json')}/1.20.1.json`,
        sha1: sha1('json'),
      },
    })
    expect(versionTask.destRel).toBe('versions/1.20.1/1.20.1.json')
    expect(versionTask.sha1).toBe(sha1('json'))
    expect(versionTask.sourcePolicy).toBe('metadata')

    const indexTask = buildAssetIndexTask({ version: fixture() })
    expect(indexTask?.destRel).toBe('assets/indexes/5.json')
    expect(indexTask?.url).toContain('piston-meta.mojang.com')
  })

  it('maps asset objects to their hashed path and URL', () => {
    const tasks = buildAssetTasks({ assetIndex: INDEX })
    const hash = 'b62ca8ec10d07e6bf5ac8dae0c8c1d2e6a1e3356'
    expect(tasks[0].destRel).toBe(`assets/objects/b6/${hash}`)
    expect(tasks[0].url).toBe(`https://resources.download.minecraft.net/b6/${hash}`)
    expect(tasks[0].sha1).toBe(hash)
    expect(tasks[0].mirrorUrl).toBe(`https://bmclapi2.bangbang93.com/assets/b6/${hash}`)
    expect(assetObjectRel(hash)).toBe(`assets/objects/b6/${hash}`)
    expect(assetObjectUrl(hash)).toContain('resources.download.minecraft.net')
  })

  it('keeps explicit mirror overrides for custom mirrors', () => {
    const tasks = buildAssetTasks({ assetIndex: INDEX, mirrorBase: 'https://mirror.example' })
    expect(tasks[0].mirrorUrl).toContain('https://mirror.example/assets/b6/')
  })
})
