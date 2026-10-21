import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { DownloadFinished, DownloadProgress, DownloadTask } from '@shared/download'
import type { RepairDownloader } from '../../core/downloader'

export interface Fixture {
  root: string
  versionId: string
  indexText: string
  indexRel: string
  clientRel: string
  clientBytes: Buffer
  payloads: Map<string, Buffer>
  userFiles: Array<{ rel: string; content: string }>
}

function sha1(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex')
}

function write(rel: string, bytes: Buffer | string): void {
  const absolute = path.join(FIXTURE_ROOT!, ...rel.split('/'))
  fs.mkdirSync(path.dirname(absolute), { recursive: true })
  fs.writeFileSync(absolute, bytes)
}

let FIXTURE_ROOT: string | null = null

/**
 * Builds a small but realistic instance:
 *  - valid client, 1 valid library, 1 missing library, 1 corrupt library;
 *  - valid asset index, 1 valid asset, 1 missing asset, 1 corrupt asset;
 *  - extra files in the version dir/libraries/assets + user data.
 */
export function createFixture(prefix = 'mcl-repair-'): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  FIXTURE_ROOT = root
  const versionId = '1.20.1'
  const versionDir = `versions/${versionId}`

  const client = Buffer.from('valid-client-jar-content')
  const libA = Buffer.from('valid-library-a')
  const libC = Buffer.from('corrupt-library-c')
  const assetA = Buffer.from('valid-asset-a')
  const assetB = Buffer.from('missing-asset-b')
  const assetC = Buffer.from('corrupt-asset-c')
  const assetCEvil = Buffer.from('corrupt-asset-X') // same length, different bytes

  const libRelA = 'libraries/com/example/lib-a/1.0/lib-a-1.0.jar'
  const libRelB = 'libraries/com/example/lib-b/1.0/lib-b-1.0.jar'
  const libRelC = 'libraries/com/example/lib-c/1.0/lib-c-1.0.jar'

  const objects = {
    'sounds/a.ogg': { hash: sha1(assetA), size: assetA.length },
    'sounds/b.ogg': { hash: sha1(assetB), size: assetB.length },
    'textures/c.png': { hash: sha1(assetC), size: assetC.length },
  }
  const indexText = JSON.stringify({ objects })
  const indexBytes = Buffer.from(indexText)
  const indexRel = 'assets/indexes/test.json'

  const versionJson = {
    id: versionId,
    type: 'release',
    mainClass: 'net.minecraft.client.main.Main',
    assets: 'test',
    assetIndex: {
      id: 'test',
      url: 'https://example.invalid/indexes/test.json',
      sha1: sha1(indexBytes),
      size: indexBytes.length,
    },
    downloads: {
      client: {
        url: 'https://example.invalid/client.jar',
        sha1: sha1(client),
        size: client.length,
      },
    },
    libraries: [
      {
        name: 'com.example:lib-a:1.0',
        downloads: {
          artifact: {
            path: 'com/example/lib-a/1.0/lib-a-1.0.jar',
            url: 'https://example.invalid/lib-a.jar',
            sha1: sha1(libA),
            size: libA.length,
          },
        },
      },
      {
        name: 'com.example:lib-b:1.0',
        downloads: {
          artifact: {
            path: 'com/example/lib-b/1.0/lib-b-1.0.jar',
            url: 'https://example.invalid/lib-b.jar',
            sha1: sha1(Buffer.from('lib-b-content')),
            size: Buffer.byteLength('lib-b-content'),
          },
        },
      },
      {
        name: 'com.example:lib-c:1.0',
        downloads: {
          artifact: {
            path: 'com/example/lib-c/1.0/lib-c-1.0.jar',
            url: 'https://example.invalid/lib-c.jar',
            sha1: sha1(libC),
            size: libC.length,
          },
        },
      },
    ],
  }

  write(`${versionDir}/${versionId}.json`, `${JSON.stringify(versionJson, null, 2)}\n`)
  write(`${versionDir}/${versionId}.jar`, client)
  write(`${versionDir}/instance.json`, '{"schemaVersion":1}\n')
  write(libRelA, libA)
  write(libRelC, Buffer.from('bad-library-c')) // size mismatch
  write(indexRel, indexBytes)
  write(`assets/objects/${objects['sounds/a.ogg'].hash.slice(0, 2)}/${objects['sounds/a.ogg'].hash}`, assetA)
  write(
    `assets/objects/${objects['textures/c.png'].hash.slice(0, 2)}/${objects['textures/c.png'].hash}`,
    assetCEvil,
  )

  // Extras: version dir, shared libraries, shared asset objects.
  write(`${versionDir}/extra.txt`, 'extra')
  write('libraries/com/example/extra/1.0/extra.jar', 'extra-library')
  write(`assets/objects/ff/${'f'.repeat(40)}`, 'extra-asset')

  // User data that must never be touched or reported as owned.
  const userFiles = [
    { rel: 'mods/example-mod.jar', content: 'mod-bytes' },
    { rel: 'saves/world/level.dat', content: 'save-bytes' },
    { rel: 'config/example.json', content: '{"config":true}' },
    { rel: 'resourcepacks/pack.zip', content: 'resource-pack' },
    { rel: 'shaderpacks/shader.zip', content: 'shader-pack' },
  ]
  for (const file of userFiles) write(file.rel, file.content)

  const payloads = new Map<string, Buffer>([
    [`${versionDir}/${versionId}.jar`, client],
    [libRelB, Buffer.from('lib-b-content')],
    [libRelC, libC],
    [`assets/objects/${objects['sounds/b.ogg'].hash.slice(0, 2)}/${objects['sounds/b.ogg'].hash}`, assetB],
    [`assets/objects/${objects['textures/c.png'].hash.slice(0, 2)}/${objects['textures/c.png'].hash}`, assetC],
    [indexRel, indexBytes],
  ])

  return {
    root,
    versionId,
    indexText,
    indexRel,
    clientRel: `${versionDir}/${versionId}.jar`,
    clientBytes: client,
    payloads,
    userFiles,
  }
}

