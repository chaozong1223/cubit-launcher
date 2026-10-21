import path from 'node:path'
import type { JavaCandidate, JavaMatch, JavaOverride, JavaRequirement, JavaSettings } from '@shared/java'
import { DEFAULT_JAVA_OVERRIDE } from '@shared/java'
import type { FsPort, ProcessPort } from '../../../core/ports'
import { CoreError } from '../../../core/errors'
import { findVersionDir, resolveVersion } from '../../../core/version/load'
import { readInstanceSettings } from '../../../core/instance/settings'
import { javaMajorForMinecraft } from '../../../core/java/version'
import { chooseJava } from '../../../core/java/select'
import { probeJavaExecutable } from '../../../core/java/probe'
import { resolveJavaExecutable } from '../../../core/java/detect'
import { JavaError, asJavaError } from './errors'

/**
 * Required-Java analysis and selection with an explicit explanation.
 *
 * Precedence (task acceptance): instance override > global default > automatic.
 * `requiredMajor` always comes from the (merged) version JSON
 * `javaVersion.majorVersion`, falling back to the t6 Minecraft-version table.
 */

export interface RequirementDeps {
  fs: FsPort
  mcRoot: string
  globalSettings: JavaSettings
}

export function readJavaRequirement(deps: RequirementDeps, versionId: string): JavaRequirement {
  const dirName = versionId
  const dir = findVersionDir(deps.fs, deps.mcRoot, versionId)
  if (!dir) {
    throw new JavaError('JAVA.VERSION_NOT_FOUND', {
      message: `version not found: ${versionId}`,
      details: { versionId, mcRoot: deps.mcRoot },
    })
  }

  let resolved: ReturnType<typeof resolveVersion>
  try {
    resolved = resolveVersion(deps.fs, deps.mcRoot, versionId)
  } catch (error) {
    throw new JavaError('JAVA.VERSION_NOT_FOUND', {
      message: error instanceof CoreError ? `${error.code}: ${error.message}` : String(error),
      details: { versionId },
      cause: error,
    })
  }

  const warnings = [...resolved.warnings]
  const jsonMajor =
    typeof resolved.json.javaVersion?.majorVersion === 'number'
      ? resolved.json.javaVersion.majorVersion
      : null
  const fallback = javaMajorForMinecraft(resolved.mcVersion)
  const requiredMajor = jsonMajor ?? fallback
  const requiredSource: JavaRequirement['requiredSource'] =
    jsonMajor !== null ? 'version-json' : fallback !== null ? 'fallback' : 'unknown'
  if (requiredMajor === null) {
    warnings.push('版本 JSON 没有 javaVersion，且无法从 MC 版本推断所需 Java；将使用最新已安装版本')
  }

  let instanceJava: JavaOverride | null = null
  try {
    const instance = readInstanceSettings(deps.fs, dir)
    instanceJava = instance.settings?.java ?? null
    if (instance.error) warnings.push(`instance.json：${instance.error}`)
  } catch (error) {
    warnings.push(`读取实例 Java 设置失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return {
    versionId: resolved.id,
    dirName: resolved.dirName,
    mcVersion: resolved.mcVersion,
    javaVersionComponent:
      typeof resolved.json.javaVersion?.component === 'string'
        ? resolved.json.javaVersion.component
        : null,
    requiredMajor,
    requiredSource,
    instanceJava,
    globalJava: deps.globalSettings.defaultJava,
    warnings,
  }
}

// --------------------------------------------------------------- matching

export interface MatchDeps {
  fs: FsPort
  ports: ProcessPort
  platform?: NodeJS.Platform
  arch?: string
  /** Provider ids to offer in the download suggestion. */
  providerIds?: Array<'adoptium' | 'microsoft'>
  now?: () => number
}

function activeOverride(override: JavaOverride | null | undefined): override is JavaOverride {
  return Boolean(override && override.mode !== 'auto' && override.value !== null && override.value !== undefined)
}

function rank(candidate: JavaCandidate): number {
  return candidate.version.major * 10_000 + candidate.version.patch
}

function sortedAlternatives(candidates: JavaCandidate[]): JavaCandidate[] {
  return [...candidates].sort((a, b) => rank(b) - rank(a))
}

async function candidateForPath(
  deps: MatchDeps,
  candidates: JavaCandidate[],
  rawPath: string,
): Promise<JavaCandidate | null> {
  const target = rawPath.trim()
  if (!target) return null
  const normalized = target.toLowerCase()
  const known = candidates.find(
    (candidate) =>
      candidate.path.toLowerCase() === normalized || candidate.home?.toLowerCase() === normalized,
  )
  if (known) return known

  const executable = resolveJavaExecutable(deps.fs, target, deps.platform ?? process.platform)
  if (!executable) return null
  const probe = await probeJavaExecutable(deps.ports, executable)
  if (!probe.ok) return null
  return {
    path: executable,
    home: probe.home ?? path.dirname(path.dirname(executable)),
    source: 'manual',
    version: probe.version,
    vendor: probe.vendor,
    arch: probe.arch,
    bits: probe.bits,
    probedAt: (deps.now ?? Date.now)(),
  }
}

function suggestionFor(input: {
  requiredMajor: number | null
  selected: JavaCandidate | null
  forcedMissingMajor: number | null
  providers: Array<'adoptium' | 'microsoft'>
  explicitInvalid: boolean
}): JavaMatch['download'] {
  const installedMajor = input.selected?.version.major ?? null
  if (input.explicitInvalid) {
    return {
      needed: false,
      suggestedMajor: null,
      installedMajor,
      sources: input.providers,
      reason: '手动指定的 Java 不可用；请重新选择或改回自动',
    }
  }
  if (input.forcedMissingMajor !== null) {
    return {
      needed: true,
      suggestedMajor: input.forcedMissingMajor,
      installedMajor,
      sources: input.providers,
      reason: `缺少指定的 Java ${input.forcedMissingMajor}，可一键下载`,
    }
  }
  if (input.requiredMajor !== null && (input.selected === null || installedMajor !== input.requiredMajor)) {
    return {
      needed: true,
      suggestedMajor: input.requiredMajor,
      installedMajor,
      sources: input.providers,
      reason:
        input.selected === null
          ? `没有找到 Java ${input.requiredMajor}，可一键下载`
          : `当前选择的 Java ${installedMajor} 与版本要求的 ${input.requiredMajor} 不同，可下载匹配版本`,
    }
  }
  return {
    needed: false,
    suggestedMajor: null,
    installedMajor,
    sources: input.providers,
    reason: null,
  }
}

export async function matchJava(
  requirement: JavaRequirement,
  candidates: JavaCandidate[],
  deps: MatchDeps,
): Promise<JavaMatch> {
  const providers = deps.providerIds ?? ['adoptium', 'microsoft']
  const instance = requirement.instanceJava
  const globalDefault = requirement.globalJava ?? DEFAULT_JAVA_OVERRIDE
  const instanceActive = activeOverride(instance)
  const globalActive = !instanceActive && activeOverride(globalDefault)
  const scope: JavaMatch['scope'] = instanceActive ? 'instance' : globalActive ? 'global' : 'auto'
  const override: JavaOverride | null = instanceActive ? instance : globalActive ? globalDefault : null
  const warnings = [...requirement.warnings]
  const alternatives = sortedAlternatives(candidates)

  // 1. Explicit path (instance > global).
  if (override && override.mode === 'path' && typeof override.value === 'string') {
    const candidate = await candidateForPath(deps, candidates, override.value)
    if (!candidate) {
      return {
        versionId: requirement.versionId,
        requiredMajor: requirement.requiredMajor,
        requiredSource: requirement.requiredSource,
        selected: null,
        scope,
        reason: {
          code: 'forced-path-invalid',
          text: `${scope === 'instance' ? '实例' : '全局'}设置的 Java 路径不可用：${override.value}`,
          details: { path: override.value },
        },
        alternatives,
        download: suggestionFor({
          requiredMajor: requirement.requiredMajor,
          selected: null,
          forcedMissingMajor: null,
          providers,
          explicitInvalid: true,
        }),
        warnings,
      }
    }
    warnings.push(
      `${scope === 'instance' ? '实例' : '全局'}设置指定 Java：${candidate.path}（Java ${candidate.version.major}）`,
    )
    return {
      versionId: requirement.versionId,
      requiredMajor: requirement.requiredMajor,
      requiredSource: requirement.requiredSource,
      selected: candidate,
      scope,
      reason: {
        code: scope === 'instance' ? 'instance-path' : 'global-path',
        text: `${scope === 'instance' ? '实例' : '全局默认'}指定使用 Java ${candidate.version.major}（${candidate.path}）`,
        details: { path: candidate.path, requiredMajor: requirement.requiredMajor },
      },
      alternatives,
      download: suggestionFor({
        requiredMajor: requirement.requiredMajor,
        selected: candidate,
        forcedMissingMajor: null,
        providers,
        explicitInvalid: false,
      }),
      warnings,
    }
  }

  // 2. Explicit major (instance > global).
  if (override && override.mode === 'major' && typeof override.value === 'number') {
    const target = override.value
    const matches = candidates.filter((candidate) => candidate.version.major === target)
    const selected = matches.length > 0 ? sortedAlternatives(matches)[0] : null
    if (!selected) {
      return {
        versionId: requirement.versionId,
        requiredMajor: requirement.requiredMajor,
        requiredSource: requirement.requiredSource,
        selected: null,
        scope,
        reason: {
          code: 'forced-major-missing',
          text: `${scope === 'instance' ? '实例' : '全局默认'}要求 Java ${target}，但本机没有检测到`,
          details: { requiredMajor: target },
        },
        alternatives,
        download: suggestionFor({
          requiredMajor: requirement.requiredMajor,
          selected: null,
          forcedMissingMajor: target,
          providers,
          explicitInvalid: false,
        }),
        warnings,
      }
    }
    warnings.push(
      `${scope === 'instance' ? '实例' : '全局默认'}要求 Java ${target}，已选择 ${selected.path}`,
    )
    return {
      versionId: requirement.versionId,
      requiredMajor: requirement.requiredMajor,
      requiredSource: requirement.requiredSource,
      selected,
      scope,
      reason: {
        code: scope === 'instance' ? 'instance-major' : 'global-major',
        text: `${scope === 'instance' ? '实例' : '全局默认'}指定 Java ${target}，已匹配 ${selected.path}`,
        details: { requiredMajor: target, selectedMajor: selected.version.major },
      },
      alternatives,
      download: suggestionFor({
        requiredMajor: requirement.requiredMajor,
        selected,
        forcedMissingMajor: null,
        providers,
        explicitInvalid: false,
      }),
      warnings,
    }
  }

  // 3. Automatic selection from the version requirement.
  try {
    const choice = chooseJava({
      candidates,
      requiredMajor: requirement.requiredMajor,
    })
    const selected = choice.candidate
    warnings.push(...choice.warnings)
    const exact = selected.version.major === requirement.requiredMajor
    const code: JavaMatch['reason']['code'] =
      requirement.requiredMajor === null
        ? 'unknown-version'
        : exact
          ? 'exact-match'
          : 'newer-allowed'
    const text =
      requirement.requiredMajor === null
        ? `无法确定版本所需 Java，使用已安装的 Java ${selected.version.major}`
        : exact
          ? `版本 ${requirement.versionId} 要求 Java ${requirement.requiredMajor}，已安装的 Java ${selected.version.major} 完全匹配`
          : `版本要求 Java ${requirement.requiredMajor}，使用已安装的 Java ${selected.version.major}（更高版本通常可用，但模组可能不兼容）`
    return {
      versionId: requirement.versionId,
      requiredMajor: requirement.requiredMajor,
      requiredSource: requirement.requiredSource,
      selected,
      scope: 'auto',
      reason: { code, text, details: { requiredMajor: requirement.requiredMajor } },
      alternatives,
      download: suggestionFor({
        requiredMajor: requirement.requiredMajor,
        selected,
        forcedMissingMajor: null,
        providers,
        explicitInvalid: false,
      }),
      warnings,
    }
  } catch (error) {
    if (!(error instanceof CoreError)) throw asJavaError(error)
    if (error.code !== 'JAVA.NOT_FOUND' && error.code !== 'JAVA.VERSION_MISMATCH') {
      throw asJavaError(error)
    }
    warnings.push(error.userMessage)
    const noJava = candidates.length === 0
    return {
      versionId: requirement.versionId,
      requiredMajor: requirement.requiredMajor,
      requiredSource: requirement.requiredSource,
      selected: null,
      scope: 'auto',
      reason: {
        code: noJava ? 'no-java' : 'required-missing',
        text: noJava
          ? requirement.requiredMajor === null
            ? '本机没有检测到任何 Java'
            : `本机没有检测到 Java；该版本需要 Java ${requirement.requiredMajor}`
          : `已安装的 Java 版本低于该版本需要的 Java ${requirement.requiredMajor}`,
        details: {
          requiredMajor: requirement.requiredMajor,
          available: candidates.map((candidate) => candidate.version.major),
        },
      },
      alternatives,
      download: suggestionFor({
        requiredMajor: requirement.requiredMajor,
        selected: null,
        forcedMissingMajor: null,
        providers,
        explicitInvalid: false,
      }),
      warnings,
    }
  }
}
