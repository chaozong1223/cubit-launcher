import { describe, expect, it, vi } from 'vitest'
import {
  DownloadEventBus,
  DownloadJob,
  JobProgressEmitter,
} from '../core/job'

describe('DownloadJob', () => {
  it('reports files, bytes, current file and a sliding-window speed', () => {
    let now = 1_000
    const job = new DownloadJob({
      id: 'job-1',
      kind: 'install',
      versionId: '1.20.1',
      total: 3,
      bytesTotal: 300,
      now: () => now,
    })

    job.setStage('libraries')
    job.setState('running')
    job.setCurrent('libraries/a.jar', 'mirror')
    job.addBytes(100)
    now += 500
    job.addBytes(100)
    now += 500
    job.addBytes(100)

    const progress = job.progress()
    expect(progress).toMatchObject({
      jobId: 'job-1',
      kind: 'install',
      state: 'running',
      stage: 'libraries',
      total: 3,
      done: 0,
      bytesDone: 300,
      bytesTotal: 300,
      currentFile: 'libraries/a.jar',
      source: 'mirror',
      versionId: '1.20.1',
    })
    expect(progress.bytesPerSec).toBe(300)

    job.completeTask({ size: 100, skipped: false })
    job.completeTask({ size: 100, skipped: true })
    job.failTask({
      destRel: 'x',
      code: 'DOWNLOAD.HASH_MISMATCH',
      message: 'bad',
      retryable: true,
      attempts: 1,
      urls: [],
    })
    expect(job.progress()).toMatchObject({ done: 2, failed: 1 })
    expect(job.finished()).toMatchObject({
      jobId: 'job-1',
      ok: false,
      downloaded: 1,
      skipped: 1,
    })
  })

  it('marks a successful job ok only when no file failed', () => {
    const job = new DownloadJob({ id: 'j', kind: 'batch', total: 1, bytesTotal: 1 })
    job.completeTask({ size: 1, skipped: false })
    job.setState('done')
    expect(job.finished().ok).toBe(true)
  })
})

describe('JobProgressEmitter (docs/03 §6.3: 100 ms throttle)', () => {
  it('coalesces rapid progress into one trailing update', async () => {
    vi.useFakeTimers()
    try {
      const received: number[] = []
      let now = 1_000
      const emitter = new JobProgressEmitter(
        (progress) => received.push(progress.done),
        100,
        () => now,
      )
      const job = new DownloadJob({ id: 'j', kind: 'install', total: 10, bytesTotal: 100 })

      job.done = 1
      emitter.push(job.progress())
      expect(received).toEqual([1])

      now += 10
      job.done = 2
      emitter.push(job.progress())
      now += 10
      job.done = 3
      emitter.push(job.progress())
      expect(received).toEqual([1])

      vi.advanceTimersByTime(100)
      expect(received).toEqual([1, 3])

      now += 200
      job.done = 4
      emitter.push(job.progress(), true)
      expect(received).toEqual([1, 3, 4])
      emitter.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('never lets a listener exception break the download', () => {
    const emitter = new JobProgressEmitter(() => {
      throw new Error('renderer exploded')
    }, 100)
    const job = new DownloadJob({ id: 'j', kind: 'install', total: 1, bytesTotal: 1 })
    expect(() => emitter.push(job.progress(), true)).not.toThrow()
    emitter.dispose()
  })
})

describe('DownloadEventBus', () => {
  it('delivers asynchronously and isolates listener failures', async () => {
    const bus = new DownloadEventBus()
    const received: string[] = []
    bus.onProgress(() => {
      throw new Error('first listener fails')
    })
    bus.onProgress((progress) => received.push(progress.jobId))
    const finished: string[] = []
    bus.onFinished((event) => finished.push(event.jobId))

    const job = new DownloadJob({ id: 'job-x', kind: 'install', total: 1, bytesTotal: 1 })
    bus.publishProgress(job.progress())
    // setImmediate: nothing is delivered synchronously.
    expect(received).toEqual([])
    await new Promise((resolve) => setImmediate(resolve))
    expect(received).toEqual(['job-x'])

    job.setState('done')
    bus.publishFinished(job.finished())
    await new Promise((resolve) => setImmediate(resolve))
    expect(finished).toEqual(['job-x'])
  })
})
