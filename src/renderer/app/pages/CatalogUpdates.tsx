import { useEffect, useState } from 'react'
import type { CatalogUpdateCheck, CatalogUpdateItem, CatalogUpdateResult } from '@shared/catalog'
import type { InstanceSummary } from '@shared/instance'
import { useBackend } from '../data/BackendContext'
import {
  describeError,
  type CatalogCheckProgressEvent,
  type CatalogInstallProgressEvent,
  type CatalogUpdatedEvent,
  type UiErrorInfo,
} from '../data/backend'
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Progress,
  Switch,
  copyToClipboard,
} from '../ui'
import { Icon } from '../icons'
import { formatBytes, shortText, versionTypeLabel } from './catalogUtils'

const PHASE_LABEL: Record<CatalogCheckProgressEvent['phase'], string> = {
  scan: '扫描已装模组',
  hash: '计算 SHA-1',
  lookup: '反查 Modrinth',
  versions: '读取版本列表',
  compare: '比较更新',
}

const RISK_META: Record<CatalogUpdateItem['risk'], { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  ok: { label: '可安全更新', tone: 'success' },
  warning: { label: '需要确认', tone: 'warning' },
  blocked: { label: '已阻止', tone: 'danger' },
}

function UpdateRow({
  item,
  ack,
  allowPrerelease,
  updating,
  onAllowPrerelease,
  onRequestUpdate,
}: {
  item: CatalogUpdateItem
  ack: boolean
  allowPrerelease: boolean
  updating: boolean
  onAllowPrerelease: (next: boolean) => void
  onRequestUpdate: () => void
}) {
  const meta = RISK_META[item.risk]
  const prerelease = item.latestVersionType !== 'release'
  const blocked = item.risk === 'blocked'
  const disabledReason = blocked
    ? (item.reason ?? (item.warnings.join('；') || '该更新与实例不兼容'))
    : !ack
      ? '先勾选“我了解旧文件会进入回收站”'
      : prerelease && !allowPrerelease
        ? '这是测试版，需要先允许预发布版本'
        : null
  return (
    <div className={`catalog-update${blocked ? ' is-blocked' : ''}`}>
      <div className="catalog-update__main">
        <div className="catalog-update__title">
          <strong>{item.title}</strong>
          <Badge tone={meta.tone}>{meta.label}</Badge>
          <Badge tone="outline">{versionTypeLabel(item.latestVersionType)}</Badge>
          {!item.currentEnabled ? <Badge tone="warning">当前已禁用</Badge> : null}
        </div>
        <div className="catalog-update__meta">
          <span className="mono">{item.currentFile}</span>
          <span>{item.currentVersion ?? '未知版本'} → <strong>{item.latestVersion}</strong></span>
          <span>{formatBytes(item.size)}</span>
        </div>
        <div className="catalog-update__changelog">
          {item.changelogSummary ? shortText(item.changelogSummary, 600) : <span className="muted">上游没有提供更新日志摘要。</span>}
        </div>
        {item.warnings.length ? <div className="catalog-update__warnings">{item.warnings.join('；')}</div> : null}
        {blocked && item.reason ? <div className="catalog-update__reason">阻止原因：{item.reason}</div> : null}
        {prerelease && !blocked ? (
          <label className="catalog-prerelease catalog-prerelease--row">
            <input type="checkbox" checked={allowPrerelease} onChange={(event) => onAllowPrerelease(event.target.checked)} />
            <span>允许本次更新安装 beta/alpha（{versionTypeLabel(item.latestVersionType)}）</span>
          </label>
        ) : null}
      </div>
      <div className="catalog-update__actions">
        <Button
          size="sm"
          variant={blocked ? 'secondary' : 'primary'}
          icon="refresh"
          loading={updating}
          disabled={Boolean(disabledReason) || updating}
          title={disabledReason ?? '先确认旧文件回收，再执行更新'}
          onClick={onRequestUpdate}
        >
          更新
        </Button>
        {disabledReason ? <span className="catalog-update__disabled">{disabledReason}</span> : null}
      </div>
    </div>
  )
}

