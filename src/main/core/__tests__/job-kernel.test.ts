import { describe, expect, it } from 'vitest'
import { AppError } from '@shared/errors'
import { JobCancelledError, JobRegistry } from '../job/kernel'

const tick = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('JobRegistry', () => {
  it('runs a background task, reports progress and resolves the composed result', async () => {
    const registry = new JobRegistry<number>()
    const stages: string[] = []
    registry.onProgress((progress) => stages.push(progress.stage))
    const job = registry.start(
      { id: 'job-1', stage: 'scan', total: 2, meta: { instanceId: 'copy-1' } },
      async (ctx) => {
        ctx.setStage('copy')
        ctx.addBytes(10)
        ctx.addDone()
        await tick()
        ctx.setCurrent('mods/a.jar')
        ctx.addBytes(10)
        ctx.addDone()
        return 42
      },
    )

    const outcome = await registry.waitFor('job-1', 5_000)
    expect(outcome).toMatchObject({ jobId: 'job-1', ok: true, state: 'done', result: 42 })
    expect(outcome.error).toBeNull()
    expect(job.progress().bytesDone).toBe(20)
    expect(job.progress().done).toBe(2)
    expect(job.progress().currentFile).toBe('mods/a.jar')
    expect(stages).toContain('copy')
    expect(registry.status('job-1')?.state).toBe('done')
    expect(registry.meta('job-1')).toEqual({ instanceId: 'copy-1' })
    expect(registry.outcome('job-1')?.result).toBe(42)
    expect(registry.list()).toHaveLength(1)
  })

  it('cancels a running task, calls cleanup("cancelled") and resolves cancelled', async () => {
    const registry = new JobRegistry<never>()
    const cleanups: string[] = []
    let aborted = false
    registry.start(
      { id: 'job-2' },
      async (ctx) => {
        await new Promise<void>((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              aborted = true
              reject(new JobCancelledError())
            },
            { once: true },
          )
        })
        return 1 as never
      },
      { cleanup: (reason) => { cleanups.push(reason) } },
    )

    await tick()
    expect(registry.cancel('job-2')).toBe(true)
    expect(aborted).toBe(true)
    const outcome = await registry.waitFor('job-2', 5_000)
    expect(outcome.state).toBe('cancelled')
    expect(outcome.ok).toBe(false)
    expect(outcome.result).toBeNull()
    expect(cleanups).toEqual(['cancelled'])
    // A terminal job cannot be cancelled twice.
    expect(registry.cancel('job-2')).toBe(false)
  })

  it('pauses at a checkpoint and resumes without running the paused section early', async () => {
    const registry = new JobRegistry<string>()
    const order: string[] = []
    let release: () => void = () => undefined
    let entered = false
    registry.start({ id: 'job-3' }, async (ctx) => {
      await new Promise<void>((resolve) => {
        release = resolve
        entered = true
      })
      await ctx.checkpoint()
      order.push('after-checkpoint')
      return 'ok'
    })

    await tick()
    expect(entered).toBe(true)
    expect(registry.pause('job-3')).toBe(true)
    release()
    await tick(40)
    expect(order).toEqual([])
    expect(registry.status('job-3')?.state).toBe('paused')

    expect(registry.resume('job-3')).toBe(true)
    const outcome = await registry.waitFor('job-3', 5_000)
    expect(outcome.result).toBe('ok')
    expect(order).toEqual(['after-checkpoint'])
  })

  it('rejects a paused checkpoint when the job is cancelled', async () => {
    const registry = new JobRegistry<void>()
    let caught: unknown
    registry.start({ id: 'job-4' }, async (ctx) => {
      registry.pause('job-4')
      try {
        await ctx.checkpoint()
      } catch (error) {
        caught = error
        throw error
      }
    })
    await tick()
    registry.cancel('job-4')
    const outcome = await registry.waitFor('job-4', 5_000)
    expect(caught).toBeInstanceOf(JobCancelledError)
    expect(outcome.state).toBe('cancelled')
  })

  it('shape errors with the original AppError code and calls cleanup("failed")', async () => {
    const registry = new JobRegistry<number>()
    const cleanups: string[] = []
    registry.start(
      { id: 'job-5' },
      async () => {
        throw new AppError('MODS.PACK_INVALID', '鏁村悎鍖呭凡鎹熷潖')
      },
      { cleanup: (reason) => { cleanups.push(reason) } },
    )
    const outcome = await registry.waitFor('job-5', 5_000)
    expect(outcome.state).toBe('failed')
    expect(outcome.error).toMatchObject({ code: 'MODS.PACK_INVALID', message: '鏁村悎鍖呭凡鎹熷潖' })
    expect(cleanups).toEqual(['failed'])
  })

  it('uses the fallback code for unknown errors and never masks a failing cleanup', async () => {
    const registry = new JobRegistry<number>()
    registry.start(
      { id: 'job-6' },
      async () => {
        throw new Error('boom')
      },
      {
        failureCode: 'TEST.FAILED',
        cleanup: () => {
          throw new Error('cleanup exploded')
        },
      },
    )
    const outcome = await registry.waitFor('job-6', 5_000)
    expect(outcome.state).toBe('failed')
    expect(outcome.error).toMatchObject({ code: 'TEST.FAILED', message: 'boom' })
  })
})
