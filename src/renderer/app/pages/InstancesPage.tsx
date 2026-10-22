import { useEffect, useMemo, useState } from 'react'
import type { InstanceCopyFinished, InstanceSummary } from '@shared/instance'
import { useBackend } from '../data/BackendContext'
import { BackendError, describeError, type UiErrorInfo } from '../data/backend'
import { assertJobSucceeded, waitForJob } from '../data/waitJob'
import { useAsync } from '../data/useAsync'
import { useInstanceRunning } from '../data/useInstanceRunning'
import { DeleteInstanceDialog } from './DeleteInstanceDialog'
import { MinecraftDirectoryPanel } from './MinecraftDirectoryPanel'
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
  InstanceStateBadge,
  PageHeader,
  Skeleton,
  Tag,
} from '../ui'
import { Icon } from '../icons'

type Filter = 'all' | 'ready' | 'broken'

function formatLastPlayed(ts: number | null): string {
  if (!ts) return '尚未游玩'
  const date = new Date(ts)
  return date.toLocaleDateString('zh-CN')
}

function loaderBadge(instance: InstanceSummary) {
  switch (instance.loader.type) {
    case 'forge': return <Tag variant="forge">Forge {instance.loader.version ?? ''}</Tag>
    case 'neoforge': return <Tag variant="neo">NeoForge {instance.loader.version ?? ''}</Tag>
    case 'fabric': return <Tag variant="fabric">Fabric {instance.loader.version ?? ''}</Tag>
    case 'quilt': return <Tag variant="pack">Quilt {instance.loader.version ?? ''}</Tag>
    case 'vanilla': return <Tag variant="vanilla">原版</Tag>
    default: return <Tag>未知</Tag>
  }
}

function InstanceRow({ instance, onDelete, onCopy }: { instance: InstanceSummary; onDelete: (instance: InstanceSummary) => void; onCopy: (instance: InstanceSummary) => void }) {
  const broken = instance.state !== 'ready'
  const running = useInstanceRunning(instance.id)
  return (
    <tr className={broken ? 'is-broken' : undefined}>
      <td>
        <div className="name-cell">
          <span className={broken ? 'icon-tile icon-tile--warn' : 'icon-tile icon-tile--vanilla'} aria-hidden="true">
            <Icon name={broken ? 'alert' : 'cube'} className="ico" />
          </span>
          <div className="name-cell__text">
            <button className="instance-name-btn nw-link-button" type="button" onClick={() => navigate(`/instances/${encodeURIComponent(instance.id)}`)}>
              <strong>{instance.name}</strong>
              <small>{instance.dirName}</small>
            </button>
          </div>
        </div>
      </td>
      <td><span className="mono">{instance.mcVersion ?? '—'}</span></td>
      <td>{loaderBadge(instance)}</td>
      <td><InstanceStateBadge state={instance.state} /></td>
      <td>{instance.isolation === 'isolated' ? '隔离' : '共用'}</td>
      <td>{formatLastPlayed(instance.lastPlayedAt)}</td>
      <td><Badge tone="outline">Java {instance.javaMajor ?? '—'}</Badge></td>
      <td className="row-actions">
        {running ? <Badge tone="success" dot>运行中 · 禁删</Badge> : null}
        <Button size="xs" variant="secondary" disabled title="启动按钮将在实例/启动通道接入后启用">启动</Button>
        <Button
          size="xs"
          variant="secondary"
          icon="copy"
          disabled={running || instance.isolation === 'shared'}
          title={
            instance.isolation === 'shared'
              ? '共享隔离的实例没有独立目录，无法复制'
              : '复制成一个新实例（含 mods 与配置）'
          }
          aria-label={`复制实例 ${instance.name}`}
          onClick={() => onCopy(instance)}
        >
          复制
        </Button>
        <Button
          size="xs"
          variant="danger-ghost"
          icon="trash"
          disabled={running}
          title={running ? '游戏运行中，不能删除；请先结束游戏' : '移入回收站'}
          aria-label={`删除实例 ${instance.name}`}
          onClick={() => onDelete(instance)}
        >
          删除
        </Button>
        <Button size="xs" variant="ghost" icon="chevron-right" aria-label="查看详情" onClick={() => navigate(`/instances/${encodeURIComponent(instance.id)}`)} />
      </td>
    </tr>
  )
}

