import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { JavaCandidate, JavaSettings } from '@shared/java'
import { nodeFsPort } from '../../../core/ports'
import { DEFAULT_JAVA_SETTINGS } from '../core/settings'
import { readJavaRequirement } from '../core/requirement'
import { tempDir, writeInstanceJava, writeVersion } from './support/harness'

let mcRoot = ''

beforeEach(() => {
  mcRoot = tempDir('mcl-java-req-')
})

afterEach(() => {
  fs.rmSync(mcRoot, { recursive: true, force: true })
})

const globalSettings: JavaSettings = { ...DEFAULT_JAVA_SETTINGS }

describe('required Java from version JSON (t6 merge)', () => {
  it('reads javaVersion.majorVersion and the component', () => {
    writeVersion(mcRoot, { id: '1.20.1', javaMajor: 17 })
    const requirement = readJavaRequirement(
      { fs: nodeFsPort(), mcRoot, globalSettings },
      '1.20.1',
    )
    expect(requirement).toMatchObject({
      versionId: '1.20.1',
      mcVersion: '1.20.1',
      requiredMajor: 17,
      requiredSource: 'version-json',
      javaVersionComponent: 'java-runtime-17',
      instanceJava: null,
      globalJava: { mode: 'auto', value: null },
    })
  })

  it('falls back to the Minecraft-version table when javaVersion is absent', () => {
    writeVersion(mcRoot, { id: '1.16.5', javaMajor: null })
    const requirement = readJavaRequirement(
      { fs: nodeFsPort(), mcRoot, globalSettings },
      '1.16.5',
    )
    expect(requirement.requiredMajor).toBe(8)
    expect(requirement.requiredSource).toBe('fallback')
    expect(requirement.javaVersionComponent).toBeNull()
  })

  it('reports instance override and global default separately', () => {
    writeVersion(mcRoot, { id: '1.20.1', javaMajor: 17 })
    writeInstanceJava(mcRoot, '1.20.1', { mode: 'path', value: 'C:\\Java\\jdk17\\bin\\java.exe' })
    const global: JavaSettings = {
      ...DEFAULT_JAVA_SETTINGS,
      defaultJava: { mode: 'major', value: 21 },
    }
    const requirement = readJavaRequirement({ fs: nodeFsPort(), mcRoot, globalSettings: global }, '1.20.1')
    expect(requirement.instanceJava).toEqual({ mode: 'path', value: 'C:\\Java\\jdk17\\bin\\java.exe' })
    expect(requirement.globalJava).toEqual({ mode: 'major', value: 21 })
  })

  it('rejects a missing version with a readable code', () => {
    expect(() =>
      readJavaRequirement({ fs: nodeFsPort(), mcRoot, globalSettings }, 'nope'),
    ).toThrowError(/version not found/)
  })

  it('keeps unknown requirements explicit (no guessing)', () => {
    writeVersion(mcRoot, { id: 'custom-snapshot', mcVersion: 'custom-snapshot', javaMajor: null })
    const requirement = readJavaRequirement(
      { fs: nodeFsPort(), mcRoot, globalSettings },
      'custom-snapshot',
    )
    expect(requirement.requiredMajor).toBeNull()
    expect(requirement.requiredSource).toBe('unknown')
  })
})
