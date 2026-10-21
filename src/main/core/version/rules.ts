import type {
  ConditionalArgument,
  PlatformArch,
  PlatformName,
  Rule,
  RuleContext,
  VersionArgument,
} from './types'

const ARCH_ALIASES: Record<string, PlatformArch> = {
  x86: 'x86',
  i386: 'x86',
  i686: 'x86',
  x86_64: 'x86_64',
  x64: 'x86_64',
  amd64: 'x86_64',
  arm64: 'arm64',
  aarch64: 'arm64',
}

export function normalizeArch(value: string | undefined): PlatformArch | null {
  if (!value) return null
  return ARCH_ALIASES[value.toLowerCase()] ?? null
}

export function currentPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): { name: PlatformName; arch: PlatformArch; version: string } {
  const name: PlatformName =
    platform === 'win32' ? 'windows' : platform === 'darwin' ? 'osx' : 'linux'
  return {
    name,
    arch: normalizeArch(arch) ?? 'x86_64',
    version: '',
  }
}

export function createRuleContext(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  features: Record<string, boolean> = {},
  osVersion = '',
): RuleContext {
  const current = currentPlatform(platform, arch)
  return {
    os: { name: current.name, arch: current.arch, version: osVersion },
    features: { ...features },
  }
}

export function ruleMatches(rule: Rule, context: RuleContext): boolean {
  if (rule.os) {
    const { name, arch, version } = rule.os
    if (name && name !== context.os.name) return false
    if (arch) {
      const normalized = normalizeArch(arch)
      // Unknown arch spellings never match; ignoring them would silently load
      // the wrong natives jar.
      if (normalized === null || normalized !== context.os.arch) return false
    }
    if (version) {
      try {
        if (!new RegExp(version).test(context.os.version)) return false
      } catch {
        // A malformed regex in vendor JSON must not crash the launch chain.
        return false
      }
    }
  }

  if (rule.features) {
    for (const [feature, expected] of Object.entries(rule.features)) {
      if (Boolean(context.features[feature]) !== expected) return false
    }
  }

  return true
}

/**
 * Official semantics: an empty rule list allows the entry; otherwise the last
 * matching rule wins and "no match" means disallowed. That is exactly what the
 * conditional `--demo` / `--width` / quick-play arguments rely on.
 */
export function isRuleSetAllowed(rules: Rule[] | undefined, context: RuleContext): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const rule of rules) {
    if (ruleMatches(rule, context)) allowed = rule.action === 'allow'
  }
  return allowed
}

export function evaluateArgument(
  argument: VersionArgument,
  context: RuleContext,
): string[] | null {
  if (typeof argument === 'string') return [argument]
  if (!argument || typeof argument !== 'object') return null
  if (!isRuleSetAllowed(argument.rules, context)) return null
  const { value } = argument as ConditionalArgument
  return Array.isArray(value) ? [...value] : [value]
}

export function evaluateArguments(
  arguments_: VersionArgument[] | undefined,
  context: RuleContext,
): string[] {
  if (!arguments_) return []
  const result: string[] = []
  for (const argument of arguments_) {
    const values = evaluateArgument(argument, context)
    if (values) result.push(...values)
  }
  return result
}

/**
 * Legacy `minecraftArguments` is a space separated string. Values never contain
 * spaces in real files (`${auth_player_name}` etc.), so a plain split matches
 * the official launcher's behaviour.
 */
export function splitLegacyArguments(value: string): string[] {
  return value
    .split(/\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}
