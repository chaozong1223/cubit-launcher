import { useEffect, useState } from 'react'
import type { RestoreResult, TrashItem } from '@shared/assets'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
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

const KIND_LABEL: Record<TrashItem['kind'], string> = {
  save: '存档',
  screenshot: '截图',
  log: '日志',
  other: '其它',
}

function isInstanceItem(item: TrashItem): boolean {
  return item.kind === 'other' && item.instanceId !== null
}

function itemKindLabel(item: TrashItem): string {
  return isInstanceItem(item) ? '实例' : KIND_LABEL[item.kind]
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function TrashPage() {
  const backend = useBackend()
  const trash = useAsync(() => backend.assets.listTrash(), [])
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [result, setResult] = useState<RestoreResult | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)

  useEffect(() => {
    const off = backend.assets.subscribeChanged(() => trash.reload())
    return off
  }, [backend, trash.reload])

  const items = trash.data?.items ?? []
  const restorable = items.filter((item) => item.canRestore)
  const chosenRestorable = restorable.filter((item) => chosen.has(item.id))

  const restore = async (ids?: string[]) => {
    const targets = ids
      ? items.filter((item) => ids.includes(item.id) && item.canRestore)
      : items.filter((item) => item.canRestore)
    setBusy(ids && ids.length === 1 ? `one:${ids[0]}` : 'all')
    setError(null)
    setResult(null)
    try {
      const restored: TrashItem[] = []
      const failed: Array<{ id: string; message: string }> = []
      let restoredInstance = false
      for (const item of targets) {
        try {
          if (isInstanceItem(item)) {
            restored.push(await backend.instances.restoreInstance(item.id))
            restoredInstance = true
          } else {
            const result = await backend.assets.restoreTrash([item.id])
            restored.push(...result.restored)
            failed.push(...result.failed)
          }
        } catch (cause) {
          failed.push({ id: item.id, message: describeError(cause).detail })
        }
      }
      if (restoredInstance) window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
      setResult({ restored, failed })
      setChosen(new Set())
      trash.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <>
      <PageHeader
        title="回收站"
        subtitle="存档/截图/实例删除后的可恢复副本；这里不提供永久删除。恢复冲突会明确说明，绝不覆盖现有文件。"
        actions={<Button variant="secondary" icon="refresh" onClick={trash.reload}>刷新回收站</Button>}
      />

      <Banner tone="info" title="只恢复，不永久删除">
        回收站与原始目录分离；恢复前会检查目标路径。若原位置已有同名文件，后端会报告冲突并保持两边都不被覆盖。需要清理磁盘时请手动处理 dataRoot/trash。
      </Banner>

      {trash.status === 'not-wired' || trash.status === 'error' ? (
        <DataStateNotice info={describeError(trash.error)} onRetry={trash.reload} />
      ) : null}
      {error ? <div className="nw-inline-error" role="alert">{error.title}：{error.detail}</div> : null}
      {result ? (
        <Banner tone={result.failed.length ? 'warning' : 'success'} title={`已恢复 ${result.restored.length} 项`}>
          {result.failed.length ? `失败/冲突 ${result.failed.length} 项：${result.failed.map((entry) => `${entry.id}（${entry.message}）`).join('；')}` : '可回到相应页面查看。'}
        </Banner>
      ) : null}

      <Card className="asset-table-card" pad={false}>
        <div className="asset-table-card__head">
          <div>
            <h2>可恢复项</h2>
            <span>{items.length} 项 · {restorable.length} 项可恢复</span>
          </div>
          <div className="row gap-8">
            {chosenRestorable.length > 0 ? (
              <>
                <Button size="sm" variant="secondary" icon="close" onClick={() => setChosen(new Set())}>取消选择</Button>
                <Button size="sm" variant="primary" icon="refresh" loading={busy === 'all'} onClick={() => void restore(chosenRestorable.map((item) => item.id))}>恢复所选（{chosenRestorable.length}）</Button>
              </>
            ) : null}
            <Button size="sm" variant="primary" icon="refresh" loading={busy === 'all'} disabled={restorable.length === 0} onClick={() => void restore()}>一键恢复全部</Button>
          </div>
        </div>

        {trash.status === 'loading' ? (
          <div className="nw-stack" style={{ padding: 16 }}>
            <Skeleton className="skeleton--text" style={{ width: '45%' }} />
            <Skeleton className="skeleton--text" style={{ width: '75%' }} />
          </div>
        ) : items.length === 0 ? (
          <EmptyState icon="trash" title="回收站为空" description="在存档、截图或实例页选择“移入回收站”后，可在这里恢复；没有任何示例项。" />
        ) : (
          <table className="table asset-table">
            <thead>
              <tr>
                <th style={{ width: 40 }} aria-label="选择" />
                <th>类型</th>
                <th>名称</th>
                <th>原位置</th>
                <th>实例</th>
                <th>删除时间</th>
                <th>大小</th>
                <th className="num">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className={item.canRestore ? undefined : 'is-disabled'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={chosen.has(item.id)}
                      disabled={!item.canRestore}
                      aria-label={`选择 ${item.name}`}
                      onChange={(event) => {
                        const next = new Set(chosen)
                        if (event.target.checked) next.add(item.id)
                        else next.delete(item.id)
                        setChosen(next)
                      }}
                    />
                  </td>
                  <td><Badge tone={item.kind === 'save' || isInstanceItem(item) ? 'accent' : item.kind === 'screenshot' ? 'outline' : 'neutral'}>{itemKindLabel(item)}</Badge></td>
                  <td><div className="asset-name"><span className="asset-name__icon"><Icon name={isInstanceItem(item) ? 'cube' : item.kind === 'save' ? 'cube' : item.kind === 'screenshot' ? 'package' : 'terminal'} /></span><strong>{item.name}</strong></div></td>
                  <td className="mono asset-trash-path" title={item.originalPath}>{item.originalPath}</td>
                  <td>{item.instanceId ?? '全局'}</td>
                  <td>{formatTime(item.deletedAt)}</td>
                  <td className="num">{formatBytes(item.size)}</td>
                  <td className="row-actions">
                    {item.canRestore
                      ? <Button size="xs" variant="secondary" icon="refresh" loading={busy === `one:${item.id}`} onClick={() => void restore([item.id])}>{isInstanceItem(item) ? '恢复实例' : '恢复'}</Button>
                      : <Badge tone="danger">冲突/不可恢复</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  )
}
