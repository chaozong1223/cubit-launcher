import { useEffect, useState } from 'react'
import type { BatchTrashResult, ScreenshotEntry } from '@shared/assets'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { useInstanceSelection } from '../data/useInstanceSelection'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  EmptyState,
  PageHeader,
  Skeleton,
} from '../ui'
import { Icon } from '../icons'
import { navigate } from '../router'
import { InstancePicker } from './InstancePicker'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function ShotCard({
  shot,
  instanceId,
  chosen,
  onToggle,
  onError,
}: {
  shot: ScreenshotEntry
  instanceId: string
  chosen: boolean
  onToggle: (next: boolean) => void
  onError: (error: UiErrorInfo) => void
}) {
  const backend = useBackend()
  const preview = useAsync(() => backend.assets.previewScreenshot(instanceId, shot.name), [instanceId, shot.name])
  const open = () => {
    void backend.assets.openFile(instanceId, 'screenshot', shot.name).catch((cause) => onError(describeError(cause)))
  }
  const show = () => {
    void backend.assets.showInFolder(instanceId, 'screenshot', shot.name).catch((cause) => onError(describeError(cause)))
  }
  return (
    <article className={`asset-shot${chosen ? ' is-selected' : ''}`}>
      <div className="asset-shot__preview">
        {preview.status === 'loading' ? <Skeleton className="skeleton--block" style={{ width: '100%', height: '100%' }} /> : null}
        {preview.status === 'ready' && preview.data ? (
          <img src={preview.data.dataUrl} alt={shot.name} onClick={open} />
        ) : null}
        {preview.status === 'error' || preview.status === 'not-wired' ? (
          <div className="asset-shot__preview-error"><Icon name="alert-circle" /><span>{describeError(preview.error).title}</span></div>
        ) : null}
        <label className="asset-shot__check">
          <input type="checkbox" checked={chosen} onChange={(event) => onToggle(event.target.checked)} aria-label={`选择 ${shot.name}`} />
        </label>
        <div className="asset-shot__hover">
          <Button size="xs" variant="secondary" icon="external" onClick={open}>打开</Button>
          <Button size="xs" variant="ghost" icon="folder" onClick={show}>在文件夹显示</Button>
        </div>
      </div>
      <div className="asset-shot__meta">
        <strong title={shot.name}>{shot.name}</strong>
        <span>{formatBytes(shot.size)} · {formatTime(shot.modifiedAt)}</span>
      </div>
    </article>
  )
}

