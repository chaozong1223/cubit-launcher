import path from 'node:path'
import type { ProcessPort } from '../ports'
import { parseJavaVersion, type JavaVersion } from './version'

export interface JavaProbeInfo {
  version: JavaVersion
  home: string | null
  vendor: string | null
  arch: string | null
  bits: 32 | 64 | 'unknown'
  /** First line of `java -version`, useful in logs. */
  versionLine: string | null
  rawOutput: string
}

export interface JavaProbeFailure {
  ok: false
  reason: string
  timedOut: boolean
}

export type JavaProbeResult = ({ ok: true } & JavaProbeInfo) | JavaProbeFailure

const PROPERTY_KEYS = [
  'java.version',
  'java.runtime.version',
  'java.home',
  'java.vendor',
  'os.arch',
  'java.vm.name',
] as const

function extractProperties(output: string): Record<string, string> {
  const properties: Record<string, string> = {}
  const pattern = /^\s*(java\.[a-z.]+|os\.arch)\s*=\s*(.+?)\s*$/gm
  for (const match of output.matchAll(pattern)) {
    const key = match[1]
    if ((PROPERTY_KEYS as readonly string[]).includes(key)) {
      properties[key] = match[2]
    }
  }
  return properties
}

function bitsFromArch(arch: string | null): 32 | 64 | 'unknown' {
  if (!arch) return 'unknown'
  const value = arch.toLowerCase()
  if (value.includes('64') || value === 'amd64' || value === 'aarch64') return 64
  if (value.includes('86') || value === 'i386' || value === 'i686') return 32
  return 'unknown'
}

function isMojibake(value: string | null): boolean {
  return Boolean(value && value.includes('\uFFFD'))
}

/**
 * Parses both `-XshowSettings:properties -version` and plain `-version`.
 *
 * Java writes these to stderr; callers may pass either stream. Property lines
 * win over the banner because they survive localized output.
 */
export function parseJavaProbeOutput(stdout: string, stderr: string): JavaProbeInfo | null {
  const output = `${stdout}\n${stderr}`
  const properties = extractProperties(output)

  const rawVersion =
    properties['java.version'] ??
    /version\s+"([^"]+)"/.exec(output)?.[1] ??
    /version\s+([0-9][^\s"']*)/.exec(output)?.[1] ??
    null

  const version = parseJavaVersion(rawVersion)
  if (!version) return null

  const arch = properties['os.arch'] ?? null
  const home = properties['java.home'] ?? null
  const versionLine =
    /(?:openjdk|java|java version)[^\r\n]*version\s+"[^"]+"/i.exec(output)?.[0]?.trim() ??
    /version\s+"[^"]+"/i.exec(output)?.[0]?.trim() ??
    null

  return {
    version,
    home: home && !isMojibake(home) ? home.replace(/[\\/]+$/, '') : null,
    vendor: properties['java.vendor'] ?? null,
    arch,
    bits: bitsFromArch(arch),
    versionLine,
    rawOutput: output.slice(0, 16_384),
  }
}

export interface ProbeJavaOptions {
  timeoutMs?: number
  /** Extra environment for the probe (usually cleaned). */
  env?: NodeJS.ProcessEnv
}

/**
 * Probes one executable. A broken JDK must never take the launcher down, so all
 * failures are returned as data and callers decide whether to drop the entry.
 */
export async function probeJavaExecutable(
  port: ProcessPort,
  javaPath: string,
  options: ProbeJavaOptions = {},
): Promise<JavaProbeResult> {
  const timeoutMs = options.timeoutMs ?? 8_000

  const first = await port.exec(javaPath, ['-XshowSettings:properties', '-version'], {
    timeoutMs,
    env: options.env,
    maxBuffer: 2 * 1024 * 1024,
  })

  if (first.spawnErrorCode === 'ENOENT') {
    return { ok: false, reason: 'executable not found', timedOut: false }
  }
  if (first.timedOut) {
    return { ok: false, reason: `probe timed out after ${timeoutMs} ms`, timedOut: true }
  }

  const parsed = parseJavaProbeOutput(first.stdout, first.stderr)
  if (parsed) return { ok: true, ...parsed }

  // Old or exotic runtimes may reject -XshowSettings; `-version` is universal.
  const fallback = await port.exec(javaPath, ['-version'], {
    timeoutMs,
    env: options.env,
    maxBuffer: 512 * 1024,
  })
  if (fallback.spawnErrorCode === 'ENOENT') {
    return { ok: false, reason: 'executable not found', timedOut: false }
  }
  if (fallback.timedOut) {
    return { ok: false, reason: `probe timed out after ${timeoutMs} ms`, timedOut: true }
  }
  const fallbackParsed = parseJavaProbeOutput(fallback.stdout, fallback.stderr)
  if (fallbackParsed) return { ok: true, ...fallbackParsed }

  const exit = first.code ?? fallback.code
  const tail = `${first.stderr}\n${fallback.stderr}`.trim().slice(0, 500)
  return {
    ok: false,
    reason: `no java version in output${exit === null ? '' : ` (exit ${exit})`}${tail ? `: ${tail}` : ''}`,
    timedOut: false,
  }
}

/** Derives the JDK home from `.../bin/java.exe`; used when java.home is mojibake. */
export function deriveJavaHome(javaPath: string): string {
  return path.dirname(path.dirname(javaPath))
}
