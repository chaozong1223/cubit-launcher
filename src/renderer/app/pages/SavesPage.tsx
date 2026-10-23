import { useEffect, useMemo, useState } from 'react'
import type { BatchTrashResult, BackupResult, SaveCopyResult } from '@shared/assets'
import type {
  InstanceSummary,
  ShareConflictStrategy,
  ShareExportFinished,
  ShareExportResult,
  ShareImportFinished,
  ShareImportResult,
} from '@shared/instance'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { navigate } from '../router'
import { useAsync } from '../data/useAsync'
import { useInstanceSelection } from '../data/useInstanceSelection'
import { useCurrentAccount } from '../data/useAccount'
import { assertJobSucceeded, waitForJob } from '../data/waitJob'
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
  Progress,
  Select,
  Skeleton,
} from '../ui'
import { Icon } from '../icons'
import { InstancePicker } from './InstancePicker'
import { SaveTransferDialog } from './SaveTransferDialog'

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
  const [transferMode, setTransferMode] = useState<{ mode: 'copy' | 'launch'; name: string } | null>(null)
  const [copied, setCopied] = useState<SaveCopyResult | null>(null)
  const [launched, setLaunched] = useState<{ target: InstanceSummary; sessionId: string; name: string } | null>(null)
  const [shareExport, setShareExport] = useState<ShareExportResult | null>(null)
  const [shareImport, setShareImport] = useState<ShareImportResult | null>(null)
  const [importConflict, setImportConflict] = useState<{ path: string; result: ShareImportResult } | null>(null)
  const [shareJob, setShareJob] = useState<{ kind: 'export' | 'import'; jobId: string; label: string } | null>(null)
  const [jobProgress, setJobProgress] = useState<{ phase: string; files: number; totalFiles: number; bytes: number; totalBytes: number; message: string | null } | null>(null)
  const [cancellingShare, setCancellingShare] = useState(false)
  const [jobNotice, setJobNotice] = useState<string | null>(null)
  const accounts = useCurrentAccount()
  const accountId = accounts.data?.selectedId ?? accounts.data?.accounts[0]?.id ?? null

  useEffect(() => {
    setChosen(new Set())
    setConfirming(false)
    setBackup(null)
    setDeleted(null)
    setError(null)
    setQuery('')
    setFilter('all')
    setTransferMode(null)
    setCopied(null)
    setLaunched(null)
    setShareExport(null)
    setShareImport(null)
    setImportConflict(null)
    setShareJob(null)
    setJobProgress(null)
    setJobNotice(null)
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

  const others = useMemo(
    () => (selection.instances.data ?? []).filter((instance) => instance.id !== selected?.id),
    [selection.instances.data, selected?.id],
  )

  const openTransfer = (mode: 'copy' | 'launch') => {
    if (!chosenName) return
    if (others.length === 0) {
      setError({
        kind: 'error',
        title: '没有其他版本',
        detail: '跨版本操作至少需要两个实例；先在「实例」页创建或导入另一个版本。',
        retryable: false,
      })
      return
    }
    setError(null)
    setCopied(null)
    setLaunched(null)
    setTransferMode({ mode, name: chosenName })
  }

  useEffect(() => {
    if (!shareJob) return
    const onProgress = (event: { jobId: string; phase: string; files: number; totalFiles: number; bytes: number; totalBytes: number; message: string | null }) => {
      if (event.jobId === shareJob.jobId) setJobProgress(event)
    }
    const offExport = backend.instances.subscribeShareExportProgress(onProgress)
    const offImport = backend.instances.subscribeShareImportProgress(onProgress)
    return () => {
      offExport()
      offImport()
    }
  }, [backend, shareJob])

  const handleCopied = (result: SaveCopyResult) => {
    setTransferMode(null)
    setCopied(result)
    if (result.status !== 'skipped') setChosen(new Set())
  }

  const handleLaunched = (target: InstanceSummary, sessionId: string) => {
    const name = transferMode?.name ?? ''
    setTransferMode(null)
    setLaunched({ target, sessionId, name })
  }

  const shareInstance = async () => {
    if (!selected) return
    setBusy('share')
    setError(null)
    setShareExport(null)
    setJobNotice(null)
    try {
      const save = await backend.system.pickSaveFile({
        title: '导出实例分享包',
        defaultPath: `${selected.name}.cubitpack`,
        filters: [{ name: 'Cubit 分享包', extensions: ['cubitpack'] }],
      })
      if (save.cancelled || !save.path) return
      const started = await backend.instances.exportSharePackJob(selected.id, save.path, { saves: true })
      setShareJob({ kind: 'export', jobId: started.jobId, label: `导出「${started.name}」` })
      setJobProgress(null)
      const finished = await waitForJob<ShareExportFinished>({
        jobId: started.jobId,
        subscribe: backend.instances.subscribeShareExportFinished,
        fetchResult: () => backend.instances.shareExportResult(started.jobId),
      })
      setShareJob(null)
      setJobProgress(null)
      if (finished.state === 'cancelled') {
        setJobNotice('导出已取消；主进程已清理半成品分享包。')
        return
      }
      assertJobSucceeded(finished, '导出分享包失败')
      if (finished.result) setShareExport(finished.result)
      else setJobNotice('导出任务已结束，但没有返回结果；请检查目标路径是否可写。')
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
      setShareJob(null)
    }
  }

  const importShare = async (strategy?: ShareConflictStrategy, existingPath?: string) => {
    setError(null)
    setJobNotice(null)
    let filePath = existingPath
    if (!filePath) {
      try {
        const picked = await backend.system.pickFiles({
          title: '选择 Cubit 分享包',
          filters: [{ name: 'Cubit 分享包', extensions: ['cubitpack'] }],
        })
        if (picked.cancelled || picked.paths.length === 0) return
        filePath = picked.paths[0]
      } catch (cause) {
        setError(describeError(cause))
        return
      }
    }
    setBusy('import-share')
    try {
      const started = await backend.instances.importSharePackJob(filePath, undefined, strategy)
      if (started.kind === 'conflict') {
        setImportConflict({ path: filePath, result: started.result })
        return
      }
      if (started.kind === 'skipped') {
        setImportConflict(null)
        setShareImport(started.result)
        return
      }
      setShareJob({ kind: 'import', jobId: started.jobId, label: `导入 ${started.name ?? filePath.split(/[\\/]/).pop() ?? '分享包'}` })
      setJobProgress(null)
      const finished = await waitForJob<ShareImportFinished>({
        jobId: started.jobId,
        subscribe: backend.instances.subscribeShareImportFinished,
        fetchResult: () => backend.instances.shareImportResult(started.jobId),
      })
      setShareJob(null)
      setJobProgress(null)
      if (finished.state === 'cancelled') {
        setJobNotice('导入已取消；主进程已清理 staging 目录。')
        return
      }
      assertJobSucceeded(finished, '导入分享包失败')
      const result = finished.result
      if (!result) {
        setJobNotice('导入任务已结束，但没有返回结果。')
        return
      }
      setImportConflict(null)
      setShareImport(result)
      if (result.status === 'imported') {
        selection.instances.reload()
        window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
      }
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
      setShareJob(null)
    }
  }

  const cancelShareJob = async () => {
    if (!shareJob) return
    setCancellingShare(true)
    setError(null)
    try {
      if (shareJob.kind === 'export') await backend.instances.cancelShareExport(shareJob.jobId)
      else await backend.instances.cancelShareImport(shareJob.jobId)
      setJobNotice('已请求取消任务，等待主进程停止并清理临时文件…')
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setCancellingShare(false)
    }
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
        actions={<Button variant="secondary" icon="chevron-left" onClick={() => navigate('/home')}>返回主页</Button>}
      />

      <InstancePicker selection={selection} onRefresh={selection.instances.reload} hint="存档列表、备份和删除都只作用于当前实例的 saves/。" />

      <Card className="asset-toolbar" pad={false}>
        <div className="asset-toolbar__row">
          <div className="asset-toolbar__group" role="group" aria-label="存档操作">
            <DisabledHint hint={chosen.size !== 1
              ? '先勾选 1 个世界'
              : others.length === 0
                ? '没有其他版本；先在实例页创建或导入另一个版本'
                : '用另一个实例（版本）启动，并直接进入该世界（1.20+）'}>
              <Button size="sm" variant="secondary" icon="play" disabled={chosen.size !== 1 || others.length === 0 || busy !== null} onClick={() => openTransfer('launch')}>用其他版本启动</Button>
            </DisabledHint>
            <DisabledHint hint={chosen.size !== 1
              ? '先勾选 1 个世界'
              : others.length === 0
                ? '没有其他版本；先在实例页创建或导入另一个版本'
                : '把存档复制到另一个实例（版本），同名冲突可选覆盖/跳过/改名'}>
              <Button size="sm" variant="secondary" icon="copy" disabled={chosen.size !== 1 || others.length === 0 || busy !== null} onClick={() => openTransfer('copy')}>复制到其他版本</Button>
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
            <DisabledHint hint={!selected ? '先选择实例' : '导出当前实例的分享包（.cubitpack，包含存档）'}>
              <Button size="sm" variant="secondary" icon="external" disabled={!selected || busy !== null || shareJob !== null} loading={busy === 'share'} onClick={() => void shareInstance()}>分享</Button>
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
            <DisabledHint hint="选择 .cubitpack 分享包；同名实例可选覆盖/跳过/改名">
              <Button size="sm" variant="secondary" icon="package" disabled={busy !== null || shareJob !== null} loading={busy === 'import-share'} onClick={() => void importShare()}>导入分享包</Button>
            </DisabledHint>
            <DisabledHint hint={selected ? '打开当前实例的 saves/ 目录' : '先选择实例'}>
              <Button size="sm" variant="secondary" icon="folder" disabled={!selected} onClick={openFolder}>打开存档目录</Button>
            </DisabledHint>
          </div>
        </div>
      </Card>

      {shareJob ? (
        <Banner
          tone="info"
          title={shareJob.kind === 'export' ? '正在导出分享包' : '正在导入分享包'}
          actions={(
            <Button size="sm" variant="danger-ghost" icon="close" loading={cancellingShare} onClick={() => void cancelShareJob()}>取消</Button>
          )}
        >
          <Progress
            value={jobProgress
              ? jobProgress.totalFiles > 0
                ? jobProgress.files / jobProgress.totalFiles * 100
                : jobProgress.totalBytes > 0 ? jobProgress.bytes / jobProgress.totalBytes * 100 : null
              : null}
            label="分享包任务进度"
          />
          <div className="muted">
            {jobProgress
              ? `${jobProgress.phase} · ${jobProgress.files}/${jobProgress.totalFiles} 个文件 · ${formatBytes(jobProgress.bytes)} / ${formatBytes(jobProgress.totalBytes)}${jobProgress.message ? ` · ${jobProgress.message}` : ''}`
              : `${shareJob.label}：准备中…`}
          </div>
        </Banner>
      ) : null}
      {jobNotice ? <Banner tone="warning" title="任务提示">{jobNotice}</Banner> : null}
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

      {copied ? (
        <Banner
          tone={copied.status === 'skipped' || copied.warnings.length > 0 ? 'warning' : 'success'}
          title={copied.status === 'skipped' ? '已跳过同名存档' : '存档已复制到其他版本'}
        >
          {copied.status === 'skipped'
            ? `目标实例已有同名世界「${copied.sourceName}」，源存档保持不动。`
            : `${copied.sourceName} → ${copied.targetName ?? copied.sourceName}（${copied.files} 个文件，${formatBytes(copied.bytes)}）${copied.renamed ? '，同名已自动改名' : ''}${copied.warnings.length > 0 ? `。${copied.warnings.join('；')}` : ''}`}
        </Banner>
      ) : null}
      {launched ? (
        <Banner tone="success" title={`已在「${launched.target.name}」启动游戏`}>
          世界「{launched.name}」将通过 quickPlay 直接进入；会话 <span className="mono">{launched.sessionId}</span>。切换页面不会结束游戏。
        </Banner>
      ) : null}
      {shareExport ? (
        <Banner
          tone={shareExport.warnings.length > 0 ? 'warning' : 'success'}
          title="分享包已导出"
        >
          已生成 <span className="mono">{shareExport.path}</span>（{shareExport.files} 个文件，{formatBytes(shareExport.bytes)}；脱敏 {shareExport.redactions.length} 处）。
          {shareExport.warnings.length > 0 ? ` ${shareExport.warnings.join('；')}` : ''}
        </Banner>
      ) : null}
      {shareImport ? (
        <Banner
          tone={shareImport.status === 'skipped' || shareImport.warnings.length > 0 || !shareImport.launchable ? 'warning' : 'success'}
          title={shareImport.status === 'skipped' ? '已跳过分享包导入' : `分享包已导入：${shareImport.name}`}
        >
          {shareImport.status === 'skipped'
            ? '目标实例已存在，分享包未写入；源包保持不变。'
            : [
                `${shareImport.mcVersion ?? '版本未知'} · ${shareImport.loader.type}${shareImport.loader.version ? ` ${shareImport.loader.version}` : ''} · ${shareImport.files} 个文件 / ${formatBytes(shareImport.bytes)}`,
                shareImport.needsBaseInstall ? '需要先安装基础 Minecraft 版本才能启动' : null,
                !shareImport.launchable && !shareImport.needsBaseInstall ? `缺少 ${shareImport.missingLibraries} 个库文件，请到实例详情校验` : null,
                shareImport.warnings.length > 0 ? shareImport.warnings.join('；') : null,
              ].filter(Boolean).join('；')}
        </Banner>
      ) : null}
      {importConflict ? (
        <Banner
          tone="warning"
          title={`实例「${importConflict.result.name}」已存在`}
          actions={(
            <>
              <Button size="sm" variant="secondary" icon="upload" loading={busy === 'import-share'} onClick={() => void importShare('overwrite', importConflict.path)}>覆盖</Button>
              <Button size="sm" variant="secondary" icon="edit" loading={busy === 'import-share'} onClick={() => void importShare('rename', importConflict.path)}>改名为副本</Button>
              <Button size="sm" variant="ghost" loading={busy === 'import-share'} onClick={() => void importShare('skip', importConflict.path)}>跳过</Button>
            </>
          )}
        >
          覆盖会先备份现有实例再替换；改名为副本会生成 -2/-3 后缀；跳过不写入任何文件。
        </Banner>
      ) : null}
      {transferMode && selected ? (
        <SaveTransferDialog
          mode={transferMode.mode}
          source={selected}
          saveName={transferMode.name}
          targets={others}
          accountId={accountId}
          onClose={() => setTransferMode(null)}
          onCopied={handleCopied}
          onLaunched={handleLaunched}
        />
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