export function cleanupFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true })
}

export class FakeDownloader implements RepairDownloader {
  readonly enqueued: DownloadTask[] = []
  readonly jobs: Array<{ jobId: string; tasks: DownloadTask[] }> = []
  private nextId = 0
  private readonly progressListeners = new Set<(progress: DownloadProgress) => void>()
  private readonly finishedListeners = new Set<(finished: DownloadFinished) => void>()
  private readonly cancelled = new Set<string>()

  constructor(
    private readonly root: string,
    private readonly payloads: Map<string, Buffer>,
  ) {}

  async enqueue(tasks: DownloadTask[]): Promise<{ jobId: string; total: number }> {
    this.enqueued.push(...tasks)
    const jobId = `fake-download-${++this.nextId}`
    this.jobs.push({ jobId, tasks })
    setTimeout(() => void this.run(jobId, tasks), 0)
    return { jobId, total: tasks.length }
  }

  onProgress(listener: (progress: DownloadProgress) => void): () => void {
    this.progressListeners.add(listener)
    return () => this.progressListeners.delete(listener)
  }

  onFinished(listener: (finished: DownloadFinished) => void): () => void {
    this.finishedListeners.add(listener)
    return () => this.finishedListeners.delete(listener)
  }

  async cancel(jobId: string): Promise<{ cancelled: boolean }> {
    this.cancelled.add(jobId)
    return { cancelled: true }
  }

  status(): null {
    return null
  }

  private async run(jobId: string, tasks: DownloadTask[]): Promise<void> {
    let done = 0
    let skipped = 0
    let bytes = 0
    const failed: DownloadFinished['failed'] = []
    for (const task of tasks) {
      if (this.cancelled.has(jobId)) {
        this.emitFinished({
          jobId,
          ok: false,
          state: 'cancelled',
          downloaded: done,
          skipped,
          failed,
          bytes,
          durationMs: 0,
        })
        return
      }
      const absolute = path.join(this.root, ...task.destRel.split('/'))
      // Mirror t8's enqueue() behaviour: existing files are checked by size.
      const existing = fs.existsSync(absolute) ? fs.statSync(absolute) : null
      if (existing?.isFile() && typeof task.size === 'number' && existing.size === task.size) {
        skipped += 1
        done += 1
        this.emitProgress({
          jobId,
          kind: 'batch',
          state: 'running',
          stage: 'files',
          done,
          failed: failed.length,
          total: tasks.length,
          bytesDone: bytes,
          bytesTotal: [...this.payloads.values()].reduce((sum, value) => sum + value.length, 0),
          currentFile: task.destRel,
          bytesPerSec: 0,
          source: null,
          versionId: null,
          startedAt: 0,
          updatedAt: Date.now(),
          message: null,
        })
        continue
      }
      const payload = this.payloads.get(task.destRel)
      if (!payload) {
        failed.push({
          destRel: task.destRel,
          code: 'DOWNLOAD.TEST_MISSING_PAYLOAD',
          message: 'no fixture payload',
          retryable: false,
          attempts: 1,
          urls: [task.url],
        })
      } else {
        fs.mkdirSync(path.dirname(absolute), { recursive: true })
        fs.writeFileSync(absolute, payload)
        done += 1
        bytes += payload.length
      }
      this.emitProgress({
        jobId,
        kind: 'batch',
        state: 'running',
        stage: 'files',
        done,
        failed: failed.length,
        total: tasks.length,
        bytesDone: bytes,
        bytesTotal: [...this.payloads.values()].reduce((sum, value) => sum + value.length, 0),
        currentFile: task.destRel,
        bytesPerSec: 0,
        source: null,
        versionId: null,
        startedAt: 0,
        updatedAt: Date.now(),
        message: null,
      })
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    this.emitFinished({
      jobId,
      ok: failed.length === 0,
      state: failed.length === 0 ? 'done' : 'failed',
      downloaded: done,
      skipped,
      failed,
      bytes,
      durationMs: 0,
    })
  }

  private emitProgress(progress: DownloadProgress): void {
    for (const listener of this.progressListeners) listener(progress)
  }

  private emitFinished(finished: DownloadFinished): void {
    for (const listener of this.finishedListeners) listener(finished)
  }
}
