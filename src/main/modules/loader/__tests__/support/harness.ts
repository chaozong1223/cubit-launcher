import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { AddressInfo } from 'node:net'
import type { DownloadProgress, DownloadTask } from '@shared/download'
import type { ExecResult, ProcessPort, SpawnedProcess, SpawnOptions } from '../../../../core/ports'
import { sha1File } from '../../core/http'
import type { LoaderLibraryDownloader } from '../../service'
import type { LoaderEndpoints } from '../../core/meta'

/** Minimal HTTP server + fake process/downloader harness for loader tests. */

export interface TestServer {
  baseUrl: string
  requests: Array<{ path: string; at: number }>
  serveText(pathname: string, text: string, status?: number): void
  serveBytes(pathname: string, bytes: Buffer, status?: number): void
  route(pathname: string, handler: (res: http.ServerResponse) => void): void
  count(pathname: string): number
  close(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
  const routes = new Map<string, (res: http.ServerResponse) => void>()
  const requests: Array<{ path: string; at: number }> = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ path: url.pathname, at: Date.now() })
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404, { 'content-length': 0 }).end()
      return
    }
    handler(res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    serveText(pathname, text, status = 200) {
      routes.set(pathname, (res) => {
        res.writeHead(status, {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(text),
        })
        res.end(text)
      })
    },
    serveBytes(pathname, bytes, status = 200) {
      routes.set(pathname, (res) => {
        res.writeHead(status, { 'content-length': bytes.length })
        res.end(bytes)
      })
    },
    route(pathname, handler) {
      routes.set(pathname, handler)
    },
    count(pathname) {
      return requests.filter((request) => request.path === pathname).length
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

export function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export const JAVA_17_PROBE =
  'Property settings:\n    java.home = C:\\fake\\jdk17\n    java.version = 17.0.9\n    os.arch = amd64\n\njava version "17.0.9" 2023-10-17'

export type SpawnScript = (child: FakeChild) => void | Promise<void>

export class FakeChild extends EventEmitter implements SpawnedProcess {
  readonly pid = 4242
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly stdin = new PassThrough()
  killed = false

  constructor(private readonly onExit: () => void) {
    super()
  }

  kill(_signal?: NodeJS.Signals | number): boolean {
    this.killed = true
    this.emit('exit', null, 'SIGTERM')
    this.onExit()
    return true
  }
}

export interface FakePorts extends ProcessPort {
  spawned: Array<{ file: string; args: string[]; options?: SpawnOptions }>
  execCalls: Array<{ file: string; args: string[] }>
}

export function fakePorts(options: {
  script?: SpawnScript
  execResult?: Partial<ExecResult>
} = {}): FakePorts {
  const spawned: FakePorts['spawned'] = []
  const execCalls: FakePorts['execCalls'] = []
  const script = options.script ?? (() => undefined)
  const ports: FakePorts = {
    spawned,
    execCalls,
    async exec(file, args) {
      execCalls.push({ file, args })
      return {
        stdout: '',
        stderr: JAVA_17_PROBE,
        code: 0,
        timedOut: false,
        ...(options.execResult ?? {}),
      }
    },
    spawn(file, args, spawnOptions) {
      spawned.push({ file, args, options: spawnOptions })
      const child = new FakeChild(() => undefined)
      setImmediate(() => {
        void Promise.resolve(script(child))
      })
      return child
    },
  }
  return ports
}

export function fakeDownloader(options: {
  fail?: boolean
  message?: string
} = {}): LoaderLibraryDownloader & { tasks: DownloadTask[]; jobIds: string[] } {
  const tasks: DownloadTask[] = []
  const jobIds: string[] = []
  const statuses = new Map<string, DownloadProgress>()
  return {
    tasks,
    jobIds,
    async enqueue(input) {
      const jobId = `download-${jobIds.length + 1}`
      jobIds.push(jobId)
      tasks.push(...input)
      statuses.set(jobId, {
        jobId,
        kind: 'batch',
        state: options.fail ? 'failed' : 'done',
        stage: options.fail ? 'libraries' : 'done',
        done: input.length,
        failed: options.fail ? 1 : 0,
        total: input.length,
        bytesDone: 0,
        bytesTotal: 0,
        currentFile: null,
        bytesPerSec: 0,
        source: null,
        versionId: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        message: options.fail ? (options.message ?? 'download failed') : null,
      })
      return { jobId, total: input.length }
    },
    status(jobId) {
      return statuses.get(jobId) ?? null
    },
  }
}

export function localEndpoints(server: TestServer): LoaderEndpoints {
  const mavenMirror = `${server.baseUrl}/mirror-maven`
  const mavenOfficial = `${server.baseUrl}/official-maven`
  return {
    fabricMeta: [`${server.baseUrl}/fabric-meta`],
    quiltMeta: [`${server.baseUrl}/quilt-meta`],
    forgeList: (mc) => [`${server.baseUrl}/forge/${mc}`],
    forgeMaven: [mavenMirror, mavenOfficial],
    neoList: (mc) => [`${server.baseUrl}/neoforge/${mc}`],
    neoMaven: [mavenMirror, mavenOfficial],
  }
}

export interface VanillaFixture {
  mcVersion: string
  versionJson: Record<string, unknown>
}

export function writeVanilla(mcRoot: string, mcVersion = '1.20.1'): VanillaFixture {
  const dir = path.join(mcRoot, 'versions', mcVersion)
  fs.mkdirSync(dir, { recursive: true })
  const versionJson = {
    id: mcVersion,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: { id: '5', url: 'https://example.invalid/5.json', size: 10, sha1: 'a'.repeat(40) },
    downloads: {
      client: {
        url: 'https://example.invalid/client.jar',
        sha1: 'b'.repeat(40),
        size: 10,
      },
    },
    javaVersion: { component: 'java-runtime-beta', majorVersion: 17 },
    libraries: [],
  }
  fs.writeFileSync(path.join(dir, `${mcVersion}.json`), `${JSON.stringify(versionJson, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, `${mcVersion}.jar`), Buffer.from('client-jar'))
  return { mcVersion, versionJson }
}

export function fabricProfile(loaderVersion = '0.16.10', mcVersion = '1.20.1'): Record<string, unknown> {
  return {
    id: `fabric-loader-${loaderVersion}-${mcVersion}`,
    inheritsFrom: mcVersion,
    type: 'release',
    mainClass: 'net.fabricmc.loader.impl.launch.knot.KnotClient',
    libraries: [
      {
        name: 'org.ow2.asm:asm:9.6',
        url: 'https://maven.fabricmc.net/',
        sha1: '1'.repeat(40),
        size: 120000,
      },
      {
        name: 'net.fabricmc:sponge-mixin:0.12.5+mixin.0.8.5',
        url: 'https://maven.fabricmc.net/',
        sha1: '2'.repeat(40),
        size: 200000,
      },
    ],
  }
}

export function quiltProfile(loaderVersion = '0.24.0', mcVersion = '1.20.1'): Record<string, unknown> {
  return {
    id: `quilt-loader-${loaderVersion}-${mcVersion}`,
    inheritsFrom: mcVersion,
    type: 'release',
    mainClass: 'org.quiltmc.loader.impl.launch.knot.KnotClient',
    libraries: [
      {
        name: 'org.quiltmc:quilt-loader:0.24.0',
        url: 'https://maven.quiltmc.org/repository/release/',
        sha1: '3'.repeat(40),
        size: 300000,
      },
    ],
  }
}

export function installerVersionJson(
  dirName: string,
  mcVersion: string,
  loaderType: 'forge' | 'neoforge',
): Record<string, unknown> {
  const libraryName =
    loaderType === 'forge'
      ? `net.minecraftforge:forge:${mcVersion}-47.2.0`
      : `net.neoforged:forge:${mcVersion}-47.1.106`
  return {
    id: dirName,
    inheritsFrom: mcVersion,
    type: 'release',
    mainClass: 'cpw.mods.bootstraplauncher.BootstrapLauncher',
    libraries: [
      {
        name: libraryName,
        url: 'https://maven.minecraftforge.net/',
        sha1: '4'.repeat(40),
        size: 500000,
      },
    ],
  }
}

/** Writes a version dir as an installer would and emits typical output lines. */
export async function simulateForgeInstaller(
  child: FakeChild,
  input: {
    mcRoot: string
    dirName?: string
    mcVersion?: string
    loaderType?: 'forge' | 'neoforge'
    exitCode?: number
    writeVersion?: boolean
  },
): Promise<void> {
  const mcVersion = input.mcVersion ?? '1.20.1'
  const loaderType = input.loaderType ?? 'forge'
  const dirName =
    input.dirName ?? (loaderType === 'forge' ? `${mcVersion}-forge-47.2.0` : `${mcVersion}-neoforge-47.1.106`)
  const lines = [
    `Analyzing ${mcVersion}...`,
    'Downloading 18 libraries...',
    '(3/18) Downloading net.minecraftforge:forge:1.20.1-47.2.0',
    '(9/18) Downloading com.mojang:logging:1.1.1',
    'Installing client...',
    'Done',
  ]
  for (const line of lines) {
    child.stdout.write(`${line}\n`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  if (input.writeVersion !== false) {
    const dir = path.join(input.mcRoot, 'versions', dirName)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, `${dirName}.json`),
      `${JSON.stringify(installerVersionJson(dirName, mcVersion, loaderType), null, 2)}\n`,
    )
    child.stdout.write(`Created ${dirName}\n`)
  }
  child.emit('exit', input.exitCode ?? 0, null)
}

export async function installerSha1(file: string): Promise<string> {
  return sha1File(file)
}
