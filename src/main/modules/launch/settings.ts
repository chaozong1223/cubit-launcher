import fs from 'node:fs'
import path from 'node:path'
import { DEFAULT_GAME_LANGUAGE, normalizeGameLanguage } from '../../core/launch/options'

export interface LaunchSettings {
  language: string | null
  defaultLanguage: string
  note: string
}

interface StoredLaunchSettings {
  schemaVersion: 1
  language: string | null
}

const NOTE =
  '每次启动都会把该语言写入实例实际 gameDir/options.txt 的 lang 行（其它键保留，写入前备份一次）；游戏内手动改语言会在下次启动时被覆盖。选择“跟随游戏”则不修改 options.txt。'

function file(dataRoot: string): string {
  return path.join(dataRoot, 'modules', 'launch', 'settings.json')
}

export function loadLaunchSettings(dataRoot: string): LaunchSettings {
  let language: string | null = DEFAULT_GAME_LANGUAGE
  try {
    const parsed = JSON.parse(fs.readFileSync(file(dataRoot), 'utf8')) as Partial<StoredLaunchSettings>
    if (parsed && typeof parsed === 'object' && 'language' in parsed) {
      language = parsed.language === null ? null : normalizeGameLanguage(parsed.language)
    }
  } catch {
    // Missing/corrupt settings use the default zh_cn.
  }
  return { language, defaultLanguage: DEFAULT_GAME_LANGUAGE, note: NOTE }
}

export function saveLaunchSettings(
  dataRoot: string,
  input: { language: string | null },
): LaunchSettings {
  const language =
    input.language === null ? null : normalizeGameLanguage(input.language)
  if (input.language !== null && language === null) {
    throw new Error('invalid Minecraft language code')
  }
  const target = file(dataRoot)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  fs.writeFileSync(
    tmp,
    `${JSON.stringify({ schemaVersion: 1, language } satisfies StoredLaunchSettings, null, 2)}\n`,
    'utf8',
  )
  try {
    fs.renameSync(tmp, target)
  } catch {
    fs.rmSync(target, { force: true })
    fs.renameSync(tmp, target)
  }
  return loadLaunchSettings(dataRoot)
}
