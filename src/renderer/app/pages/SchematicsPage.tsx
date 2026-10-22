import { useEffect, useMemo, useState } from 'react'
import type { InstanceSummary } from '@shared/instance'
import type { SchematicEntry, SchematicFormat } from '@shared/assets'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { navigate } from '../router'
import {
  copySchematic,
  deleteSchematics,
  importSchematic,
  listSchematics,
  openSchematic,
  openSchematicFolder,
  showSchematicInFolder,
} from '../data/schematics'
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
  PageSubNav,
  Select,
  SectionHead,
  Skeleton,
  type PageSubNavItem,
} from '../ui'
import { Icon } from '../icons'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function versionLabel(instance: InstanceSummary): string {
  return `${instance.name} · ${instance.mcVersion ?? '版本未知'}`
}

function loaderLabel(instance: InstanceSummary): string {
  switch (instance.loader.type) {
    case 'vanilla': return '原版'
    case 'fabric': return 'Fabric'
    case 'quilt': return 'Quilt'
    case 'forge': return 'Forge'
    case 'neoforge': return 'NeoForge'
    default: return '未知加载器'
  }
}

function instanceMeta(instance: InstanceSummary): string {
  return `${instance.mcVersion ?? '版本未知'} · ${loaderLabel(instance)}${instance.isolation === 'shared' ? ' · 共享' : ''}`
}

function dimensionsLabel(row: SchematicEntry): string {
  return row.dimensions ? `${row.dimensions.x} × ${row.dimensions.y} × ${row.dimensions.z}` : '—'
}

function formatLabel(format: SchematicFormat): string {
  switch (format) {
    case 'litematic': return '.litematic'
    case 'sponge-v1': return '.schem（Sponge v1）'
    case 'sponge-v2': return '.schem（Sponge v2）'
    case 'sponge-v3': return '.schem（Sponge v3）'
    case 'mcedit': return '.schem（MCEdit）'
    case 'structure': return 'structure'
    default: return '未知格式'
  }
}

function volumeLabel(row: SchematicEntry): string {
  const parts: string[] = []
  if (row.volume !== null) parts.push(`${row.volume.toLocaleString('zh-CN')} 方块`)
  if (row.regionCount !== null && row.regionCount > 1) parts.push(`${row.regionCount} 个区域`)
  return parts.join(' · ')
}

interface Notice {
  tone: 'success' | 'warning'
  title: string
  detail: string
}

interface ConflictState {
  mode: 'copy' | 'move'
  targetName: string | null
}

