import { useEffect, useState } from 'react'
import type { BatchTrashResult, BackupResult } from '@shared/assets'
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
import { InstancePicker } from './InstancePicker'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function SavesPage() {
  const backend = useBackend()
  const selection = useInstanceSelection()
  const { selected } = selection
  const saves = useAsync(
    () => selected ? backend.assets.listSaves(selected.id) : Promise.resolve(null),
    [selected?.id],
  )
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [backup, setBackup] = useState<BackupResult | null>(null)
  const [deleted, setDeleted] = useState<BatchTrashResult | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)

  useEffect(() => {
    setChosen(new Set())
    setConfirming(false)
    setBackup(null)
    setDeleted(null)
    setError(null)
  }, [selected?.id])

  useEffect(() => {
    const off = backend.assets.subscribeChanged((event) => {
      if (event.area === 'saves') saves.reload()
    })
    return off
  }, [backend, saves.reload])

  const instanceId = selected?.id ?? ''
  const rows = saves.data?.saves ?? []

  const backupOne = async (name: string) => {
    if (!instanceId) return
    setBusy(`backup:${name}`)
    setError(null)
    setBackup(null)
    try {
      setBackup(await backend.assets.backupSave(instanceId, name))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  const removeChosen = async () => {
    if (!instanceId || chosen.size === 0) return
    setConfirming(false)
    setBusy('delete')
    setError(null)
    setDeleted(null)
    try {
      const result = await backend.assets.deleteSaves(instanceId, [...chosen])
      setDeleted(result)
      setChosen(new Set())
      saves.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  const openFolder = () => {
    if (!instanceId) return
    void backend.assets.openFolder(instanceId, 'saves').catch((cause) => setError(describeError(cause)))
  }

  return (
    <>
      <PageHeader
        title="存档"
        subtitle="世界列表来自实例的 saves/ 目录；删除只会移入回收站，不提供永久删除。"
        actions={<Button variant="secondary" icon="folder" onClick={openFolder} disabled={!selected}>打开存档目录</Button>}
      />

      <InstancePicker selection={selection} onRefresh={selection.instances.reload} hint="存档列表、备份和删除都只作用于当前实例的 saves/。" />

      {saves.status === 'not-wired' || saves.status === 'error' ? (
        <DataStateNotice info={describeError(saves.error)} onRetry={saves.reload} />
      ) : null}
      {error ? <div className="nw-inline-error" role="alert">{error.title}：{error.detail}</div> : null}
      {backup ? (
        <Banner tone="success" title="存档已备份">
          已生成 zip：<span className="mono">{backup.path}</span>（{backup.files} 个文件，{formatBytes(backup.bytes)}）。
        </Banner>
      ) : null}
      {deleted ? (
        <Banner tone={deleted.errors.length ? 'warning' : 'success'} title={`已移入回收站 ${deleted.items.length} 项`}>
          {deleted.errors.length ? `失败 ${deleted.errors.length} 项：${deleted.errors.map((entry) => `${entry.name}（${entry.message}）`).join('；')}` : '可在「回收站」页逐条或一键恢复。'}
        </Banner>
      ) : null}
      {confirming ? (
        <Banner
          tone="warning"
          title={`确认移入回收站 ${chosen.size} 个世界？`}
          actions={(
            <>
              <Button size="sm" variant="danger-ghost" icon="trash" loading={busy === 'delete'} onClick={() => void removeChosen()}>确认移入回收站</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>取消</Button>
            </>
          )}
        >
          删除只会把世界目录移入回收站，不提供永久删除；之后可在回收站恢复。
        </Banner>
      ) : null}

      <Card className="asset-table-card" pad={false}>
        <div className="asset-table-card__head">
          <div>
            <h2>世界列表</h2>
            <span>{saves.data?.gameDir ?? '读取实例目录中'} · {rows.length} 个世界</span>
          </div>
          <div className="row gap-8">
            {chosen.size > 0 ? (
              <>
                <Button size="sm" variant="secondary" icon="close" onClick={() => setChosen(new Set())}>取消选择</Button>
                <Button size="sm" variant="danger-ghost" icon="trash" loading={busy === 'delete'} onClick={() => setConfirming(true)}>移入回收站（{chosen.size}）</Button>
              </>
            ) : <Badge tone="outline">删除可恢复</Badge>}
            <Button size="sm" variant="ghost" icon="refresh" onClick={saves.reload}>重新读取</Button>
          </div>
        </div>

        {saves.status === 'loading' ? (
          <div className="nw-stack" style={{ padding: 16 }}>
            <Skeleton className="skeleton--text" style={{ width: '42%' }} />
            <Skeleton className="skeleton--text" style={{ width: '72%' }} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            icon="cube"
            title={selected ? '还没有世界' : '先选择实例'}
            description={selected ? '进入游戏创建世界后，saves/ 下的目录会出现在这里。' : '没有实例时不会读取或伪造存档。'}
          />
        ) : (
          <table className="table asset-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    aria-label="选择全部世界"
                    checked={rows.length > 0 && rows.every((row) => chosen.has(row.name))}
                    onChange={(event) => setChosen(event.target.checked ? new Set(rows.map((row) => row.name)) : new Set())}
                  />
                </th>
                <th>世界</th>
                <th>大小</th>
                <th>修改时间</th>
                <th>图标</th>
                <th className="num">操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((save) => (
                <tr key={save.name}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`选择 ${save.name}`}
                      checked={chosen.has(save.name)}
                      onChange={(event) => {
                        const next = new Set(chosen)
                        if (event.target.checked) next.add(save.name)
                        else next.delete(save.name)
                        setChosen(next)
                      }}
                    />
                  </td>
                  <td>
                    <div className="asset-name">
                      <span className="asset-name__icon"><Icon name="cube" /></span>
                      <strong>{save.name}</strong>
                    </div>
                  </td>
                  <td className="num">{formatBytes(save.size)}</td>
                  <td>{formatTime(save.modifiedAt)}</td>
                  <td><Badge tone={save.hasIcon ? 'success' : 'outline'}>{save.hasIcon ? '有 icon.png' : '无图标'}</Badge></td>
                  <td className="row-actions">
                    <Button size="xs" variant="secondary" icon="upload" loading={busy === `backup:${save.name}`} onClick={() => void backupOne(save.name)}>备份 zip</Button>
                    <Button size="xs" variant="ghost" icon="folder" onClick={() => { if (instanceId) void backend.assets.showInFolder(instanceId, 'save', save.name).catch((cause) => setError(describeError(cause))) }}>在文件夹显示</Button>
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
