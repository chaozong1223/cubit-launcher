import { useEffect, useMemo, useState } from 'react'
import type { InstanceSummary } from '@shared/instance'
import type { RepairFinished, RepairProgress, RepairReport } from '@shared/repair'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { useInstanceRunning } from '../data/useInstanceRunning'
import { navigate, useRoute } from '../router'
import { useInstanceSettingsDraft } from '../data/useInstanceSettingsDraft'
import { Badge, Button, Card, DataStateNotice, EmptyState, InstanceStateBadge, Skeleton, Tag, Tabs } from '../ui'
import { Icon } from '../icons'
import { ModsPanel } from './ModsPanel'
import { DeleteInstanceDialog } from './DeleteInstanceDialog'
import { InstanceSettingsFields } from './InstanceSettingsFields'

type DetailTab = 'overview' | 'mods' | 'resourcepacks' | 'shaders' | 'settings' | 'export'

const TABS: ReadonlyArray<{ value: DetailTab; label: string }> = [
  { value: 'overview', label: '概览' },
  { value: 'mods', label: '模组' },
  { value: 'resourcepacks', label: '资源包' },
  { value: 'shaders', label: '光影' },
  { value: 'settings', label: '设置' },
  { value: 'export', label: '导出' },
]

function tabFromSection(section: string | undefined): DetailTab {
  return TABS.some((tab) => tab.value === section) ? (section as DetailTab) : 'overview'
}

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

