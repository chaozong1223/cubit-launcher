import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Logger } from './logger'

const roots: string[] = []

function createLogger(): Logger {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-logger-'))
  roots.push(root)
  return new Logger({ dataRoot: root, level: 'trace' })
}

function epipe(): Error {
  return Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true })
    } catch {
      // The platform can briefly hold a log handle; test cleanup is best effort.
    }
  }
})

describe('Logger EPIPE hardening', () => {
  it('swallows stdout EPIPE, never throws, and keeps writing launcher.log', () => {
    const logger = createLogger()
    logger.info('test', 'before the pipe closes')

    const original = process.stdout.write
    process.stdout.write = (() => {
      throw epipe()
    }) as typeof process.stdout.write

    try {
      expect(() => logger.info('test', 'while stdout is broken')).not.toThrow()
      expect(() => logger.error('test', 'after the pipe broke')).not.toThrow()
      expect(() => logger.fatal('test', 'fatal after the pipe broke')).not.toThrow()
    } finally {
      process.stdout.write = original
    }

    const text = fs.readFileSync(logger.humanLogFile, 'utf8')
    expect(text).toContain('before the pipe closes')
    expect(text).toContain('while stdout is broken')
    expect(text).toContain('after the pipe broke')
    expect(text).toContain('fatal after the pipe broke')
    expect(fs.statSync(logger.humanLogFile).size).toBeGreaterThan(0)
  })

  it('swallows a throwing console sink (EPIPE) and keeps writing the file sinks', () => {
    const logger = createLogger()
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {
      throw epipe()
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      throw epipe()
    })

    try {
      expect(() => logger.info('test', 'console log EPIPE')).not.toThrow()
      expect(() => logger.error('test', 'console error EPIPE')).not.toThrow()
    } finally {
      logSpy.mockRestore()
      errorSpy.mockRestore()
    }

    const text = fs.readFileSync(logger.humanLogFile, 'utf8')
    expect(text).toContain('console log EPIPE')
    expect(text).toContain('console error EPIPE')
    expect(fs.readFileSync(logger.jsonlFile, 'utf8')).toContain('console error EPIPE')
  })

  it('swallows stderr EPIPE for error/fatal lines and still writes both sinks', () => {
    const logger = createLogger()
    const original = process.stderr.write
    process.stderr.write = (() => {
      throw epipe()
    }) as typeof process.stderr.write

    try {
      expect(() => logger.error('test', 'stderr error line')).not.toThrow()
      expect(() => logger.fatal('test', 'stderr fatal line')).not.toThrow()
    } finally {
      process.stderr.write = original
    }

    const text = fs.readFileSync(logger.humanLogFile, 'utf8')
    expect(text).toContain('stderr error line')
    expect(text).toContain('stderr fatal line')
    const jsonl = fs.readFileSync(logger.jsonlFile, 'utf8')
    expect(jsonl).toContain('stderr error line')
    expect(jsonl).toContain('stderr fatal line')
  })

  it('swallows an asynchronous stdout pipe error and keeps the file sink', () => {
    const logger = createLogger()
    expect(() => process.stdout.emit('error', epipe())).not.toThrow()
    expect(() => logger.info('test', 'after async stdout error')).not.toThrow()
    const text = fs.readFileSync(logger.humanLogFile, 'utf8')
    expect(text).toContain('after async stdout error')
  })
})

describe('Logger rotation', () => {
  it('rotates launcher.log by size and keeps at most maxFiles copies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-rotate-'))
    roots.push(root)
    const logger = new Logger({
      dataRoot: root,
      level: 'trace',
      console: false,
      maxBytes: 220,
      maxFiles: 3,
    })
    for (let index = 0; index < 30; index += 1) {
      logger.info('test', `rotation line ${String(index).padStart(2, '0')} abcdefghijklmnopqrstuvwxyz`)
    }
    const files = fs
      .readdirSync(path.join(root, 'logs'))
      .filter((name) => name === 'launcher.log' || /^launcher\.log\.\d+$/.test(name))
    expect(files.length).toBeLessThanOrEqual(3)
    expect(files).toContain('launcher.log')
    expect(files).toContain('launcher.log.1')
    expect(files).not.toContain('launcher.log.3')
    expect(fs.readFileSync(logger.humanLogFile, 'utf8')).toContain('rotation line 29')
    expect(fs.readFileSync(path.join(root, 'logs', 'launcher.log.1'), 'utf8').length).toBeGreaterThan(0)
  })

  it('starts a new app JSONL file when the UTC day changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-day-'))
    roots.push(root)
    let current = new Date('2026-10-21T23:59:00.000Z')
    const logger = new Logger({
      dataRoot: root,
      level: 'trace',
      console: false,
      now: () => current,
    })
    logger.info('test', 'day one')
    current = new Date('2026-10-22T00:01:00.000Z')
    logger.info('test', 'day two')
    const textOne = fs.readFileSync(path.join(root, 'logs', 'app-20261021.jsonl'), 'utf8')
    const textTwo = fs.readFileSync(path.join(root, 'logs', 'app-20261022.jsonl'), 'utf8')
    expect(textOne).toContain('day one')
    expect(textTwo).toContain('day two')
    expect(logger.jsonlFile.endsWith('app-20261022.jsonl')).toBe(true)
  })
})
