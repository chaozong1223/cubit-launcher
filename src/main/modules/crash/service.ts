import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  CrashAnalysis,
  CrashContext,
  CrashExportResult,
  CrashReportResult,
  CrashText,
  FixAction,
  FixResult,
} from '@shared/crash'
import type { InstanceSettings } from '@shared/instance'
import { AppError } from '@shared/errors'
import type { ScopedLogger } from '../../kernel/logger'
import type { ModuleRoots } from '../_context'
import { requireMcRoot } from '../_context'
import { getService } from '../_services'
import {
  defaultInstanceSettings,
  gameDirectory,
  readInstanceSettings,
  writeInstanceSettings,
} from '../../core/instance/settings'
import { scanInstances, type ScannedInstance } from '../../core/instance/scan'
import { CRASH_RULES, actionsFor, type RuleMatch } from './rules'
import { createStoredZip, type ZipEntryInput } from './zip'

const MAX_LOG_BYTES = 8 * 1024 * 1024

export interface RepairFilesResult {
  jobId?: string
  message?: string
}

export interface CrashServiceOptions {
  roots: ModuleRoots
  log: ScopedLogger
  appVersion?: string
  openPath?: (target: string) => Promise<string>
  openExternal?: (url: string) => Promise<void>
  repairFiles?: (input: { versionId: string }) => Promise<RepairFilesResult>
  now?: () => number
}

interface ResolvedInstance {
  instance: ScannedInstance
  gameDir: string
  settings: InstanceSettings
}

interface LaunchLast {
  exitCode: number | null
  javaMajor: number | null
  javaVersion: string | null
  memory: { minMb: number; maxMb: number } | null
  logFile: string | null
  instanceId: string | null
}

function readJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  } catch {
    return null
  }
}

function readTail(file: string, maxBytes: number): string {
  try {
    const stat = fs.statSync(file)
    if (stat.size <= maxBytes) return fs.readFileSync(file, 'utf8')
    const buffer = Buffer.alloc(maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      fs.readSync(fd, buffer, 0, maxBytes, stat.size - maxBytes)
    } finally {
      fs.closeSync(fd)
    }
    return buffer.toString('utf8')
  } catch {
    return ''
  }
}

function tailLines(text: string, maxLines: number): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .slice(-maxLines)
    .map((line) => line.slice(0, 2_000))
}

function failed(code: string, message: string, details?: Record<string, unknown>): never {
  throw new AppError(code, message, { details })
}

