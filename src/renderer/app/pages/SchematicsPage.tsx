import { useEffect, useMemo, useState } from 'react'
import type { InstanceSummary } from '@shared/instance'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { useInstanceSelection } from '../data/useInstanceSelection'
import { importSchematic, listSchematics, SCHEMATIC_CHANNELS } from '../data/schematics'
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
  SectionHead,
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

function versionLabel(instance: InstanceSummary): string {
  return `${instance.name} · ${instance.mcVersion ?? '版本未知'}`
}

function dimensionsLabel(row: { dimensions: { x: number; y: number; z: number } | null }): string {
  return row.dimensions ? `${row.dimensions.x} × ${row.dimensions.y} × ${row.dimensions.z}` : '—'
}

interface PickNotice {
  tone: 'warning' | 'success'
  title: string
  detail: string
}

export function SchematicsPage() {
  const backend = useBackend()
  const selection = useInstanceSelection()
  const { selected } = selection
  const list = useAsync(
    () => selected ? listSchematics(selected.id) : Promise.resolve(null),
    [selected?.id],
  )
  const [query, setQuery] = useState('')
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [targetId, setTargetId] = useState('')
  const [busy, setBusy] = useState(false)
  const [pickError, setPickError] = useState<UiErrorInfo | null>(null)
  const [notice, setNotice] = useState<PickNotice | null>(null)

  const rows = list.data?.schematics ?? []
  const others = useMemo(
    () => (selection.instances.data ?? []).filter((instance) => instance.id !== selected?.id),
    [selection.instances.data, selected?.id],
  )
  const target = others.find((instance) => instance.id === targetId) ?? null
  const selectedRow = rows.find((row) => row.name === selectedName) ?? null
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((row) => `${row.name} ${row.format} ${selected?.mcVersion ?? ''}`.toLowerCase().includes(q))
  }, [rows, query, selected?.mcVersion])

  useEffect(() => {
    setSelectedName(null)
    setPickError(null)
    setNotice(null)
    setQuery('')
  }, [selected?.id])

  useEffect(() => {
    if (others.length === 0) {
      if (targetId) setTargetId('')
      return
    }
    if (!others.some((instance) => instance.id === targetId)) setTargetId(others[0].id)
  }, [others, targetId])

  const pickAndImport = async () => {
    if (!selected) {
      setPickError({
        kind: 'error',
        title: '先选择实例',
        detail: '投影文件属于某个实例的 gameDir/schematics/；先在顶部选择目标实例，再打开文件。',
        retryable: false,
      })
      return
    }
    setPickError(null)
    setNotice(null)

    let picked
    try {
      picked = await backend.system.pickFiles({
        title: '选择投影文件',
        multi: true,
        filters: [{ name: '投影文件（.litematic / .nbt / .schem）', extensions: ['litematic', 'nbt', 'schem'] }],
      })
    } catch (cause) {
      setPickError(describeError(cause))
      return
    }
    if (picked.cancelled || picked.paths.length === 0) return

    setBusy(true)
    let imported = 0
    try {
      for (const filePath of picked.paths) {
        await importSchematic(selected.id, filePath)
        imported += 1
      }
      setNotice({
        tone: 'success',
        title: `已导入 ${imported} 个投影`,
        detail: `目标实例：${selected.name}。列表会重新读取。`,
      })
      list.reload()
    } catch (cause) {
      const info = describeError(cause)
      if (info.kind === 'not-wired') {
        setNotice({
          tone: 'warning',
          title: '投影导入通道尚未接入',
          detail: `已选择 ${picked.paths.length} 个文件，但通道 ${info.channel ?? SCHEMATIC_CHANNELS.import} 尚未由主进程注册${imported > 0 ? `（前 ${imported} 个已导入）` : ''}；文件没有复制。等 t4 后端接入后，这个按钮会直接导入。`,
        })
      } else {
        setPickError(info)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="投影管理"
        subtitle="管理当前实例 gameDir/schematics/ 下的 .litematic / .nbt / .schem；尺寸 X×Y×Z 来自文件头，列表只显示真实目录内容。"
        actions={<Button variant="secondary" icon="plus" loading={busy} onClick={() => void pickAndImport()}>打开文件…</Button>}
      />

      <InstancePicker
        selection={selection}
        onRefresh={selection.instances.reload}
        hint="投影列表读取当前实例的 gameDir/schematics/；「目标版本」可以是另一个实例（版本），用于跨版本复制或移动。"
        badge="实例级资源"
      />

      {list.status === 'not-wired' || list.status === 'error' ? (
        <DataStateNotice info={describeError(list.error)} onRetry={list.reload} />
      ) : null}
      {pickError ? <DataStateNotice info={pickError} /> : null}
      {notice ? <Banner tone={notice.tone} title={notice.title}>{notice.detail}</Banner> : null}

      <div className="schematic-layout">
        <Card className="schematic-list" pad={false}>
          <div className="asset-table-card__head">
            <div>
              <h2>投影文件</h2>
              <span>
                {list.data?.gameDir ?? (selected ? 'gameDir/schematics' : '先选择实例')} · {visibleRows.length}
                {visibleRows.length !== rows.length ? ` / ${rows.length}` : ''} 个文件
              </span>
            </div>
            <div className="asset-toolbar__group">
              <div className="input-wrap schematic-search">
                <Icon name="search" />
                <Input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索投影"
                  aria-label="搜索投影文件"
                />
              </div>
              <Badge tone="outline">.litematic / .nbt / .schem</Badge>
              <Button size="sm" variant="ghost" icon="refresh" disabled={!selected} onClick={list.reload}>重新读取</Button>
            </div>
          </div>

          {list.status === 'loading' ? (
            <div className="nw-stack" style={{ padding: 16 }}>
              <Skeleton className="skeleton--text" style={{ width: '42%' }} />
              <Skeleton className="skeleton--text" style={{ width: '72%' }} />
            </div>
          ) : (
            <table className="table asset-table schematic-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>尺寸 X×Y×Z</th>
                  <th className="num">大小</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((row) => (
                  <tr
                    key={row.name}
                    className={`schematic-row${selectedName === row.name ? ' is-current' : ''}`}
                    aria-selected={selectedName === row.name}
                    tabIndex={0}
                    onClick={() => setSelectedName(row.name)}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter' && event.key !== ' ') return
                      event.preventDefault()
                      setSelectedName(row.name)
                    }}
                  >
                    <td>
                      <div className="asset-name">
                        <span className="asset-name__icon"><Icon name="schematic" /></span>
                        <strong>{row.name}</strong>
                        <Badge tone="outline">{row.format}</Badge>
                      </div>
                    </td>
                    <td className="mono" title={row.dimensions ? '来自文件头 EnclosingSize' : '文件头没有尺寸信息'}>{dimensionsLabel(row)}</td>
                    <td className="num">{formatBytes(row.size)}</td>
                    <td>{formatTime(row.modifiedAt)}</td>
                  </tr>
                ))}
                {visibleRows.length === 0 ? (
                  <tr className="schematic-empty-row">
                    <td colSpan={4}>
                      {!selected ? (
                        <EmptyState
                          icon="instances"
                          title="先选择实例"
                          description="没有实例时不会读取或伪造投影列表。"
                        />
                      ) : query.trim() ? (
                        <EmptyState
                          icon="search"
                          title="没有匹配的投影"
                          description={`当前搜索「${query.trim()}」没有结果。`}
                          actions={<Button size="sm" variant="secondary" icon="refresh" onClick={() => setQuery('')}>清空搜索</Button>}
                        />
                      ) : (
                        <EmptyState
                          icon="schematic"
                          title={list.status === 'not-wired' ? '列表暂不可用' : '还没有投影文件'}
                          description="把 .litematic / .nbt / .schem 放进 .minecraft/schematics，或用「打开文件…」直接选"
                          actions={<Button size="sm" variant="primary" icon="plus" loading={busy} onClick={() => void pickAndImport()}>打开文件…</Button>}
                          hint={list.status === 'not-wired'
                            ? `等待通道 ${SCHEMATIC_CHANNELS.list} 注册；这里不会显示示例数据。`
                            : list.data?.gameDir
                              ? `目录：${list.data.gameDir}`
                              : '目录：当前实例的 gameDir/schematics/'}
                        />
                      )}
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          )}
        </Card>

        <Card className="schematic-side">
          <SectionHead title="操作" action={<Badge tone="warning">等 t4 后端</Badge>} />
          <div className="schematic-selected">
            {selectedRow ? (
              <>
                <span className="asset-name__icon"><Icon name="schematic" /></span>
                <div>
                  <strong title={selectedRow.name}>{selectedRow.name}</strong>
                  <span>{dimensionsLabel(selectedRow)} · {formatBytes(selectedRow.size)}</span>
                </div>
              </>
            ) : (
              <>
                <span className="asset-name__icon"><Icon name="more" /></span>
                <div><strong>未选择投影</strong><span>先左键选择一个投影文件</span></div>
              </>
            )}
          </div>

          <label className="schematic-side__label" htmlFor="schematic-target">目标版本</label>
          <Select
            id="schematic-target"
            aria-label="目标版本"
            value={targetId}
            onChange={(event) => setTargetId(event.target.value)}
            disabled={others.length === 0}
          >
            {others.length === 0
              ? <option value="">没有其他版本</option>
              : others.map((instance) => <option key={instance.id} value={instance.id}>{versionLabel(instance)}</option>)}
          </Select>

          <div className="schematic-side__actions">
            <DisabledHint hint={selectedRow
              ? `等投影管理后端接入（t4）：把 ${selectedRow.name} 复制到 ${target ? versionLabel(target) : '目标版本'}`
              : '先在左侧选择一个投影；跨版本复制通道（t4）接入后可用'}>
              <Button size="sm" variant="secondary" icon="copy" disabled>复制到该版本</Button>
            </DisabledHint>
            <DisabledHint hint={selectedRow
              ? `等投影管理后端接入（t4）：把 ${selectedRow.name} 移动到 ${target ? versionLabel(target) : '目标版本'}`
              : '先在左侧选择一个投影；跨版本移动通道（t4）接入后可用'}>
              <Button size="sm" variant="secondary" icon="external" disabled>移动到该版本</Button>
            </DisabledHint>
            <DisabledHint hint="等投影管理后端接入（t4）：在系统文件管理器中定位文件">
              <Button size="sm" variant="ghost" icon="folder" disabled>在文件夹中显示</Button>
            </DisabledHint>
            <DisabledHint hint={selectedRow
              ? `等投影管理后端接入（t4）：把 ${selectedRow.name} 移入回收站`
              : '先在左侧选择一个投影；删除通道（t4）接入后可用'}>
              <Button size="sm" variant="danger-ghost" icon="trash" disabled>删除</Button>
            </DisabledHint>
          </div>

          <div className="nw-context-note">
            <Icon name="flask" />
            <span>
              跨版本复制/移动、在文件夹中显示和删除都还没有主进程通道（t4）；这些按钮先保持禁用，
              接入后启用，不会伪造执行结果。列表通道：<code>{SCHEMATIC_CHANNELS.list}</code>
            </span>
          </div>
        </Card>
      </div>
    </>
  )
}
