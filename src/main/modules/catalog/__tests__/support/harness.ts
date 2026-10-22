import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import type {
  InstallLocalFileResult,
  ModFile,
  ModpackImportFinished,
  ModpackImportProgress,
  ModpackImportStart,
  ModScanResult,
  ModsService,
} from '@shared/mods'

/** Minimal local Modrinth API/CDN + fake mods service for catalog tests. */

export interface RequestRecord {
  method: string
  path: string
  url: string
  headers: http.IncomingHttpHeaders
}

export interface TestServer {
  baseUrl: string
  requests: RequestRecord[]
  route(path: string, handler: (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void): void
  json(path: string, value: unknown): void
  bytes(path: string, body: Buffer): void
  count(path: string): number
  close(): Promise<void>
}

export async function startServer(): Promise<TestServer> {
  const routes = new Map<string, (req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void>()
  const requests: RequestRecord[] = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    requests.push({ method: req.method ?? 'GET', path: url.pathname, url: url.toString(), headers: req.headers })
    const handler = routes.get(url.pathname)
    if (!handler) {
      res.writeHead(404, { 'content-length': 0 }).end()
      return
    }
    handler(req, res, url)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    route(pathname, handler) {
      routes.set(pathname, handler)
    },
    json(pathname, value) {
      const text = JSON.stringify(value)
      routes.set(pathname, (_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        }).end(text)
      })
    },
    bytes(pathname, body) {
      routes.set(pathname, (_req, res) => {
        res.writeHead(200, {
          'content-type': 'application/java-archive',
          'content-length': body.length,
        }).end(body)
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

export function modFile(name: string, enabled = true): ModFile {
  return {
    name: name.replace(/\.disabled$/, ''),
    fileName: enabled ? name : `${name}.disabled`,
    kind: 'mods',
    enabled,
    size: 10,
    modifiedAt: 1,
    metadata: {
      id: 'sodium',
      name: 'Sodium',
      version: '0.5.8',
      loader: 'fabric',
      dependencies: [],
    },
    metadataError: null,
  }
}

export class FakeModsService implements ModsService {
  installs: Array<{ instanceId: string; path: string }> = []

  constructor(
    private readonly gameDir: string,
    private readonly mods: ModFile[],
  ) {}

  async scan(): Promise<ModScanResult> {
    return {
      instanceId: '1.20.1',
      gameDir: this.gameDir,
      files: {
        mods: {
          enabled: this.mods.filter((mod) => mod.enabled),
          disabled: this.mods.filter((mod) => !mod.enabled),
        },
        resourcepacks: { enabled: [], disabled: [] },
        shaderpacks: { enabled: [], disabled: [] },
      },
      totals: { enabled: this.mods.filter((mod) => mod.enabled).length, disabled: 0 },
      issues: [],
    }
  }

  async installLocalFile(input: { instanceId: string; path: string }): Promise<InstallLocalFileResult> {
    this.installs.push({ instanceId: input.instanceId, path: input.path })
    const dir = path.join(this.gameDir, 'mods')
    fs.mkdirSync(dir, { recursive: true })
    const base = path.basename(input.path)
    let target = path.join(dir, base)
    let suffix = 1
    while (fs.existsSync(target)) {
      target = path.join(dir, `${path.parse(base).name}-${suffix}${path.extname(base)}`)
      suffix += 1
    }
    fs.copyFileSync(input.path, target)
    return {
      kind: 'mods',
      targetPath: target,
      file: modFile(path.basename(target)),
    }
  }

  async setEnabled(): Promise<never> {
    throw new Error('not used')
  }
  async remove(): Promise<never> {
    throw new Error('not used')
  }
  async analyzeDependencies(): Promise<{ issues: [] }> {
    return { issues: [] }
  }
  async importModpack(): Promise<ModpackImportStart> {
    throw new Error('not used')
  }
  async cancelImport(): Promise<{ cancelled: boolean }> {
    throw new Error('not used')
  }
  async pauseImport(): Promise<{ paused: boolean }> {
    throw new Error('not used')
  }
  async resumeImport(): Promise<{ resumed: boolean }> {
    throw new Error('not used')
  }
  async importStatus(): Promise<ModpackImportProgress | null> {
    throw new Error('not used')
  }
  async importResult(): Promise<ModpackImportFinished | null> {
    throw new Error('not used')
  }
  async exportModpack(): Promise<never> {
    throw new Error('not used')
  }
  async openFolder(): Promise<{ path: string }> {
    return { path: this.gameDir }
  }
}
