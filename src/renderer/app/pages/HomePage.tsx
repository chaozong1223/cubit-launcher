import { useCallback, useEffect, useMemo, useState } from 'react'
import type { InstanceSummary } from '@shared/instance'
import type { LaunchExitReport, LaunchPlan, LaunchState } from '@shared/launch'
import { useBackend } from '../data/BackendContext'
import { useCurrentAccount } from '../data/useAccount'
import { BackendError, describeError, type LaunchExitedEvent, type LaunchStageEvent, type LaunchStatusEvent, type UiErrorInfo } from '../data/backend'
import { DeleteInstanceDialog } from './DeleteInstanceDialog'
import { ImportPackDialog } from './ImportPackDialog'
import { MinecraftDirectoryPanel } from './MinecraftDirectoryPanel'
import { useAsync } from '../data/useAsync'
import { useInstanceRunning } from '../data/useInstanceRunning'

import { useSystem } from '../system'
import { navigate } from '../router'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  Dropdown,
  EmptyState,
  Input,
  LaunchButton,
  PageHeader,
  SectionHead,
  Skeleton,
  Tag,
  type LaunchUiState,
} from '../ui'
import { Icon } from '../icons'
import { CrashPanel } from './CrashPanel'

function loaderTag(instance: InstanceSummary) {
  switch (instance.loader.type) {
    case 'forge': return <Tag variant="forge">Forge {instance.loader.version ?? ''}</Tag>
    case 'neoforge': return <Tag variant="neo">NeoForge {instance.loader.version ?? ''}</Tag>
    case 'fabric': return <Tag variant="fabric">Fabric {instance.loader.version ?? ''}</Tag>
    case 'quilt': return <Tag variant="pack">Quilt {instance.loader.version ?? ''}</Tag>
    case 'vanilla': return <Tag variant="vanilla">原版</Tag>
    default: return <Tag>未知加载器</Tag>
  }
}

/** Sections of the instance detail page, reachable from the hero overflow menu. */
const DETAIL_LINKS: ReadonlyArray<{ section: string; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { section: 'overview', label: '概览', icon: 'info' },
  { section: 'mods', label: '模组', icon: 'package' },
  { section: 'resourcepacks', label: '资源包', icon: 'folder' },
  { section: 'shaders', label: '光影', icon: 'sun' },
  { section: 'settings', label: '设置', icon: 'settings' },
  { section: 'export', label: '导出', icon: 'upload' },
]

/** Page-level destinations that used to live in the sidebar. */
const PAGE_LINKS: ReadonlyArray<{ path: string; label: string; icon: Parameters<typeof Icon>[0]['name'] }> = [
  { path: '#/updates', label: '模组更新', icon: 'refresh' },
  { path: '#/saves', label: '存档', icon: 'cube' },
  { path: '#/schematics', label: '投影管理', icon: 'schematic' },
  { path: '#/screenshots', label: '截图', icon: 'package' },
]

function launchUiState(instance: InstanceSummary, status: LaunchState | null): LaunchUiState {
  if (instance.state !== 'ready') return instance.state === 'missing-json' || instance.state === 'corrupt-json' ? 'blocked' : 'not-installed'
  if (!status) return 'unknown'
  switch (status) {
    case 'running': return 'running'
    case 'crashed': return 'crashed'
    case 'exited': return 'ready'
    case 'idle': return 'ready'
    case 'precheck':
    case 'java':
    case 'args':
    case 'spawning': return 'launching'
    default: return 'unknown'
  }
}

type ExitInfo = {
  exitCode: number | null
  durationMs: number | null
  classification: string | null
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${ms} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  const minutes = Math.floor(ms / 60_000)
  const seconds = Math.round((ms % 60_000) / 1000)
  return `${minutes} 分 ${seconds} 秒`
}

function classificationLabel(value: string | null): string {
  if (value === 'normal') return '正常退出'
  if (value === 'killed' || value === 'suspend') return '已结束'
  if (value === 'suspect') return '可疑退出'
  if (value === 'crashed') return '异常退出'
  return '退出'
}

function launchStateLabel(state: LaunchUiState): string {
  if (state === 'running') return '运行中'
  if (state === 'launching') return '启动中'
  if (state === 'crashed') return '已崩溃'
  return '就绪'
}