export function CatalogUpdates({ instance }: { instance: InstanceSummary | null }) {
  const backend = useBackend()
  const [includeDisabled, setIncludeDisabled] = useState(false)
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState<CatalogCheckProgressEvent | null>(null)
  const [check, setCheck] = useState<CatalogUpdateCheck | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [ack, setAck] = useState(false)
  const [allowPrerelease, setAllowPrerelease] = useState<Record<string, boolean>>({})
  const [confirming, setConfirming] = useState<CatalogUpdateItem | null>(null)
  const [updatingProject, setUpdatingProject] = useState<string | null>(null)
  const [updateProgress, setUpdateProgress] = useState<CatalogInstallProgressEvent | null>(null)
  const [updateResult, setUpdateResult] = useState<CatalogUpdateResult | null>(null)
  const [updateError, setUpdateError] = useState<UiErrorInfo | null>(null)
  const [cancelledNotice, setCancelledNotice] = useState<string | null>(null)
  const [lastUpdated, setLastUpdated] = useState<CatalogUpdatedEvent | null>(null)

  useEffect(() => {
    const offCheck = backend.catalog.subscribeCheckProgress((event) => setProgress(event))
    const offInstall = backend.catalog.subscribeInstallProgress((event) => setUpdateProgress(event))
    const offUpdated = backend.catalog.subscribeUpdated((event) => setLastUpdated(event))
    return () => {
      offCheck()
      offInstall()
      offUpdated()
    }
  }, [backend])

  useEffect(() => {
    setCheck(null)
    setError(null)
    setProgress(null)
    setUpdateResult(null)
    setUpdateError(null)
    setUpdateProgress(null)
    setConfirming(null)
    setAck(false)
    setAllowPrerelease({})
    setCancelledNotice(null)
    setLastUpdated(null)
  }, [instance?.id])

  const runCheck = async () => {
    if (!instance) return
    setChecking(true)
    setError(null)
    setCheck(null)
    setProgress(null)
    setUpdateResult(null)
    setUpdateError(null)
    setCancelledNotice(null)
    try {
      setCheck(await backend.catalog.checkUpdates({ instanceId: instance.id, includeDisabled }))
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setChecking(false)
      setProgress(null)
    }
  }

  const requestUpdate = (item: CatalogUpdateItem) => {
    setConfirming(item)
    setUpdateError(null)
    setUpdateResult(null)
    setCancelledNotice(null)
  }

  const cancelUpdate = () => {
    setConfirming(null)
    setCancelledNotice('已取消本次更新；没有修改任何文件。')
  }

  const runUpdate = async (item: CatalogUpdateItem) => {
    if (!instance) return
    if (!ack) {
      setUpdateError({ kind: 'error', title: '需要确认回收站', detail: '请先勾选“我了解旧文件会进入回收站”。', retryable: false })
      return
    }
    if (item.risk === 'blocked') {
      setUpdateError({ kind: 'error', title: '更新已被阻止', detail: item.reason ?? '该更新与实例不兼容。', retryable: false })
      return
    }
    if (item.latestVersionType !== 'release' && !allowPrerelease[item.projectId]) {
      setUpdateError({ kind: 'error', title: '测试版未确认', detail: '请先勾选允许 beta/alpha，再确认更新。', retryable: false })
      return
    }
    setUpdatingProject(item.projectId)
    setConfirming(null)
    setUpdateError(null)
    setUpdateResult(null)
    setUpdateProgress(null)
    try {
      const result = await backend.catalog.update({
        instanceId: instance.id,
        projectId: item.projectId,
        versionId: item.latestVersionId,
        currentFile: item.currentFile,
        allowPrerelease: Boolean(allowPrerelease[item.projectId]),
      })
      setUpdateResult(result)
      setCheck((previous) => previous ? {
        ...previous,
        updates: previous.updates.filter((entry) => entry.projectId !== item.projectId),
      } : previous)
    } catch (cause) {
      setUpdateError(describeError(cause))
    } finally {
      setUpdatingProject(null)
    }
  }

  const copyRecycledPath = () => {
    if (!updateResult?.recycledPath) return
    void copyToClipboard(updateResult.recycledPath)
  }

  if (!instance) {
    return (
      <EmptyState
        icon="refresh"
        title="先选择一个实例"
        description="模组更新检查需要实例的已装 mods 目录和 SHA-1 文件；没有目标实例时不会发起网络请求。"
      />
    )
  }

  const checkedAt = check ? new Date(check.checkedAt).toLocaleString('zh-CN') : null
  const percent = progress && progress.total > 0 ? Math.min(100, (progress.done / progress.total) * 100) : null

  return (
    <>
      <Banner tone="warning" title="更新前请确认文件回收">
        更新不会删除旧模组：旧文件会移入 <code className="mono">dataRoot/trash/catalog/&lt;instance&gt;/&lt;timestamp&gt;/</code>，可手动回滚；如果下载/校验/安装失败，新文件会被清理，旧文件保持不变。
      </Banner>

      <Card className="catalog-updates-toolbar">
        <div>
          <div className="catalog-updates-toolbar__title"><Icon name="refresh" /><strong>模组更新检查</strong><Badge tone="outline">Modrinth SHA-1 反查</Badge></div>
          <p>只读取 <code className="mono">mods/</code> 下的文件；检查通过 <code className="mono">mc:catalog:checkUpdates</code> 与 checkProgress 事件回显。</p>
        </div>
        <div className="catalog-updates-toolbar__actions">
          <Switch checked={includeDisabled} onChange={setIncludeDisabled} label="包含已禁用模组" />
          <Button size="sm" variant="secondary" icon="search" onClick={() => void runCheck()} loading={checking} disabled={instance.state !== 'ready'} title={instance.state !== 'ready' ? `实例状态为 ${instance.state}` : '检查更新'}>
            检查更新
          </Button>
        </div>
      </Card>

      {checking || progress ? (
        <Card className="catalog-check-progress">
          <div className="row gap-8">
            <span className="spinner" />
            <strong>{progress ? PHASE_LABEL[progress.phase] : '准备检查'}</strong>
            <span className="muted">{progress ? `${progress.done}/${progress.total}` : '等待后端'}</span>
            {progress?.currentFile ? <span className="mono subtle">{progress.currentFile}</span> : null}
          </div>
          <Progress value={percent} label="更新检查进度" />
        </Card>
      ) : null}

      {error ? <div className="nw-inline-error">{error.title}：{error.detail}</div> : null}
      {cancelledNotice ? <Banner tone="info">{cancelledNotice}</Banner> : null}
      {updateError ? <div className="nw-inline-error">{updateError.title}：{updateError.detail}</div> : null}
      {updateResult ? (
        <Banner tone="success" title={`已更新 ${updateResult.filename}`}>
          旧文件 <span className="mono">{updateResult.previousFile ?? '—'}</span> 已移入回收站：
          <span className="mono">{updateResult.recycledPath ?? '同路径替换，未产生回收站副本'}</span>。
          新文件：<span className="mono">{updateResult.targetPath}</span>（{formatBytes(updateResult.size)}）。
          <div className="row gap-8" style={{ marginTop: 8 }}>
            {updateResult.recycledPath ? <Button size="xs" variant="secondary" icon="copy" onClick={copyRecycledPath}>复制回收站路径</Button> : null}
            <Button size="xs" variant="ghost" icon="folder" onClick={() => void backend.system.openDataDir().catch(() => undefined)}>打开数据目录（手动回滚）</Button>
          </div>
        </Banner>
      ) : null}
      {lastUpdated && !updateResult ? (
        <Banner tone="info">收到 updated 事件：{lastUpdated.projectId} → {lastUpdated.versionId}{lastUpdated.recycledPath ? `，回收站 ${lastUpdated.recycledPath}` : ''}。</Banner>
      ) : null}
      {updateProgress && updatingProject ? (
        <div className="catalog-progress">
          <div className="row gap-8"><Icon name="download" /><strong>{updateProgress.stage}</strong><span className="muted">{updateProgress.percent === null ? '—' : `${Math.round(updateProgress.percent)}%`} · {formatBytes(updateProgress.bytes)} / {formatBytes(updateProgress.totalBytes)}</span></div>
          <Progress value={updateProgress.percent} label="模组更新进度" />
        </div>
      ) : null}

      {confirming ? (
        <Card className="catalog-confirm">
          <div className="catalog-confirm__title"><Icon name="alert" /><strong>确认更新 {confirming.title}</strong></div>
          <p>
            旧文件 <span className="mono">{confirming.currentFile}</span> 会移入回收站，不会删除；可手动回滚。
            本次将从 <span className="mono">{confirming.currentVersion ?? '未知'}</span> 更新到 <span className="mono">{confirming.latestVersion}</span>。
          </p>
          <div className="row gap-8">
            <Button size="sm" variant="primary" icon="refresh" onClick={() => void runUpdate(confirming)} loading={updatingProject === confirming.projectId}>确认更新</Button>
            <Button size="sm" variant="ghost" icon="close" onClick={cancelUpdate}>取消</Button>
          </div>
        </Card>
      ) : null}

      {check ? (
        <>
          <div className="catalog-check-summary">
            <span><strong>{check.updates.length}</strong> 个可更新</span>
            <span>检查 {check.checked} · 匹配 {check.matched}</span>
            <span>跳过 {check.skipped.length} · 错误 {check.errors.length}</span>
            <span>{check.mcVersion ?? 'MC 未知'} / {check.loader ?? '加载器未知'}</span>
            <span className="subtle">{checkedAt}</span>
          </div>
          <Card className="catalog-ack">
            <label className="catalog-ack__label">
              <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
              <span>我了解更新会把旧文件移入回收站（可手动回滚），并会在确认框中再次确认。</span>
            </label>
            <Badge tone={ack ? 'success' : 'warning'}>{ack ? '已确认' : '未确认'}</Badge>
          </Card>
          {check.updates.length === 0 ? (
            <EmptyState icon="check" title="没有可更新项" description="当前已装模组均为最新，或 Modrinth 未收录文件哈希。检查结果只来自真实 SHA-1 反查。" />
          ) : (
            <div className="catalog-update-list">
              {check.updates.map((item) => (
                <UpdateRow
                  key={`${item.projectId}-${item.currentFile}`}
                  item={item}
                  ack={ack}
                  allowPrerelease={Boolean(allowPrerelease[item.projectId])}
                  updating={updatingProject === item.projectId}
                  onAllowPrerelease={(next) => setAllowPrerelease((previous) => ({ ...previous, [item.projectId]: next }))}
                  onRequestUpdate={() => requestUpdate(item)}
                />
              ))}
            </div>
          )}
          {check.skipped.length ? (
            <details className="catalog-check-details">
              <summary>跳过的文件（{check.skipped.length}）</summary>
              <ul>{check.skipped.map((entry) => <li key={entry.file}><span className="mono">{entry.file}</span>：{entry.reason}</li>)}</ul>
            </details>
          ) : null}
          {check.errors.length ? (
            <details className="catalog-check-details is-error" open>
              <summary>检查错误（{check.errors.length}）</summary>
              <ul>{check.errors.map((entry) => <li key={entry.file}><span className="mono">{entry.file}</span>：{entry.message}</li>)}</ul>
            </details>
          ) : null}
        </>
      ) : !checking ? (
        <EmptyState
          icon="refresh"
          title="尚未检查更新"
          description="点击“检查更新”后，会读取已装 mod 的 SHA-1 并在 Modrinth 反查；检查进度与结果全部来自真实 IPC。"
        />
      ) : null}
    </>
  )
}
