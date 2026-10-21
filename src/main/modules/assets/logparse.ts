import type { LogLevel } from '@shared/assets'

export interface ParsedLogLine {
  timestamp: number | null
  level: LogLevel | null
  source: string
  message: string
}

const LEVELS = new Set<LogLevel>(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
}

export function levelRank(level: LogLevel | null): number {
  return level ? LEVEL_ORDER[level] : -1
}

function normalizeLevel(value: string | null | undefined): LogLevel | null {
  if (!value) return null
  const lower = value.toLowerCase()
  return LEVELS.has(lower as LogLevel) ? (lower as LogLevel) : null
}

function parseLauncherLine(line: string, source: string): ParsedLogLine | null {
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s+([A-Za-z]+)\s+(?:\[([^\]]+)\]\s*)?(.*)$/,
  )
  if (!match) return null
  const timestamp = Date.parse(match[1])
  return {
    timestamp: Number.isFinite(timestamp) ? timestamp : null,
    level: normalizeLevel(match[2]),
    source,
    message: match[3] ? `[${match[3]}] ${match[4]}` : match[4],
  }
}

function parseJsonLine(line: string, source: string, fallback: number): ParsedLogLine | null {
  if (!line.trimStart().startsWith('{')) return null
  try {
    const record = JSON.parse(line) as Record<string, unknown>
    if (typeof record.msg !== 'string' && typeof record.message !== 'string') return null
    const rawTs = record.ts ?? record.time ?? record.timestamp
    const timestamp =
      typeof rawTs === 'string'
        ? Date.parse(rawTs)
        : typeof rawTs === 'number'
          ? rawTs
          : fallback
    const scope = typeof record.scope === 'string' ? record.scope : null
    const message = String(record.msg ?? record.message)
    return {
      timestamp: Number.isFinite(timestamp) ? timestamp : null,
      level: normalizeLevel(typeof record.level === 'string' ? record.level : null),
      source,
      message: scope ? `[${scope}] ${message}` : message,
    }
  } catch {
    return null
  }
}

function parseGameLine(
  line: string,
  source: string,
  modifiedAt: number,
): ParsedLogLine | null {
  const match = line.match(/^\[(\d{2}):(\d{2}):(\d{2})\]\s+\[([^\]]+)\]:?\s?(.*)$/)
  if (!match) return null
  const base = new Date(modifiedAt)
  const time = new Date(
    base.getFullYear(),
    base.getMonth(),
    base.getDate(),
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ).getTime()
  const timestamp = time > modifiedAt + 60 * 60 * 1000 ? time - 24 * 60 * 60 * 1000 : time
  const thread = match[4]
  const levelMatch = thread.match(/\/([A-Za-z]+)$/)
  return {
    timestamp,
    level: normalizeLevel(levelMatch?.[1]),
    source,
    message: `[${thread}] ${match[5]}`,
  }
}

export function parseLogText(
  text: string,
  input: { area: 'launcher' | 'game'; source: string; modifiedAt: number },
): ParsedLogLine[] {
  const result: ParsedLogLine[] = []
  const lines = text.split(/\r?\n/)
  // Keep a hard cap so a hostile/oversized log cannot exhaust IPC memory.
  for (const line of lines.slice(0, 200_000)) {
    if (!line.trim()) continue
    const parsed =
      input.area === 'launcher'
        ? parseJsonLine(line, input.source, input.modifiedAt) ??
          parseLauncherLine(line, input.source)
        : parseGameLine(line, input.source, input.modifiedAt)
    result.push(
      parsed ?? {
        timestamp: input.modifiedAt,
        level: null,
        source: input.source,
        message: line.slice(0, 4_000),
      },
    )
  }
  return result
}
