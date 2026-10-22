import { useEffect, useMemo, useState } from 'react'
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
  DisabledHint,
  EmptyState,
  Input,
  PageHeader,
  Select,
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

type SaveFilter = 'all' | 'icon' | 'no-icon'

const FILTER_LABELS: Record<SaveFilter, string> = {
  all: '全部',
  icon: '有图标',
  'no-icon': '无图标',
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
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<SaveFilter>('all')

  useEffect(() => {
    setChosen(new Set())
    setConfirming(false)
    setBackup(null)
    setDeleted(null)
    setError(null)
    setQuery('')
    setFilter('all')
  }, [selected?.id])

  useEffect(() => {
    const off = backend.assets.subscribeChanged((event) => {
      if (event.area === 'saves') saves.reload()
    })
    return off
  }, [backend, saves.reload])

  const instanceId = selected?.id ?? ''
  const rows = saves.data?.saves ?? []
  const chosenName = chosen.size === 1 ? [...chosen][0] : null
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((save) => {
      const haystack = `${save.name} ${selected?.name ?? ''} ${selected?.mcVersion ?? ''} ${selected?.loader.type ?? ''}`.toLowerCase()
      const matchesQuery = !q || haystack.includes(q)
      const matchesFilter = filter === 'all' || (filter === 'icon' ? save.hasIcon : !save.hasIcon)
      return matchesQuery && matchesFilter
    })
  }, [rows, query, filter, selected?.name, selected?.mcVersion, selected?.loader.type])

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

  const backupChosen = () => {
    if (chosenName) void backupOne(chosenName)
  }

  const openChosenWorld = () => {
    if (!instanceId || !chosenName) return
    void backend.assets.openFile(instanceId, 'save', chosenName).catch((cause) => setError(describeError(cause)))
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

  const backupHint = chosen.size === 0
    ? '先勾选 1 个世界再备份'
    : chosen.size > 1
      ? '一次只能备份 1 个世界'
      : `把 ${chosenName ?? '选中的世界'} 打包成 zip`
  const openWorldHint = chosenName
    ? `打开世界目录：${chosenName}`
    : chosen.size > 1
      ? '一次只能打开 1 个世界'
      : '先勾选 1 个世界'

  return (
    <>
      <PageHeader
        title="存档"
        subtitle="世界列表来自实例的 saves/ 目录；删除只会移入回收站，不提供永久删除。"
      />

      <InstancePicker selection={selection} onRefresh={selection.instances.reload} hint="存档列表、备份和删除都只作用于当前实例的 saves/。" />

      <Card className="asset-toolbar" pad={false}>
        <div className="asset-toolbar__row">
          <div className="asset-toolbar__group" role="group" aria-label="存档操作">
            <DisabledHint hint="等「用其他版本启动」后端接入后可用（存档按版本启动，t3）">
              <Button size="sm" variant="secondary" icon="play" disabled>用其他版本启动</Button>
            </DisabledHint>
            <DisabledHint hint="等「存档复制到其他版本」后端接入后可用（t3）">
              <Button size="sm" variant="secondary" icon="copy" disabled>复制到其他版本</Button>
            </DisabledHint>
            <DisabledHint hint={backupHint}>
              <Button
                size="sm"
                variant="secondary"
                icon="upload"
                disabled={chosen.size !== 1 || busy === 'delete'}
                loading={chosenName ? busy === `backup:${chosenName}` : false}
                onClick={backupChosen}
              >
                备份
              </Button>
            </DisabledHint>
            <DisabledHint hint="等「存档分享包」导出通道接入后可用">
              <Button size="sm" variant="secondary" icon="external" disabled>分享</Button>
            </DisabledHint>
            <DisabledHint hint={chosen.size === 0 ? '先勾选要移入回收站的世界' : `移入回收站 ${chosen.size} 个世界（可恢复）`}>
              <Button
                size="sm"
                variant="danger-ghost"
                icon="trash"
                disabled={chosen.size === 0 || busy === 'delete'}
                loading={busy === 'delete'}
                onClick={() => setConfirming(true)}
              >
                删除
              </Button>
            </DisabledHint>
            <DisabledHint hint={openWorldHint}>
              <Button size="sm" variant="ghost" icon="external" disabled={chosen.size !== 1} onClick={openChosenWorld}>打开世界</Button>
            </DisabledHint>
          </div>

          <span className="toolbar__spacer" />

          <div className="asset-toolbar__group asset-toolbar__group--end">
            <div className="input-wrap asset-toolbar__search">
              <Icon name="search" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索世界/版本"
                aria-label="搜索世界或版本"
              />
            </div>
            <Select
              aria-label="筛选世界"
              value={filter}
              onChange={(event) => setFilter(event.target.value as SaveFilter)}
            >
              {(Object.keys(FILTER_LABELS) as SaveFilter[]).map((value) => (
                <option key={value} value={value}>{FILTER_LABELS[value]}</option>
              ))}
            </Select>
            <DisabledHint hint="等「分享包导入」对话框接入后可用（t6）">
              <Button size="sm" variant="secondary" icon="package" disabled>导入分享包</Button>
            </DisabledHint>
            <DisabledHint hint={selected ? '打开当前实例的 saves/ 目录' : '先选择实例'}>
              <Button size="sm" variant="secondary" icon="folder" disabled={!selected} onClick={openFolder}>打开存档目录</Button>
            </DisabledHint>
          </div>
        </div>
      </Card>

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
            <span>
              {saves.data?.gameDir ?? '读取实例目录中'} · {visibleRows.length}
              {visibleRows.length !== rows.length ? ` / ${rows.length}` : ''} 个世界
            </span>
          </div>
          <div className="row gap-8">
            {chosen.size > 0 ? (
              <>
                <Badge tone="accent">已选 {chosen.size}</Badge>
                <Button size="sm" variant="ghost" onClick={() => setChosen(new Set())}>取消选择</Button>
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
        ) : visibleRows.length === 0 ? (
          <EmptyState
            icon="search"
            title="没有匹配的世界"
            description={`当前搜索「${query.trim() || FILTER_LABELS[filter]}」没有结果。`}
            actions={<Button size="sm" variant="secondary" icon="refresh" onClick={() => { setQuery(''); setFilter('all') }}>清空筛选</Button>}
          />
        ) : (
          <table className="table asset-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    aria-label="选择全部世界"
                    checked={visibleRows.length > 0 && visibleRows.every((row) => chosen.has(row.name))}
                    onChange={(event) => setChosen(event.target.checked ? new Set(visibleRows.map((row) => row.name)) : new Set())}
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
              {visibleRows.map((save) => (
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
