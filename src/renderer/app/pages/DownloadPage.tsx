import { useEffect, useMemo, useState } from 'react'
import type { DownloadProgress, DownloadStage, InstallPlanSummary, ManifestVersion } from '@shared/download'
import type { LoaderProgress, LoaderType } from '@shared/loader'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { useSystem } from '../system'
import { navigate } from '../router'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  EmptyState,
  Field,
  PageHeader,
  Progress,
  Select,
  Skeleton,
  Switch,
  Tag,
} from '../ui'
import { Icon } from '../icons'

type InstallType = 'vanilla' | 'forge' | 'neoforge' | 'fabric' | 'quilt'

const TYPES: ReadonlyArray<{ value: InstallType; label: string; supported: boolean }> = [
  { value: 'vanilla', label: '原版', supported: true },
  { value: 'forge', label: 'Forge', supported: true },
  { value: 'neoforge', label: 'NeoForge', supported: true },
  { value: 'fabric', label: 'Fabric', supported: true },
  { value: 'quilt', label: 'Quilt', supported: true },
]

const STAGE_LABEL: Record<DownloadStage, string> = {
  idle: '准备',
  manifest: '版本清单',
  'version-json': '版本 JSON',
  client: '客户端 JAR',
  libraries: '依赖库',
  logging: '日志配置',
  'assets-index': '资源索引',
  assets: '资源文件',
  files: '模组文件',
  done: '完成',
}

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : '—'
}