function action(
  id: string,
  kind: FixAction['kind'],
  label: string,
  description: string,
  risk: FixAction['risk'],
  params: Record<string, unknown> = {},
): FixAction {
  return { id, kind, label, description, risk, automatic: kind !== 'manual', params }
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/** Local-time crash filename used by docs/01 R5.7. */
function crashStamp(ms: number): string {
  const date = new Date(ms)
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-` +
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  )
}

function redactReport(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<redacted-jwt>')
    .replace(/(--accessToken\s+)\S+/gi, '$1<redacted>')
    .replace(/(refresh_token["']?\s*[:=]\s*["']?)[^"',\s]+/gi, '$1<redacted>')
    .replace(/accessToken/gi, '<redacted-key>')
}

export class CrashModuleService {
  private readonly now: () => number
  private readonly lastAnalyses = new Map<string, CrashAnalysis>()
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>()

  constructor(private readonly options: CrashServiceOptions) {
    this.now = options.now ?? Date.now
  }

  onEvent(event: string, listener: (payload: unknown) => void): () => void {
    const set = this.listeners.get(event) ?? new Set()
    set.add(listener)
    this.listeners.set(event, set)
    return () => set.delete(listener)
  }

  private emit(event: string, payload: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      try {
        listener(payload)
      } catch {
        // An observer can never fail a repair or report write.
      }
    }
  }

  private emitChanged(instanceId: string | null): void {
    this.emit('changed', { instanceId })
  }

  private fsPort() {
    return {
      exists: (target: string) => fs.existsSync(target),
      stat: (target: string) => {
        try {
          return fs.statSync(target)
        } catch {
          return null
        }
      },
      readDir: (target: string) => {
        try {
          return fs.readdirSync(target)
        } catch {
          return []
        }
      },
      readText: (target: string) => fs.readFileSync(target, 'utf8'),
      readBytes: (target: string) => fs.readFileSync(target),
      realpath: (target: string) => fs.realpathSync.native(target),
      mkdirp: (target: string) => fs.mkdirSync(target, { recursive: true }),
      writeTextAtomic: (target: string, contents: string) =>
        fs.writeFileSync(target, contents, 'utf8'),
      writeText: (target: string, contents: string) => fs.writeFileSync(target, contents, 'utf8'),
      writeBytes: (target: string, contents: Buffer) => fs.writeFileSync(target, contents),
      appendText: (target: string, contents: string) => fs.appendFileSync(target, contents, 'utf8'),
      rename: (from: string, to: string) => fs.renameSync(from, to),
      remove: (target: string) => fs.rmSync(target, { recursive: true, force: true }),
      copyFile: (from: string, to: string) => fs.copyFileSync(from, to),
      createWriteStream: (target: string) => fs.createWriteStream(target),
      tmpdir: () => os.tmpdir(),
    }
  }

  private resolve(instanceId: string): ResolvedInstance {
    const mcRoot = requireMcRoot(this.options.roots)
    const port = this.fsPort()
    const instance = scanInstances(port, mcRoot).find(
      (item) => item.id === instanceId || item.dirName === instanceId,
    )
    if (!instance) failed('CRASH.INSTANCE_NOT_FOUND', `找不到实例: ${instanceId}`)
    const read = readInstanceSettings(port, instance.dir)
    const settings =
      read.settings ??
      defaultInstanceSettings({
        dirName: instance.dirName,
        id: instance.id,
        mcVersion: instance.mcVersion,
        loader: instance.loader,
      })
    return {
      instance,
      gameDir: gameDirectory(mcRoot, instance.dirName, instance.isolation),
      settings,
    }
  }

  private launchLast(instanceId?: string): LaunchLast {
    const raw = readJson(path.join(this.options.roots.dataRoot, 'logs', 'launch-last.json'))
    const exit = raw && typeof raw.exit === 'object' ? (raw.exit as Record<string, unknown>) : null
    const java = raw && typeof raw.java === 'object' ? (raw.java as Record<string, unknown>) : null
    const memory =
      raw && typeof raw.memory === 'object' ? (raw.memory as Record<string, unknown>) : null
    const rawInstance = typeof raw?.instanceId === 'string' ? raw.instanceId : null
    const applies = !instanceId || !rawInstance || rawInstance === instanceId
    return {
      exitCode: applies && typeof exit?.exitCode === 'number' ? exit.exitCode : null,
      javaMajor: applies && typeof java?.major === 'number' ? java.major : null,
      javaVersion: applies && typeof java?.version === 'string' ? java.version : null,
      memory:
        applies && memory && typeof memory.minMb === 'number' && typeof memory.maxMb === 'number'
          ? { minMb: memory.minMb, maxMb: memory.maxMb }
          : null,
      logFile: applies && typeof exit?.logFile === 'string' ? exit.logFile : null,
      instanceId: rawInstance,
    }
  }

  private context(instance: ResolvedInstance | null, exitCode: number | null): CrashContext {
    const launch = this.launchLast(instance?.instance.dirName)
    const memory = instance?.settings.memory ?? launch.memory
    let modCount = 0
    if (instance) {
      try {
        modCount = fs
          .readdirSync(path.join(instance.gameDir, 'mods'))
          .filter((name) => name.toLowerCase().endsWith('.jar')).length
      } catch {
        modCount = 0
      }
    }
    return {
      exitCode: exitCode ?? launch.exitCode,
      javaVersion: launch.javaVersion,
      javaMajor:
        launch.javaMajor ??
        (instance?.settings.java.mode === 'major' &&
        typeof instance.settings.java.value === 'number'
          ? instance.settings.java.value
          : null),
      memory: memory ? { minMb: memory.minMb, maxMb: memory.maxMb } : null,
      modCount,
      mcVersion: instance?.settings.mcVersion ?? instance?.instance.mcVersion ?? null,
      loader: instance
        ? `${instance.settings.loader.type}${instance.settings.loader.version ? ` ${instance.settings.loader.version}` : ''}`
        : null,
    }
  }

  private latestLog(instance: ResolvedInstance | null, launch: LaunchLast): string | null {
    if (launch.logFile && fs.existsSync(launch.logFile)) return launch.logFile
    if (!instance) return null
    const dirs = [
      path.join(this.options.roots.dataRoot, 'logs', 'game', instance.instance.dirName),
      path.join(instance.gameDir, 'logs'),
    ]
    const candidates: Array<{ file: string; mtime: number }> = []
    for (const dir of dirs) {
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !/\.log$/i.test(entry.name)) continue
          const file = path.join(dir, entry.name)
          try {
            candidates.push({ file, mtime: fs.statSync(file).mtimeMs })
          } catch {
            // Skip files that disappeared between readdir and stat.
          }
        }
      } catch {
        // A missing game log directory is normal before the first launch.
      }
    }
    candidates.sort((left, right) => right.mtime - left.mtime)
    return candidates[0]?.file ?? null
  }

  private readLatestLog(instance: ResolvedInstance | null, launch: LaunchLast): string {
    const file = this.latestLog(instance, launch)
    return file ? readTail(file, MAX_LOG_BYTES) : ''
  }

  async analyze(input: {
    instanceId?: string
    exitCode?: number | null
    logText?: string
    maxLines?: number
  }): Promise<CrashAnalysis> {
    const instance = input.instanceId ? this.resolve(input.instanceId) : null
    const launch = this.launchLast(instance?.instance.dirName)
    const logText = input.logText ?? this.readLatestLog(instance, launch)
    const maxLines = input.maxLines ?? 500
    const lines = tailLines(logText, maxLines)
    const context = this.context(instance, input.exitCode ?? null)

    const matches: RuleMatch[] = []
    for (const rule of CRASH_RULES) {
      let lastIndex = -1
      const evidence: string[] = []
      for (let index = 0; index < lines.length; index += 1) {
        if (rule.patterns.some((pattern) => pattern.test(lines[index]))) {
          lastIndex = index
          const line = lines[index].trim().slice(0, 500)
          if (!evidence.includes(line)) evidence.push(line)
        }
      }
      if (lastIndex >= 0) matches.push({ rule, evidence: evidence.slice(-3), lastIndex })
    }
    matches.sort(
      (left, right) =>
        right.lastIndex - left.lastIndex ||
        (left.rule.confidence === right.rule.confidence ? 0 : left.rule.confidence === 'high' ? -1 : 1) ||
        left.rule.priority - right.rule.priority,
    )
    if (matches.length === 0) return this.unknownAnalysis(instance, context, lines)

    const primary = matches[0]
    const alternatives = matches.slice(1, 4).map((match) => ({
      category: match.rule.category,
      confidence: match.rule.confidence,
      title: match.rule.title,
    }))
    const closeCall = matches.length > 1 && primary.lastIndex - matches[1].lastIndex <= 2
    const contextNote =
      primary.rule.category === 'java-version' && context.javaMajor
        ? ` 当前实例选择的 Java 主版本为 ${context.javaMajor}。`
        : primary.rule.category === 'out-of-memory' && context.memory
          ? ` 当前最大内存为 ${context.memory.maxMb} MB。`
          : primary.rule.category === 'mod-conflict' && context.modCount > 0
            ? ` 当前启用了 ${context.modCount} 个模组。`
            : ''
    const analysis: CrashAnalysis = {
      id: crypto.randomUUID(),
      instanceId: instance?.instance.dirName ?? null,
      category: primary.rule.category,
      confidence: closeCall ? 'medium' : primary.rule.confidence,
      uncertain: false,
      phenomenon: `${primary.rule.phenomenon}（退出码 ${context.exitCode ?? '未知'}）`,
      likelyCause: `${primary.rule.cause}${contextNote}`,
      evidence: primary.evidence,
      alternatives,
      actions: actionsFor(primary.rule, context, primary.evidence),
      diagnostics: [
        '修复动作只修改本实例配置/文件；Java 与内存改动在下次启动生效。',
        '如果执行建议后仍崩溃，请导出诊断包并附上完整 latest.log，不要只发送截图。',
        ...(context.modCount > 0
          ? ['可以先用“进入安全模式”排除模组因素，再逐个恢复定位。']
          : []),
      ],
      context,
      logTail: lines.slice(-80),
      createdAt: this.now(),
    }
    if (instance) this.lastAnalyses.set(instance.instance.dirName, analysis)
    this.options.log.info('crash analyzed', {
      instanceId: analysis.instanceId,
      category: analysis.category,
      confidence: analysis.confidence,
      evidence: analysis.evidence.length,
    })
    return analysis
  }

  private unknownAnalysis(
    instance: ResolvedInstance | null,
    context: CrashContext,
    lines: string[],
  ): CrashAnalysis {
    const exit = context.exitCode
    const noEvidence = lines.length === 0
    const analysis: CrashAnalysis = {
      id: crypto.randomUUID(),
      instanceId: instance?.instance.dirName ?? null,
      category: 'unknown',
      confidence: 'low',
      uncertain: true,
      phenomenon: noEvidence
        ? `没有可读取的游戏日志（退出码 ${exit ?? '未知'}）。`
        : `日志尾部没有匹配到已知崩溃特征（退出码 ${exit ?? '未知'}）。`,
      likelyCause: '无法确定原因。启动器不会在证据不足时编造结论。',
      evidence: [],
      alternatives: [],
      actions: [
        action(
          'unknown-export',
          'export-diagnostics',
          '导出诊断包',
          '收集日志、实例配置和启动参数，便于人工分析。',
          'safe',
        ),
        action(
          'unknown-open-logs',
          'open-folder',
          '打开日志目录',
          '查看完整 latest.log 的最后 100 行，尤其关注最新异常堆栈。',
          'safe',
          { area: 'logs' },
        ),
        action(
          'unknown-copy-help',
          'copy-text',
          '复制求助模板',
          '复制一段包含环境信息与排查步骤的文本，发到求助群/论坛。',
          'manual',
          {
            text: `Minecraft 启动失败求助\n退出码: ${exit ?? '未知'}\n实例: ${instance?.instance.name ?? '未知'}\n需要附上：诊断包 + 完整 latest.log 最后 100 行`,
          },
        ),
      ],
      diagnostics: [
        '先导出诊断包，再附上完整 latest.log（不要只发截图）。',
        '说明最近是否安装/更新了模组、光影、Java 或显卡驱动。',
        '如果游戏完全无日志，检查 Java 路径和启动参数是否有效。',
      ],
      context,
      logTail: lines.slice(-80),
      createdAt: this.now(),
    }
    if (instance) this.lastAnalyses.set(instance.instance.dirName, analysis)
    this.options.log.info('crash analysis unknown', {
      instanceId: analysis.instanceId,
      exitCode: exit,
      hasLog: !noEvidence,
    })
    return analysis
  }

  format(analysis: CrashAnalysis): CrashText {
    const actions = analysis.actions
      .map((item, index) => `${index + 1}. [${item.risk}] ${item.label} — ${item.description}`)
      .join('\n')
    const evidence = analysis.evidence.length > 0 ? analysis.evidence.join('\n') : '（无）'
    const markdown = [
      '# Minecraft 崩溃分析',
      '',
      `- 实例：${analysis.instanceId ?? '未知'}`,
      `- 分类：${analysis.category}（置信度 ${analysis.confidence}${analysis.uncertain ? '，不确定' : ''}）`,
      `- 退出码：${analysis.context.exitCode ?? '未知'}`,
      `- Java：${analysis.context.javaVersion ?? analysis.context.javaMajor ?? '未知'}`,
      `- 最大内存：${analysis.context.memory?.maxMb ?? '未知'} MB`,
      `- 模组数：${analysis.context.modCount}`,
      '',
      '## 现象',
      analysis.phenomenon,
      '',
      '## 最可能原因',
      analysis.likelyCause,
      '',
      '## 日志证据',
      '```text',
      evidence,
      '```',
      '',
      '## 修复动作',
      actions,
      '',
      '## 诊断建议',
      ...analysis.diagnostics.map((item) => `- ${item}`),
    ].join('\n')
    const plain = markdown.replace(/[#`]/g, '').replace(/\n{3,}/g, '\n\n')
    return { markdown, plain }
  }

  /** Writes the R5.7 text report to `$DATA/crash-reports` and a second copy
   * inside the instance. Returns the exact paths for the notification/event. */
  writeCrashReport(analysis: CrashAnalysis, rawLog?: string): CrashReportResult {
    const instance = this.resolve(analysis.instanceId ?? '')
    const stamp = crashStamp(this.now())
    const safeInstance = instance.instance.dirName.replace(/[<>:"/\\|?*]/g, '_')
    const base = `${stamp}-${safeInstance}`
    const dataDir = path.join(this.options.roots.dataRoot, 'crash-reports')
    const instanceDir = path.join(instance.gameDir, 'crash-reports')
    fs.mkdirSync(dataDir, { recursive: true })
    fs.mkdirSync(instanceDir, { recursive: true })
    let fileName = `${base}.txt`
    let suffix = 2
    while (fs.existsSync(path.join(dataDir, fileName)) || fs.existsSync(path.join(instanceDir, fileName))) {
      fileName = `${base}-${suffix}.txt`
      suffix += 1
    }
    const logText = rawLog ?? analysis.logTail.join('\n')
    const text = this.format(analysis)
    const body = redactReport(
      [
        'mc-launcher 崩溃报告',
        '====================',
        `生成时间: ${new Date(this.now()).toISOString()}`,
        `实例: ${instance.instance.name} (${instance.instance.dirName})`,
        `Minecraft: ${analysis.context.mcVersion ?? '未知'}`,
        `加载器: ${analysis.context.loader ?? '未知'}`,
        `Java: ${analysis.context.javaVersion ?? analysis.context.javaMajor ?? '未知'}`,
        `最大内存: ${analysis.context.memory?.maxMb ?? '未知'} MB`,
        `退出码: ${analysis.context.exitCode ?? '未知'}`,
        '',
        text.markdown,
        '',
        '---- 日志尾部 ----',
        logText,
        '',
      ].join('\n'),
    )
    const reportPath = path.join(dataDir, fileName)
    const instanceReportPath = path.join(instanceDir, fileName)
    fs.writeFileSync(reportPath, body, 'utf8')
    fs.writeFileSync(instanceReportPath, body, 'utf8')
    this.options.log.info('crash report written', {
      instanceId: instance.instance.dirName,
      reportPath,
      instanceReportPath,
    })
    return { analysis, reportPath, instanceReportPath, fileName }
  }

  async handleCrash(input: {
    instanceId: string
    exitCode: number | null
    logText?: string
  }): Promise<CrashReportResult> {
    const instance = this.resolve(input.instanceId)
    const launch = this.launchLast(instance.instance.dirName)
    const rawLog = input.logText ?? this.readLatestLog(instance, launch)
    const analysis = await this.analyze({
      instanceId: input.instanceId,
      exitCode: input.exitCode,
      ...(rawLog ? { logText: rawLog } : {}),
    })
    const result = this.writeCrashReport(analysis, rawLog)
    this.emit('detected', {
      instanceId: input.instanceId,
      analysis: result.analysis,
      reportPath: result.reportPath,
      instanceReportPath: result.instanceReportPath,
      fileName: result.fileName,
    })
    return result
  }

  async exportReport(input: {
    analysis: CrashAnalysis
    logText?: string
    outPath?: string
  }): Promise<CrashExportResult> {
    const instance = input.analysis.instanceId
      ? (() => {
          try {
            return this.resolve(input.analysis.instanceId!)
          } catch {
            return null
          }
        })()
      : null
    const launch = this.launchLast(instance?.instance.dirName)
    const rawLog = input.logText ?? this.readLatestLog(instance, launch)
    const text = this.format(input.analysis)
    const entries: ZipEntryInput[] = [
      { name: 'analysis.md', data: Buffer.from(`${text.markdown}\n`) },
      {
        name: 'analysis.json',
        data: Buffer.from(`${JSON.stringify(input.analysis, null, 2)}\n`),
      },
    ]
    if (rawLog) entries.push({ name: 'game.log', data: Buffer.from(rawLog) })
    const launchFile = path.join(this.options.roots.dataRoot, 'logs', 'launch-last.json')
    if (fs.existsSync(launchFile)) entries.push({ name: 'launch-last.json', data: fs.readFileSync(launchFile) })
    if (instance) {
      const settingsFile = path.join(instance.instance.dir, 'instance.json')
      if (fs.existsSync(settingsFile)) entries.push({ name: 'instance.json', data: fs.readFileSync(settingsFile) })
    }
    const out = input.outPath
      ? path.resolve(input.outPath)
      : path.join(this.options.roots.dataRoot, 'backups', 'crash', `crash-${input.analysis.id}.zip`)
    fs.mkdirSync(path.dirname(out), { recursive: true })
    const buffer = createStoredZip(entries, new Date(this.now()))
    fs.writeFileSync(out, buffer)
    this.options.log.info('crash report exported', {
      instanceId: input.analysis.instanceId,
      bytes: buffer.length,
    })
    return { path: out, bytes: buffer.length, files: entries.length }
  }

  private settingsFile(instance: ResolvedInstance): void {
    writeInstanceSettings(this.fsPort(), instance.instance.dir, instance.settings)
  }

  async applyFix(input: { instanceId: string; action: FixAction }): Promise<FixResult> {
    const instance = this.resolve(input.instanceId)
    const item = input.action
    const base: FixResult = {
      ok: true,
      actionId: item.id,
      message: '已完成',
      changed: [],
      restartRequired: false,
    }
    switch (item.kind) {
      case 'set-java': {
        const major = Number(item.params.major)
        if (!Number.isInteger(major) || major < 8 || major > 64) {
          failed('CRASH.INVALID_ACTION', 'Java 主版本无效')
        }
        instance.settings.java = { mode: 'major', value: major }
        this.settingsFile(instance)
        this.emitChanged(instance.instance.dirName)
        return { ...base, message: `实例 Java 已切换为 Java ${major}`, changed: ['java'], restartRequired: true }
      }
      case 'set-memory': {
        const maxMb = Number(item.params.maxMb)
        const minMb = Number(item.params.minMb ?? 1024)
        if (!Number.isInteger(maxMb) || maxMb < 512 || maxMb > 65_536) {
          failed('CRASH.INVALID_ACTION', '内存配置无效')
        }
        instance.settings.memory = {
          minMb: Math.max(512, Math.min(maxMb, Number.isInteger(minMb) ? minMb : 1024)),
          maxMb,
        }
        instance.settings.memoryMode = 'custom'
        this.settingsFile(instance)
        this.emitChanged(instance.instance.dirName)
        return { ...base, message: `实例最大内存已调整为 ${maxMb} MB`, changed: ['memory'], restartRequired: true }
      }
      case 'disable-mods': {
        const result = this.disableMods(instance)
        return { ...result, actionId: item.id }
      }
      case 'restore-mods': {
        const result = this.restoreMods(instance)
        return { ...result, actionId: item.id }
      }
      case 'repair-files': {
        const versionId =
          typeof item.params.versionId === 'string' && item.params.versionId.length > 0
            ? item.params.versionId
            : instance.settings.mcVersion ?? instance.instance.dirName
        let repair = this.options.repairFiles
        if (!repair) {
          const download = getService<{
            repair(input: { versionId: string; verifyExisting?: string }): Promise<{ jobId: string }>
          }>('download')
          if (!download) {
            return { ...base, ok: false, message: '下载模块尚未就绪，无法自动重下文件；请到版本页手动修复。' }
          }
          repair = async (repairInput) => download.repair({ ...repairInput, verifyExisting: 'hash' })
        }
        const result = await repair({ versionId })
        return {
          ...base,
          message: result.message ?? `已开始校验并重下 ${versionId} 的文件`,
          changed: [`repair:${versionId}`],
          ...(result.jobId ? { jobId: result.jobId } : {}),
        }
      }
      case 'open-url': {
        const url = typeof item.params.url === 'string' ? item.params.url : ''
        if (!/^https?:\/\//i.test(url)) failed('CRASH.INVALID_ACTION', '只允许 http(s) 链接')
        if (!this.options.openExternal) return { ...base, ok: false, message: '当前环境不支持打开浏览器' }
        await this.options.openExternal(url)
        return { ...base, message: '已在浏览器中打开', changed: ['browser'] }
      }
      case 'open-folder': {
        if (!this.options.openPath) return { ...base, ok: false, message: '当前环境不支持打开文件夹' }
        const area = typeof item.params.area === 'string' ? item.params.area : 'instance'
        const target =
          area === 'mods'
            ? path.join(instance.gameDir, 'mods')
            : area === 'logs'
              ? path.join(instance.gameDir, 'logs')
              : instance.instance.dir
        fs.mkdirSync(target, { recursive: true })
        const error = await this.options.openPath(target)
        return error
          ? { ...base, ok: false, message: error }
          : { ...base, message: `已打开 ${target}`, changed: [target] }
      }
      case 'copy-text': {
        const text = typeof item.params.text === 'string' ? item.params.text : ''
        return { ...base, message: '已准备好复制文本', clipboard: text }
      }
      case 'export-diagnostics': {
        const analysis = this.lastAnalyses.get(instance.instance.dirName)
        if (!analysis) return { ...base, ok: false, message: '请先执行一次崩溃分析，再导出诊断包。' }
        const exported = await this.exportReport({ analysis })
        return { ...base, message: `诊断包已导出: ${exported.path}`, changed: [exported.path] }
      }
      case 'manual':
      default:
        return { ...base, message: item.description }
    }
  }

  private modsDir(instance: ResolvedInstance): string {
    return path.join(instance.gameDir, 'mods')
  }

  private safeModeManifest(instance: ResolvedInstance): string {
    return path.join(
      this.options.roots.dataRoot,
      'crash',
      `${instance.instance.dirName}-safe-mode.json`,
    )
  }

  private disableMods(instance: ResolvedInstance): FixResult {
    const dir = this.modsDir(instance)
    const disabled: string[] = []
    let entries: fs.Dirent[] = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      entries = []
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.jar')) continue
      const source = path.join(dir, entry.name)
      const target = `${source}.disabled`
      if (fs.existsSync(target)) continue
      try {
        fs.renameSync(source, target)
        disabled.push(entry.name)
      } catch {
        // Continue with the remaining mods; report how many succeeded.
      }
    }
    if (disabled.length > 0) {
      fs.mkdirSync(path.dirname(this.safeModeManifest(instance)), { recursive: true })
      fs.writeFileSync(
        this.safeModeManifest(instance),
        `${JSON.stringify({ instanceId: instance.instance.dirName, disabled, at: this.now() }, null, 2)}\n`,
        'utf8',
      )
      this.emitChanged(instance.instance.dirName)
    }
    return {
      ok: true,
      actionId: 'disable-mods',
      message:
        disabled.length > 0
          ? `已禁用 ${disabled.length} 个模组；可用“恢复模组”撤销。`
          : '没有可禁用的模组。',
      changed: disabled,
      restartRequired: true,
    }
  }

  private restoreMods(instance: ResolvedInstance): FixResult {
    const manifest = this.safeModeManifest(instance)
    const restored: string[] = []
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { disabled?: string[] }
      for (const name of parsed.disabled ?? []) {
        const safe = path.basename(name)
        const disabled = path.join(this.modsDir(instance), `${safe}.disabled`)
        const target = path.join(this.modsDir(instance), safe)
        if (!fs.existsSync(disabled) || fs.existsSync(target)) continue
        fs.renameSync(disabled, target)
        restored.push(safe)
      }
      fs.rmSync(manifest, { force: true })
    } catch {
      return {
        ok: false,
        actionId: 'restore-mods',
        message: '没有找到安全模式记录，或记录已损坏。',
        changed: [],
        restartRequired: false,
      }
    }
    this.emitChanged(instance.instance.dirName)
    return {
      ok: true,
      actionId: 'restore-mods',
      message: restored.length > 0 ? `已恢复 ${restored.length} 个模组` : '没有需要恢复的模组',
      changed: restored,
      restartRequired: true,
    }
  }
}

export function createCrashService(options: CrashServiceOptions): CrashModuleService {
  return new CrashModuleService(options)
}
