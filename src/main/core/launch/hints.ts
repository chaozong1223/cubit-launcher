import type { CrashHint } from '@shared/launch'

export interface CrashRule {
  id: string
  category: CrashHint['category']
  confidence: CrashHint['confidence']
  title: string
  detail: string
  patterns: RegExp[]
}

/**
 * P0 crash rules (docs/01 R5.6). Rules are intentionally narrow: a false
 * "memory" conclusion is worse than "no known cause".
 */
export const CRASH_RULES: CrashRule[] = [
  {
    id: 'java-version',
    category: 'java',
    confidence: 'high',
    title: 'Java 版本不匹配',
    detail: '这个实例需要更高版本的 Java。请在实例设置里选择匹配的 Java 后重试。',
    patterns: [
      /UnsupportedClassVersionError/i,
      /class file version \d+\.\d+/i,
      /requires Java (\d+)/i,
      /has been compiled by a more recent version/i,
    ],
  },
  {
    id: 'jvm-args',
    category: 'jvm-args',
    confidence: 'high',
    title: 'JVM 参数错误',
    detail: 'Java 无法识别启动参数。请检查实例的 JVM 参数，移除无效项。',
    patterns: [
      /Unrecognized VM option/i,
      /Could not create the Java Virtual Machine/i,
      /Error: Could not find or load main class/i,
      /Invalid maximum heap size/i,
      /Too small maximum heap/i,
      /Invalid initial heap size/i,
    ],
  },
  {
    id: 'memory',
    category: 'memory',
    confidence: 'high',
    title: '内存不足',
    detail: '游戏耗尽了分配的内存。请在实例设置中提高最大内存（建议 4096 MB 以上）。',
    patterns: [
      /java\.lang\.OutOfMemoryError/i,
      /Java heap space/i,
      /GC overhead limit exceeded/i,
      /unable to allocate .* bytes/i,
      /insufficient memory/i,
    ],
  },
  {
    id: 'missing-dependency',
    category: 'classpath',
    confidence: 'medium',
    title: '缺少依赖或类',
    detail: '启动时找不到需要的类或库。请检查实例文件完整性，或补齐对应的前置模组。',
    patterns: [
      /NoClassDefFoundError/i,
      /ClassNotFoundException/i,
      /java\.lang\.module\.FindException/i,
      /Missing or unsupported mandatory dependencies/i,
      /Failed to find library/i,
    ],
  },
  {
    id: 'mod-conflict',
    category: 'mods',
    confidence: 'medium',
    title: '模组冲突',
    detail: '模组之间出现重复或冲突。请检查最近的模组变更，并查看完整日志中的 Mod 列表。',
    patterns: [
      /Mixin apply failed/i,
      /MixinTransformerError/i,
      /Incompatible mod set/i,
      /Duplicate mods?/i,
      /Mod .* requires .* which is missing/i,
      /fml\.modloading\.ModLoadingException/i,
    ],
  },
  {
    id: 'graphics',
    category: 'graphics',
    confidence: 'medium',
    title: '显卡/OpenGL 错误',
    detail: '游戏无法初始化图形环境。请更新显卡驱动，或关闭光影/渲染优化模组后重试。',
    patterns: [
      /GLFW error/i,
      /Pixel format not accelerated/i,
      /EXCEPTION_ACCESS_VIOLATION/i,
      /The game crashed whilst/i,
      /Failed to create display/i,
      /OpenGL.*(?:error|not supported)/i,
      /WGL: (?:Failed|The driver)/i,
    ],
  },
]

function evidenceFor(lines: string[], pattern: RegExp): string | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (pattern.test(line)) return line.trim().slice(0, 300)
  }
  return null
}

/** Returns at most one hint per rule, ordered by matched evidence recency. */
export function detectCrashHints(lines: string[]): CrashHint[] {
  const hints: CrashHint[] = []
  for (const rule of CRASH_RULES) {
    for (const pattern of rule.patterns) {
      const evidence = evidenceFor(lines, pattern)
      if (!evidence) continue
      hints.push({
        id: rule.id,
        category: rule.category,
        confidence: rule.confidence,
        title: rule.title,
        detail: rule.detail,
        evidence,
      })
      break
    }
  }
  return hints
}

/** First user-facing conclusion, or the documented fallback. */
export function primaryConclusion(hints: CrashHint[]): string {
  if (hints.length === 0) return '未匹配到已知原因（已附完整日志）'
  return hints[0].title
}
