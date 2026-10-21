import { useEffect, useRef, useState } from 'react'
import type { CrashAnalysis, CrashCategory, FixAction, FixResult } from '@shared/crash'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { Badge, Banner, Button, EmptyState } from '../ui'
import { Icon } from '../icons'

const CATEGORY_LABEL: Record<CrashCategory, string> = {
  'java-version': 'Java 版本不匹配',
  'missing-library': '缺失库或类文件',
  'mod-conflict': '模组冲突/缺失前置',
  'out-of-memory': '内存不足',
  'graphics-driver': '显卡/OpenGL 初始化失败',
  'auth-failed': '登录/会话验证失败',
  'corrupt-files': '游戏文件损坏',
  'port-in-use': '端口被占用',
  'jvm-args': 'JVM 启动参数错误',
  unknown: '无法归类',
}

const CONFIDENCE_LABEL: Record<CrashAnalysis['confidence'], string> = {
  high: '高置信度',
  medium: '中置信度',
  low: '低置信度',
}

function riskTone(risk: FixAction['risk']): 'success' | 'warning' | 'danger' {
  if (risk === 'safe') return 'success'
  if (risk === 'caution') return 'warning'
  return 'danger'
}

export function CrashPanel({ instanceId, instanceName, autoAnalyze = false }: { instanceId: string | null; instanceName?: string; autoAnalyze?: boolean }) {
  const backend = useBackend()
  const autoStarted = useRef(false)
  const [analysis, setAnalysis] = useState<CrashAnalysis | null>(null)
  const [analyzing, setAnalyzing] = useState(false)
  const [fixing, setFixing] = useState<string | null>(null)
  const [fixResult, setFixResult] = useState<FixResult | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [exported, setExported] = useState<{ path: string; bytes: number; files: number } | null>(null)
  const [exporting, setExporting] = useState(false)

  const analyze = async () => {
    setAnalyzing(true)
    setError(null)
    setFixResult(null)
    setReport(null)
    setExported(null)
    try {
      setAnalysis(await backend.crash.analyze({ ...(instanceId ? { instanceId } : {}) }))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setAnalyzing(false)
    }
  }

  useEffect(() => {
    if (!autoAnalyze || autoStarted.current) return
    autoStarted.current = true
    void analyze()
    // Auto-analyze runs once when a crashed launch mounts this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAnalyze])

  const runFix = async (action: FixAction) => {
    if (!instanceId) {
      setError({ kind: 'error', title: '需要实例', detail: '崩溃修复必须指定实例；请先分析一个实例。', retryable: false })
      return
    }
    setFixing(action.id)
    setFixResult(null)
    setError(null)
    try {
      const result = await backend.crash.applyFix(instanceId, action)
      setFixResult(result)
      if (result.clipboard) {
        await navigator.clipboard.writeText(result.clipboard).catch(() => undefined)
        setCopied(true)
      }
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setFixing(null)
    }
  }

  const copyReport = async () => {
    if (!analysis) return
    try {
      const formatted = await backend.crash.format(analysis)
      setReport(formatted.markdown)
      await navigator.clipboard.writeText(formatted.markdown)
      setCopied(true)
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  const exportReport = async () => {
    if (!analysis) return
    setExporting(true)
    setError(null)
    try {
      setExported(await backend.crash.exportReport(analysis))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setExporting(false)
    }
  }

  if (!analysis) {
    return (
      <div className="crash-panel">
        <div className="crash-panel__empty">
          <EmptyState
            icon="alert-circle"
            title={instanceId ? '还没有崩溃分析' : '分析最近一次启动'}
            description={instanceId
              ? '分析会读取该实例最近一次游戏日志与 launch-last.json，不会编造原因。'
              : '未选择实例时可以分析最近一次启动记录；修复动作需要具体实例。'}
            actions={<Button size="sm" variant="primary" icon="search" loading={analyzing} onClick={() => void analyze()}>分析最近一次崩溃</Button>}
          />
        </div>
        {error ? <div className="nw-inline-error">{error.title}：{error.detail}</div> : null}
      </div>
    )
  }

  const unknown = analysis.uncertain || analysis.category === 'unknown'
  return (
    <div className="crash-panel">
      <div className="crash-panel__head">
        <div>
          <div className="crash-panel__eyebrow">t40 崩溃分析 · {instanceName ?? analysis.instanceId ?? '最近启动'}</div>
          <h3><Icon name="alert" />{CATEGORY_LABEL[analysis.category]}</h3>
          <div className="crash-panel__badges">
            <Badge tone={unknown ? 'warning' : 'accent'}>{unknown ? '不确定，不编造原因' : CONFIDENCE_LABEL[analysis.confidence]}</Badge>
            {analysis.context.exitCode !== null ? <Badge tone="outline">退出码 {analysis.context.exitCode}</Badge> : null}
            {analysis.context.javaMajor ? <Badge tone="outline">Java {analysis.context.javaMajor}</Badge> : null}
            {analysis.context.memory ? <Badge tone="outline">内存 {analysis.context.memory.maxMb} MB</Badge> : null}
            <Badge tone="outline">模组 {analysis.context.modCount}</Badge>
            {analysis.context.loader ? <Badge tone="outline">{analysis.context.loader}</Badge> : null}
          </div>
        </div>
        <div className="row gap-8">
          <Button size="xs" variant="secondary" icon="refresh" loading={analyzing} onClick={() => void analyze()}>重新分析</Button>
        </div>
      </div>

      {unknown ? (
        <Banner tone="warning" title="无法确定原因">
          {analysis.likelyCause} 请先导出诊断包并附上完整 latest.log，不要只发截图；下面提供可复制的求助模板。
        </Banner>
      ) : null}

      <div className="crash-panel__section">
        <div className="crash-panel__label">现象</div>
        <p>{analysis.phenomenon}</p>
      </div>
      <div className="crash-panel__section">
        <div className="crash-panel__label">最可能原因</div>
        <p>{analysis.likelyCause}</p>
      </div>
      <div className="crash-panel__section">
        <div className="crash-panel__label">日志证据</div>
        {analysis.evidence.length ? (
          <pre className="crash-panel__evidence">{analysis.evidence.join('\n')}</pre>
        ) : <p className="muted">日志中没有匹配到该类别的明确证据。</p>}
      </div>
      {analysis.alternatives.length ? (
        <div className="crash-panel__section">
          <div className="crash-panel__label">其它可能</div>
          <div className="crash-panel__alternatives">
            {analysis.alternatives.map((alt) => <Badge key={`${alt.category}-${alt.title}`} tone="outline">{CATEGORY_LABEL[alt.category]} · {alt.title} · {alt.confidence}</Badge>)}
          </div>
        </div>
      ) : null}
      <div className="crash-panel__section">
        <div className="crash-panel__label">一键动作</div>
        <div className="crash-panel__actions">
          {analysis.actions.map((action) => (
            <div className="crash-action" key={action.id}>
              <div className="crash-action__text">
                <strong>{action.label}</strong>
                <span>{action.description}</span>
                <span className="crash-action__meta"><Badge tone={riskTone(action.risk)}>{action.risk}</Badge>{action.automatic ? '可自动执行' : '需手动确认'}</span>
              </div>
              <Button size="xs" variant={action.risk === 'safe' ? 'secondary' : 'ghost'} icon="play" loading={fixing === action.id} disabled={!instanceId || Boolean(fixing)} onClick={() => void runFix(action)}>执行</Button>
            </div>
          ))}
        </div>
        {!instanceId ? <p className="muted">执行动作需要选择实例。</p> : null}
      </div>
      {fixResult ? (
        <Banner tone={fixResult.ok ? 'success' : 'warning'} title={fixResult.message}>
          {fixResult.changed.length ? `变更：${fixResult.changed.join('；')}` : null}
          {fixResult.restartRequired ? ' 需要重启游戏后生效。' : ''}
          {fixResult.jobId ? ` 任务：${fixResult.jobId}` : ''}
        </Banner>
      ) : null}
      {exported ? (
        <Banner tone="success" title="诊断包已导出">
          <span className="mono">{exported.path}</span>（{exported.files} 个文件，{exported.bytes} B）。
        </Banner>
      ) : null}
      {error ? <div className="nw-inline-error">{error.title}：{error.detail}</div> : null}

      <div className="crash-panel__footer">
        <Button size="sm" variant="secondary" icon="copy" onClick={() => void copyReport()}>复制报告</Button>
        <Button size="sm" variant="secondary" icon="upload" loading={exporting} onClick={() => void exportReport()}>导出诊断包</Button>
        {copied ? <span className="crash-panel__copied">已复制到剪贴板</span> : null}
      </div>
      {report ? (
        <details className="crash-panel__report">
          <summary>报告文本（剪贴板失败时可手动复制）</summary>
          <pre>{report}</pre>
        </details>
      ) : null}
      {analysis.diagnostics.length ? (
        <details className="crash-panel__diagnostics">
          <summary>诊断建议</summary>
          <ul>{analysis.diagnostics.map((item) => <li key={item}>{item}</li>)}</ul>
        </details>
      ) : null}
      {analysis.logTail.length ? (
        <details className="crash-panel__logs">
          <summary>日志尾部（{analysis.logTail.length} 行）</summary>
          <pre>{analysis.logTail.join('\n')}</pre>
        </details>
      ) : null}
    </div>
  )
}
