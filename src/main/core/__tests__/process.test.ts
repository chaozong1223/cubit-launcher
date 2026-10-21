import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeFsPort, nodeProcessPort } from '../ports'
import { LineSplitter, startLaunchProcess } from '../launch/process'
import { makeTempRoot } from '../__tests__/helpers'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tempRoot(): string {
  const root = makeTempRoot('mcl-proc-')
  cleanup.push(root)
  return root
}

interface Running {
  lines: Array<{ stream: string; text: string; at: number; order: number }>
  exit: Awaited<ReturnType<ReturnType<typeof startLaunchProcess>['waitForExit']>>
  log: string
  firstLineOrder: number
}

const order: { value: number } = { value: 0 }

async function run(
  script: string,
  options: {
    menuMarker?: string
    stopAfterMs?: number
    killGraceMs?: number
  } = {},
): Promise<Running> {
  const root = tempRoot()
  const logFile = path.join(root, 'session.log')
  const handle = startLaunchProcess({
    sessionId: 'session-1',
    instanceId: 'instance-1',
    javaPath: process.execPath,
    argv: ['-e', script],
    cwd: root,
    env: { ...process.env },
    logFile,
    encoding: 'utf-8',
    fs: nodeFsPort(),
    ports: nodeProcessPort(),
    menuMarker: options.menuMarker ?? 'Sound engine started',
    killGraceMs: options.killGraceMs ?? 300,
  })

  const lines: Running['lines'] = []
  let firstLineOrder = -1
  handle.onLine((line) => {
    order.value += 1
    if (firstLineOrder < 0) firstLineOrder = order.value
    lines.push({ stream: line.stream, text: line.text, at: line.at, order: order.value })
  })

  if (options.stopAfterMs !== undefined) {
    setTimeout(() => {
      void handle.stop()
    }, options.stopAfterMs)
  }

  const exit = await handle.waitForExit()
  return {
    lines,
    exit,
    log: fs.readFileSync(logFile, 'utf8'),
    firstLineOrder,
  }
}

describe('startLaunchProcess', () => {
  it('streams stdout/stderr line by line and reports exit code + duration', async () => {
    const result = await run(
      [
        'console.log("out1")',
        'console.error("java.lang.OutOfMemoryError: Java heap space")',
        'setTimeout(() => { console.log("out2"); process.exit(3) }, 80)',
      ].join(';'),
    )

    const texts = result.lines.map((line) => line.text)
    expect(texts).toContain('out1')
    expect(texts).toContain('out2')
    expect(texts.some((text) => text.includes('OutOfMemoryError'))).toBe(true)
    expect(result.lines.some((line) => line.stream === 'stderr')).toBe(true)

    // Lines arrived before the process finished, not in one batch afterwards.
    expect(result.firstLineOrder).toBeGreaterThan(0)
    expect(result.lines[0].at).toBeLessThanOrEqual(result.exit.exitedAt)
    expect(result.lines.some((line) => line.at < result.exit.exitedAt)).toBe(true)

    expect(result.exit.exitCode).toBe(3)
    expect(result.exit.classification).toBe('crashed')
    expect(result.exit.durationMs).toBeGreaterThanOrEqual(0)
    expect(result.exit.exitedAt).toBeGreaterThanOrEqual(result.exit.startedAt)
    expect(result.exit.crashHints.map((hint) => hint.id)).toContain('memory')
    expect(result.exit.lastLines.length).toBeGreaterThan(0)

    expect(result.log).toContain('[stdout] out1')
    expect(result.log).toContain('[stderr] java.lang.OutOfMemoryError')
    expect(result.log).toContain(`# mc-launcher session session-1`)
    expect(result.log).toContain('classification=crashed')
  })

  it('classifies a clean exit with the main-menu marker as normal', async () => {
    const result = await run('console.log("Sound engine started"); setTimeout(() => process.exit(0), 30)')
    expect(result.exit.exitCode).toBe(0)
    expect(result.exit.sawMenu).toBe(true)
    expect(result.exit.classification).toBe('normal')
    expect(result.exit.crashHints).toHaveLength(0)
  })

  it('reports a fast exit without the marker as a launch anomaly, not a crash', async () => {
    const result = await run('process.exit(0)')
    expect(result.exit.exitCode).toBe(0)
    expect(result.exit.sawMenu).toBe(false)
    expect(result.exit.classification).toBe('suspect')
  })

  it('stops a long running process and reports it as killed', async () => {
    const result = await run('setInterval(() => {}, 500)', {
      stopAfterMs: 100,
      killGraceMs: 200,
    })
    expect(result.exit.classification).toBe('killed')
    expect(result.log).toContain('classification=killed')
  })

  it('reports a missing Java executable as PROCESS.SPAWN_FAILED', async () => {
    const root = tempRoot()
    const handle = startLaunchProcess({
      sessionId: 's',
      instanceId: 'i',
      javaPath: path.join(root, 'no-such-java.exe'),
      argv: ['-version'],
      cwd: root,
      env: { ...process.env },
      logFile: path.join(root, 'x.log'),
      fs: nodeFsPort(),
      ports: nodeProcessPort(),
    })
    await expect(handle.waitForExit()).rejects.toMatchObject({ code: 'PROCESS.SPAWN_FAILED' })
  })
})

describe('LineSplitter', () => {
  it('handles CRLF across chunks and lone CR', () => {
    const splitter = new LineSplitter()
    expect(splitter.feed('a\r')).toEqual([])
    expect(splitter.feed('\nb\r\nc')).toEqual(['a', 'b'])
    expect(splitter.flush()).toBe('c')
    expect(splitter.flush()).toBeNull()
  })

  it('splits overlong lines instead of buffering forever', () => {
    const splitter = new LineSplitter(5)
    expect(splitter.feed('abcdefgh')).toEqual(['abcde'])
    expect(splitter.flush()).toBe('fgh')
  })
})
