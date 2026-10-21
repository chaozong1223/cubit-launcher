import { useEffect, useMemo, useState, type DragEvent } from 'react'
import type { ModFile, ModKind, ModpackImportResult } from '@shared/mods'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { navigate } from '../router'
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Input,
  Skeleton,
  Switch,
  Tag,
} from '../ui'
import { Icon } from '../icons'

const KIND_META: Record<ModKind, { title: string; folder: string; filterName: string; extensions: string[]; hint: string }> = {
  mods: { title: '模组', folder: 'mods', filterName: 'Minecraft 模组', extensions: ['jar'], hint: '拖入 .jar 安装到当前实例；不会影响其它实例。' },
  resourcepacks: { title: '资源包', folder: 'resourcepacks', filterName: '资源包', extensions: ['zip'], hint: '拖入资源包 .zip；可按需启用、禁用或删除。' },
  shaderpacks: { title: '光影', folder: 'shaderpacks', filterName: '光影包', extensions: ['zip'], hint: '拖入光影包 .zip；需要 Iris/OptiFine 才能在游戏内切换。' },
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`
}

function loaderTag(file: ModFile) {
  const type = file.metadata?.loader
  if (type === 'forge') return <Tag variant="forge">Forge</Tag>
  if (type === 'neoforge') return <Tag variant="neo">NeoForge</Tag>
  if (type === 'fabric') return <Tag variant="fabric">Fabric</Tag>
  if (type === 'quilt') return <Tag variant="pack">Quilt</Tag>
  return <Tag>{type ?? '未知'}</Tag>
}

export function ModsPanel({ instanceId, kind }: { instanceId: string; kind: ModKind }) {
  const backend = useBackend()
  const meta = KIND_META[kind]
  const scan = useAsync(() => backend.mods.scan(instanceId, kind), [instanceId, kind])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<'all' | 'enabled' | 'disabled'>('all')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const [importing, setImporting] = useState(false)

  useEffect(() => {
    setSelected(new Set())
    setError(null)
    setNotice(null)
  }, [instanceId, kind])

  useEffect(() => {
    const off = backend.mods.subscribeChanged(() => scan.reload())
    return off
  }, [backend, scan.reload])

  const files = scan.data?.files[kind]
  const allFiles = useMemo(() => (files ? [...files.enabled, ...files.disabled] : []), [files])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return allFiles.filter((file) => {
      const text = `${file.name} ${file.fileName} ${file.metadata?.name ?? ''} ${file.metadata?.id ?? ''}`.toLowerCase()
      return (!q || text.includes(q)) && (filter === 'all' || (filter === 'enabled' ? file.enabled : !file.enabled))
    })
  }, [allFiles, query, filter])

  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await task()
      scan.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const installPaths = async (paths: string[]) => {
    if (paths.length === 0) return
    setBusy(true)
    setError(null)
    setNotice(null)
    const failures: string[] = []
    let installed = 0
    for (const filePath of paths) {
      try {
        await backend.mods.installLocalFile(instanceId, filePath, kind)
        installed += 1
      } catch (cause) {
        failures.push(`${filePath}: ${describeError(cause).title}`)
      }
    }
    setBusy(false)
    scan.reload()
    if (installed > 0) setNotice(`已安装 ${installed} 个文件到 ${meta.folder}/。`)
    if (failures.length > 0) {
      setError({
        kind: 'error',
        title: `${failures.length} 个文件安装失败`,
        detail: failures.join('\n'),
        retryable: false,
      })
    }
  }

  const pickAndInstall = async () => {
    const result = await backend.system.pickFiles({
      title: `选择${meta.title}`,
      multi: true,
      filters: [{ name: meta.filterName, extensions: meta.extensions }],
    }).catch((cause) => {
      setError(describeError(cause))
      return null
    })
    if (!result || result.cancelled) return
    await installPaths(result.paths)
  }

  const onDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setDragging(false)
    const nativeEvent = event.nativeEvent as unknown as { __mclGlobalDrop?: boolean }
    if (nativeEvent.__mclGlobalDrop) return
    const dropped = Array.from(event.dataTransfer.files)
    if (dropped.length === 0) return
    const paths = dropped.map((file) => backend.system.getPathForFile(file))
    const missing = paths.filter((path) => !path).length
    if (missing > 0) {
      setError({
        kind: 'error',
        title: '无法读取拖入文件的绝对路径',
        detail: 'preload 的 webUtils.getPathForFile 返回空值。请改用“选择文件”系统对话框；拖拽和选择器最终调用同一个 mods.installLocalFile(path)。',
        retryable: false,
      })
    }
    const valid = paths.filter((path): path is string => Boolean(path))
    if (valid.length > 0) await installPaths(valid)
  }

  const toggle = (file: ModFile) => {
    void run(async () => {
      await backend.mods.setEnabled(instanceId, kind, [file.name], !file.enabled)
      setNotice(`${file.name} 已${file.enabled ? '禁用' : '启用'}。`)
    })
  }

  const batchSet = (enabled: boolean) => {
    if (selected.size === 0) return
    void run(async () => {
      const result = await backend.mods.setEnabled(instanceId, kind, [...selected], enabled)
      setNotice(`已${enabled ? '启用' : '禁用'} ${result.changed.length} 个；跳过 ${result.skipped.length} 个。`)
      setSelected(new Set())
    })
  }

  const batchRemove = () => {
    if (selected.size === 0) return
    if (!window.confirm(`删除所选 ${selected.size} 个${meta.title}文件？此操作不可撤销。`)) return
    void run(async () => {
      const result = await backend.mods.remove(instanceId, kind, [...selected])
      setNotice(`已删除 ${result.changed.length} 个；失败 ${result.errors.length} 个。`)
      setSelected(new Set())
    })
  }

  const importModpack = async () => {
    setImporting(true)
    setError(null)
    try {
      const pick = await backend.system.pickFiles({
        title: '选择整合包',
        filters: [
          { name: '整合包', extensions: ['mrpack', 'zip'] },
        ],
      })
      if (pick.cancelled || pick.paths.length === 0) return
      const result: ModpackImportResult = await backend.mods.importModpack(pick.paths[0])
      setNotice(`已导入 ${result.name}（${result.format}，下载 ${result.downloaded}，跳过 ${result.skipped}）。`)
      if (result.needsBaseInstall) setNotice((prev) => `${prev ?? ''} 还需要安装基础游戏版本。`.trim())
      navigate(`/instances/${encodeURIComponent(result.instanceId)}`)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setImporting(false)
    }
  }

  const exportModpack = async () => {
    setError(null)
    try {
      const save = await backend.system.pickSaveFile({
        title: '导出整合包',
        defaultPath: `${instanceId}.mrpack`,
        filters: [{ name: 'Modrinth 整合包', extensions: ['mrpack'] }],
      })
      if (save.cancelled || !save.path) return
      const result = await backend.mods.exportModpack(instanceId, save.path)
      setNotice(`已导出 ${result.files} 个文件 / ${formatBytes(result.bytes)} 到 ${result.path}。`)
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  const openFolder = () => {
    void backend.mods.openFolder(instanceId, kind).catch((cause) => setError(describeError(cause)))
  }

  const toggleAll = (checked: boolean) => {
    setSelected(checked ? new Set(visible.filter((file) => file.enabled).map((file) => file.name)) : new Set())
  }

  return (
    <div className="detail-panel is-active">
      <div className="mod-toolbar">
        <div className="input-wrap search">
          <Icon name="search" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索${meta.title}名称、文件名或 ID`}
            aria-label={`搜索${meta.title}`}
          />
        </div>
        <div className="chip-group" role="group" aria-label={`筛选${meta.title}`}>
          <button className={`chip${filter === 'all' ? ' is-active' : ''}`} type="button" onClick={() => setFilter('all')}>全部 {allFiles.length}</button>
          <button className={`chip${filter === 'enabled' ? ' is-active' : ''}`} type="button" onClick={() => setFilter('enabled')}>已启用 {files?.enabled.length ?? 0}</button>
          <button className={`chip${filter === 'disabled' ? ' is-active' : ''}`} type="button" onClick={() => setFilter('disabled')}>已禁用 {files?.disabled.length ?? 0}</button>
        </div>
        <div className="toolbar__spacer" />
        <Button size="sm" variant="secondary" icon="folder" onClick={openFolder}>打开文件夹</Button>
        <Button size="sm" variant="primary" icon="plus" onClick={() => void pickAndInstall()} loading={busy}>
          选择文件
        </Button>
      </div>

      {scan.data?.issues.length ? (
        <Banner tone="warning" title={`发现 ${scan.data.issues.length} 个依赖问题`}>
          <div className="mods-issues">
            {scan.data.issues.slice(0, 6).map((issue, index) => (
              <div key={`${issue.kind}-${issue.modId}-${index}`}>{issue.message}</div>
            ))}
          </div>
        </Banner>
      ) : null}

      {error ? (
        <div className="nw-inline-error" role="alert">
          {error.title}：{error.detail}
        </div>
      ) : null}
      {notice ? <Banner tone="success">{notice}</Banner> : null}

      {selected.size > 0 ? (
        <div className="mods-batchbar">
          <strong>已选择 {selected.size} 个</strong>
          <Button size="xs" variant="secondary" icon="check" onClick={() => batchSet(true)} loading={busy}>启用</Button>
          <Button size="xs" variant="secondary" icon="pause" onClick={() => batchSet(false)} loading={busy}>禁用</Button>
          <Button size="xs" variant="danger-ghost" icon="trash" onClick={batchRemove} loading={busy}>删除</Button>
          <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>取消选择</Button>
        </div>
      ) : null}

      <Card className="table-wrap" pad={false}>
        {scan.status === 'loading' ? (
          <div className="nw-stack" style={{ padding: 16 }}>
            <Skeleton className="skeleton--text" style={{ width: '50%' }} />
            <Skeleton className="skeleton--text" style={{ width: '80%' }} />
          </div>
        ) : scan.status === 'not-wired' || scan.status === 'error' ? (
          <div style={{ padding: 16 }}>
            <EmptyState
              icon="flask"
              title={describeError(scan.error).title}
              description={describeError(scan.error).detail}
              actions={<Button size="sm" variant="secondary" icon="refresh" onClick={scan.reload}>重新扫描</Button>}
            />
          </div>
        ) : allFiles.length === 0 ? (
          <EmptyState
            icon="package"
            title={`还没有${meta.title}`}
            description={meta.hint}
            actions={<Button size="sm" variant="primary" icon="plus" onClick={() => void pickAndInstall()}>选择文件安装</Button>}
          />
        ) : visible.length === 0 ? (
          <EmptyState icon="search" title="没有匹配项" description="清空搜索或切换筛选条件。" />
        ) : (
          <table className="table mod-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>
                  <input
                    type="checkbox"
                    aria-label={`选择全部${meta.title}`}
                    checked={visible.length > 0 && visible.filter((file) => file.enabled).every((file) => selected.has(file.name))}
                    onChange={(event) => toggleAll(event.target.checked)}
                  />
                </th>
                <th className="col-mod">{meta.title}</th>
                <th>版本</th>
                <th>加载器</th>
                <th className="num">大小</th>
                <th>状态</th>
                <th aria-label="启用开关" />
              </tr>
            </thead>
            <tbody>
              {visible.map((file) => (
                <tr key={file.fileName} className={file.enabled ? undefined : 'is-disabled'}>
                  <td>
                    <input
                      type="checkbox"
                      checked={selected.has(file.name)}
                      aria-label={`选择 ${file.name}`}
                      onChange={(event) => {
                        const next = new Set(selected)
                        if (event.target.checked) next.add(file.name)
                        else next.delete(file.name)
                        setSelected(next)
                      }}
                    />
                  </td>
                  <td>
                    <div className="mod-name">
                      <strong>{file.metadata?.name ?? file.name}</strong>
                      <span>{file.metadata?.id ?? file.fileName}{file.metadataError ? ` · ${file.metadataError}` : ''}</span>
                    </div>
                  </td>
                  <td className="mono">{file.metadata?.version ?? '—'}</td>
                  <td>{loaderTag(file)}</td>
                  <td className="num">{formatBytes(file.size)}</td>
                  <td><Badge tone={file.enabled ? 'success' : 'outline'}>{file.enabled ? '已启用' : '已禁用'}</Badge></td>
                  <td><Switch checked={file.enabled} onChange={() => toggle(file)} label={`${file.enabled ? '禁用' : '启用'} ${file.name}`} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="mod-foot">
          <span>已启用 <strong className="muted">{files?.enabled.length ?? 0}</strong> / {allFiles.length} · 禁用 {files?.disabled.length ?? 0}</span>
          <span className="row gap-8">
            <span className="subtle">{meta.hint}</span>
            <Button size="xs" variant="ghost" icon="refresh" onClick={scan.reload}>重新扫描</Button>
          </span>
        </div>
      </Card>

      <div
        className={`dropzone${dragging ? ' is-dragging' : ''}`}
        onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => void onDrop(event)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') void pickAndInstall() }}
      >
        <Icon name="upload" />
        <span>{meta.hint} 也可以拖到这里。</span>
      </div>

      <div className="mods-modpack-actions">
        <div>
          <strong>整合包</strong>
          <span className="muted">导入会新建实例；导出生成 .mrpack，保留 overrides。</span>
        </div>
        <Button size="sm" variant="secondary" icon="package" onClick={() => void importModpack()} loading={importing}>导入整合包</Button>
        <Button size="sm" variant="secondary" icon="upload" onClick={() => void exportModpack()}>导出整合包</Button>
      </div>
    </div>
  )
}