function RepairPanel({ versionId }: { versionId: string }) {
  const backend = useBackend()
  const [jobId, setJobId] = useState<string | null>(null)
  const [progress, setProgress] = useState<RepairProgress | null>(null)
  const [report, setReport] = useState<RepairReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onFinished = (event: RepairFinished) => {
      setProgress(null)
      setJobId(null)
      if (event.ok && event.report) setReport(event.report)
      else if (event.error) setError(event.error.message)
    }
    const offs = [
      backend.repair.subscribeScanProgress((next) => { setProgress(next); setJobId(next.jobId) }),
      backend.repair.subscribeRepairProgress((next) => { setProgress(next); setJobId(next.jobId) }),
      backend.repair.subscribeScanFinished(onFinished),
      backend.repair.subscribeRepairFinished(onFinished),
    ]
    return () => offs.forEach((off) => off())
  }, [backend])

  const start = async (kind: 'scan' | 'repair') => {
    setBusy(true)
    setError(null)
    setReport(null)
    try {
      const result = kind === 'scan'
        ? await backend.repair.scan(versionId, 'size')
        : await backend.repair.repair(versionId, 'size')
      setJobId(result.jobId)
    } catch (cause) {
      setError(describeError(cause).detail)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="info-card" style={{ marginTop: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h3>实例完整性</h3>
        <Badge tone={report ? (report.ok ? 'success' : 'warning') : 'outline'}>
          {report ? (report.ok ? '校验通过' : `${report.counts.missing} 缺失 / ${report.counts.corrupt} 损坏`) : '未检查'}
        </Badge>
      </div>
      {jobId ? (
        <div className="nw-launch-progress" style={{ marginTop: 10 }}>
          <span className="spinner" />
          {progress ? `${progress.stage} · ${progress.done}/${progress.total} · ${progress.percent === null ? '—' : `${Math.round(progress.percent)}%`}` : '任务已提交…'}
        </div>
      ) : null}
      {error ? <div className="nw-inline-error">{error}</div> : null}
      {report ? (
        <div className="info-list">
          <div className="info-row"><span className="info-row__label">已检查</span><span className="info-row__value">{report.counts.checked} 个文件 · {report.counts.bytesChecked} B</span></div>
          <div className="info-row"><span className="info-row__label">缺失 / 损坏</span><span className="info-row__value">{report.counts.missing} / {report.counts.corrupt}</span></div>
          <div className="info-row"><span className="info-row__label">额外文件</span><span className="info-row__value">{report.counts.extra}（不会被删除）</span></div>
        </div>
      ) : <p className="hint">只校验版本 metadata 拥有的 client/libraries/assets；不会动 mods、存档或配置。</p>}
      <div className="row gap-8" style={{ marginTop: 10 }}>
        <Button size="sm" variant="secondary" icon="shield" onClick={() => void start('scan')} disabled={busy || Boolean(jobId)}>校验文件</Button>
        <Button size="sm" variant="primary" icon="refresh" onClick={() => void start('repair')} disabled={busy || Boolean(jobId)}>修复缺失</Button>
      </div>
    </Card>
  )
}

function Overview({ instance }: { instance: InstanceSummary }) {
  const ready = instance.state === 'ready'
  return (
    <div className="detail-panel is-active">
      <div className={`banner ${ready ? 'banner--success' : 'banner--warning'}`}>
        <Icon name={ready ? 'shield' : 'alert'} />
        <div className="banner__body">
          <div className="banner__title">{ready ? '实例结构检查通过' : '实例需要处理'}</div>
          <div>{ready ? '版本 JSON、客户端 JAR 与实例元数据均可读；启动参数会在通道接入后生成。' : (instance.reason ?? '实例文件不完整，暂时不能启动。')}</div>
        </div>
      </div>

      <div className="stat-grid">
        <div className="card stat-card"><div className="stat-card__label">游戏版本</div><div className="stat-card__value mono">{instance.mcVersion ?? '—'}</div><div className="stat-card__sub">来自版本 JSON</div></div>
        <div className="card stat-card"><div className="stat-card__label">加载器</div><div className="stat-card__value">{instance.loader.type}</div><div className="stat-card__sub">{instance.loader.version ?? '版本未知'}</div></div>
        <div className="card stat-card"><div className="stat-card__label">状态</div><div className="stat-card__value"><InstanceStateBadge state={instance.state} /></div><div className="stat-card__sub">{instance.reason ?? '可读'}</div></div>
        <div className="card stat-card"><div className="stat-card__label">Java</div><div className="stat-card__value">{instance.javaMajor ?? '—'}</div><div className="stat-card__sub">来自版本/实例要求</div></div>
      </div>

      <div className="content-grid-2">
        <Card className="info-card">
          <h3>实例目录</h3>
          <div className="path-row">
            <Icon name="folder" />
            <span>{instance.dirName}</span>
          </div>
          <div className="info-list">
            <div className="info-row"><span className="info-row__label">内部 ID</span><span className="info-row__value mono">{instance.id}</span></div>
            <div className="info-row"><span className="info-row__label">隔离</span><span className="info-row__value">{instance.isolation === 'isolated' ? '实例隔离' : '共用 .minecraft'}</span></div>
            <div className="info-row"><span className="info-row__label">最近游玩</span><span className="info-row__value">{instance.lastPlayedAt ? new Date(instance.lastPlayedAt).toLocaleString('zh-CN') : '尚未游玩'}</span></div>
          </div>
        </Card>

        <Card className="info-card">
          <h3>启动与设置</h3>
          <div className="info-list">
            <div className="info-row"><span className="info-row__label">启动按钮</span><span className="info-row__value">等待启动通道</span></div>
            <div className="info-row"><span className="info-row__label">内存 / JVM 参数</span><span className="info-row__value">实例设置尚未接入</span></div>
            <div className="info-row"><span className="info-row__label">自动进服</span><span className="info-row__value">尚未接入</span></div>
          </div>
          <div className="row gap-8" style={{ marginTop: 12 }}>
            <Button size="sm" variant="primary" icon="play" disabled title="启动通道尚未接入">启动游戏</Button>
            <Button size="sm" variant="ghost" icon="terminal" disabled title="日志通道尚未接入">查看日志</Button>
          </div>
        </Card>
      </div>

      <div className="nw-context-note">
        <Icon name="info" />
        <span>本页只显示 <code className="mono">mc:instance:get</code> 返回的真实字段；内存、JVM 参数、模组列表分别等待设置/mod 模块通道，不使用示例值。</span>
      </div>
      <RepairPanel versionId={instance.id} />
    </div>
  )
}

function UnwiredTab({ tab }: { tab: DetailTab }) {
  const feature = tab === 'settings' ? '实例设置' : tab === 'mods' ? '模组列表' : tab === 'resourcepacks' ? '资源包列表' : '光影列表'
  const channel = tab === 'settings' ? 'mc:store:settings' : `mc:mods:${tab}`
  return (
    <div className="detail-panel is-active">
      <DataStateNotice
        info={{
          kind: 'not-wired',
          title: `${feature}尚未接入后端`,
          detail: '当前渲染层没有该模块的 IPC 通道；保留页面结构与操作位置，等待后端接线。',
          channel,
          code: 'UI.NOT_WIRED',
          retryable: false,
          feature,
        }}
      />
    </div>
  )
}

/** Export this instance as a share pack (.cubitpack), with progress polling. */
function ExportTab({ instance }: { instance: InstanceSummary }) {
  const backend = useBackend()
  const [busy, setBusy] = useState(false)
  const [path, setPath] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async () => {
    setBusy(true)
    setError(null)
    setPath(null)
    try {
      const started = await backend.instances.exportSharePackJob(instance.id)
      for (let attempt = 0; attempt < 2400; attempt += 1) {
        const finished = await backend.instances.shareExportResult(started.jobId)
        if (finished) {
          if (finished.state === 'done' && finished.result) setPath(finished.result.path)
          else setError(`导出未完成（${finished.state}）`)
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 500))
      }
      setError('导出超时：20 分钟内没有完成')
    } catch (cause) {
      const info = describeError(cause)
      setError(`${info.title}：${info.detail}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="instance-settings-card">
      <h3>导出分享包</h3>
      <p className="muted">
        打包版本配置、Mods、资源包、光影与可选存档成单个 .cubitpack 文件。导出前会扫描并剔除账号令牌等凭据，证据写入日志。
      </p>
      <div className="instance-settings-card__footer">
        <Button variant="primary" loading={busy} disabled={busy} onClick={() => void run()}>开始导出</Button>
        {path ? <span className="instance-settings-card__saved">已导出：<code className="mono">{path}</code></span> : null}
        {error ? <span className="instance-settings-card__error">{error}</span> : null}
      </div>
    </Card>
  )
}

export function InstanceDetailPage() {
  const backend = useBackend()
  const route = useRoute()
  const id = route.id
  const detail = useAsync(() => (id ? backend.instances.get(id) : Promise.reject(new Error('缺少实例 id'))), [id])
  const [tab, setTab] = useState<DetailTab>(() => tabFromSection(route.section))

  useEffect(() => {
    setTab(tabFromSection(route.section))
  }, [route.section])
  const pendingInfo = detail.status === 'not-wired' || detail.status === 'error' ? describeError(detail.error) : null
  const instance = detail.data
  const title = useMemo(() => instance?.name ?? '实例详情', [instance])
  const running = useInstanceRunning(instance?.id ?? null)
  const settingsDraft = useInstanceSettingsDraft(instance ?? null)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<UiErrorInfo | null>(null)

  const confirmDelete = async () => {
    if (!instance) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      await backend.instances.removeInstance(instance.id)
      sessionStorage.setItem('mcl.instances.flash', `「${instance.name}」已移入回收站，可在回收站恢复。`)
      window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
      navigate('/instances')
    } catch (cause) {
      setDeleteError(describeError(cause))
    } finally {
      setDeleteBusy(false)
    }
  }

  if (detail.status === 'loading') {
    return (
      <>
        <div className="back-row"><Button variant="link" icon="arrow-left" onClick={() => navigate('/instances')}>实例</Button><span>/</span><span>加载中</span></div>
        <Card className="nw-loading"><Skeleton className="skeleton--title" style={{ width: '34%' }} /><Skeleton className="skeleton--text" style={{ width: '62%', marginTop: 12 }} /><Skeleton className="skeleton--block" style={{ height: 100, marginTop: 18 }} /></Card>
      </>
    )
  }

  if (pendingInfo || !instance) {
    return (
      <>
        <div className="back-row"><Button variant="link" icon="arrow-left" onClick={() => navigate('/instances')}>实例</Button><span>/</span><span>{title}</span></div>
        <DataStateNotice info={pendingInfo ?? {
          kind: 'error', title: '实例不存在', detail: `没有找到 id 为 ${id ?? '（空）'} 的实例。`, code: 'INSTANCE.NOT_FOUND', retryable: false,
        }} onRetry={detail.reload} />
        <div style={{ marginTop: 12 }}><Button variant="secondary" icon="arrow-left" onClick={() => navigate('/instances')}>返回实例列表</Button></div>
      </>
    )
  }

  return (
    <>
      <div className="back-row">
        <Button variant="link" icon="arrow-left" onClick={() => navigate('/home')}>主页</Button>
        <span>/</span>
        <span>{instance.name}</span>
      </div>

      <div className="card detail-head">
        <span className="icon-tile icon-tile--vanilla icon-tile--lg" aria-hidden="true"><Icon name="cube" className="ico" /></span>
        <div className="detail-head__text">
          <h1>{instance.name}</h1>
          <div className="detail-head__tags">
            {loaderTag(instance)}
            <Tag>{instance.mcVersion ?? '版本未知'}</Tag>
            <InstanceStateBadge state={instance.state} />
          </div>
          <div className="detail-meta">
            <span className="meta-chip"><Icon name="folder" />{instance.dirName}</span>
            <span className="meta-chip"><Icon name="clock" />{instance.lastPlayedAt ? new Date(instance.lastPlayedAt).toLocaleString('zh-CN') : '尚未游玩'}</span>
            <span className="meta-chip"><Icon name="coffee" />Java {instance.javaMajor ?? '—'}</span>
          </div>
        </div>
        <div className="detail-actions">
          <Button variant="primary" size="lg" icon="play" disabled title="启动通道尚未接入">启动游戏</Button>
          <Button variant="secondary" size="lg" icon="folder" disabled title="文件操作通道尚未接入">打开文件夹</Button>
          <Button
            variant="danger-ghost"
            size="lg"
            icon="trash"
            disabled={running}
            title={running ? '游戏运行中，不能删除；请先结束游戏' : '移入回收站'}
            onClick={() => { setDeleteError(null); setDeleteOpen(true) }}
          >
            删除实例
          </Button>
          <Button variant="ghost" size="lg" icon="more" onClick={() => setTab('settings')} />
          {running ? <span className="detail-delete-hint">运行中，删除已禁用</span> : null}
        </div>
      </div>

      <div className="card detail-tabs-card">
        <Tabs value={tab} options={TABS} onChange={setTab} ariaLabel="实例分区" />
      </div>

      {tab === 'overview' ? <Overview instance={instance} /> : null}
      {tab === 'mods' ? <ModsPanel instanceId={instance.id} kind="mods" /> : null}
      {tab === 'resourcepacks' ? <ModsPanel instanceId={instance.id} kind="resourcepacks" /> : null}
      {tab === 'shaders' ? <ModsPanel instanceId={instance.id} kind="shaderpacks" /> : null}
      {tab === 'settings' ? (
        settingsDraft ? (
          <Card className="instance-settings-card">
            <InstanceSettingsFields draft={settingsDraft} />
            <div className="instance-settings-card__footer">
              <Button variant="primary" loading={settingsDraft.saving} disabled={settingsDraft.saving} onClick={() => void settingsDraft.save()}>
                保存设置
              </Button>
              {settingsDraft.saveError ? <span className="instance-settings-card__error">{settingsDraft.saveError.title}：{settingsDraft.saveError.detail}</span> : null}
              {settingsDraft.savedAt ? <span className="instance-settings-card__saved">已保存</span> : null}
            </div>
          </Card>
        ) : (
          <UnwiredTab tab="settings" />
        )
      ) : null}
      {tab === 'export' ? <ExportTab instance={instance} /> : null}

      <DeleteInstanceDialog
        instance={deleteOpen ? instance : null}
        running={running}
        busy={deleteBusy}
        error={deleteError}
        onCancel={() => { setDeleteOpen(false); setDeleteError(null) }}
        onConfirm={() => void confirmDelete()}
      />
    </>
  )
}