export function SchematicsPage() {
  const backend = useBackend()
  const instances = useAsync(() => backend.instances.list(), [])
  const [sourceKey, setSourceKey] = useState('')
  const [query, setQuery] = useState('')
  const [format, setFormat] = useState('all')
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [targetId, setTargetId] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const sharedInstance = useMemo(
    () => (instances.data ?? []).find((instance) => instance.isolation === 'shared') ?? null,
    [instances.data],
  )
  const sourceInstance = sourceKey === 'global'
    ? sharedInstance
    : (instances.data ?? []).find((instance) => instance.id === sourceKey) ?? null
  const sourceInstanceId = sourceInstance?.id ?? null
  const list = useAsync(
    () => sourceInstanceId ? listSchematics(sourceInstanceId) : Promise.resolve(null),
    [sourceInstanceId],
  )
  const rows = list.data?.schematics ?? []
  const others = useMemo(
    () => (instances.data ?? []).filter((instance) => instance.id !== sourceInstanceId),
    [instances.data, sourceInstanceId],
  )
  const target = others.find((instance) => instance.id === targetId) ?? null
  const selectedRow = rows.find((row) => row.name === selectedName) ?? null
  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (format !== 'all' && row.format !== format) return false
      if (!q) return true
      return `${row.name} ${row.format} ${sourceInstance?.mcVersion ?? ''}`.toLowerCase().includes(q)
    })
  }, [rows, query, format, sourceInstance?.mcVersion])
  const formatCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(row.format, (counts.get(row.format) ?? 0) + 1)
    return counts
  }, [rows])

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
    if (instances.status !== 'ready' || !instances.data) return
    if (instances.data.length === 0) {
      if (sourceKey) setSourceKey('')
      return
    }
    if (sourceKey === 'global') {
      if (sharedInstance) return
      setSourceKey(instances.data[0].id)
      return
    }
    if (sourceKey && instances.data.some((instance) => instance.id === sourceKey)) return
    setSourceKey(instances.data[0].id)
  }, [instances.status, instances.data, sourceKey, sharedInstance])

  useEffect(() => {
    if (others.length === 0) {
      if (targetId) setTargetId('')
      return
    }
    if (!others.some((instance) => instance.id === targetId)) setTargetId(others[0].id)
  }, [others, targetId])

  useEffect(() => {
    setSelectedName(null)
    setError(null)
    setNotice(null)
    setConflict(null)
    setConfirmingDelete(false)
    setQuery('')
    setFormat('all')
  }, [sourceInstanceId])

  useEffect(() => {
    if (format !== 'all' && !formatCounts.has(format)) setFormat('all')
  }, [format, formatCounts])

  const sourceItems = useMemo<PageSubNavItem[]>(() => {
    const items: PageSubNavItem[] = [{
      key: 'global',
      label: '全局（共享目录）',
      icon: 'cube',
      meta: sharedInstance ? '共享 .minecraft/schematics' : '未检测到共享实例（isolation=shared）',
      disabled: !sharedInstance,
      hint: sharedInstance
        ? '读取共享实例的 .minecraft/schematics 目录'
        : '后端 listSchematics 需要实例上下文；当前没有共享实例，全局目录暂不可读',
    }]
    for (const instance of instances.data ?? []) {
      items.push({
        key: instance.id,
        label: instance.name,
        icon: 'instances',
        meta: instanceMeta(instance),
        disabled: false,
        hint: `${instance.name} · ${instanceMeta(instance)}`,
      })
    }
    return items
  }, [instances.data, sharedInstance])

  const formatItems = useMemo(() => [
    { key: 'all', label: '全部投影', count: rows.length },
    ...Array.from(formatCounts.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([name, count]) => ({ key: name, label: formatLabel(name as SchematicFormat), count })),
  ], [formatCounts, rows.length])

  const pickAndImport = async () => {
    if (!sourceInstance) {
      setError({
        kind: 'error',
        title: '先选择实例来源',
        detail: '投影文件属于某个实例的 gameDir/schematics/；先在左侧选择实例，再打开文件。',
        retryable: false,
      })
      return
    }
    setError(null)
    setNotice(null)

    let picked
    try {
      picked = await backend.system.pickFiles({
        title: '选择投影文件',
        multi: true,
        filters: [{ name: '投影文件（.litematic / .nbt / .schem）', extensions: ['litematic', 'nbt', 'schem'] }],
      })
    } catch (cause) {
      setError(describeError(cause))
      return
    }
    if (picked.cancelled || picked.paths.length === 0) return

    setBusy('import')
    const imported: string[] = []
    const failures: string[] = []
    for (const filePath of picked.paths) {
      try {
        const result = await importSchematic(sourceInstance.id, filePath)
        imported.push(result.fileName)
      } catch (cause) {
        failures.push(`${filePath.split(/[\\/]/).pop() ?? filePath}：${describeError(cause).title}`)
      }
    }
    setBusy(null)
    if (imported.length > 0) {
      setNotice({
        tone: 'success',
        title: `已导入 ${imported.length} 个投影`,
        detail: `${imported.join('、')} → ${sourceInstance.name} 的 gameDir/schematics/。`,
      })
      list.reload()
    }
    if (failures.length > 0) {
      setError({
        kind: 'error',
        title: `${failures.length} 个投影导入失败`,
        detail: failures.join('\n'),
        retryable: false,
      })
    }
  }

  const runTransfer = async (mode: 'copy' | 'move', strategy?: 'overwrite' | 'skip' | 'rename') => {
    if (!sourceInstance || !selectedRow || !target) return
    if (strategy === 'skip') {
      setConflict(null)
      setNotice({
        tone: 'warning',
        title: '已跳过同名投影',
        detail: `目标实例 ${target.name} 中已有同名文件，源文件保持不变。`,
      })
      return
    }
    setBusy(mode)
    setError(null)
    setNotice(null)
    try {
      const result = await copySchematic({
        instanceId: sourceInstance.id,
        name: selectedRow.name,
        targetInstanceId: target.id,
        mode,
        conflict: strategy,
      })
      if (result.status === 'conflict') {
        setConflict({ mode, targetName: result.targetName })
        return
      }
      setConflict(null)
      const targetName = result.targetName ?? selectedRow.name
      setNotice({
        tone: result.warnings.length > 0 ? 'warning' : 'success',
        title: result.status === 'moved' ? `已移动到 ${target.name}` : `已复制到 ${target.name}`,
        detail: `${targetName}${result.renamed ? '（同名已自动改名）' : ''} · ${formatBytes(result.size)}${result.warnings.length > 0 ? `。${result.warnings.join('；')}` : ''}`,
      })
      if (result.status === 'moved') setSelectedName(null)
      list.reload()
    } catch (cause) {
      setConflict(null)
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  const deleteSelected = async () => {
    if (!sourceInstance || !selectedRow) return
    setConfirmingDelete(false)
    setBusy('delete')
    setError(null)
    setNotice(null)
    try {
      const result = await deleteSchematics(sourceInstance.id, [selectedRow.name])
      if (result.errors.length > 0) {
        setError({
          kind: 'error',
          title: '删除投影失败',
          detail: result.errors.map((entry) => `${entry.name}：${entry.message}`).join('；'),
          retryable: false,
        })
      } else {
        setNotice({
          tone: 'success',
          title: '投影已移入回收站',
          detail: `${selectedRow.name} 可在「回收站」恢复。`,
        })
      }
      setSelectedName(null)
      list.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  const showSelected = async () => {
    if (!sourceInstance || !selectedRow) return
    setBusy('show')
    setError(null)
    try {
      await showSchematicInFolder(sourceInstance.id, selectedRow.name)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  const openSelected = () => {
    if (!sourceInstance || !selectedRow) return
    void openSchematic(sourceInstance.id, selectedRow.name).catch((cause) => setError(describeError(cause)))
  }

  const openFolder = () => {
    if (!sourceInstance) return
    void openSchematicFolder(sourceInstance.id).catch((cause) => setError(describeError(cause)))
  }

  const refreshAll = () => {
    instances.reload()
    list.reload()
  }

  const actionsDisabled = !selectedRow || busy !== null
  const instancesEmpty = instances.status === 'ready' && (instances.data?.length ?? 0) === 0
  const instancesPending = instances.status === 'not-wired' || instances.status === 'error'

  return (
    <>
      <PageHeader
        title="投影管理"
        subtitle="左侧选择实例来源（全局 = 共享 .minecraft/schematics）；右侧「目标版本」独立决定复制/移动的去向。列表只显示真实目录内容。"
        actions={(
          <>
            <Button variant="secondary" icon="folder" disabled={!sourceInstance} onClick={openFolder}>打开文件夹</Button>
            <Button variant="primary" icon="plus" loading={busy === 'import'} disabled={!sourceInstance} onClick={() => void pickAndImport()}>打开文件…</Button>
          </>
        )}
      />

      {instances.status === 'loading' ? (
        <Card className="nw-loading">
          <Skeleton className="skeleton--title" style={{ width: '30%' }} />
          <Skeleton className="skeleton--text" style={{ width: '58%', marginTop: 12 }} />
        </Card>
      ) : instancesPending ? (
        <DataStateNotice info={describeError(instances.error)} onRetry={instances.reload} />
      ) : instancesEmpty ? (
        <Card className="nw-empty-card">
          <EmptyState
            icon="instances"
            title="还没有实例"
            description="投影来源于实例的 gameDir/schematics；先安装或导入一个 Minecraft 版本，再回来管理投影。"
            actions={<Button variant="secondary" icon="instances" onClick={() => navigate('/instances')}>去实例页面</Button>}
          />
        </Card>
      ) : (
        <>
          {error ? <div className="nw-inline-error" role="alert">{error.title}：{error.detail}</div> : null}
          {notice ? <Banner tone={notice.tone} title={notice.title}>{notice.detail}</Banner> : null}
          {conflict ? (
            <Banner
              tone="warning"
              title={`目标实例已有同名投影${conflict.targetName ? `「${conflict.targetName}」` : ''}`}
              actions={(
                <>
                  <Button size="sm" variant="secondary" icon="copy" loading={busy === conflict.mode} onClick={() => void runTransfer(conflict.mode, 'overwrite')}>覆盖</Button>
                  <Button size="sm" variant="secondary" icon="edit" loading={busy === conflict.mode} onClick={() => void runTransfer(conflict.mode, 'rename')}>自动改名</Button>
                  <Button size="sm" variant="ghost" onClick={() => void runTransfer(conflict.mode, 'skip')}>跳过</Button>
                </>
              )}
            >
              覆盖会先备份目标文件再替换；自动改名会生成 -2/-3 后缀；跳过保持源文件不变。
            </Banner>
          ) : null}
          {confirmingDelete && selectedRow ? (
            <Banner
              tone="warning"
              title={`确认删除「${selectedRow.name}」？`}
              actions={(
                <>
                  <Button size="sm" variant="danger-ghost" icon="trash" loading={busy === 'delete'} onClick={() => void deleteSelected()}>移入回收站</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmingDelete(false)}>取消</Button>
                </>
              )}
            >
              删除只会把投影文件移入回收站，之后可在回收站恢复；不会永久删除。
            </Banner>
          ) : null}

          <div className="schematic-page">
            <Card className="schematic-source" pad={false}>
              <div className="schematic-source__head">
                <strong>实例来源</strong>
                <Button size="xs" variant="ghost" icon="refresh" aria-label="刷新实例来源" title="刷新实例来源" onClick={refreshAll} />
              </div>
              <PageSubNav
                variant="list"
                label="实例来源"
                active={sourceKey}
                onChange={setSourceKey}
                items={sourceItems}
              />
              <p className="schematic-source__hint">
                全局项读取共享实例的 .minecraft/schematics；实例项读取各自 gameDir/schematics。目标版本在右侧单独选择。
              </p>
            </Card>

            <div className="schematic-main">
              {list.status === 'not-wired' || list.status === 'error' ? (
                <DataStateNotice info={describeError(list.error)} onRetry={list.reload} />
              ) : null}

              <PageSubNav
                variant="tabs"
                label="投影分类"
                active={format}
                onChange={setFormat}
                items={formatItems}
              />

              <div className="schematic-layout">
                <Card className="schematic-list" pad={false}>
                  <div className="asset-table-card__head">
                    <div>
                      <h2>投影文件</h2>
                      <span>
                        {list.data?.gameDir ?? (sourceInstance ? 'gameDir/schematics' : '先选择实例来源')} · {visibleRows.length}
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
                      <Button size="sm" variant="ghost" icon="refresh" disabled={!sourceInstance} onClick={list.reload}>重新读取</Button>
                    </div>
                  </div>

                  {list.status === 'loading' ? (
                    <div className="nw-stack" style={{ padding: 16 }}>
                      <Skeleton className="skeleton--text" style={{ width: '42%' }} />
                      <Skeleton className="skeleton--text" style={{ width: '72%' }} />
                    </div>
                  ) : !sourceInstance ? (
                    <div className="schematic-empty-row">
                      <EmptyState
                        icon="instances"
                        title="先选择实例来源"
                        description="左栏选择全局（共享目录）或具体实例后，才会读取真实投影列表。"
                      />
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
                            className={`schematic-row${selectedName === row.name ? ' is-current' : ''}${row.error ? ' is-broken' : ''}`}
                            aria-selected={selectedName === row.name}
                            tabIndex={0}
                            title={row.error ?? '双击打开文件'}
                            onClick={() => setSelectedName(row.name)}
                            onDoubleClick={() => {
                              setSelectedName(row.name)
                              if (sourceInstance) void openSchematic(sourceInstance.id, row.name).catch((cause) => setError(describeError(cause)))
                            }}
                            onKeyDown={(event) => {
                              if (event.key !== 'Enter' && event.key !== ' ') return
                              event.preventDefault()
                              setSelectedName(row.name)
                            }}
                          >
                            <td>
                              <div className="asset-name">
                                <span className="asset-name__icon"><Icon name="schematic" /></span>
                                <strong title={row.name}>{row.name}</strong>
                                {row.error ? <Badge tone="danger">解析失败</Badge> : null}
                              </div>
                            </td>
                            <td className="mono" title={row.error ?? (row.dimensions ? '来自文件头 EnclosingSize' : '文件头没有尺寸信息')}>
                              {dimensionsLabel(row)}
                            </td>
                            <td className="num">{formatBytes(row.size)}</td>
                            <td>{formatTime(row.modifiedAt)}</td>
                          </tr>
                        ))}
                        {visibleRows.length === 0 ? (
                          <tr className="schematic-empty-row">
                            <td colSpan={4}>
                              {query.trim() ? (
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
                                  description="把 .litematic / .nbt / .schem 放进该来源的 schematics 目录，或用「打开文件…」直接选"
                                  actions={<Button size="sm" variant="primary" icon="plus" loading={busy === 'import'} onClick={() => void pickAndImport()}>打开文件…</Button>}
                                  hint={list.status === 'not-wired'
                                    ? '投影通道尚未由主进程注册；这里不会显示示例数据。'
                                    : list.data?.gameDir
                                      ? `目录：${list.data.gameDir}`
                                      : '目录：当前来源的 gameDir/schematics/'}
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
                  <SectionHead title="操作" action={<Badge tone="outline">目标独立</Badge>} />
                  <div className="schematic-selected">
                    {selectedRow ? (
                      <>
                        <span className="asset-name__icon"><Icon name="schematic" /></span>
                        <div>
                          <strong title={selectedRow.name}>{selectedRow.name}</strong>
                          <span>
                            {dimensionsLabel(selectedRow)} · {formatBytes(selectedRow.size)}
                            {volumeLabel(selectedRow) ? ` · ${volumeLabel(selectedRow)}` : ''}
                          </span>
                        </div>
                      </>
                    ) : (
                      <>
                        <span className="asset-name__icon"><Icon name="more" /></span>
                        <div><strong>未选择投影</strong><span>先左键选择一个投影文件</span></div>
                      </>
                    )}
                  </div>
                  {selectedRow?.error ? (
                    <div className="nw-inline-error" role="alert">文件解析失败：{selectedRow.error}</div>
                  ) : null}

                  <label className="schematic-side__label" htmlFor="schematic-target">目标版本</label>
                  <Select
                    id="schematic-target"
                    aria-label="目标版本"
                    value={targetId}
                    onChange={(event) => { setTargetId(event.target.value); setConflict(null) }}
                    disabled={others.length === 0}
                  >
                    {others.length === 0
                      ? <option value="">没有其他版本</option>
                      : others.map((instance) => <option key={instance.id} value={instance.id}>{versionLabel(instance)}</option>)}
                  </Select>

                  <div className="schematic-side__actions">
                    <DisabledHint hint={!selectedRow
                      ? '先在左侧选择一个投影'
                      : !target ? '先选择一个目标版本' : `复制到 ${versionLabel(target)}`}>
                      <Button size="sm" variant="secondary" icon="copy" disabled={actionsDisabled || !target} loading={busy === 'copy'} onClick={() => void runTransfer('copy')}>复制到该版本</Button>
                    </DisabledHint>
                    <DisabledHint hint={!selectedRow
                      ? '先在左侧选择一个投影'
                      : !target ? '先选择一个目标版本' : `移动到 ${versionLabel(target)}（复制完成后源文件移入回收站）`}>
                      <Button size="sm" variant="secondary" icon="external" disabled={actionsDisabled || !target} loading={busy === 'move'} onClick={() => void runTransfer('move')}>移动到该版本</Button>
                    </DisabledHint>
                    <Button size="sm" variant="ghost" icon="folder" disabled={actionsDisabled} loading={busy === 'show'} onClick={() => void showSelected()}>在文件夹中显示</Button>
                    <Button size="sm" variant="ghost" icon="external" disabled={actionsDisabled} onClick={openSelected}>打开文件</Button>
                    <Button size="sm" variant="danger-ghost" icon="trash" disabled={actionsDisabled} onClick={() => setConfirmingDelete(true)}>删除</Button>
                  </div>

                  <div className="nw-context-note">
                    <Icon name="flask" />
                    <span>
                      左栏只决定「查看哪个实例的投影」；目标版本只决定复制/移动去向，两处互不影响。
                      跨版本复制会保留源文件；「移动到该版本」在复制提交后才把源文件移入回收站。
                    </span>
                  </div>
                </Card>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  )
}
