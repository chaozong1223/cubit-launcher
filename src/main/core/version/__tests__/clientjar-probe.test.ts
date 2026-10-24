import { describe, expect, it } from 'vitest'
import { resolveClientJar } from '../load'
import type { VersionChainNode } from '../types'

const fsLike = {
  exists: (target: string) => !target.includes('missing'),
} as unknown as Parameters<typeof resolveClientJar>[0]

function node(dirName: string, json: Record<string, unknown> = {}): VersionChainNode {
  return {
    dirName,
    dir: `E:/MC/.minecraft/versions/${dirName}`,
    id: dirName,
    json,
  } as unknown as VersionChainNode
}

describe('resolveClientJar', () => {
  it('prefers the base version jar over a loader universal in the leaf folder', () => {
    const chain = [node('1.12.2'), node('modpack')]
    const resolved = resolveClientJar(fsLike, 'E:/MC/.minecraft', chain, 'E:/MC/.minecraft/versions')
    console.log(JSON.stringify({ clientJar: resolved.clientJar, jarVersionId: resolved.jarVersionId }))
    expect(resolved.jarVersionId).toBe('1.12.2')
  })

  it('honours an explicit jar pointer', () => {
    const chain = [node('1.20.1'), node('custom', { jar: '1.20.1-custom-client' })]
    const resolved = resolveClientJar(fsLike, 'E:/MC/.minecraft', chain, 'E:/MC/.minecraft/versions')
    expect(resolved.jarVersionId).toBe('1.20.1-custom-client')
  })

  it('keeps a plain vanilla version working', () => {
    const chain = [node('1.20.1')]
    const resolved = resolveClientJar(fsLike, 'E:/MC/.minecraft', chain, 'E:/MC/.minecraft/versions')
    expect(resolved.jarVersionId).toBe('1.20.1')
  })
})
