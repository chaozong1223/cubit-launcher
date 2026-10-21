import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { JavaCandidate } from '@shared/java'
import type { ProcessPort } from '../ports'
import { CoreError } from '../errors'
import {
  detectJava,
  findJavaExecutablesUnder,
  JavaDetectionCache,
  resolveJavaExecutable,
} from '../java/detect'
import {
  javaMajorForMinecraft,
  parseJavaVersion,
} from '../java/version'
import { parseJavaProbeOutput } from '../java/probe'
import { chooseJava, requiredJavaMajor } from '../java/select'
import { makeTempRoot } from '../__tests__/helpers'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tempRoot(): string {
  const root = makeTempRoot('mcl-java-')
  cleanup.push(root)
  return root
}

function touch(file: string): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '', 'utf8')
  return file
}

interface FakePortOptions {
  versions?: Record<string, string>
  broken?: string[]
  timeouts?: string[]
  registry?: string
  onProbe?: (file: string) => void
}

function fakePort(options: FakePortOptions = {}): ProcessPort {
  return {
    async exec(file, args) {
      if (path.basename(file).toLowerCase() === 'reg.exe') {
        return { stdout: options.registry ?? '', stderr: '', code: 0, timedOut: false }
      }
      options.onProbe?.(file)
      if (options.timeouts?.includes(file)) {
        return { stdout: '', stderr: '', code: null, timedOut: true }
      }
      if (options.broken?.includes(file)) {
        return { stdout: '', stderr: 'this is not a java runtime', code: 1, timedOut: false }
      }
      const version = options.versions?.[file] ?? '17.0.15'
      const home = path.dirname(path.dirname(file))
      const output = [
        'Property settings:',
        `    java.home = ${home}`,
        '    java.vendor = Eclipse Adoptium',
        `    java.version = ${version}`,
        '    os.arch = amd64',
        '',
        `openjdk version "${version}" 2026-01-01`,
      ].join('\n')
      return { stdout: '', stderr: output, code: 0, timedOut: false }
    },
    spawn() {
      throw new Error('spawn not expected in java tests')
    },
  }
}

describe('parseJavaVersion', () => {
  it('parses legacy and modern layouts', () => {
    expect(parseJavaVersion('1.8.0_402')).toMatchObject({ major: 8, patch: 402 })
    expect(parseJavaVersion('1.8.0_402-b06')).toMatchObject({ major: 8, patch: 402 })
    expect(parseJavaVersion('17.0.15')).toMatchObject({ major: 17, minor: 0, patch: 15 })
    expect(parseJavaVersion('21.0.12.1')).toMatchObject({ major: 21, patch: 12 })
    expect(parseJavaVersion('21-ea')).toMatchObject({ major: 21 })
    expect(parseJavaVersion('9.0.4')).toMatchObject({ major: 9, patch: 4 })
    expect(parseJavaVersion('25+36')).toMatchObject({ major: 25 })
    expect(parseJavaVersion('not java')).toBeNull()
  })

  it('maps Minecraft versions to required Java', () => {
    expect(javaMajorForMinecraft('1.20.5')).toBe(21)
    expect(javaMajorForMinecraft('1.21.3')).toBe(21)
    expect(javaMajorForMinecraft('1.20.1')).toBe(17)
    expect(javaMajorForMinecraft('1.18')).toBe(17)
    expect(javaMajorForMinecraft('1.17')).toBe(16)
    expect(javaMajorForMinecraft('1.16.5')).toBe(8)
    expect(javaMajorForMinecraft('1.7.10')).toBe(8)
    expect(javaMajorForMinecraft(null)).toBeNull()
    expect(requiredJavaMajor(17, '1.21.3')).toBe(17)
    expect(requiredJavaMajor(null, '1.21.3')).toBe(21)
  })
})

describe('parseJavaProbeOutput', () => {
  it('reads properties from stderr (java writes -version there)', () => {
    const info = parseJavaProbeOutput(
      '',
      [
        'Property settings:',
        '    java.home = C:\\Program Files\\Java\\jdk-17.0.9',
        '    java.vendor = Oracle Corporation',
        '    java.version = 17.0.9',
        '    os.arch = amd64',
      ].join('\r\n'),
    )
    expect(info).toMatchObject({
      version: { major: 17, patch: 9 },
      home: 'C:\\Program Files\\Java\\jdk-17.0.9',
      vendor: 'Oracle Corporation',
      bits: 64,
    })
  })

  it('falls back to the version banner', () => {
    const info = parseJavaProbeOutput('openjdk version "21.0.12" 2026-08-18\n', '')
    expect(info?.version.major).toBe(21)
    expect(info?.bits).toBe('unknown')
  })

  it('rejects output without a version', () => {
    expect(parseJavaProbeOutput('Hello', 'Error: could not open jvm.cfg')).toBeNull()
  })
})

