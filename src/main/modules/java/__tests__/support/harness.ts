import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import type { ExecResult, ProcessPort, SpawnedProcess, SpawnOptions } from '../../../../core/ports'
import { nodeFsPort } from '../../../../core/ports'
import { defaultInstanceSettings, writeInstanceSettings } from '../../../../core/instance/settings'

/** Structural copy of the instance Java override (avoid extra shared type import). */
export type JavaOverrideInput = {
  mode: 'auto' | 'major' | 'path'
  value: number | string | null
}

/** HTTP server + fake Java runtime harness for the Java manager tests. */

export interface TestServer {
  baseUrl: string
  requests: Array<{ method: string; path: string }>
  route(pathname: string, handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): void
  serveBytes(pathname: string, bytes: Buffer): void
  serveJson(pathname: string, value: unknown): void
  serveSlow(pathname: string, bytes: Buffer, chunkSize: number, delayMs: number): void
  count(pathname: string): number
  close(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
  const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse) => void>()
  const requests: Array<{ method: string; path: string }> = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: req.method ?? 'GET', path: url.pathname })
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404, { 'content-length': 0 }).end()
      return
    }
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    route(pathname, handler) {
      routes.set(pathname, handler)
    },
    serveBytes(pathname, bytes) {
      routes.set(pathname, (_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/zip',
          'content-length': bytes.length,
        })
        res.end(bytes)
      })
    },
    serveJson(pathname, value) {
      const text = JSON.stringify(value)
      routes.set(pathname, (_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        })
        res.end(text)
      })
    },
    serveSlow(pathname, bytes, chunkSize, delayMs) {
      routes.set(pathname, (_req, res) => {
        res.writeHead(200, { 'content-length': bytes.length })
        let offset = 0
        const tick = () => {
          if (res.destroyed) return
          res.write(bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)))
          offset += chunkSize
          if (offset >= bytes.length) res.end()
          else setTimeout(tick, delayMs)
        }
        tick()
      })
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

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

export function javaProbeOutput(major: number, home: string): string {
  return [
    'Property settings:',
    `    java.home = ${home}`,
    `    java.version = ${major}.0.9`,
    '    java.vendor = Eclipse Adoptium',
    '    os.arch = amd64',
    '',
    `java version "${major}.0.9" 2025-01-01`,
  ].join('\n')
}

export interface FakePorts extends ProcessPort {
  execCalls: Array<{ file: string; args: string[] }>
  spawned: Array<{ file: string; args: string[]; options?: SpawnOptions }>
}

export function fakePorts(options: { javaMajor?: number } = {}): FakePorts {
  const execCalls: FakePorts['execCalls'] = []
  const spawned: FakePorts['spawned'] = []
  const ports: FakePorts = {
    execCalls,
    spawned,
    async exec(file, args): Promise<ExecResult> {
      execCalls.push({ file, args })
      const lower = file.toLowerCase()
      if (lower.includes('reg.exe') || lower.endsWith('where.exe') || lower.endsWith('cmd.exe')) {
        return { stdout: '', stderr: '', code: 1, timedOut: false }
      }
      const match = /java(?:\.exe)?$/i.test(file)
      if (!match) return { stdout: '', stderr: '', code: 1, timedOut: false }
      const majorMatch = /(?:adoptium|microsoft|jdk|java)[-_]?(\d+)/i.exec(file)
      const major = options.javaMajor ?? (majorMatch ? Number(majorMatch[1]) : 17)
      return {
        stdout: '',
        stderr: javaProbeOutput(Number.isFinite(major) ? major : 17, path.dirname(path.dirname(file))),
        code: 0,
        timedOut: false,
      }
    },
    spawn(file, args, spawnOptions) {
      spawned.push({ file, args, options: spawnOptions })
      const child = new EventEmitter() as SpawnedProcess & { kill(): boolean }
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      Object.assign(child, { pid: 1, stdout, stderr, stdin: new PassThrough() })
      child.kill = () => {
        child.emit('exit', null, 'SIGTERM')
        return true
      }
      return child
    },
  }
  return ports
}

export interface VersionFixture {
  id: string
  dir: string
  jsonPath: string
  major: number | null
}

export function writeVersion(
  mcRoot: string,
  options: { id?: string; javaMajor?: number | null; mcVersion?: string } = {},
): VersionFixture {
  const id = options.id ?? '1.20.1'
  const mcVersion = options.mcVersion ?? id
  const dir = path.join(mcRoot, 'versions', id)
  fs.mkdirSync(dir, { recursive: true })
  const json: Record<string, unknown> = {
    id,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: '5',
    assetIndex: { id: '5', url: 'https://example.invalid/5.json', sha1: 'a'.repeat(40), size: 10 },
    downloads: {
      client: { url: 'https://example.invalid/client.jar', sha1: 'b'.repeat(40), size: 10 },
    },
    libraries: [],
  }
  if (options.javaMajor !== null) {
    json.javaVersion = {
      component: `java-runtime-${options.javaMajor ?? 17}`,
      majorVersion: options.javaMajor ?? 17,
    }
  }
  const jsonPath = path.join(dir, `${id}.json`)
  fs.writeFileSync(jsonPath, `${JSON.stringify(json, null, 2)}\n`)
  fs.writeFileSync(path.join(dir, `${id}.jar`), Buffer.from('client-jar'))
  return { id, dir, jsonPath, major: options.javaMajor === null ? null : (options.javaMajor ?? 17) }
}

export function writeInstanceJava(
  mcRoot: string,
  dirName: string,
  java: JavaOverrideInput,
  mcVersion = '1.20.1',
): void {
  const dir = path.join(mcRoot, 'versions', dirName)
  const settings = defaultInstanceSettings({
    dirName,
    id: dirName,
    mcVersion,
    loader: { type: 'vanilla', version: null },
  })
  settings.java = java
  writeInstanceSettings(nodeFsPort(), dir, settings)
}
