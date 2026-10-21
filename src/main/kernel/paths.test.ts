import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertPathBudget, isInside, resolveDataRoot, resolveMcRoot, winLongPath } from './paths'

const base = {
  argv: [] as string[],
  env: {} as NodeJS.ProcessEnv,
  cwd: 'D:\\work\\mc-launcher',
  exeDir: 'C:\\Apps\\mc-launcher',
  appDataDir: 'C:\\Users\\tester\\AppData\\Roaming',
  isPackaged: true,
}

describe('resolveDataRoot', () => {
  it('defaults to <exeDir>/data in packaged portable mode', () => {
    const result = resolveDataRoot(base)
    expect(result.dataRoot).toBe(path.resolve('C:\\Apps\\mc-launcher', 'data'))
    expect(result.portable).toBe(true)
    expect(result.source).toBe('default')
  })

  it('uses <cwd>/data while running from source', () => {
    const result = resolveDataRoot({ ...base, isPackaged: false })
    expect(result.dataRoot).toBe(path.resolve(base.cwd, 'data'))
    expect(result.portable).toBe(true)
  })

  it('honours MCL_DATA_DIR and anchors relative paths to exeDir in packaged builds', () => {
    const result = resolveDataRoot({ ...base, env: { MCL_DATA_DIR: 'custom-data' } })
    expect(result.dataRoot).toBe(path.resolve(base.exeDir, 'custom-data'))
    expect(result.portable).toBe(false)
    expect(result.source).toBe('env')
  })

  it('anchors relative overrides to cwd while running from source', () => {
    const result = resolveDataRoot({
      ...base,
      isPackaged: false,
      env: { MCL_DATA_DIR: 'custom-data' },
    })
    expect(result.dataRoot).toBe(path.resolve(base.cwd, 'custom-data'))
  })

  it('keeps absolute explicit paths unchanged in packaged builds', () => {
    const result = resolveDataRoot({ ...base, env: { MCL_DATA_DIR: 'D:\\portable\\data' } })
    expect(result.dataRoot).toBe(path.normalize('D:\\portable\\data'))
  })

  it('lets --data-dir override the environment', () => {
    const result = resolveDataRoot({
      ...base,
      argv: ['--data-dir=D:\\tmp\\mcl-data'],
      env: { MCL_DATA_DIR: 'ignored' },
    })
    expect(result.dataRoot).toBe(path.resolve('D:\\tmp\\mcl-data'))
    expect(result.source).toBe('cli')
  })

  it('switches to the roaming user directory with MCL_PORTABLE=0', () => {
    const result = resolveDataRoot({ ...base, env: { MCL_PORTABLE: '0' } })
    expect(result.dataRoot).toBe(path.resolve(base.appDataDir, 'mc-launcher'))
    expect(result.portable).toBe(false)
    expect(result.source).toBe('user')
  })

  it('supports the legacy MC_LAUNCHER_PORTABLE flag', () => {
    const result = resolveDataRoot({ ...base, env: { MC_LAUNCHER_PORTABLE: '1' } })
    expect(result.dataRoot).toBe(path.resolve(base.exeDir, 'data'))
    expect(result.source).toBe('portable')
  })
})

describe('resolveMcRoot', () => {
  it('resolves the CLI mc dir relative to cwd', () => {
    const result = resolveMcRoot({ ...base, argv: ['--mc-dir', 'E:\\MC\\.minecraft'] }, null)
    expect(result).toBe(path.resolve('E:\\MC\\.minecraft'))
  })

  it('falls back to config and accepts absolute paths', () => {
    const result = resolveMcRoot(base, 'E:\\MC\\.minecraft')
    expect(result).toBe(path.resolve('E:\\MC\\.minecraft'))
  })

  it('returns null when no mc root is configured', () => {
    expect(resolveMcRoot(base, null)).toBeNull()
  })
})

describe('isInside', () => {
  it('rejects siblings and prefix tricks', () => {
    expect(isInside('C:\\root', 'C:\\root\\a\\b')).toBe(true)
    expect(isInside('C:\\root', 'C:\\root-evil\\a')).toBe(false)
    expect(isInside('C:\\root', 'C:\\root')).toBe(false)
    expect(isInside('C:\\root', 'C:\\other')).toBe(false)
  })
})

describe('Windows long paths', () => {
  it('adds the extended prefix only for long paths and enforces a budget', () => {
    const short = path.resolve('C:\\Games\\MC')
    expect(winLongPath(short)).toBe(short)
    if (process.platform === 'win32') {
      const long = path.join('C:\\', 'a'.repeat(260))
      expect(winLongPath(long).startsWith('\\\\?\\')).toBe(true)
      expect(() => assertPathBudget(long, 'natives 目录')).toThrow()
    } else {
      expect(() => assertPathBudget(`/tmp/${'a'.repeat(300)}`, 'natives 目录')).not.toThrow()
    }
  })
})
