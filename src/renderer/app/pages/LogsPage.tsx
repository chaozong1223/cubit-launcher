import { useEffect, useMemo, useRef, useState } from 'react'
import type { BackupResult, LogLevel, LogSource } from '@shared/assets'
import { useBackend } from '../data/BackendContext'
import { describeError, type LogQueryResult, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { useInstanceSelection } from '../data/useInstanceSelection'
import { useSystem } from '../system'
import { navigate } from '../router'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  EmptyState,
  Input,
  PageHeader,
  Segmented,
} from '../ui'
import { Icon } from '../icons'
import { InstancePicker } from './InstancePicker'
import { CrashPanel } from './CrashPanel'

type Level = 'all' | LogLevel
type SourceFilter = 'all' | 'launcher' | 'game'

const LEVELS: ReadonlyArray<{ value: Level; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'trace', label: 'Trace' },
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
  { value: 'fatal', label: 'Fatal' },
]

const SOURCES: ReadonlyArray<{ value: SourceFilter; label: string }> = [
  { value: 'all', label: '全部来源' },
  { value: 'launcher', label: '启动器' },
  { value: 'game', label: '游戏' },
]

interface LogLine {
  id: number
  sessionId: string
  line: string
  receivedAt: number
}

function lineLevel(text: string): LogLevel {
  if (/\b(FATAL)\b/i.test(text)) return 'fatal'
  if (/\b(ERROR|SEVERE)\b/i.test(text)) return 'error'
  if (/\bWARN(ING)?\b/i.test(text)) return 'warn'
  if (/\bDEBUG\b/i.test(text)) return 'debug'
  if (/\bTRACE\b/i.test(text)) return 'trace'
  return 'info'
}

function levelClass(level: LogLevel): string {
  if (level === 'error' || level === 'fatal') return 'log-lvl log-lvl--error'
  if (level === 'warn') return 'log-lvl log-lvl--warn'
  if (level === 'debug' || level === 'trace') return 'log-lvl log-lvl--debug'
  return 'log-lvl log-lvl--info'
}

function sourceArea(value: string): 'launcher' | 'game' {
  return value.startsWith('launcher:') ? 'launcher' : 'game'
}

function sourceLabel(value: string): string {
  return value.startsWith('launcher:')
    ? `启动器 · ${value.slice('launcher:'.length)}`
    : `游戏 · ${value.slice('game:'.length)}`
}

