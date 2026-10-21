import { describe, expect, it } from 'vitest'
import { AppError, ERROR_CODES } from '@shared/errors'
import { CoreError } from '../core/errors'
import { LinkError } from '../modules/net/ticket'
import { toHandlerErrorShape } from './error-shape'

describe('kernel IPC domain error passthrough', () => {
  it('keeps CoreError codes and Chinese user messages', () => {
    const shape = toHandlerErrorShape(
      new CoreError('JAVA.VERSION_MISMATCH', {
        message: 'requires 21',
        userMessage: '这个实例需要 Java 21',
        hint: '在实例设置里切换 Java',
      }),
    )
    expect(shape).toMatchObject({
      code: 'JAVA.VERSION_MISMATCH',
      message: '这个实例需要 Java 21',
      retryable: false,
    })
    expect(shape.details?.hint).toBe('在实例设置里切换 Java')
  })

  it('keeps AppError codes', () => {
    const shape = toHandlerErrorShape(
      new AppError('MODS.PACK_UNSAFE_PATH', '压缩包包含路径穿越', {
        retryable: true,
        details: { path: '../x' },
      }),
    )
    expect(shape).toMatchObject({
      code: 'MODS.PACK_UNSAFE_PATH',
      message: '压缩包包含路径穿越',
      retryable: true,
    })
  })

  it('keeps third-party domain errors exposing toShape()', () => {
    const loaderError = Object.assign(new Error('technical detail'), {
      code: 'LOADER.PARENT_MISSING',
      userMessage: '缺少父版本',
      retryable: false,
      details: { versionId: '1.20.1' },
      toShape() {
        return {
          code: 'LOADER.PARENT_MISSING',
          message: '缺少父版本',
          retryable: false,
          details: { versionId: '1.20.1' },
        }
      },
    })
    expect(toHandlerErrorShape(loaderError)).toMatchObject({
      code: 'LOADER.PARENT_MISSING',
      message: '缺少父版本',
    })
  })

  it('keeps plain objects with a domain code', () => {
    const shape = toHandlerErrorShape({
      code: 'REPAIR.SCAN_FAILED',
      userMessage: '校验失败',
      retryable: true,
    })
    expect(shape).toEqual({ code: 'REPAIR.SCAN_FAILED', message: '校验失败', retryable: true })
  })

  it('keeps LinkError codes and localized messages', () => {
    const shape = toHandlerErrorShape(
      new LinkError('VERSION_MISMATCH', 'internal detail', { retryable: true }),
    )
    expect(shape).toMatchObject({
      code: 'VERSION_MISMATCH',
      message: '双方游戏版本不一致，暂时不能加入',
      retryable: true,
    })
    expect(shape.details?.technicalMessage).toBe('internal detail')
  })

  it('carries causeCode for diagnostics', () => {
    const shape = toHandlerErrorShape(
      new AppError('LAUNCH.PLAN_INVALID', '无法生成启动参数', {
        cause: Object.assign(new Error('ENOENT: java.exe'), { code: 'ENOENT' }),
      }),
    )
    expect(shape.details?.causeCode).toBe('ENOENT')
  })

  it('does not leak random system error codes as domain errors', () => {
    const shape = toHandlerErrorShape(
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
    )
    expect(shape).toEqual({
      code: ERROR_CODES.IPC_HANDLER_FAILED,
      message: 'write EPIPE',
      retryable: false,
    })
    expect(toHandlerErrorShape(new Error('boom')).code).toBe(ERROR_CODES.IPC_HANDLER_FAILED)
  })
})