export function ScreenshotsPage({ initialInstanceId }: { initialInstanceId?: string } = {}) {
  const backend = useBackend()
  const selection = useInstanceSelection(initialInstanceId)
  const { selected } = selection
  const screenshots = useAsync(
    () => selected ? backend.assets.listScreenshots(selected.id) : Promise.resolve(null),
    [selected?.id],
  )
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deleted, setDeleted] = useState<BatchTrashResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)

  useEffect(() => {
    setChosen(new Set())
    setConfirming(false)
    setDeleted(null)
    setError(null)
  }, [selected?.id])

  useEffect(() => {
    const off = backend.assets.subscribeChanged((event) => {
      if (event.area === 'screenshots') screenshots.reload()
    })
    return off
  }, [backend, screenshots.reload])

  const instanceId = selected?.id ?? ''
  const shots = screenshots.data?.screenshots ?? []

  const openFolder = () => {
    if (!instanceId) return
    void backend.assets.openFolder(instanceId, 'screenshots').catch((cause) => setError(describeError(cause)))
  }

  const purgeChosen = async () => {
    if (!instanceId || chosen.size === 0) return
    const count = chosen.size
    if (!window.confirm(`永久删除 ${count} 张截图？不会进入回收站，此操作不可撤销。`)) return
    setConfirming(false)
    setBusy(true)
    setError(null)
    setDeleted(null)
    try {
      const result = await backend.assets.purgeScreenshots(instanceId, [...chosen])
      setNotice(`已永久删除 ${result.deleted.length} 张截图${result.errors.length > 0 ? `，${result.errors.length} 张失败` : ''}`)
      setChosen(new Set())
      screenshots.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const removeChosen = async () => {
    if (!instanceId || chosen.size === 0) return
    setConfirming(false)
    setBusy(true)
    setError(null)
    setDeleted(null)
    try {
      const result = await backend.assets.deleteScreenshots(instanceId, [...chosen])
      setDeleted(result)
      setChosen(new Set())
      screenshots.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="back-row">
        <Button variant="link" icon="arrow-left" onClick={() => navigate('/home')}>主页</Button>
        <span>/</span>
        <span>截图</span>
      </div>
      <PageHeader
        title={selected ? `截图 · ${selected.name}` : '截图'}
        subtitle="截图网格来自当前实例的 screenshots/；缩略图由主进程读取并返回 data URL，不伪造占位图片。"
        actions={<Button variant="secondary" icon="folder" onClick={openFolder} disabled={!selected}>打开截图目录</Button>}
      />

      {screenshots.status === 'not-wired' || screenshots.status === 'error' ? (
        <DataStateNotice info={describeError(screenshots.error)} onRetry={screenshots.reload} />
      ) : null}
      {error ? <div className="nw-inline-error" role="alert">{error.title}：{error.detail}</div> : null}
      {deleted ? (
        <Banner tone={deleted.errors.length ? 'warning' : 'success'} title={`已移入回收站 ${deleted.items.length} 张截图`}>
          {deleted.errors.length ? `失败 ${deleted.errors.length} 张：${deleted.errors.map((entry) => `${entry.name}（${entry.message}）`).join('；')}` : '可在「回收站」页恢复。'}
        </Banner>
      ) : null}
      {notice ? <Banner tone="success" title={notice} /> : null}
      {confirming ? (
        <Banner
          tone="warning"
          title={`确认删除 ${chosen.size} 张截图？`}
          actions={(
            <>
              <Button size="sm" variant="secondary" icon="trash" loading={busy} onClick={() => void removeChosen()}>移入回收站</Button>
              <Button size="sm" variant="danger-ghost" icon="trash" loading={busy} onClick={() => void purgeChosen()}>永久删除</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>取消</Button>
            </>
          )}
        >
          「移入回收站」可从回收站恢复；「永久删除」直接抹掉文件，不可撤销（会再确认一次）。
        </Banner>
      ) : null}

      <Card className="asset-gallery-card" pad={false}>
        <div className="asset-table-card__head">
          <div>
            <h2>截图网格</h2>
            <span>{screenshots.data?.gameDir ?? '读取实例目录中'} · {shots.length} 张</span>
          </div>
          <div className="row gap-8">
            {chosen.size > 0 ? (
              <>
                <Button size="sm" variant="secondary" icon="close" onClick={() => setChosen(new Set())}>取消选择</Button>
                <Button size="sm" variant="danger-ghost" icon="trash" loading={busy} onClick={() => setConfirming(true)}>移入回收站（{chosen.size}）</Button>
              </>
            ) : <Badge tone="outline">批量删除可恢复</Badge>}
            <Button size="sm" variant="ghost" icon="refresh" onClick={screenshots.reload}>重新读取</Button>
          </div>
        </div>

        {screenshots.status === 'loading' ? (
          <div className="asset-shot-grid">
            {Array.from({ length: 6 }, (_, index) => <div className="asset-shot" key={index}><Skeleton className="skeleton--block" style={{ width: '100%', height: 130 }} /><Skeleton className="skeleton--text" style={{ width: '70%', marginTop: 8 }} /></div>)}
          </div>
        ) : shots.length === 0 ? (
          <EmptyState
            icon="cube"
            title={selected ? '还没有截图' : '先选择实例'}
            description={selected ? '游戏内截图会出现在 screenshots/ 目录。' : '没有实例时不会伪造截图。'}
          />
        ) : (
          <div className="asset-shot-grid">
            {shots.map((shot) => (
              <ShotCard
                key={shot.name}
                shot={shot}
                instanceId={instanceId}
                chosen={chosen.has(shot.name)}
                onError={setError}
                onToggle={(next) => {
                  const updated = new Set(chosen)
                  if (next) updated.add(shot.name)
                  else updated.delete(shot.name)
                  setChosen(updated)
                }}
              />
            ))}
          </div>
        )}
      </Card>
    </>
  )
}