function formatTime(ts: number | null): string {
  return ts ? new Date(ts).toLocaleString('zh-CN', { hour12: false }) : '—'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

export function LogsPage() {
  const backend = useBackend()
  const system = useSystem()
  const selection = useInstanceSelection()
  const { selected } = selection
  const [mode, setMode] = useState<'live' | 'history'>('live')
  const [source, setSource] = useState<SourceFilter>('all')
  const [level, setLevel] = useState<Level>('all')
  const [query, setQuery] = useState('')
  const [debouncedQuery, setDebouncedQuery] = useState('')
  const [paused, setPaused] = useState(false)
  const [follow, setFollow] = useState(true)
  const [lines, setLines] = useState<LogLine[]>([])
  const [subscribeError, setSubscribeError] = useState<string | null>(null)
  const [exporting, setExporting] = useState<'logs' | 'diagnostics' | null>(null)
  const [exported, setExported] = useState<BackupResult | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const seq = useRef(0)
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedQuery(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])

  useEffect(() => {
    try {
      const off = backend.logs.subscribeLaunchOutput((event) => {
        seq.current += 1
        setLines((prev) => [
          ...prev.slice(-1999),
          { id: seq.current, sessionId: event.sessionId, line: event.line, receivedAt: Date.now() },
        ])
      })
      return off
    } catch (cause) {
      setSubscribeError(describeError(cause).detail)
      return () => undefined
    }
  }, [backend])

  const history = useAsync<LogQueryResult>(
    () => mode === 'history'
      ? backend.assets.queryLogs({
          ...(selected ? { instanceId: selected.id } : {}),
          ...(level !== 'all' ? { level } : {}),
          ...(debouncedQuery ? { search: debouncedQuery } : {}),
          limit: 1000,
        })
      : Promise.resolve({ entries: [], total: 0, sources: [] }),
    [mode, selected?.id, level, debouncedQuery],
  )

  useEffect(() => {
    if (mode !== 'live' || !follow || paused) return
    const node = bodyRef.current
    if (node) node.scrollTop = node.scrollHeight
  }, [lines, follow, paused, mode])

  const liveFiltered = useMemo(() => {
    const q = debouncedQuery.toLowerCase()
    return lines.filter((line) => {
      if (source === 'launcher') return false
      const lineLvl = lineLevel(line.line)
      return (level === 'all' || lineLvl === level) &&
        (!q || line.line.toLowerCase().includes(q) || line.sessionId.toLowerCase().includes(q))
    })
  }, [lines, level, source, debouncedQuery])

  const historyFiltered = useMemo(() => {
    return (history.data?.entries ?? []).filter((entry) => source === 'all' || sourceArea(entry.source) === source)
  }, [history.data, source])

  const sources: LogSource[] = history.data?.sources ?? []

  const clear = () => {
    setLines([])
    setQuery('')
    setLevel('all')
    setSource('all')
  }

  const exportLogs = async (kind: 'logs' | 'diagnostics') => {
    setExporting(kind)
    setError(null)
    setExported(null)
    try {
      setExported(kind === 'logs'
        ? await backend.assets.exportLogs(selected?.id)
        : await backend.assets.exportDiagnostics(selected?.id))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setExporting(null)
    }
  }

  const openDataSource = () => {
    void backend.assets.openFolder(selected?.id, selected ? 'game-logs' : 'launcher-logs')
      .catch((cause) => setError(describeError(cause)))
  }

  const entryCount = mode === 'live' ? liveFiltered.length : historyFiltered.length
  const totalCount = mode === 'live' ? lines.length : history.data?.total ?? 0

  return (
    <>
      <PageHeader
        title="日志"
        subtitle="实时启动输出与历史日志来自真实事件/IPC；级别、来源、搜索、导出日志和诊断包都在本页完成。"
        actions={(
          <>
            <Button variant="secondary" icon="folder" onClick={openDataSource}>打开日志目录</Button>
            <Button variant="secondary" icon="upload" loading={exporting === 'logs'} onClick={() => void exportLogs('logs')}>导出日志</Button>
            <Button variant="primary" icon="shield" loading={exporting === 'diagnostics'} onClick={() => void exportLogs('diagnostics')}>导出诊断包</Button>
          </>
        )}
      />

      <InstancePicker
        selection={selection}
        onRefresh={selection.instances.reload}
        hint="历史日志优先读取当前实例的 game/logs 与启动器 logs/；崩溃分析也使用该实例。"
      />

      <div className="log-modebar">
        <Segmented
          value={mode}
          ariaLabel="日志视图"
          options={[
            { value: 'live', label: '实时输出' },
            { value: 'history', label: '历史日志' },
          ]}
          onChange={setMode}
        />
        <div className="chip-group" role="group" aria-label="日志来源">
          {SOURCES.map((item) => (
            <button key={item.value} className={`chip${source === item.value ? ' is-active' : ''}`} type="button" onClick={() => setSource(item.value)}>
              {item.label}
            </button>
          ))}
        </div>
        <span className="log-modebar__hint">
          {mode === 'live' ? 'launch:evt:output' : 'mc:assets:queryLogs'}
        </span>
      </div>

      {subscribeError ? <div className="nw-inline-error">订阅 launch output 失败：{subscribeError}</div> : null}
      {error ? <div className="nw-inline-error" role="alert">{error.title}：{error.detail}</div> : null}
      {exported ? (
        <Banner tone="success" title="导出完成">
          <span className="mono">{exported.path}</span>（{exported.files} 个文件，{formatSize(exported.bytes)}）。
        </Banner>
      ) : null}

      {mode === 'history' && (history.status === 'not-wired' || history.status === 'error') ? (
        <DataStateNotice info={describeError(history.error)} onRetry={history.reload} retryLabel="重新查询" />
      ) : null}

      <div className="logs-grid">
        <Card className="log-console" pad={false}>
          <div className="log-toolbar">
            <div className="chip-group" role="group" aria-label="按级别筛选">
              {LEVELS.map((item) => (
                <button key={item.value} className={`chip${level === item.value ? ' is-active' : ''}`} type="button" onClick={() => setLevel(item.value)}>
                  {item.label}
                </button>
              ))}
            </div>
            <div className="log-toolbar__spacer" />
            <div className="input-wrap search">
              <Icon name="search" />
              <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索日志" aria-label="搜索日志" />
            </div>
            {mode === 'live' ? (
              <>
                <Button size="sm" variant={paused ? 'subtle' : 'ghost'} icon={paused ? 'play' : 'pause'} onClick={() => setPaused((value) => !value)} aria-pressed={paused} title="暂停/继续跟随">
                  {paused ? '继续' : '暂停'}
                </Button>
                <Button size="sm" variant={follow ? 'subtle' : 'ghost'} icon="activity" onClick={() => setFollow((value) => !value)} aria-pressed={follow} title="跟随最新">
                  跟随
                </Button>
                <Button size="sm" variant="ghost" icon="trash" onClick={clear} disabled={lines.length === 0}>清空</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" icon="refresh" onClick={history.reload} loading={history.status === 'loading'}>重新查询</Button>
            )}
          </div>

          <div className="log-body" ref={bodyRef} role="log" aria-live="polite" aria-label="日志控制台">
            {mode === 'live' ? (
              liveFiltered.length === 0 ? (
                <EmptyState
                  icon="terminal"
                  title={source === 'launcher' ? '实时输出只包含游戏进程' : lines.length === 0 ? '等待启动输出' : '没有匹配的日志行'}
                  description={source === 'launcher'
                    ? '启动器自身的日志请切换到「历史日志」，来源选择启动器。'
                    : lines.length === 0
                      ? '启动一个实例后，stdout/stderr 会通过 launch:evt:output 实时出现在这里。'
                      : '清空搜索或切换级别/来源。'}
                  actions={<Button size="sm" variant="secondary" onClick={() => { setQuery(''); setLevel('all'); setSource('all') }}>清除筛选</Button>}
                />
              ) : (
                liveFiltered.map((item) => {
                  const lvl = lineLevel(item.line)
                  return (
                    <div className="log-line" key={item.id}>
                      <span className="log-time">{new Date(item.receivedAt).toLocaleTimeString('zh-CN', { hour12: false })}</span>
                      <span className={levelClass(lvl)}>{lvl.toUpperCase()}</span>
                      <span className="log-scope">{item.sessionId.slice(0, 8)}</span>
                      <span className="log-msg">{item.line}</span>
                    </div>
                  )
                })
              )
            ) : history.status === 'loading' ? (
              <div className="log-history-loading"><span className="spinner" />读取历史日志…</div>
            ) : historyFiltered.length === 0 ? (
              <EmptyState
                icon="terminal"
                title={history.data?.total ? '没有匹配的日志行' : '没有历史日志'}
                description={history.data?.total ? '切换来源/级别或清空搜索。' : '当前实例和启动器 logs/ 目录没有可读取的 .log/.jsonl 文件；不会生成示例日志。'}
                actions={<Button size="sm" variant="secondary" onClick={history.reload}>重新查询</Button>}
              />
            ) : (
              historyFiltered.map((entry, index) => (
                <div className="log-line" key={`${entry.source}-${entry.timestamp ?? 'na'}-${index}`}>
                  <span className="log-time">{formatTime(entry.timestamp)}</span>
                  <span className={levelClass(entry.level ?? 'info')}>{(entry.level ?? '—').toUpperCase()}</span>
                  <span className="log-scope">{sourceLabel(entry.source)}</span>
                  <span className="log-msg">{entry.message}</span>
                </div>
              ))
            )}
          </div>

          <div className="log-statusbar">
            <span>{entryCount} / {totalCount} 行</span>
            <span aria-hidden="true">·</span>
            <span>来源 <strong className="muted">{SOURCES.find((item) => item.value === source)?.label}</strong></span>
            <span className="log-statusbar__right">
              <span>{mode === 'live' ? (paused ? '已暂停滚动' : '实时输出') : '历史查询'}</span>
              <Badge tone={mode === 'live' ? (lines.length ? 'success' : 'outline') : history.status === 'ready' ? 'success' : 'outline'} dot>
                {mode === 'live' ? (lines.length ? 'IPC 实时' : '等待事件') : history.status === 'ready' ? 'IPC 历史' : '未查询'}
              </Badge>
            </span>
          </div>
        </Card>

        <aside className="log-aside">
          <CrashPanel instanceId={selected?.id ?? null} instanceName={selected?.name} />

          <Card className="log-file-card">
            <h3>日志来源</h3>
            {sources.length === 0 ? (
              <p className="muted">切换到「历史日志」后读取启动器/游戏日志文件。</p>
            ) : (
              <div className="log-source-list">
                {sources.map((item) => (
                  <div className="log-source-row" key={item.id}>
                    <Badge tone={item.area === 'game' ? 'accent' : 'outline'}>{item.area === 'game' ? '游戏' : '启动器'}</Badge>
                    <span className="log-source-row__name" title={item.id}>{item.fileName}</span>
                    <span className="subtle">{formatSize(item.size)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <Card className="log-file-card">
            <h3>日志文件位置</h3>
            <div className="path-row" title={system.info?.logFile}>
              <Icon name="terminal" />
              <span>{system.info?.logFile ?? '等待 system.info'}</span>
            </div>
            <div className="row gap-8" style={{ marginTop: 10 }}>
              <Button size="sm" variant="secondary" icon="folder" onClick={openDataSource}>打开目录</Button>
              <Button size="sm" variant="ghost" icon="info" onClick={() => navigate('/about')}>诊断</Button>
            </div>
          </Card>
        </aside>
      </div>
    </>
  )
}