function Hero({ instance, onChanged }: { instance: InstanceSummary; onChanged?: () => void }) {
  const [detailMenuOpen, setDetailMenuOpen] = useState(false)
  const [renameOpen, setRenameOpen] = useState(false)
  const [renameValue, setRenameValue] = useState(instance.name)
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameError, setRenameError] = useState<string | null>(null)

  const submitRename = async () => {
    const next = renameValue.trim()
    if (!next) {
      setRenameError('名称不能为空')
      return
    }
    setRenameBusy(true)
    setRenameError(null)
    try {
      await backend.instances.update(instance.id, { name: next })
      setRenameOpen(false)
      onChanged?.()
    } catch (cause) {
      const info = describeError(cause)
      setRenameError(`${info.title}：${info.detail}`)
    } finally {
      setRenameBusy(false)
    }
  }

  // Close the overflow menu on any outside click or Escape, not just the button.
  useEffect(() => {
    if (!detailMenuOpen) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.hero-more')) setDetailMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDetailMenuOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [detailMenuOpen])
  const backend = useBackend()
  const status = useAsync(() => backend.launch.status(instance.id), [instance.id])
  const accounts = useAsync(() => backend.auth.list(), [])
  useEffect(() => {
    const off = backend.auth.subscribeChanged(() => accounts.reload())
    return off
  }, [backend, accounts.reload])
  const [plan, setPlan] = useState<LaunchPlan | null>(null)
  const [planError, setPlanError] = useState<UiErrorInfo | null>(null)
  const [actionError, setActionError] = useState<UiErrorInfo | null>(null)
  const [repairing, setRepairing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [flow, setFlow] = useState<'idle' | 'checking' | 'starting' | 'running' | 'stopping' | 'failed'>('idle')
  const [stage, setStage] = useState<string | null>(null)
  const [live, setLive] = useState<LaunchState | null>(null)
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [stopping, setStopping] = useState(false)
  const [exitInfo, setExitInfo] = useState<ExitInfo | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const state: LaunchUiState = flow === 'checking' || flow === 'starting'
    ? 'launching'
    : flow === 'failed'
      ? 'crashed'
      : flow === 'running' || flow === 'stopping' || live === 'running'
        ? 'running'
        : launchUiState(instance, live ?? (status.status === 'ready' ? status.data?.state ?? null : null))

  const applyExit = useCallback((report: LaunchExitReport | null, fallbackCode: number | null) => {
    const exitCode = report?.exitCode ?? fallbackCode
    const classification = report?.classification ?? null
    setExitInfo({ exitCode, durationMs: report?.durationMs ?? null, classification })
    setSessionId(null)
    setStopping(false)
    if (!report) {
      setLive(exitCode === 0 ? 'exited' : 'crashed')
      if (exitCode === 0) {
        setFlow('idle')
        setActionError(null)
        setDetailOpen(false)
      } else {
        setFlow('failed')
        setActionError({
          kind: 'error',
          title: '游戏进程已退出',
          detail: exitCode === null ? '没有收到退出码。' : `退出码 ${exitCode}。`,
          code: 'LAUNCH.EXIT_NONZERO',
          retryable: true,
        })
        setDetailOpen(true)
      }
      return
    }
    if (classification === 'normal' || classification === 'killed') {
      setLive('exited')
      setFlow('idle')
      setActionError(null)
      setDetailOpen(false)
      return
    }
    setLive('crashed')
    setFlow('failed')
    setActionError({
      kind: 'error',
      title: classification === 'suspect' ? '游戏可能异常退出' : '游戏异常退出',
      detail: report.crashHints[0]?.title ?? (exitCode === null ? '进程没有返回退出码。' : `退出码 ${exitCode}。`),
      code: report.crashHints[0] ? 'LAUNCH.CRASH_HINT' : 'LAUNCH.EXIT_NONZERO',
      retryable: true,
    })
    setDetailOpen(true)
  }, [])

  const refreshExit = useCallback(async (fallbackCode: number | null) => {
    try {
      const report = await backend.launch.lastReport(instance.id)
      applyExit(report, fallbackCode)
    } catch {
      applyExit(null, fallbackCode)
    }
  }, [applyExit, backend, instance.id])

  useEffect(() => {
    const offs = [
      backend.launch.subscribeStatus((event: LaunchStatusEvent) => {
        if (event.instanceId !== instance.id) return
        setLive(event.state)
        if (event.sessionId) setSessionId(event.sessionId)
        if (event.state === 'running') {
          setFlow('running')
          setStopping(false)
          setStage(null)
        } else if (event.state === 'precheck' || event.state === 'java' || event.state === 'args' || event.state === 'spawning') {
          setFlow((current) => current === 'running' || current === 'failed' || current === 'stopping' ? current : 'starting')
        } else if (event.state === 'exited') {
          setStopping(false)
          void refreshExit(event.exitCode)
        } else if (event.state === 'crashed') {
          setStopping(false)
          setFlow((current) => current === 'stopping' ? 'stopping' : 'failed')
          void refreshExit(event.exitCode)
        }
      }),
      backend.launch.subscribeStage((event: LaunchStageEvent) => {
        if (event.instanceId !== instance.id) return
        const labels: Record<LaunchStageEvent['stage'], string> = {
          precheck: '检查实例与账户',
          java: '选择 Java 运行时',
          args: '生成启动参数',
          spawn: '启动游戏进程',
        }
        setStage(`${labels[event.stage]}${event.detail ? ` · ${event.detail}` : ''}`)
        setFlow((current) => current === 'running' || current === 'failed' || current === 'stopping' ? current : 'starting')
      }),
      backend.launch.subscribeExited((event: LaunchExitedEvent) => {
        if (sessionId && event.sessionId !== sessionId) return
        setStopping(false)
        setSessionId(null)
        void refreshExit(event.exitCode)
      }),
    ]
    return () => offs.forEach((off) => off())
  }, [backend, instance.id, sessionId, refreshExit])

  useEffect(() => {
    if (status.status !== 'ready' || !status.data) return
    const current = status.data
    setLive(current.state)
    if (current.sessionId) setSessionId(current.sessionId)
    if (current.state === 'running') {
      setFlow('running')
      setStopping(false)
      setStage(null)
    } else if (current.state === 'crashed') {
      void refreshExit(current.exitCode)
    } else if (current.state === 'exited') {
      void refreshExit(current.exitCode)
    }
  }, [status.status, status.data, refreshExit])

  const start = useCallback(async () => {
    setBusy(true)
    setActionError(null)
    setPlanError(null)
    setDetailOpen(false)
    setExitInfo(null)
    setFlow('checking')
    setStage('检查账户…')
    try {
      const accountState = await backend.auth.list()
      if (accountState.accounts.length === 0) {
        throw new BackendError('AUTH.NO_ACCOUNT', '还没有启动账户，请先在设置中创建离线账户', false)
      }
      const accountId = accountState.selectedId ?? accountState.accounts[0].id
      if (!accountState.selectedId) await backend.auth.select(accountId)
      setStage('检查 Java…')
      // Make sure the JVM matches what this version wants. Legacy versions need
      // Java 8 exactly; downloading it beats launching on 17 and crashing.
      const requirement = await backend.java.requirement(instance.id).catch(() => null)
      const requiredMajor = requirement?.requiredMajor ?? null
      let detected = await backend.java.detect(false)
      const hasMatching = (result: typeof detected): boolean =>
        result.candidates.some((candidate) =>
          requiredMajor === null ? true : candidate.version.major === requiredMajor,
        )
      if (requiredMajor !== null && !hasMatching(detected)) {
        setStage(`缺少 Java ${requiredMajor}，正在自动下载…`)
        const javaJob = await backend.java.download({
          major: requiredMajor,
          source: 'auto',
          force: false,
        })
        for (let attempt = 0; attempt < 900; attempt += 1) {
          await new Promise((resolve) => setTimeout(resolve, 2000))
          const progress = await backend.java.downloadStatus(javaJob.jobId).catch(() => null)
          if (!progress) continue
          setStage(
            `下载 Java ${requiredMajor} · ${progress.stage}` +
              (progress.percent === null ? '' : ` ${Math.round(progress.percent)}%`),
          )
          if (progress.state === 'done') break
          if (progress.state === 'failed' || progress.state === 'cancelled') {
            throw new BackendError(
              'JAVA.DOWNLOAD_FAILED',
              `Java ${requiredMajor} 下载${progress.state === 'cancelled' ? '已取消' : '失败'}：${progress.message ?? '没有更多信息'}`,
              true,
            )
          }
        }
        detected = await backend.java.detect(true)
        if (!hasMatching(detected)) {
          throw new BackendError(
            'JAVA.VERSION_MISMATCH',
            `该版本需要 Java ${requiredMajor}，下载完成但没有检测到它`,
            true,
          )
        }
      }
      const java = detected
      if (java.candidates.length === 0) {
        throw new BackendError('JAVA.NOT_FOUND', '没有找到可用的 Java；请安装 Java 或在设置中指定路径', true)
      }
      setStage('生成启动参数…')
      // Optional pre-launch cleanup (settings → 启动 → 内存分配). Only touches
      // the whitelisted cache categories; failures never block the launch.
      try {
        if (window.localStorage.getItem('mcl.pref.optimizeBeforeLaunch') === '1') {
          setStage('启动前清理缓存…')
          await backend.perf.cleanCache({}).catch(() => undefined)
        }
      } catch {
        /* storage unavailable: skip the optimisation */
      }
      const result = await backend.launch.start(instance.id, accountId)
      setSessionId(result.sessionId)
      // Do not overwrite a `running` event that may arrive before start()
      // resolves. Query the real status once instead of assuming a phase.
      const current = await backend.launch.status(instance.id).catch(() => null)
      if (current) {
        setLive(current.state)
        if (current.sessionId) setSessionId(current.sessionId)
        if (current.state === 'running') {
          setFlow('running')
          setStage(null)
        } else if (current.state === 'crashed' || current.state === 'exited') {
          void refreshExit(current.exitCode)
        } else {
          setFlow('starting')
          setStage('等待游戏进程…')
        }
      } else {
        setFlow('starting')
        setStage('等待游戏进程…')
      }
      status.reload()
    } catch (cause) {
      setFlow('failed')
      setActionError(describeError(cause))
      setDetailOpen(true)
    } finally {
      setBusy(false)
    }
  }, [backend, instance.id, refreshExit, status])

  /**
   * Re-download whatever the launch pre-check found missing. Used both by the
   * failure banner (which then retries the launch) and by the hero menu (which
   * only repairs).
   */
  const repairOnly = useCallback(async (): Promise<boolean> => {
    if (!instance) return false
    setRepairing('准备修复…')
    setActionError(null)
    try {
      const started = await backend.repair.repair(instance.id, 'size')
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const progress = await backend.repair.status(started.jobId)
        if (!progress) continue
        setRepairing(
          `${progress.stage} ${progress.done}/${progress.total}` +
            (progress.percent === null ? '' : ` · ${Math.round(progress.percent)}%`),
        )
        if (progress.state === 'done') break
        if (progress.state === 'failed' || progress.state === 'cancelled') {
          throw new BackendError(
            'REPAIR.FAILED',
            `修复${progress.state === 'cancelled' ? '已取消' : '失败'}：${progress.message ?? '没有更多信息'}`,
            true,
          )
        }
      }
      setRepairing(null)
      return true
    } catch (cause) {
      setRepairing(null)
      setActionError(describeError(cause))
      return false
    }
  }, [backend, instance])

  const repairAndLaunch = useCallback(async () => {
    if (await repairOnly()) await start()
  }, [repairOnly, start])

  const stop = useCallback(async () => {
    if (!sessionId) {
      setActionError({ kind: 'error', title: '没有运行中的会话', detail: '启动状态尚未返回 sessionId，请刷新启动状态。', retryable: true })
      return
    }
    setStopping(true)
    setFlow('stopping')
    setStage('正在结束游戏…')
    setActionError(null)
    try {
      const result = await backend.launch.stop(sessionId)
      if (!result.ok) {
        throw new BackendError('LAUNCH.STOP_FAILED', '主进程没有找到该启动会话', true)
      }
      const current = await backend.launch.status(instance.id).catch(() => null)
      if (current && (current.state === 'exited' || current.state === 'crashed')) {
        void refreshExit(current.exitCode)
      } else {
        setStage('等待游戏进程退出…')
      }
    } catch (cause) {
      setStopping(false)
      setFlow('running')
      setActionError(describeError(cause))
    }
  }, [backend, instance.id, refreshExit, sessionId])


  const preview = useCallback(async () => {
    setBusy(true)
    setPlanError(null)
    try {
      const accountState = await backend.auth.list()
      const accountId = accountState.selectedId ?? accountState.accounts[0]?.id ?? null
      setPlan(await backend.launch.plan(instance.id, accountId))
    } catch (cause) {
      setPlanError(describeError(cause))
      setPlan(null)
    } finally {
      setBusy(false)
    }
  }, [backend, instance.id])

  return (
    <article className="card hero">
      <div className="icon-tile icon-tile--forge icon-tile--lg" aria-hidden="true">
        <Icon name="cube" className="ico" />
      </div>
      <div className="hero__body">
        <div className="hero__title">
          <h2>{instance.name}</h2>
          <Badge tone={instance.state === 'ready' ? 'accent' : 'warning'}>{instance.state === 'ready' ? '当前实例' : '需要处理'}</Badge>
          <Badge tone={state === 'running' ? 'success' : state === 'crashed' ? 'danger' : state === 'launching' ? 'accent' : 'outline'} dot>
            {launchStateLabel(state)}
          </Badge>
        </div>
        <div className="hero__tags">
          {loaderTag(instance)}
          <Tag>{instance.mcVersion ?? '版本未知'}</Tag>
          <Tag>{instance.isolation === 'isolated' ? '实例隔离' : '共用目录'}</Tag>
        </div>
        <div className="hero__meta">
          <span className="meta-chip"><Icon name="coffee" />Java 自动 · {instance.javaMajor ?? '检测中'}</span>
          <span className="meta-chip"><Icon name="memory" />内存 实例 auto</span>
          <span className="meta-chip"><Icon name="clock" />{instance.lastPlayedAt ? new Date(instance.lastPlayedAt).toLocaleString('zh-CN') : '尚未游玩'}</span>
          <span className="meta-chip"><Icon name="folder" />{instance.dirName}</span>
        </div>
        <div className="hero__actions">
          <LaunchButton state={state} onClick={() => void start()} disabled={busy || state === 'running' || stopping} />
          {state === 'running' ? (
            <Button variant="danger-ghost" size="lg" icon="close" loading={stopping} disabled={stopping} onClick={() => void stop()}>
              {stopping ? '正在结束…' : '结束游戏'}
            </Button>
          ) : null}
          <Button variant="secondary" size="lg" icon="package" onClick={() => navigate('/catalog')} title="打开资源库，按当前实例筛选模组">下载模组</Button>
          <div className="hero-more">
            <Button
              variant="ghost"
              size="lg"
              icon="more"
              aria-label="更多操作"
              aria-haspopup="menu"
              aria-expanded={detailMenuOpen}
              title="更多操作"
              onClick={() => setDetailMenuOpen((open) => !open)}
            />
            {detailMenuOpen ? (
              <div className="hero-more__menu" role="menu">
                {DETAIL_LINKS.map((entry) => (
                  <button
                    key={entry.section}
                    type="button"
                    role="menuitem"
                    className="hero-more__item"
                    onClick={() => {
                      setDetailMenuOpen(false)
                      navigate(`/instances/${encodeURIComponent(instance.id)}/${entry.section}`)
                    }}
                  >
                    <Icon name={entry.icon} className="ico ico--sm" />
                    <span>{entry.label}</span>
                  </button>
                ))}
                <div className="hero-more__sep" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className="hero-more__item"
                  disabled={repairing !== null}
                  onClick={() => {
                    setDetailMenuOpen(false)
                    void repairOnly()
                  }}
                >
                  <Icon name="shield" className="ico ico--sm" />
                  <span>{repairing ?? '校验并修复'}</span>
                </button>
                <div className="hero-more__sep" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className="hero-more__item"
                  onClick={() => {
                    setDetailMenuOpen(false)
                    setRenameValue(instance.name)
                    setRenameError(null)
                    setRenameOpen(true)
                  }}
                >
                  <Icon name="edit" className="ico ico--sm" />
                  <span>重命名</span>
                </button>
                <div className="hero-more__sep" aria-hidden="true" />
                <button
                  type="button"
                  role="menuitem"
                  className="hero-more__item"
                  disabled={busy}
                  onClick={() => {
                    setDetailMenuOpen(false)
                    void preview()
                  }}
                >
                  <Icon name="terminal" className="ico ico--sm" />
                  <span>预览启动参数</span>
                </button>
                <div className="hero-more__sep" aria-hidden="true" />
                {PAGE_LINKS.map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    role="menuitem"
                    className="hero-more__item"
                    onClick={() => {
                      setDetailMenuOpen(false)
                      // Carry the instance in the URL: the target page reads it
                      // from the route instead of guessing from storage.
                      navigate(`${entry.path}/${encodeURIComponent(instance.id)}`)
                    }}
                  >
                    <Icon name={entry.icon} className="ico ico--sm" />
                    <span>{entry.label}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
        <div className="nw-launch-account">
          <Icon name="user" />
          {accounts.status === 'ready'
            ? accounts.data?.accounts.length
              ? <span>自动账户：{accounts.data.accounts.find((account) => account.id === accounts.data?.selectedId)?.name ?? accounts.data.accounts[0].name} · 一键启动</span>
              : <span>未配置账户 · <button className="nw-link-button" type="button" onClick={() => navigate('/settings/account')}>去创建</button></span>
            : <span>{accounts.status === 'error' || accounts.status === 'not-wired' ? '账户通道不可用' : '读取账户…'}</span>}
        </div>
        {stopping ? (
          <div className="nw-launch-progress" aria-live="polite"><span className="spinner" />正在结束游戏…等待进程退出事件</div>
        ) : flow === 'checking' || flow === 'starting' ? (
          <div className="nw-launch-progress" aria-live="polite"><span className="spinner" />{stage ?? '准备启动…'}</div>
        ) : null}
        {flow === 'running' && !stopping ? (
          <div className="nw-launch-progress nw-launch-progress--running"><span className="pulse-dot" />游戏运行中{sessionId ? <code className="mono">{sessionId.slice(0, 8)}</code> : null}</div>
        ) : null}
        {exitInfo ? (
          <div className={`launch-strip ${exitInfo.classification === 'normal' || exitInfo.classification === 'killed' ? 'launch-strip--exit' : 'status-crashed'}`}>
            <Icon name={exitInfo.classification === 'normal' || exitInfo.classification === 'killed' ? 'check' : 'alert-circle'} className="ico ico--xs" />
            <span>{classificationLabel(exitInfo.classification)} · 退出码 {exitInfo.exitCode ?? '—'} · 耗时 {formatDuration(exitInfo.durationMs)}</span>
          </div>
        ) : null}
        {status.status === 'not-wired' ? (
          <div className="launch-strip">
            <span>启动状态通道尚未接入；按钮不会伪造“运行中”。</span>
            <span className="strip-actions"><Button size="xs" variant="ghost" onClick={status.reload}>重新探测</Button></span>
          </div>
        ) : status.status === 'error' ? (
          <div className="launch-strip status-crashed"><Icon name="alert-circle" className="ico ico--xs" />启动状态读取失败</div>
        ) : (
          <div className="launch-strip"><span>启动状态来自 <code className="mono">mc:launch:status</code>，进度来自 stage/status 事件</span></div>
        )}
        {actionError ? (
          <details className="nw-launch-details" open={detailOpen} onToggle={(event) => setDetailOpen((event.target as HTMLDetailsElement).open)}>
            <summary>启动失败详情</summary>
            <div className="nw-inline-error">{actionError.title}：{actionError.detail}{actionError.code ? `（${actionError.code}）` : ''}</div>
            <div className="row gap-8" style={{ marginTop: 8 }}>
              <Button size="sm" variant="secondary" icon="refresh" onClick={() => void start()}>重试启动</Button>
              {actionError.code?.startsWith('AUTH') ? <Button size="sm" variant="ghost" icon="user" onClick={() => navigate('/settings/account')}>创建账户</Button> : null}
              {actionError.code === 'JAVA.NOT_FOUND' ? <Button size="sm" variant="ghost" icon="coffee" onClick={() => navigate('/settings/java')}>Java 设置</Button> : null}
              {actionError.code?.startsWith('LAUNCH.MISSING') ? <Button size="sm" variant="ghost" icon="shield" onClick={() => navigate(`/instances/${encodeURIComponent(instance.id)}`)}>校验并修复</Button> : null}
              <Button size="sm" variant="ghost" icon="terminal" onClick={() => navigate('/logs')}>查看日志</Button>
            </div>
          </details>
        ) : null}
        {state === 'crashed' ? (
          <div className="home-crash-panel">
            <CrashPanel instanceId={instance.id} instanceName={instance.name} autoAnalyze />
          </div>
        ) : null}
        {planError ? <div className="nw-inline-error">{planError.title}：{planError.detail}</div> : null}
        {plan ? (
          <div className="nw-plan">
            <div className="nw-plan__head">
              <strong><Icon name="terminal" /> dry-run 启动参数</strong>
              <Badge tone="outline">未启动进程</Badge>
            </div>
            <div className="nw-plan__meta">
              <span><Icon name="coffee" />{plan.javaPath}</span>
              <span><Icon name="folder" />{plan.cwd}</span>
              <span><Icon name="terminal" />{plan.logFile}</span>
            </div>
            <pre className="nw-plan__argv">{plan.argv.map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(' ')}</pre>
            {plan.warnings.length ? <ul className="nw-plan__warnings">{plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : null}
          </div>
        ) : null}
      </div>

      {renameOpen ? (
        <div className="rename-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setRenameOpen(false)
        }}>
          <div className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title">
            <div className="rename-dialog__head">
              <span className="rename-dialog__icon"><Icon name="edit" /></span>
              <div>
                <div className="eyebrow">重命名实例</div>
                <h2 id="rename-title">{instance.name}</h2>
              </div>
            </div>
            <label className="rename-dialog__field">
              <span>新名称</span>
              <Input
                value={renameValue}
                maxLength={64}
                autoFocus
                onChange={(event) => setRenameValue(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void submitRename()
                  if (event.key === 'Escape') setRenameOpen(false)
                }}
              />
            </label>
            {renameError ? <p className="rename-dialog__error">{renameError}</p> : null}
            <div className="rename-dialog__actions">
              <Button variant="secondary" onClick={() => setRenameOpen(false)}>取消</Button>
              <Button variant="primary" loading={renameBusy} onClick={() => void submitRename()}>保存</Button>
            </div>
          </div>
        </div>
      ) : null}
    </article>
  )
}

function PendingHero({ info, onRetry }: { info: UiErrorInfo; onRetry: () => void }) {
  return (
    <article className="card hero nw-hero">
      <div className="icon-tile icon-tile--vanilla icon-tile--lg" aria-hidden="true">
        <Icon name="flask" className="ico" />
      </div>
      <div className="hero__body">
        <div className="hero__title">
          <h2>尚未接入实例数据</h2>
          <Badge tone="warning">等待后端</Badge>
        </div>
        <p className="nw-hero__lead">
          渲染层已经按设计稿落地；实例列表与启动状态需要 IPC 白名单放行后才会出现。这里不会用示例实例名或虚拟版本号填充。
        </p>
        <div className="hero__tags">
          <Tag>mc:instance:list</Tag>
          <Tag>mc:launch:status</Tag>
        </div>
        <div className="hero__actions">
          <LaunchButton state="unknown" />
          <Button variant="secondary" size="lg" icon="refresh" onClick={onRetry}>重新探测</Button>
          <Button variant="ghost" size="lg" icon="info" onClick={() => navigate('/about')}>模块状态</Button>
        </div>
        <div className="launch-strip">
          <span>{info.detail}</span>
        </div>
      </div>
    </article>
  )
}

export function HomePage() {
  const backend = useBackend()
  const system = useSystem()
  const accountState = useCurrentAccount()
  const currentAccount = accountState.data?.accounts.find((account) => account.id === accountState.data?.selectedId) ?? accountState.data?.accounts[0] ?? null
  const instances = useAsync(() => backend.instances.list(), [])
  const [selectedId, setSelectedId] = useState<string | null>(() => localStorage.getItem('mcl.global.instanceId'))
  const [pendingDelete, setPendingDelete] = useState<InstanceSummary | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [dirPanelOpen, setDirPanelOpen] = useState(false)
  const [rowMenuId, setRowMenuId] = useState<string | null>(null)
  const [expandedList, setExpandedList] = useState(false)

  // Close the per-row menu on any outside click or Escape, same as the hero menu.
  useEffect(() => {
    if (!rowMenuId) return
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.instance-row__menu')) setRowMenuId(null)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setRowMenuId(null)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [rowMenuId])
  const pendingDeleteRunning = useInstanceRunning(pendingDelete?.id ?? null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<UiErrorInfo | null>(null)

  const selected = useMemo(() => {
    if (!instances.data || instances.data.length === 0) return null
    return instances.data.find((item) => item.id === selectedId) ?? instances.data[0]
  }, [instances.data, selectedId])

  useEffect(() => {
    if (selected) localStorage.setItem('mcl.global.instanceId', selected.id)
  }, [selected?.id])

  useEffect(() => {
    const refresh = () => instances.reload()
    const off = backend.instances.subscribeChanged(refresh)
    window.addEventListener('mcl:instances-changed', refresh)
    return () => {
      off()
      window.removeEventListener('mcl:instances-changed', refresh)
    }
  }, [backend, instances.reload])

  useEffect(() => {
    const select = (event: Event) => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id) setSelectedId(id)
    }
    window.addEventListener('mcl:select-instance', select)
    return () => window.removeEventListener('mcl:select-instance', select)
  }, [])

  /** Move an instance to the recycle bin; it can be restored from 回收站. */
  const removeInstance = async (instance: InstanceSummary) => {
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await backend.instances.removeInstance(instance.id)
      window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
      await instances.reload()
      if (selectedId === instance.id) setSelectedId(null)
      setPendingDelete(null)
    } catch (cause) {
      setDeleteError(describeError(cause))
    } finally {
      setDeleteBusy(false)
    }
  }

  // Every instance is listed; long lists collapse behind a "show more" row.
  const listedInstances = instances.data ?? []
  // Collapsed by default: keep a few rows visible and put the rest behind a
  // toggle, so a long list does not push the rest of the page away.
  const INSTANCE_PREVIEW = 6
  const shownInstances = expandedList ? listedInstances : listedInstances.slice(0, INSTANCE_PREVIEW)

  const pendingInfo = instances.status === 'not-wired' || instances.status === 'error'
    ? describeError(instances.error)
    : null

  const chooseNext = () => {
    if (!instances.data || instances.data.length === 0) return
    const index = Math.max(0, instances.data.findIndex((item) => item.id === selected?.id))
    const next = instances.data[(index + 1) % instances.data.length]
    setSelectedId(next.id)
  }
  void chooseNext

  return (
    <>
      <PageHeader
        title="欢迎回来"
        subtitle="从实例列表启动游戏；真实数据通过 adapter 读取，未接入时明确提示。"
      />

      {/* Quick actions live right under the title (was a row of header buttons
          plus a second block at the bottom of the page). */}
      <div className="quick-row quick-row--top">
        <button className="quick-tile" type="button" onClick={() => navigate('/download')}>
          <span className="quick-tile__icon"><Icon name="download" /></span>
          <span className="quick-tile__text"><span className="quick-tile__title">安装新版本</span><span className="quick-tile__sub">原版或加载器，进入安装与下载</span></span>
          <Icon name="chevron-right" />
        </button>
        <button className="quick-tile" type="button" onClick={() => setImportOpen(true)}>
          <span className="quick-tile__icon"><Icon name="package" /></span>
          <span className="quick-tile__text"><span className="quick-tile__title">导入整合包</span><span className="quick-tile__sub">从链接或本地文件创建实例</span></span>
          <Icon name="chevron-right" />
        </button>
        <button className="quick-tile" type="button" onClick={() => navigate('/settings/java')}>
          <span className="quick-tile__icon"><Icon name="coffee" /></span>
          <span className="quick-tile__text"><span className="quick-tile__title">管理 Java</span><span className="quick-tile__sub">检测与指定运行时</span></span>
          <Icon name="chevron-right" />
        </button>
      </div>

      {system.error ? (
        <Banner tone="danger" title="系统信息读取失败" actions={<Button size="sm" variant="secondary" onClick={system.reload}>重试</Button>}>
          {describeError(system.error).detail}
        </Banner>
      ) : null}

      <div className="home__grid">
        <div className="home__main">
          {instances.status === 'loading' ? (
            <div className="card nw-loading">
              <Skeleton className="skeleton--block" style={{ width: 64, height: 64, borderRadius: 12 }} />
              <Skeleton className="skeleton--title" style={{ width: '42%', marginTop: 18 }} />
              <Skeleton className="skeleton--text" style={{ width: '66%', marginTop: 10 }} />
              <Skeleton className="skeleton--block" style={{ width: 180, height: 40, marginTop: 20, borderRadius: 7 }} />
            </div>
          ) : selected ? (
            <Hero key={selected.id} instance={selected} onChanged={instances.reload} />
          ) : pendingInfo ? (
            <PendingHero info={pendingInfo} onRetry={instances.reload} />
          ) : (
            <Card className="nw-empty-card">
              <EmptyState
                icon="cube"
                title="还没有游戏实例"
                description="安装一个 Minecraft 版本，或导入现有整合包。安装/导入后端接入后会出现在这里。"
                actions={(
                  <>
                    <Button variant="primary" icon="download" onClick={() => navigate('/download')}>安装第一个版本</Button>
                    <Button variant="secondary" icon="package" onClick={() => setImportOpen(true)}>导入整合包</Button>
                  </>
                )}
                hint="页面不会预填示例实例。"
              />
            </Card>
          )}

          {pendingInfo ? <div className="nw-spacer"><DataStateNotice info={pendingInfo} onRetry={instances.reload} /></div> : null}

          <SectionHead
            title="实例与版本"
            action={(
              <div className="row gap-8">
                <Button size="sm" variant="secondary" icon="package" onClick={() => setImportOpen(true)}>导入整合包</Button>
                <Button size="sm" variant="primary" icon="plus" onClick={() => navigate('/download')}>新建实例</Button>
              </div>
            )}
          />
          {instances.status === 'ready' && instances.data ? (
            listedInstances.length > 0 ? (
              <div className="instance-list">
                {shownInstances.map((instance) => (
                  <div
                    className={selected?.id === instance.id ? 'instance-row is-current' : 'instance-row'}
                    key={instance.id}
                  >
                    <button
                      type="button"
                      className="instance-row__pick"
                      title={`切换到「${instance.name}」`}
                      onClick={() => setSelectedId(instance.id)}
                    >
                      <span className="instance-row__icon" aria-hidden="true"><Icon name="cube" className="ico" /></span>
                      <span className="instance-row__main">
                        <span className="instance-row__name">{instance.name}</span>
                        <span className="instance-row__sub">
                          {instance.mcVersion ?? '版本未知'}
                          {instance.loader.type !== 'vanilla' ? `, ${instance.loader.type}${instance.loader.version ? ` ${instance.loader.version}` : ''}` : ''}
                        </span>
                      </span>
                      <span className="instance-row__meta">
                        <InstanceStateBadge state={instance.state} />
                        <Tag>{instance.isolation === 'isolated' ? '隔离' : '共用'}</Tag>
                        <span className="instance-row__stat">Java {instance.javaMajor ?? '—'}</span>
                        <span className="instance-row__stat">
                          {instance.lastPlayedAt ? new Date(instance.lastPlayedAt).toLocaleDateString('zh-CN') : '尚未游玩'}
                        </span>
                      </span>
                    </button>
                    <div className="instance-row__menu">
                      <Button
                        size="xs"
                        variant="ghost"
                        icon="more"
                        aria-label={`「${instance.name}」的更多操作`}
                        onClick={() => setRowMenuId(rowMenuId === instance.id ? null : instance.id)}
                      />
                      {rowMenuId === instance.id ? (
                        <div className="hero-more__menu" role="menu">
                          {DETAIL_LINKS.map((entry) => (
                            <button
                              key={entry.section}
                              type="button"
                              role="menuitem"
                              className="hero-more__item"
                              onClick={() => {
                                setRowMenuId(null)
                                navigate(`/instances/${encodeURIComponent(instance.id)}/${entry.section}`)
                              }}
                            >
                              <Icon name={entry.icon} className="ico ico--sm" />
                              <span>{entry.label}</span>
                            </button>
                          ))}
                          <div className="hero-more__sep" aria-hidden="true" />
                          {PAGE_LINKS.map((entry) => (
                            <button
                              key={entry.path}
                              type="button"
                              role="menuitem"
                              className="hero-more__item"
                              onClick={() => {
                                setRowMenuId(null)
                                navigate(`${entry.path}/${encodeURIComponent(instance.id)}`)
                              }}
                            >
                              <Icon name={entry.icon} className="ico ico--sm" />
                              <span>{entry.label}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      size="xs"
                      variant="danger-ghost"
                      icon="trash"
                      aria-label={`删除实例 ${instance.name}`}
                      title="移入回收站（可在回收站恢复）"
                      onClick={() => setPendingDelete(instance)}
                    >
                      删除
                    </Button>
                  </div>
                ))}
                {listedInstances.length > INSTANCE_PREVIEW ? (
                  <button
                    type="button"
                    className="instance-list__more"
                    onClick={() => setExpandedList((value) => !value)}
                  >
                    <Icon name={expandedList ? 'chevron-down' : 'chevron-right'} className="ico ico--xs" />
                    {expandedList
                      ? '收起列表'
                      : `展开全部（还有 ${listedInstances.length - INSTANCE_PREVIEW} 个实例）`}
                  </button>
                ) : null}
              </div>
            ) : (
              <Card><EmptyState icon="cube" title="没有符合条件的实例" description="换个筛选条件，或点「全部实例」查看完整列表。" /></Card>
            )
          ) : (
            <Card className="nw-empty-card">
              <EmptyState
                icon="instances"
                title={instances.status === 'loading' ? '正在读取实例…' : '实例数据尚未接入'}
                description={instances.status === 'loading' ? '等待 mc:instance:list 返回。' : '接入后会在此显示真实实例；不会用示例实例填充。'}
                actions={<Button size="sm" variant="secondary" icon="refresh" onClick={instances.reload}>重新探测</Button>}
              />
            </Card>
          )}

          {/* Game directory management used to live on the (now removed)
              instance page; it belongs next to the instance list. */}
          <SectionHead
            title="游戏目录"
            action={(
              <Button size="sm" variant="secondary" icon="folder" onClick={() => setDirPanelOpen((value) => !value)}>
                {dirPanelOpen ? '收起' : '管理游戏目录'}
              </Button>
            )}
          />
          {dirPanelOpen ? (
            <MinecraftDirectoryPanel onImported={() => void instances.reload()} />
          ) : null}

        </div>
      </div>

      <ImportPackDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onImported={(instanceId, name) => {
          setImportOpen(false)
          window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
          void instances.reload()
          navigate(`/instances/${encodeURIComponent(instanceId)}`)
        }}
      />

      <DeleteInstanceDialog
        instance={pendingDelete}
        running={pendingDeleteRunning}
        busy={deleteBusy}
        error={deleteError}
        onCancel={() => {
          setPendingDelete(null)
          setDeleteError(null)
        }}
        onConfirm={() => {
          if (pendingDelete) void removeInstance(pendingDelete)
        }}
      />
    </>
  )
}

function InstanceStateBadge({ state }: { state: InstanceSummary['state'] }) {
  // Local import avoids a second generic component dependency in this page.
  switch (state) {
    case 'ready': return <Badge tone="success">就绪</Badge>
    case 'missing-json': return <Badge tone="warning">缺 JSON</Badge>
    case 'corrupt-json': return <Badge tone="danger">JSON 损坏</Badge>
    case 'missing-jar': return <Badge tone="warning">缺 JAR</Badge>
    default: return <Badge tone="outline">无法识别</Badge>
  }
}
