import path from 'node:path'
import {
  InstanceSettingsSchema,
  type InstanceSettings,
  type Loader,
} from '@shared/instance'
import type { FsPort } from '../ports'
import { versionsDirectory } from '../version/load'

export const DEFAULT_MEMORY = { minMb: 1024, maxMb: 4096 }

export function instanceDirectory(mcRoot: string, dirName: string): string {
  return path.join(versionsDirectory(mcRoot), dirName)
}

/** `shared` → mcRoot, `isolated` → versions/<dir>. */
export function gameDirectory(
  mcRoot: string,
  dirName: string,
  isolation: 'shared' | 'isolated',
): string {
  return isolation === 'isolated' ? instanceDirectory(mcRoot, dirName) : mcRoot
}

/** PCL-compatible native folder: `versions/<dir>/<dir>-natives`. */
export function nativesDirectory(mcRoot: string, dirName: string): string {
  return path.join(instanceDirectory(mcRoot, dirName), `${dirName}-natives`)
}

export interface DefaultSettingsInput {
  dirName: string
  id?: string
  name?: string
  mcVersion: string | null
  loader: Loader
  isolation?: 'shared' | 'isolated'
  source?: 'ours' | 'pcl' | 'pack' | 'manual'
  now?: number
  window?: { width: number; height: number; fullscreen: boolean }
}

export function defaultInstanceSettings(input: DefaultSettingsInput): InstanceSettings {
  return {
    schemaVersion: 1,
    id: input.id ?? input.dirName,
    dirName: input.dirName,
    name: input.name ?? input.dirName,
    mcVersion: input.mcVersion,
    loader: input.loader,
    java: { mode: 'auto', value: null },
    memory: { ...DEFAULT_MEMORY },
    memoryMode: 'auto',
    window: input.window ?? { width: 1280, height: 720, fullscreen: false },
    isolation: input.isolation ?? 'isolated',
    serverAuth: { type: 'none' },
    autoJoin: null,
    jvmArgs: [],
    source: input.source ?? 'ours',
    createdAt: input.now ?? Date.now(),
    lastPlayedAt: null,
    playTimeSec: 0,
    icon: null,
  }
}

export interface ReadSettingsResult {
  settings: InstanceSettings | null
  error: string | null
  /**
   * Which sections the file actually set. Zod defaults make "1024-4096" look
   * identical to "not configured", and auto memory depends on that distinction.
   */
  explicit: { memory: boolean; window: boolean; java: boolean }
}

const NO_EXPLICIT = { memory: false, window: false, java: false }

/** A corrupt `instance.json` never blocks scanning; it is reported instead. */
export function readInstanceSettings(fs: FsPort, dir: string): ReadSettingsResult {
  const file = path.join(dir, 'instance.json')
  if (!fs.exists(file)) return { settings: null, error: null, explicit: { ...NO_EXPLICIT } }
  try {
    const raw = JSON.parse(fs.readText(file)) as Record<string, unknown>
    const parsed = InstanceSettingsSchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
      return {
        settings: null,
        error: `invalid instance.json: ${issues}`,
        explicit: { ...NO_EXPLICIT },
      }
    }
    return {
      settings: parsed.data,
      error: null,
      explicit: {
        memory: raw.memory !== undefined,
        window: raw.window !== undefined,
        java: raw.java !== undefined,
      },
    }
  } catch (error) {
    return {
      settings: null,
      error: `unreadable instance.json: ${error instanceof Error ? error.message : String(error)}`,
      explicit: { ...NO_EXPLICIT },
    }
  }
}

export function writeInstanceSettings(fs: FsPort, dir: string, settings: InstanceSettings): InstanceSettings {
  const parsed = InstanceSettingsSchema.parse(settings)
  fs.writeTextAtomic(path.join(dir, 'instance.json'), `${JSON.stringify(parsed, null, 2)}\n`)
  return parsed
}
