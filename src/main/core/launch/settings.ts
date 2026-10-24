import type { ProcessPort } from '../ports'
import { encodingForCodePage } from '../java/version'

/**
 * Auto memory for instances that never set it by hand.
 *
 * A flat "25% of RAM" ignores what actually decides the footprint: the number of
 * mods. A 1.12.2 kitchen-sink pack with 230 mods needs ~11 GB while 25% of a
 * 32 GB machine gave 8 GB — the game then stalls during mod loading.
 *
 *   budget = 2048 + mods × 40 MiB, clamped to [4096, min(70% RAM, 16384)]
 *
 * Without a mod count the old 25% rule still applies.
 */
export function autoMaxMemoryMb(totalBytes: number, modCount?: number | null): number {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) return 4096
  const totalMb = totalBytes / (1024 * 1024)
  const ceiling = Math.min(16_384, Math.round(totalMb * 0.7))
  const quarter = Math.round(totalMb * 0.25)
  const mods = typeof modCount === 'number' && modCount > 0 ? modCount : 0
  const budget = mods > 0 ? 2048 + Math.round(mods * 40) : quarter
  return Math.min(ceiling, Math.max(4096, budget))
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
