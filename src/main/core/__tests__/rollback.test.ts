import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RollbackStack } from '../fs/rollback'
import {
  resolvePathConflict,
  sanitizePathName,
  uniqueFileName,
  uniquePathName,
} from '../fs/conflict'

describe('RollbackStack (shared by share-pack import and cross-version save copy)', () => {
  it('unwinds in reverse order and continues after one step fails', async () => {
    const order: string[] = []
    const stack = new RollbackStack()
    stack.push('first', () => {
      order.push('first')
    })
    stack.push('second', () => {
      order.push('second')
      throw new Error('locked file')
    })
    stack.push('third', async () => {
      order.push('third')
    })

    const failures = await stack.rollback()
    expect(order).toEqual(['third', 'second', 'first'])
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ label: 'second', message: 'locked file' })
    expect(stack.size).toBe(0)
  })

  it('commit drops every undo action', async () => {
    const stack = new RollbackStack()
    let undone = false
    stack.push('step', () => {
      undone = true
    })
    stack.commit()
    expect(stack.size).toBe(0)
    expect(await stack.rollback()).toEqual([])
    expect(undone).toBe(false)
  })
})

describe('conflict policy helpers', () => {
  it('sanitizes invalid Windows characters, trailing dots and reserved names', () => {
    expect(sanitizePathName('My:Pack?')).toBe('My_Pack_')
    expect(sanitizePathName('  Name.  ')).toBe('Name')
    expect(sanitizePathName('CON')).toBe('share-CON')
    expect(sanitizePathName('')).toBe('share')
    expect(sanitizePathName('..', 'fallback')).toBe('fallback')
  })

  it('allocates the first free name-2, name-3 …', () => {
    const parent = path.join('root', 'versions')
    const taken = new Set(['Foo', 'Foo-2'])
    expect(uniquePathName(parent, 'Foo', (target) => taken.has(path.basename(target)))).toBe('Foo-3')
    expect(uniquePathName(parent, 'Bar', () => false)).toBe('Bar')
  })

  it('keeps the extension when numbering files', () => {
    const parent = path.join('root', 'schematics')
    const taken = new Set(['Castle.litematic', 'Castle-2.litematic'])
    expect(uniqueFileName(parent, 'Castle.litematic', (target) => taken.has(path.basename(target)))).toBe(
      'Castle-3.litematic',
    )
    expect(uniqueFileName(parent, 'plain', () => false)).toBe('plain')
  })

  it('resolves overwrite / skip / rename for an occupied target', () => {
    const base = { target: path.join('versions', 'Foo'), exists: () => true }
    expect(
      resolvePathConflict({ ...base, strategy: 'overwrite', uniqueTarget: () => 'unused' }),
    ).toMatchObject({ skip: false, renamed: false, target: base.target })
    expect(
      resolvePathConflict({ ...base, strategy: 'skip', uniqueTarget: () => 'unused' }),
    ).toMatchObject({ skip: true, renamed: false })
    expect(
      resolvePathConflict({
        ...base,
        strategy: 'rename',
        uniqueTarget: () => path.join('versions', 'Foo-2'),
      }),
    ).toMatchObject({ skip: false, renamed: true, target: path.join('versions', 'Foo-2') })

    expect(
      resolvePathConflict({
        target: base.target,
        strategy: 'rename',
        exists: () => false,
        uniqueTarget: () => 'unused',
      }),
    ).toMatchObject({ skip: false, renamed: false })
  })
})
