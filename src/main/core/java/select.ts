import type { JavaCandidate } from '@shared/java'
import { CoreError } from '../errors'
import { javaMajorForMinecraft } from './version'

export interface ChooseJavaOptions {
  candidates: JavaCandidate[]
  /** From `javaVersion.majorVersion` or the fallback table. */
  requiredMajor?: number | null
  /** Per-instance forced executable; takes priority over everything. */
  forcedPath?: string | null
  /** Per-instance forced major version. */
  forcedMajor?: number | null
}

export interface JavaChoiceResult {
  candidate: JavaCandidate
  requiredMajor: number | null
  warnings: string[]
}

function rank(candidate: JavaCandidate): number {
  return candidate.version.major * 10_000 + candidate.version.patch + (candidate.bits === 64 ? 0.5 : 0)
}

function best(candidates: JavaCandidate[]): JavaCandidate {
  return [...candidates].sort((a, b) => rank(b) - rank(a))[0]
}

export function requiredJavaMajor(
  versionJavaMajor: number | null | undefined,
  mcVersion: string | null,
): number | null {
  if (typeof versionJavaMajor === 'number' && Number.isFinite(versionJavaMajor)) {
    return versionJavaMajor
  }
  return javaMajorForMinecraft(mcVersion)
}

/**
 * Java selection contract (docs/01 R3.4/R3.5):
 *  forced path → forced major → exact required major → smallest major ≥ required
 *  → error. "Newer than required" is allowed with an explicit warning.
 */
export function chooseJava(options: ChooseJavaOptions): JavaChoiceResult {
  const { candidates } = options
  const requiredMajor =
    typeof options.requiredMajor === 'number' ? options.requiredMajor : null
  const warnings: string[] = []

  if (candidates.length === 0) {
    throw new CoreError('JAVA.NOT_FOUND', {
      message: 'no Java runtime was detected',
      hint: '请在设置中选择 java.exe，或安装一个 Java 运行时',
    })
  }

  if (options.forcedPath && options.forcedPath.trim().length > 0) {
    const normalized = options.forcedPath.trim().toLowerCase()
    const match = candidates.find((candidate) => candidate.path.toLowerCase() === normalized)
    if (!match) {
      throw new CoreError('JAVA.INVALID', {
        message: `forced Java path is not a usable runtime: ${options.forcedPath}`,
        hint: '这个 Java 路径不可用，请重新选择',
        details: { path: options.forcedPath },
      })
    }
    if (requiredMajor !== null && match.version.major !== requiredMajor) {
      warnings.push(
        `forced Java ${match.version.major} differs from required ${requiredMajor}; the game may fail to start`,
      )
    }
    return { candidate: match, requiredMajor, warnings }
  }

  if (typeof options.forcedMajor === 'number') {
    const matches = candidates.filter((candidate) => candidate.version.major === options.forcedMajor)
    if (matches.length === 0) {
      throw new CoreError('JAVA.NOT_FOUND', {
        message: `no Java ${options.forcedMajor} runtime was detected`,
        hint: `请安装 Java ${options.forcedMajor} 或在设置中改回自动`,
        details: { forcedMajor: options.forcedMajor },
      })
    }
    return { candidate: best(matches), requiredMajor, warnings }
  }

  if (requiredMajor === null) {
    warnings.push('unknown Minecraft version; using the newest detected Java')
    return { candidate: best(candidates), requiredMajor, warnings }
  }

  const exact = candidates.filter((candidate) => candidate.version.major === requiredMajor)
  if (exact.length > 0) {
    return { candidate: best(exact), requiredMajor, warnings }
  }

  const newer = candidates
    .filter((candidate) => candidate.version.major > requiredMajor)
    .sort((a, b) => {
      if (a.version.major !== b.version.major) return a.version.major - b.version.major
      return rank(b) - rank(a)
    })
  if (newer.length > 0) {
    warnings.push(
      `required Java ${requiredMajor} not found; using Java ${newer[0].version.major} (newer, may break mods)`,
    )
    return { candidate: newer[0], requiredMajor, warnings }
  }

  throw new CoreError('JAVA.VERSION_MISMATCH', {
    message: `no Java ${requiredMajor}+ runtime was detected`,
    userMessage: `该版本需要 Java ${requiredMajor}，当前只检测到更低版本`,
    hint: `请安装 Java ${requiredMajor} 或在实例设置中改选`,
    details: {
      requiredMajor,
      available: candidates.map((candidate) => candidate.version.major),
    },
  })
}