export function InstancesPage() {
  const backend = useBackend()
  const system = useSystem()
  const instances = useAsync(() => backend.instances.list(), [])
  const versions = useAsync(() => backend.versions.list(), [])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [deleteTarget, setDeleteTarget] = useState<InstanceSummary | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [deleteError, setDeleteError] = useState<UiErrorInfo | null>(null)
  const [flash, setFlash] = useState<string | null>(() => sessionStorage.getItem('mcl.instances.flash'))
  const deleteRunning = useInstanceRunning(deleteTarget?.id ?? null)

  useEffect(() => {
    if (flash) sessionStorage.removeItem('mcl.instances.flash')
  }, [flash])

  const copyInstance = async (instance: InstanceSummary) => {
    const suggestion = `${instance.name} 副本`
    const input = window.prompt('把实例复制成一个新实例（包含 mods 与配置）', suggestion)
    const name = input?.trim()
    if (!name) return
    try {
      const started = await backend.instances.copyInstance(instance.id, name)
      setFlash(`正在后台复制「${started.name}」…`)
      const finished = await waitForJob<InstanceCopyFinished>({
        jobId: started.jobId,
        subscribe: backend.instances.subscribeCopyFinished,
        fetchResult: () => backend.instances.copyResult(started.jobId),
      })
      assertJobSucceeded(finished, '复制实例失败')
      const created = finished.result
      if (!created) throw new BackendError('INSTANCE.COPY_FAILED', '复制实例没有返回结果', false)
      await instances.reload()
      versions.reload()
      window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
      setFlash(`已创建副本「${created.name}」，可以直接启动或再改配置。`)
    } catch (cause) {
      setFlash(`复制失败：${describeError(cause).title ?? '未知错误'}`)
    }
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleteBusy(true)
    setDeleteError(null)
    try {
      const removed = deleteTarget
      await backend.instances.removeInstance(removed.id)
      setDeleteTarget(null)
      await instances.reload()
      versions.reload()
      window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
      setFlash(`「${removed.name}」已移入回收站，可在回收站恢复。`)
    } catch (cause) {
      setDeleteError(describeError(cause))
    } finally {
      setDeleteBusy(false)
    }
  }

  useEffect(() => {
    const refresh = () => {
      instances.reload()
      versions.reload()
    }
    const off = backend.instances.subscribeChanged(refresh)
    window.addEventListener('mcl:instances-changed', refresh)
    return () => {
      off()
      window.removeEventListener('mcl:instances-changed', refresh)
    }
  }, [backend, instances.reload, versions.reload])

  const filtered = useMemo(() => {
    if (!instances.data) return []
    const q = query.trim().toLowerCase()
    return instances.data.filter((instance) => {
      const loader = instance.loader.type.toLowerCase()
      const matchesText = !q || instance.name.toLowerCase().includes(q) || (instance.mcVersion ?? '').toLowerCase().includes(q) || loader.includes(q)
      const matchesFilter = filter === 'all' || (filter === 'ready' ? instance.state === 'ready' : instance.state !== 'ready')
      return matchesText && matchesFilter
    })
  }, [instances.data, query, filter])

  const pending = instances.status === 'not-wired' || instances.status === 'error'
  const pendingInfo = pending ? describeError(instances.error) : null
  const brokenCount = instances.data?.filter((item) => item.state !== 'ready').length ?? null

  return (
    <>
      <PageHeader
        title="实例"
        subtitle={instances.status === 'ready'
          ? `共 ${instances.data?.length ?? 0} 个实例${brokenCount ? ` · ${brokenCount} 个需要处理` : ''}`
          : '读取真实实例目录；未接入时显示明确的等待状态。'}
        actions={(
          <>
            <Button variant="secondary" icon="package" onClick={() => navigate('/download')}>导入整合包</Button>
            <Button variant="primary" icon="plus" onClick={() => navigate('/download')}>新建实例</Button>
          </>
        )}
      />

      {flash ? (
        <Banner
          tone="success"
          title="已移入回收站，可在回收站恢复"
          actions={<Button size="xs" variant="secondary" onClick={() => setFlash(null)}>关闭</Button>}
        >
          {flash}
        </Banner>
      ) : null}

      <MinecraftDirectoryPanel onImported={() => { instances.reload(); versions.reload() }} />

      <div className="toolbar">
        <div className="input-wrap search">
          <Icon name="search" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索实例、版本或加载器"
            aria-label="搜索实例"
            disabled={instances.status !== 'ready'}
          />
        </div>
        <div className="chip-group" aria-label="按状态筛选">
          <button className={`chip${filter === 'all' ? ' is-active' : ''}`} type="button" onClick={() => setFilter('all')} disabled={instances.status !== 'ready'}>全部{instances.data ? ` ${instances.data.length}` : ''}</button>
          <button className={`chip${filter === 'ready' ? ' is-active' : ''}`} type="button" onClick={() => setFilter('ready')} disabled={instances.status !== 'ready'}>就绪</button>
          <button className={`chip${filter === 'broken' ? ' is-active' : ''}`} type="button" onClick={() => setFilter('broken')} disabled={instances.status !== 'ready'}>需处理</button>
        </div>
        <div className="toolbar__spacer" />
        <Button size="sm" variant="secondary" icon="refresh" onClick={instances.reload} disabled={instances.status === 'loading'}>重新扫描</Button>
      </div>

      {system.info && instances.status === 'not-wired' ? (
        <div className="nw-meta-row">
          <Badge tone="warning" dot>实例通道未放行</Badge>
          <span className="muted">已注册模块：{system.info.modules.join(' · ') || '无'}</span>
        </div>
      ) : null}

      {instances.status === 'loading' ? (
        <Card className="nw-loading" pad>
          <Skeleton className="skeleton--title" style={{ width: '32%' }} />
          <Skeleton className="skeleton--text" style={{ width: '84%', marginTop: 16 }} />
          <Skeleton className="skeleton--text" style={{ width: '76%', marginTop: 10 }} />
          <Skeleton className="skeleton--text" style={{ width: '68%', marginTop: 10 }} />
        </Card>
      ) : pendingInfo ? (
        <DataStateNotice info={pendingInfo} onRetry={instances.reload} />
      ) : instances.data && instances.data.length === 0 ? (
        <Card>
          <EmptyState
            icon="cube"
            title="还没有实例"
            description="实例目录为空。安装一个版本或导入整合包后，这里会显示真实实例。"
            actions={<Button variant="primary" icon="download" onClick={() => navigate('/download')}>安装第一个版本</Button>}
          />
        </Card>
      ) : (
        <Card className="table-wrap instance-table-card" pad={false}>
          <table className="table">
            <thead>
              <tr>
                <th>实例</th>
                <th>游戏版本</th>
                <th>加载器</th>
                <th>状态</th>
                <th>隔离</th>
                <th>最近游玩</th>
                <th>Java</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {filtered.length > 0 ? filtered.map((instance) => <InstanceRow instance={instance} key={instance.id} onDelete={setDeleteTarget} onCopy={(target) => void copyInstance(target)} />) : (
                <tr><td colSpan={8}>
                  <EmptyState
                    icon="search"
                    title="没有匹配的实例"
                    description="清空搜索或切换筛选条件。"
                    actions={<Button size="sm" variant="secondary" onClick={() => { setQuery(''); setFilter('all') }}>清除筛选</Button>}
                  />
                </td></tr>
              )}
            </tbody>
          </table>
          <div className="table-foot">
            <span>{instances.data ? `显示 ${filtered.length} / ${instances.data.length} 个实例` : ''}</span>
            <span>数据来自 mc:instance:list</span>
          </div>
        </Card>
      )}

      <Card className="queue-card" pad={false} style={{ marginTop: 14 }}>
        <div className="card__head" style={{ padding: '14px 14px 0' }}>
          <div>
            <h2 className="card__title">本地版本库</h2>
            <div className="card__sub">来自 <code className="mono">mc:version:listVersions</code>；实例与版本是两层数据。</div>
          </div>
          <Badge tone={versions.status === 'ready' ? 'success' : versions.status === 'not-wired' ? 'warning' : 'outline'}>
            {versions.status === 'ready' ? `${versions.data?.length ?? 0} 个` : '等待'}
          </Badge>
        </div>
        {versions.status === 'loading' ? (
          <div style={{ padding: 14 }}><Skeleton className="skeleton--text" style={{ width: '70%' }} /></div>
        ) : versions.status === 'not-wired' || versions.status === 'error' ? (
          <div style={{ padding: 14 }}>
            <DataStateNotice info={describeError(versions.error)} onRetry={versions.reload} />
          </div>
        ) : versions.data && versions.data.length > 0 ? (
          <div className="nw-version-list">
            {versions.data.slice(0, 20).map((version) => (
              <div className="nw-version-row" key={version.id}>
                <span className="mono">{version.id}</span>
                <Tag variant={version.loader.type === 'vanilla' ? 'vanilla' : version.loader.type === 'forge' ? 'forge' : version.loader.type === 'neoforge' ? 'neo' : version.loader.type === 'fabric' ? 'fabric' : version.loader.type === 'quilt' ? 'pack' : 'neutral'}>
                  {version.loader.type}
                </Tag>
                <InstanceStateBadge state={version.state} />
                <span className="muted">{version.clientJarExists ? 'JAR 已就绪' : '缺客户端 JAR'}</span>
              </div>
            ))}
            {versions.data.length > 20 ? <div className="nw-version-row"><span className="muted">还有 {versions.data.length - 20} 个版本未展开</span></div> : null}
          </div>
        ) : (
          <div style={{ padding: 14 }}><EmptyState icon="download" title="版本目录为空" description="download 模块安装原版后会出现在这里。" actions={<Button size="sm" variant="secondary" onClick={() => navigate('/download')}>去安装</Button>} /></div>
        )}
      </Card>

      <DeleteInstanceDialog
        instance={deleteTarget}
        running={deleteRunning}
        busy={deleteBusy}
        error={deleteError}
        onCancel={() => { setDeleteTarget(null); setDeleteError(null) }}
        onConfirm={() => void confirmDelete()}
      />
    </>
  )
}