describe('resolveJavaExecutable', () => {
  it('accepts homes, bin dirs and executables, and swaps javaw for java', () => {
    const root = tempRoot()
    const home = path.join(root, 'jdk-17')
    const java = touch(path.join(home, 'bin', 'java.exe'))
    touch(path.join(home, 'bin', 'javaw.exe'))
    const fsLike = {
      exists: (target: string) => fs.existsSync(target),
      stat: (target: string) => {
        try {
          return fs.statSync(target)
        } catch {
          return null
        }
      },
    } as never

    expect(resolveJavaExecutable(fsLike, home, 'win32')).toBe(java)
    expect(resolveJavaExecutable(fsLike, path.join(home, 'bin'), 'win32')).toBe(java)
    expect(resolveJavaExecutable(fsLike, path.join(home, 'bin', 'javaw.exe'), 'win32')).toBe(java)
  })

  it('searches the Mojang runtime layout', () => {
    const root = tempRoot()
    const java = touch(path.join(root, 'java-runtime-beta', 'bin', 'java.exe'))
    const fsLike = {
      exists: (target: string) => fs.existsSync(target),
      stat: (target: string) => {
        try {
          return fs.statSync(target)
        } catch {
          return null
        }
      },
      readDir: (target: string) => fs.readdirSync(target),
    }
    expect(findJavaExecutablesUnder(fsLike as never, root, 'win32', 4)).toContain(java)
  })
})

describe('detectJava', () => {
  it('covers manual, JAVA_HOME, Mojang, launcher, registry, common and PATH', async () => {
    const root = tempRoot()
    const manual = touch(path.join(root, 'manual', 'bin', 'java.exe'))
    const javaHome = touch(path.join(root, 'jdk17', 'bin', 'java.exe'))
    const launcher = touch(path.join(root, 'data', 'java', 'jdk21', 'bin', 'java.exe'))
    const mojang = touch(path.join(root, 'mc', 'runtime', 'java-runtime-beta', 'bin', 'java.exe'))
    const common = touch(path.join(root, 'common', 'Java', 'jdk8', 'bin', 'java.exe'))
    const registry = touch(path.join(root, 'regjdk', 'bin', 'java.exe'))
    const pathJava = touch(path.join(root, 'pathdir', 'java.exe'))

    const versions: Record<string, string> = {
      [manual]: '17.0.15',
      [javaHome]: '17.0.15',
      [launcher]: '21.0.12.1',
      [mojang]: '17.0.15',
      [common]: '1.8.0_402',
      [registry]: '11.0.22',
      [pathJava]: '25.0.1',
    }
    const ports = fakePort({
      versions,
      registry: `    JavaHome    REG_SZ    ${path.join(root, 'regjdk')}\r\n`,
    })

    const result = await detectJava({
      ports,
      platform: 'win32',
      arch: 'x64',
      env: {
        JAVA_HOME: path.join(root, 'jdk17'),
        PATH: path.join(root, 'pathdir'),
        ProgramFiles: path.join(root, 'common'),
        USERPROFILE: path.join(root, 'user'),
        APPDATA: path.join(root, 'appdata'),
        LOCALAPPDATA: path.join(root, 'local'),
      },
      dataRoot: path.join(root, 'data'),
      mcRoot: path.join(root, 'mc'),
      appDataDir: path.join(root, 'appdata'),
      exeDir: path.join(root, 'app'),
      extraPaths: [manual],
      now: () => 1_000,
    })

    const byPath = new Map(result.candidates.map((candidate) => [candidate.path, candidate]))
    expect([...byPath.keys()].sort()).toEqual(
      [manual, javaHome, launcher, mojang, common, registry, pathJava].sort(),
    )
    expect(byPath.get(common)?.version.major).toBe(8)
    expect(byPath.get(launcher)?.version.major).toBe(21)
    expect(byPath.get(pathJava)?.source).toBe('path')
    expect(byPath.get(registry)?.source).toBe('registry')
    expect(byPath.get(mojang)?.source).toBe('mojang-runtime')
    expect(byPath.get(launcher)?.source).toBe('launcher-runtime')
    expect(byPath.get(common)?.source).toBe('common-path')
    expect(result.sources).toContain('registry')
    expect(result.rejected).toHaveLength(0)
  })

  it('deduplicates the same executable and records broken JVMs', async () => {
    const root = tempRoot()
    const shared = touch(path.join(root, 'jdk17', 'bin', 'java.exe'))
    const broken = touch(path.join(root, 'broken', 'bin', 'java.exe'))
    const slow = touch(path.join(root, 'slow', 'bin', 'java.exe'))
    let probes = 0
    const ports = fakePort({
      broken: [broken],
      timeouts: [slow],
      onProbe: () => {
        probes += 1
      },
    })

    const result = await detectJava({
      ports,
      platform: 'win32',
      env: {
        JAVA_HOME: path.join(root, 'jdk17'),
        ProgramFiles: path.join(root, 'jdk17'),
        PATH: '',
      },
      dataRoot: path.join(root, 'data'),
      mcRoot: path.join(root, 'mc'),
      appDataDir: path.join(root, 'appdata'),
      extraPaths: [shared, broken, slow],
      now: () => 2_000,
    })

    expect(result.candidates.filter((candidate) => candidate.path === shared)).toHaveLength(1)
    expect(result.rejected.map((item) => item.path)).toEqual(
      expect.arrayContaining([broken, slow]),
    )
    expect(result.rejected.find((item) => item.path === slow)?.reason).toContain('timed out')
    expect(probes).toBeGreaterThanOrEqual(3)

    // Cache: second call does not probe again.
    const cache = new JavaDetectionCache()
    const first = await detectJava({ ports, cache, platform: 'win32', env: {}, dataRoot: root, mcRoot: null, now: () => 3_000 })
    const second = await detectJava({ ports, cache, platform: 'win32', env: {}, dataRoot: root, mcRoot: null, now: () => 3_001 })
    expect(first.cached).toBe(false)
    expect(second.cached).toBe(true)
    expect(second.durationMs).toBe(0)
  })
})