/** ETA is derived only from the live event's byte counters and measured speed. */
function formatEta(progress: DownloadProgress): string {
  if (progress.state !== 'running' || progress.bytesPerSec <= 0 || progress.bytesTotal <= progress.bytesDone) {
    return '—'
  }
  const seconds = Math.ceil((progress.bytesTotal - progress.bytesDone) / progress.bytesPerSec)
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} 分钟`
  return `${(seconds / 3600).toFixed(1)} 小时`
}

function versionLabel(version: ManifestVersion): string {
  return version.type === 'release' ? version.id : `${version.id} · ${version.type}`
}

type McTab = 'release' | 'snapshot' | 'legacy'

const MC_TABS: ReadonlyArray<{ value: McTab; label: string }> = [
  { value: 'release', label: '正式版' },
  { value: 'snapshot', label: '快照版' },
  { value: 'legacy', label: '远古版本' },
]

function formatReleaseDate(value: string | null | undefined): string {
  if (!value) return '日期未知'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '日期未知'
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function versionTypeLabel(type: string): string {
  switch (type) {
    case 'release': return '正式版'
    case 'snapshot': return '快照'
    case 'old_beta': return '远古 beta'
    case 'old_alpha': return '远古 alpha'
    default: return type
  }
}

function TaskCard({ progress, onPause, onResume, onCancel }: {
  progress: DownloadProgress
  onPause: () => void
  onResume: () => void
  onCancel: () => void
}) {
  const pct = progress.bytesTotal > 0 ? (progress.bytesDone / progress.bytesTotal) * 100 : null
  const active = progress.state === 'running' || progress.state === 'queued' || progress.state === 'paused'
  return (
    <div className="nw-task-card">
      <div className="nw-task-card__head">
        <div>
          <div className="nw-task-card__title">
            {progress.versionId ? `安装 ${progress.versionId}` : '下载任务'}
            <Tag>{progress.kind}</Tag>
          </div>
          <div className="nw-task-card__sub">
            {STAGE_LABEL[progress.stage]} · {progress.done}/{progress.total} 文件
            {progress.failed ? ` · ${progress.failed} 失败` : ''}
            {progress.source ? ` · ${progress.source}` : ''}
          </div>
        </div>
        <Badge tone={progress.state === 'done' ? 'success' : progress.state === 'failed' ? 'danger' : progress.state === 'paused' ? 'warning' : 'accent'} dot>
          {progress.state}
        </Badge>
      </div>
      <Progress value={pct} tone={progress.state === 'failed' ? 'danger' : progress.state === 'done' ? 'success' : 'accent'} label={`${progress.versionId ?? '任务'}进度`} />
      <div className="nw-task-card__stats">
        <span>{progress.bytesTotal > 0 ? `${formatBytes(progress.bytesDone)} / ${formatBytes(progress.bytesTotal)}` : '大小未知'}</span>
        <span>速度 {formatSpeed(progress.bytesPerSec)}</span>
        <span>剩余 {formatEta(progress)}</span>
        <span>{progress.currentFile ?? '等待当前文件'}</span>
      </div>
      {active ? (
        <div className="nw-task-card__actions">
          {progress.state === 'paused'
            ? <Button size="xs" variant="secondary" icon="play" onClick={onResume}>继续</Button>
            : <Button size="xs" variant="secondary" icon="pause" onClick={onPause}>暂停</Button>}
          <Button size="xs" variant="danger-ghost" icon="close" onClick={onCancel}>取消</Button>
        </div>
      ) : null}
      {progress.message ? <div className="nw-task-card__message">{progress.message}</div> : null}
    </div>
  )
}

export function DownloadPage() {
  const backend = useBackend()
  const system = useSystem()
  const sources = useAsync(() => backend.downloads.sources(), [])
  const manifest = useAsync(() => backend.downloads.manifest(false), [])
  const java = useAsync(() => backend.java.detect(false), [])
  const tasks = useAsync(() => backend.downloads.list(), [])
  const [type, setType] = useState<InstallType>('vanilla')
  const [versionId, setVersionId] = useState('')
  const [mcTab, setMcTab] = useState<McTab>('release')
  const [mcQuery, setMcQuery] = useState('')
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loaderProgress, setLoaderProgress] = useState<LoaderProgress | null>(null)
  const [loaderLines, setLoaderLines] = useState<string[]>([])
  const [loaderError, setLoaderError] = useState<UiErrorInfo | null>(null)
  const [allowUnverified, setAllowUnverified] = useState(false)
  const loaderType: LoaderType | null = type === 'vanilla' ? null : type as LoaderType
  const loaderList = useAsync(
    () => (loaderType && versionId ? backend.loader.list(loaderType, versionId, false) : Promise.resolve(null)),
    [loaderType, versionId],
  )
  const [isolate, setIsolate] = useState(true)
  const [liveProgress, setLiveProgress] = useState<Record<string, DownloadProgress>>({})
  const [plan, setPlan] = useState<InstallPlanSummary | null>(null)
  const [planError, setPlanError] = useState<UiErrorInfo | null>(null)
  const [planBusy, setPlanBusy] = useState(false)
  const [actionError, setActionError] = useState<UiErrorInfo | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const offProgress = backend.downloads.subscribeProgress((progress) => {
      setLiveProgress((prev) => ({ ...prev, [progress.jobId]: progress }))
    })
    const offFinished = backend.downloads.subscribeFinished(() => {
      tasks.reload()
      setBusy(false)
    })
    const offLoaderProgress = backend.loader.subscribeProgress((progress) => {
      setLoaderProgress(progress)
      if (progress.state === 'failed') {
        setLoaderError({ kind: 'error', title: '加载器安装失败', detail: progress.message ?? progress.currentTask ?? '安装器返回失败', retryable: true })
      }
    })
    const offLoaderLog = backend.loader.subscribeLog((event) => {
      setLoaderLines((prev) => [...prev, ...event.lines].slice(-8))
    })
    const offLoaderFinished = backend.loader.subscribeFinished((event) => {
      setBusy(false)
      if (!event.ok) {
        setLoaderError({ kind: 'error', title: '加载器安装失败', detail: event.error?.message ?? '安装器返回失败', retryable: true })
      } else {
        setLoaderProgress((prev) => (prev ? { ...prev, state: 'done', stage: 'done' } : prev))
        setLoaderLines([])
      }
    })
    return () => {
      offProgress()
      offFinished()
      offLoaderProgress()
      offLoaderLog()
      offLoaderFinished()
    }
  }, [backend, tasks.reload])

  useEffect(() => {
    if (!loaderType) {
      setLoaderVersion('')
      return
    }
    const versions = loaderList.data?.versions ?? []
    if (versions.length === 0) return
    if (!versions.some((version) => version.version === loaderVersion)) {
      setLoaderVersion((versions.find((version) => version.recommended) ?? versions.find((version) => version.stable) ?? versions[0]).version)
    }
  }, [loaderType, loaderList.data, loaderVersion])

  const versions = manifest.data?.versions ?? []
  const selected = versions.find((version) => version.id === versionId) ?? null

  const releaseVersions = versions.filter((version) => version.type === 'release')
  const snapshotVersions = versions.filter((version) => version.type === 'snapshot')
  const legacyVersions = versions.filter(
    (version) => version.type === 'old_beta' || version.type === 'old_alpha',
  )
  const latestRelease = releaseVersions[0] ?? null
  const latestSnapshot = snapshotVersions[0] ?? null
  const query = mcQuery.trim().toLowerCase()
  const tabVersions = (
    mcTab === 'release' ? releaseVersions : mcTab === 'snapshot' ? snapshotVersions : legacyVersions
  )
    .filter((version) => (query ? version.id.toLowerCase().includes(query) : true))
    .slice(0, 60)
  const pickVersion = (id: string) => {
    setVersionId(id)
    setPlan(null)
    setPlanError(null)
  }
  const typeInfo = TYPES.find((item) => item.value === type)
  const downloadPending = sources.status === 'not-wired' || sources.status === 'error'
  const downloadInfo = downloadPending ? describeError(sources.error) : null
  const manifestPending = manifest.status === 'not-wired' || manifest.status === 'error'
  const manifestInfo = manifestPending ? describeError(manifest.error) : null
  const tasksPending = tasks.status === 'not-wired' || tasks.status === 'error'
  const tasksInfo = tasksPending ? describeError(tasks.error) : null
  const javaPending = java.status === 'not-wired' || java.status === 'error'
  const javaInfo = javaPending ? describeError(java.error) : null
  const loaderPending = loaderList.status === 'not-wired' || loaderList.status === 'error'
  const loaderInfo = loaderPending ? describeError(loaderList.error) : null
  const loaderVersions = loaderList.data?.versions ?? []
  const loaderChoice = loaderVersions.find((version) => version.version === loaderVersion) ?? null
  const loaderReady = type === 'vanilla' || Boolean(loaderVersion) && loaderList.status === 'ready'
  const canInstall = typeInfo?.supported === true && Boolean(versionId) && !manifestPending && !downloadPending && loaderReady

  const mergedTasks = useMemo(() => {
    const map = new Map<string, DownloadProgress>()
    for (const task of tasks.data ?? []) map.set(task.jobId, task)
    for (const [jobId, task] of Object.entries(liveProgress)) map.set(jobId, task)
    return [...map.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }, [tasks.data, liveProgress])

  const install = async () => {
    if (!canInstall) return
    setBusy(true)
    setActionError(null)
    setLoaderError(null)
    try {
      if (type === 'vanilla') {
        await backend.downloads.install(versionId)
        tasks.reload()
        return
      }
      const plan = await backend.loader.plan(type as LoaderType, versionId, loaderVersion || undefined)
      if (plan.installer?.hashSource === 'none' && !allowUnverified) {
        setLoaderError({
          kind: 'error',
          title: '安装器没有可校验哈希',
          detail: '需要先勾选“允许无上游哈希的安装器”，或换一个来源/版本；这是 SEC-EXE-05 的明确同意。',
          retryable: false,
        })
        return
      }
      await backend.loader.install({
        type: type as LoaderType,
        mcVersion: versionId,
        loaderVersion: loaderVersion || undefined,
        confirmSha1: plan.installer?.sha1 ?? null,
        allowUnverifiedInstaller: allowUnverified,
      })
    } catch (cause) {
      setActionError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const previewPlan = async () => {
    if (!versionId) return
    setPlanBusy(true)
    setPlanError(null)
    try {
      setPlan(await backend.downloads.plan(versionId))
    } catch (cause) {
      setPlan(null)
      setPlanError(describeError(cause))
    } finally {
      setPlanBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="安装与下载"
        subtitle={manifest.data
          ? `版本清单来自 ${manifest.data.source}${manifest.data.cached ? '（缓存）' : ''}；最后获取 ${new Date(manifest.data.fetchedAt).toLocaleString('zh-CN')}`
          : '版本清单与下载任务来自真实 download 模块；未接入时明确显示等待状态。'}
        actions={(
          <>
            <Button variant="secondary" icon="folder" onClick={() => void backend.system.openDataDir()}>下载目录</Button>
            <Button variant="secondary" icon="refresh" onClick={() => { manifest.reload(); tasks.reload(); sources.reload() }} disabled={manifest.status === 'loading'}>刷新清单</Button>
          </>
        )}
      />

      {downloadInfo ? (
        <Banner
          tone="warning"
          title="下载模块尚未接入当前渲染层"
          icon="flask"
          actions={(
            <>
              <Button size="sm" variant="secondary" icon="refresh" onClick={sources.reload}>重新探测</Button>
              <Button size="sm" variant="ghost" onClick={() => navigate('/about')}>模块状态</Button>
            </>
          )}
        >
          {downloadInfo.detail}
        </Banner>
      ) : null}

      <div className="ver-picker">
        <div className="ver-pills">
          {MC_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              className={`ver-pill${mcTab === tab.value ? ' is-active' : ''}`}
              onClick={() => setMcTab(tab.value)}
            >
              {tab.label}
            </button>
          ))}
          <input
            className="input ver-search"
            placeholder="搜索版本 ID…"
            value={mcQuery}
            onChange={(event) => setMcQuery(event.target.value)}
            aria-label="搜索版本 ID"
          />
        </div>

        <div className="ver-heroes">
          <button
            type="button"
            className="ver-hero"
            disabled={!latestRelease}
            onClick={() => latestRelease && pickVersion(latestRelease.id)}
          >
            <span className="ver-hero__icon" aria-hidden="true" />
            <span className="ver-hero__text">
              <span className="ver-hero__kicker">最新正式版</span>
              <span className="ver-hero__name">{latestRelease?.id ?? '—'}</span>
              <span className="ver-hero__meta">{latestRelease ? `发布于 ${formatReleaseDate(latestRelease.releaseTime)}` : '清单不可用'}</span>
            </span>
            <Icon name="chevron-right" className="ico ico--sm subtle" />
          </button>
          <button
            type="button"
            className="ver-hero"
            disabled={!latestSnapshot}
            onClick={() => latestSnapshot && pickVersion(latestSnapshot.id)}
          >
            <span className="ver-hero__icon ver-hero__icon--snap" aria-hidden="true" />
            <span className="ver-hero__text">
              <span className="ver-hero__kicker">最新预览版</span>
              <span className="ver-hero__name">{latestSnapshot?.id ?? '—'}</span>
              <span className="ver-hero__meta">{latestSnapshot ? `发布于 ${formatReleaseDate(latestSnapshot.releaseTime)}` : '清单不可用'}</span>
            </span>
            <Icon name="chevron-right" className="ico ico--sm subtle" />
          </button>
        </div>

        <div className="ver-list" role="listbox" aria-label="Minecraft 版本">
          {tabVersions.length === 0 ? (
            <div className="ver-list__empty">
              {manifest.status === 'loading' ? '正在读取版本清单…' : '这个分类下没有可显示的版本'}
            </div>
          ) : (
            tabVersions.map((version) => (
              <button
                key={version.id}
                type="button"
                role="option"
                aria-selected={versionId === version.id}
                className={`ver-row${versionId === version.id ? ' is-active' : ''}`}
                onClick={() => pickVersion(version.id)}
              >
                <span
                  className={`ver-row__icon${version.type === 'snapshot' ? ' ver-row__icon--snap' : ''}`}
                  aria-hidden="true"
                />
                <span className="ver-row__main">
                  <span className="ver-row__name">{version.id}</span>
                  <span className="ver-row__meta">
                    {formatReleaseDate(version.releaseTime)} · {versionTypeLabel(version.type)}
                  </span>
                </span>
              </button>
            ))
          )}
        </div>
      </div>

      <div className="download-grid">
        <Card className="install-card">
          <div className="tabs install-type-tabs" role="tablist" aria-label="安装类型">
            {TYPES.map((option) => (
              <button
                className={`tab${type === option.value ? ' is-active' : ''}`}
                key={option.value}
                type="button"
                role="tab"
                aria-selected={type === option.value}
                onClick={() => setType(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>

          {!typeInfo?.supported ? (
            <Banner tone="warning" title={`${typeInfo?.label ?? '加载器'} 安装器尚未接入`} icon="flask">
              当前 download 契约只实现原版安装。加载器选项和视觉位置已保留，但不会生成示例安装任务；接入 installer 后在这里回显真实阶段进度。
            </Banner>
          ) : null}
          {loaderInfo ? (
            <Banner tone="warning" title={`${typeInfo?.label ?? '加载器'} 清单不可用`} icon="flask">
              {loaderInfo.detail}
            </Banner>
          ) : null}

          <div className="form-grid">
            <Field
              label="Minecraft 版本"
              hint={manifestInfo ? `版本清单不可用：${manifestInfo.title}` : selected ? `${selected.type} · ${selected.releaseTime ? new Date(selected.releaseTime).toLocaleDateString('zh-CN') : '发布日期未知'}` : '从真实 manifest 选择'}
            >
              <Select
                aria-label="Minecraft 版本"
                value={versionId}
                onChange={(event) => { setVersionId(event.target.value); setPlan(null); setPlanError(null) }}
                disabled={manifest.status !== 'ready'}
              >
                <option value="">{manifest.status === 'loading' ? '正在读取版本清单…' : manifestInfo ? '版本清单不可用' : '选择一个版本'}</option>
                {versions.map((version) => <option key={version.id} value={version.id}>{versionLabel(version)}</option>)}
              </Select>
            </Field>
            <Field label="实例名称" hint="原版 install 只写入 versions；实例创建需要 instance 模块，当前不伪造名称。">
              <input className="input" value="" disabled placeholder="安装后由实例模块创建" />
            </Field>
            <Field
              label={`${typeInfo?.label ?? '加载器'} 版本`}
              hint={type === 'vanilla'
                ? '原版无需加载器版本'
                : loaderChoice
                  ? `${loaderChoice.stable ? '稳定' : '测试'}${loaderChoice.recommended ? ' · 推荐' : ''} · ${loaderChoice.installer ? `安装器 ${loaderChoice.installer.hashSource}` : 'meta-json'}`
                  : '来自 loader 模块的真实版本清单'}
            >
              <Select
                aria-label="加载器版本"
                value={loaderVersion}
                onChange={(event) => setLoaderVersion(event.target.value)}
                disabled={type === 'vanilla' || loaderList.status !== 'ready'}
              >
                <option value="">{type === 'vanilla' ? '原版无需加载器' : loaderList.status === 'loading' ? '正在读取…' : loaderInfo ? '清单不可用' : '选择加载器版本'}</option>
                {loaderVersions.map((version) => <option key={`${version.version}-${version.rawVersion ?? ''}`} value={version.version}>{version.version}{version.recommended ? ' · 推荐' : ''}</option>)}
              </Select>
            </Field>
            <Field label="版本隔离" hint="新安装默认隔离；实例设置落盘通道尚未接入">
              <div className="row gap-8" style={{ height: 32 }}>
                <Switch checked={isolate} onChange={setIsolate} label="版本隔离" disabled />
                <span className="caption muted">存档与模组保存在实例内</span>
              </div>
            </Field>
            <Field label="下载源" hint={sources.data ? `当前：${sources.data.activeSource ?? '自动选择'}` : '来源由 download.listSources 返回'}>
              <Select disabled aria-label="下载源">
                <option>{sources.data ? `${sources.data.preference} · ${sources.data.activeSource ?? '自动'}` : '等待下载源'}</option>
              </Select>
            </Field>
          </div>

          {loaderChoice?.installer?.hashSource === 'none' ? (
            <div className="row gap-8" style={{ marginTop: 10 }}>
              <Switch checked={allowUnverified} onChange={setAllowUnverified} label="允许无上游哈希的安装器" />
              <span className="caption subtle">该安装器没有可校验 SHA1；SEC-EXE-05 要求显式同意。</span>
            </div>
          ) : null}

          <div className="auto-java-row" style={{ marginTop: 14 }}>
            <div className="auto-java-row__text">
              {java.status === 'ready'
                ? <><strong>{java.data?.candidates.length ?? 0} 个 Java 候选</strong> · 真实探测结果</>
                : java.status === 'loading' ? '正在探测 Java…' : <><strong>Java 检测尚未接入</strong><br /><span className="subtle">{javaInfo?.detail ?? '等待 java 模块通道'}</span></>}
            </div>
            <Button size="xs" variant="ghost" onClick={java.reload} disabled={java.status === 'loading'}>重新探测</Button>
          </div>

          <div className="summary-strip">
            <span className="meta-chip"><Icon name="download" />文件：{selected ? '待生成计划' : '—'}</span>
            <span className="meta-chip"><Icon name="folder" />空间：{selected ? '待 plan' : '—'}</span>
            <span className="meta-chip"><Icon name="network" />源：{sources.data?.activeSource ?? '—'}</span>
          </div>

          <div className="install-actions">
            <Button variant="primary" size="lg" icon="download" disabled={!canInstall || busy} loading={busy} onClick={() => void install()} title={canInstall ? '开始真实安装' : '先选择版本并等待版本/加载器清单'}>
              开始安装
            </Button>
            <Button variant="secondary" size="lg" icon="search" disabled={!versionId || planBusy || type !== 'vanilla'} loading={planBusy} onClick={() => void previewPlan()}>
              检查安装计划
            </Button>
            <span className="caption subtle">
              {canInstall
                ? type === 'vanilla'
                  ? `将安装 ${selected?.id ?? ''}；进度来自 download 事件`
                  : `将通过 loader 安装 ${typeInfo?.label} ${loaderVersion}；阶段来自 loader 事件`
                : '版本与加载器清单就绪后启用'}
            </span>
          </div>

          {planError ? <div className="nw-inline-error">{planError.title}：{planError.detail}</div> : null}
          {plan ? (
            <div className="nw-plan">
              <div className="nw-plan__head"><strong><Icon name="package" /> 安装计划 · {plan.versionId}</strong><Badge tone="outline">dry-run</Badge></div>
              <div className="nw-plan__meta">
                <span>文件 {plan.files}（缺 {plan.missingFiles}）</span>
                <span>总大小 {formatBytes(plan.bytes)}</span>
                <span>需下载 {formatBytes(plan.missingBytes)}</span>
                <span>依赖库 {plan.libraries.allowed}/{plan.libraries.total}</span>
                <span>资源 {plan.assets.objects}</span>
              </div>
            </div>
          ) : null}

          {actionError ? <div className="nw-inline-error">{actionError.title}：{actionError.detail}{actionError.channel ? `（${actionError.channel}）` : ''}</div> : null}
          {loaderError ? <div className="nw-inline-error">{loaderError.title}：{loaderError.detail}</div> : null}
        </Card>

        <Card className="task-panel">
          <div className="task-panel__head">
            <div>
              <div className="task-panel__title">{loaderProgress ? '加载器安装任务' : '下载任务'}</div>
              <div className="task-panel__sub">
                {loaderProgress ? <>来自 <code className="mono">mc:loader:evt:progress</code> 与 log 事件</> : <>来自 <code className="mono">mc:download:list</code> 与 progress 事件</>}
              </div>
            </div>
            <Badge tone={loaderProgress ? (loaderProgress.state === 'failed' ? 'danger' : loaderProgress.state === 'done' ? 'success' : 'accent') : tasksPending ? 'warning' : mergedTasks.length ? 'accent' : 'outline'} dot>
              {loaderProgress ? loaderProgress.state : tasksPending ? '未接入' : `${mergedTasks.length} 个`}
            </Badge>
          </div>

          {loaderProgress ? (
            <div className="nw-task-card" style={{ marginTop: 12 }}>
              <div className="nw-task-card__head">
                <div>
                  <div className="nw-task-card__title">{loaderProgress.type} {loaderProgress.loaderVersion}<Tag>{loaderProgress.mcVersion}</Tag></div>
                  <div className="nw-task-card__sub">{loaderProgress.stage} · {loaderProgress.currentTask ?? '等待安装器输出'}</div>
                </div>
                <Badge tone={loaderProgress.state === 'failed' ? 'danger' : loaderProgress.state === 'done' ? 'success' : 'accent'}>{loaderProgress.state}</Badge>
              </div>
              <Progress value={loaderProgress.percent} label="加载器安装进度" />
              <div className="nw-task-card__stats">
                <span>进度 {loaderProgress.percent === null ? '由安装器输出决定' : `${Math.round(loaderProgress.percent)}%`}</span>
                <span>{loaderProgress.message ?? '—'}</span>
              </div>
              {loaderLines.length ? <pre className="nw-loader-log">{loaderLines.join('\n')}</pre> : null}
            </div>
          ) : null}

          {tasks.status === 'loading' ? (
            <div className="nw-stack"><Skeleton className="skeleton--text" /><Skeleton className="skeleton--text" style={{ width: '70%' }} /></div>
          ) : tasksInfo ? (
            <DataStateNotice info={tasksInfo} onRetry={tasks.reload} />
          ) : mergedTasks.length === 0 ? (
            <div className="nw-task-placeholder">
              <Icon name="download" />
              <strong>当前没有下载任务</strong>
              <p>选择版本并点击“开始安装”后，进度事件会在这里显示总量、速度与当前文件；不会用示例任务填充。</p>
              <div className="nw-task-slot"><span>总量 / 速度 / 当前文件</span><span>等待真实任务</span></div>
            </div>
          ) : (
            <div className="nw-task-list">
              {mergedTasks.map((task) => (
                <TaskCard
                  key={task.jobId}
                  progress={task}
                  onPause={() => void backend.downloads.pause(task.jobId).then(tasks.reload).catch((cause) => setActionError(describeError(cause)))}
                  onResume={() => void backend.downloads.resume(task.jobId).then(tasks.reload).catch((cause) => setActionError(describeError(cause)))}
                  onCancel={() => void backend.downloads.cancel(task.jobId).then(tasks.reload).catch((cause) => setActionError(describeError(cause)))}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card className="queue-card" pad={false}>
        <div className="card__head" style={{ padding: '14px 14px 0' }}>
          <div>
            <h2 className="card__title">版本清单</h2>
            <div className="card__sub">真实 manifest 条目；不含示例版本。</div>
          </div>
          <Button size="xs" variant="ghost" onClick={manifest.reload} disabled={manifest.status === 'loading'}>重新获取</Button>
        </div>
        {manifest.status === 'ready' && versions.length > 0 ? (
          <div className="nw-version-list">
            {versions.slice(0, 12).map((version) => (
              <button key={version.id} type="button" className={`nw-version-row${version.id === versionId ? ' is-selected' : ''}`} onClick={() => setVersionId(version.id)}>
                <span className="mono">{version.id}</span>
                <Tag>{version.type}</Tag>
                <span className="muted">{version.releaseTime ? new Date(version.releaseTime).toLocaleDateString('zh-CN') : '—'}</span>
                {version.sha1 ? <Badge tone="success">有校验</Badge> : <Badge tone="outline">无哈希</Badge>}
              </button>
            ))}
          </div>
        ) : (
          <div style={{ padding: '0 14px 14px' }}>
            <EmptyState
              icon="download"
              title={manifest.status === 'loading' ? '正在读取版本清单…' : '版本清单不可用'}
              description={manifestInfo?.detail ?? 'download 模块返回空清单。'}
              actions={<Button size="sm" variant="secondary" icon="refresh" onClick={manifest.reload}>重新获取</Button>}
            />
          </div>
        )}
      </Card>

      <div className="nw-context-note">
        <Icon name="info" />
        <span>原版安装由 t8 download 模块提供，加载器由 loader 模块安装（Forge/NeoForge 执行官方 installer，Fabric/Quilt 走 meta-json）；所有进度/速度/当前文件均来自真实事件或 plan，不使用示例值。</span>
      </div>
    </>
  )
}
