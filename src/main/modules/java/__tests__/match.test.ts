import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JavaCandidate, JavaRequirement } from '@shared/java'
import { nodeFsPort } from '../../../core/ports'
import { matchJava } from '../core/requirement'
import { fakePorts, tempDir } from './support/harness'

let root = ''

beforeEach(() => {
  root = tempDir('mcl-java-match-')
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function requirement(patch: Partial<JavaRequirement> = {}): JavaRequirement {
  return {
    versionId: '1.20.1',
    dirName: '1.20.1',
    mcVersion: '1.20.1',
    javaVersionComponent: 'java-runtime-17',
    requiredMajor: 17,
    requiredSource: 'version-json',
    instanceJava: null,
    globalJava: { mode: 'auto', value: null },
    warnings: [],
    ...patch,
  }
}

function candidate(file: string, major: number): JavaCandidate {
  return {
    path: file,
    home: path.dirname(path.dirname(file)),
    source: 'manual',
    version: { major, minor: 0, patch: 0, raw: `${major}.0.0` },
    vendor: 'Eclipse Adoptium',
    arch: 'x64',
    bits: 64,
    probedAt: 1,
  }
}

const java17 = candidate('C:\\Java\\jdk17\\bin\\java.exe', 17)
const java21 = candidate('C:\\Java\\jdk21\\bin\\java.exe', 21)

function deps() {
  return {
    fs: nodeFsPort(),
    ports: fakePorts(),
    platform: 'win32' as const,
    arch: 'x64',
    providerIds: ['adoptium', 'microsoft'] as Array<'adoptium' | 'microsoft'>,
  }
}

describe('automatic matching + explanation', () => {
  it('explains an exact match', async () => {
    const match = await matchJava(requirement(), [java17, java21], deps())
    expect(match.selected?.version.major).toBe(17)
    expect(match.scope).toBe('auto')
    expect(match.reason.code).toBe('exact-match')
    expect(match.reason.text).toContain('Java 17')
    expect(match.download).toMatchObject({ needed: false, suggestedMajor: null, installedMajor: 17 })
  })

  it('explains a newer fallback and suggests the required major', async () => {
    const match = await matchJava(requirement(), [java21], deps())
    expect(match.selected?.version.major).toBe(21)
    expect(match.reason.code).toBe('newer-allowed')
    expect(match.reason.text).toContain('更高版本通常可用')
    expect(match.download).toMatchObject({ needed: true, suggestedMajor: 17, installedMajor: 21 })
    expect(match.warnings.join('\n')).toContain('required Java 17 not found')
  })

  it('reports missing Java and offers a download', async () => {
    const match = await matchJava(requirement(), [], deps())
    expect(match.selected).toBeNull()
    expect(match.reason.code).toBe('no-java')
    expect(match.download).toMatchObject({
      needed: true,
      suggestedMajor: 17,
      sources: ['adoptium', 'microsoft'],
    })
    expect(match.download.reason).toContain('Java 17')
  })

  it('reports only-older Java as required-missing', async () => {
    const match = await matchJava(requirement(), [candidate('C:\\Java\\jdk8\\bin\\java.exe', 8)], deps())
    expect(match.selected).toBeNull()
    expect(match.reason.code).toBe('required-missing')
    expect(match.download.suggestedMajor).toBe(17)
  })

  it('handles unknown requirements without guessing', async () => {
    const match = await matchJava(
      requirement({ requiredMajor: null, requiredSource: 'unknown' }),
      [java21],
      deps(),
    )
    expect(match.selected?.version.major).toBe(21)
    expect(match.reason.code).toBe('unknown-version')
    expect(match.download.needed).toBe(false)
  })
})

describe('instance override > global default', () => {
  it('instance path wins over the global default', async () => {
    const match = await matchJava(
      requirement({
        instanceJava: { mode: 'path', value: java17.path },
        globalJava: { mode: 'path', value: java21.path },
      }),
      [java17, java21],
      deps(),
    )
    expect(match.scope).toBe('instance')
    expect(match.selected?.path).toBe(java17.path)
    expect(match.reason.code).toBe('instance-path')
    expect(match.reason.text).toContain('实例')
  })

  it('global path applies when the instance is automatic', async () => {
    const match = await matchJava(
      requirement({ globalJava: { mode: 'path', value: java21.path } }),
      [java17, java21],
      deps(),
    )
    expect(match.scope).toBe('global')
    expect(match.selected?.version.major).toBe(21)
    expect(match.reason.code).toBe('global-path')
  })

  it('instance major wins over a global path', async () => {
    const match = await matchJava(
      requirement({
        instanceJava: { mode: 'major', value: 21 },
        globalJava: { mode: 'path', value: java17.path },
      }),
      [java17, java21],
      deps(),
    )
    expect(match.scope).toBe('instance')
    expect(match.selected?.version.major).toBe(21)
    expect(match.reason.code).toBe('instance-major')
  })

  it('global major applies when the instance is automatic', async () => {
    const match = await matchJava(
      requirement({ globalJava: { mode: 'major', value: 21 } }),
      [java17, java21],
      deps(),
    )
    expect(match.scope).toBe('global')
    expect(match.selected?.version.major).toBe(21)
    expect(match.reason.code).toBe('global-major')
  })

  it('reports an invalid instance path instead of silently falling back', async () => {
    const match = await matchJava(
      requirement({ instanceJava: { mode: 'path', value: path.join(root, 'missing', 'bin', 'java.exe') } }),
      [java17],
      deps(),
    )
    expect(match.selected).toBeNull()
    expect(match.reason.code).toBe('forced-path-invalid')
    expect(match.download.needed).toBe(false)
  })

  it('probes a valid instance path that detection did not list', async () => {
    const home = path.join(root, 'custom-jdk17')
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(home, 'bin', 'java.exe'), Buffer.from('fake'))
    const match = await matchJava(
      requirement({ instanceJava: { mode: 'path', value: home } }),
      [],
      deps(),
    )
    expect(match.reason.code).toBe('instance-path')
    expect(match.selected?.version.major).toBe(17)
  })

  it('offers the explicitly requested major when it is missing', async () => {
    const match = await matchJava(
      requirement({ instanceJava: { mode: 'major', value: 25 } }),
      [java17, java21],
      deps(),
    )
    expect(match.selected).toBeNull()
    expect(match.reason.code).toBe('forced-major-missing')
    expect(match.download).toMatchObject({ needed: true, suggestedMajor: 25 })
  })
})