describe('chooseJava', () => {
  const candidate = (major: number, patch = 0, bits: 32 | 64 = 64): JavaCandidate => ({
    path: `C:\\java\\${major}.${patch}\\bin\\java.exe`,
    home: `C:\\java\\${major}.${patch}`,
    source: 'common-path',
    version: { major, minor: 0, patch, raw: `${major}.0.${patch}` },
    vendor: null,
    arch: 'amd64',
    bits,
    probedAt: 1,
  })

  it('prefers the exact required major', () => {
    const choice = chooseJava({ candidates: [candidate(17, 15), candidate(21, 12)], requiredMajor: 17 })
    expect(choice.candidate.version.major).toBe(17)
    expect(choice.warnings).toHaveLength(0)
  })

  it('allows a newer major with a warning', () => {
    const choice = chooseJava({ candidates: [candidate(21, 12)], requiredMajor: 17 })
    expect(choice.candidate.version.major).toBe(21)
    expect(choice.warnings[0]).toContain('newer')
  })

  it('blocks when every runtime is too old', () => {
    try {
      chooseJava({ candidates: [candidate(8, 402)], requiredMajor: 17 })
      throw new Error('expected JAVA.VERSION_MISMATCH')
    } catch (error) {
      expect((error as CoreError).code).toBe('JAVA.VERSION_MISMATCH')
    }
  })

  it('honours a forced path and a forced major', () => {
    const candidates = [candidate(17), candidate(21)]
    const byPath = chooseJava({
      candidates,
      requiredMajor: 17,
      forcedPath: candidates[1].path,
    })
    expect(byPath.candidate.version.major).toBe(21)
    expect(byPath.warnings[0]).toContain('forced')

    const byMajor = chooseJava({ candidates, requiredMajor: null, forcedMajor: 17 })
    expect(byMajor.candidate.version.major).toBe(17)
  })

  it('rejects an unknown forced path', () => {
    try {
      chooseJava({
        candidates: [candidate(17)],
        forcedPath: 'C:\\no-such-dir\\java.exe',
      })
      throw new Error('expected JAVA.INVALID')
    } catch (error) {
      expect((error as CoreError).code).toBe('JAVA.INVALID')
    }
  })

  it('picks the newest runtime when the required major is unknown', () => {
    const choice = chooseJava({ candidates: [candidate(17), candidate(21)], requiredMajor: null })
    expect(choice.candidate.version.major).toBe(21)
    expect(choice.warnings[0]).toContain('unknown Minecraft version')
  })
})
