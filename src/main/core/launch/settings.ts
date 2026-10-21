import type { ProcessPort } from '../ports'
import { encodingForCodePage } from '../java/version'

/**
 * Auto memory: clamp(25% of physical memory, 2048, 8192) MiB (docs/01 R4.1).
 * The lower bound protects heavily modded packs; the upper bound avoids
 * starving the rest of the desktop.
 */
export function autoMaxMemoryMb(totalBytes: number): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 4096
  const quarter = Math.round((totalBytes / (1024 * 1024)) * 0.25)
  return Math.min(8192, Math.max(2048, quarter))
}

export interface CodePageResult {
  codePage: number
  source: 'chcp' | 'registry' | 'default'
}

/**
 * Windows ANSI code page drives `-Dstdout.encoding` (R4.3). `chcp` is the
 * cheapest source; the registry is the fallback; 936 is the documented local
 * default when both fail.
 */
export async function detectWindowsCodePage(
  ports: ProcessPort,
  platform: NodeJS.Platform = process.platform,
): Promise<CodePageResult> {
  if (platform !== 'win32') return { codePage: 65001, source: 'default' }

  const chcp = await ports.exec('cmd.exe', ['/d', '/c', 'chcp'], { timeoutMs: 3_000 })
  const chcpMatch = /(\d{3,5})/.exec(chcp.stdout)
  if (chcpMatch) return { codePage: Number(chcpMatch[1]), source: 'chcp' }

  const registry = await ports.exec(
    'reg.exe',
    ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Nls\\CodePage', '/v', 'ACP'],
    { timeoutMs: 3_000 },
  )
  const acpMatch = /ACP\s+REG_SZ\s+(\d+)/.exec(registry.stdout)
  if (acpMatch) return { codePage: Number(acpMatch[1]), source: 'registry' }

  return { codePage: 936, source: 'default' }
}

/** Charset label accepted by both Java (`-Dstdout.encoding`) and TextDecoder. */
export function logEncodingForCodePage(codePage: number): string {
  return encodingForCodePage(codePage)
}
