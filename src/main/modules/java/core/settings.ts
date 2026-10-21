import fs from 'node:fs'
import path from 'node:path'
import {
  JavaSettingsSchema,
  JavaSettingsPatchSchema,
  type JavaSettings,
  type JavaSettingsPatch,
} from '@shared/java'
import { JavaError } from './errors'

/**
 * Module-owned Java settings.
 *
 * `dataRoot/modules/java/settings.json` holds the global default and download
 * preferences; managed runtimes live in `dataRoot/java/` (already scanned by the
 * t6 detector as `launcher-runtime`, so a new JDK appears without extra wiring).
 */

export const JAVA_MODULE_DIR = 'java'

export function javaModuleDir(dataRoot: string): string {
  return path.join(dataRoot, 'modules', JAVA_MODULE_DIR)
}

export function javaSettingsFile(dataRoot: string): string {
  return path.join(javaModuleDir(dataRoot), 'settings.json')
}

export function javaCacheDir(dataRoot: string): string {
  return path.join(javaModuleDir(dataRoot), 'cache')
}

/** Managed JDK root; the t6 detector scans this path as `launcher-runtime`. */
export function managedJavaRoot(dataRoot: string): string {
  return path.join(dataRoot, 'java')
}

export const DEFAULT_JAVA_SETTINGS: JavaSettings = {
  schemaVersion: 1,
  defaultJava: { mode: 'auto', value: null },
  preferredSource: 'adoptium',
  autoDownload: true,
}

export interface JavaSettingsLogger {
  warn(message: string, fields?: Record<string, unknown>): void
  info?(message: string, fields?: Record<string, unknown>): void
}

export function loadJavaSettings(
  dataRoot: string,
  log?: JavaSettingsLogger,
): JavaSettings {
  const file = javaSettingsFile(dataRoot)
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_JAVA_SETTINGS }
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JavaSettingsSchema.safeParse(JSON.parse(text))
    if (!parsed.success) {
      log?.warn('java settings invalid; using defaults', {
        issues: parsed.error.issues.slice(0, 5).map((issue) => issue.path.join('.')),
      })
      return { ...DEFAULT_JAVA_SETTINGS }
    }
    return parsed.data
  } catch (error) {
    log?.warn('java settings unreadable; using defaults', {
      message: error instanceof Error ? error.message : String(error),
    })
    return { ...DEFAULT_JAVA_SETTINGS }
  }
}

export function mergeJavaSettings(
  current: JavaSettings,
  patch: JavaSettingsPatch,
): JavaSettings {
  const parsedPatch = JavaSettingsPatchSchema.safeParse(patch)
  if (!parsedPatch.success) {
    throw new JavaError('JAVA.SETTINGS_INVALID', {
      message: parsedPatch.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      details: { issues: parsedPatch.error.issues.slice(0, 10).map((issue) => issue.message) },
    })
  }
  const merged = JavaSettingsSchema.safeParse({ ...current, ...parsedPatch.data })
  if (!merged.success) {
    throw new JavaError('JAVA.SETTINGS_INVALID', {
      message: merged.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    })
  }
  return merged.data
}

/** Atomic settings write (temp file + rename, Windows fallback). */
export function saveJavaSettings(dataRoot: string, settings: JavaSettings): JavaSettings {
  const file = javaSettingsFile(dataRoot)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  ensureManagedRoot(dataRoot)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch {
    try {
      fs.rmSync(file, { force: true })
    } catch {
      /* best effort */
    }
    fs.renameSync(tmp, file)
  }
  return settings
}

export function ensureManagedRoot(dataRoot: string): string {
  const root = managedJavaRoot(dataRoot)
  try {
    fs.mkdirSync(root, { recursive: true })
    fs.accessSync(root, fs.constants.W_OK)
  } catch (error) {
    throw new JavaError('JAVA.INSTALL_DIR_UNWRITABLE', {
      message: `managed Java directory is not writable: ${root}`,
      details: { root },
      cause: error,
    })
  }
  return root
}
