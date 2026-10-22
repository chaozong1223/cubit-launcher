import { useEffect, useState } from 'react'
import type { InstanceSummary } from '@shared/instance'
import type { SaveConflictStrategy, SaveCopyFinished, SaveCopyProgress, SaveCopyResult } from '@shared/assets'
import type { LaunchPlan } from '@shared/launch'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { assertJobSucceeded, waitForJob } from '../data/waitJob'
import { Badge, Banner, Button, Dialog, Progress, Select, Tag } from '../ui'
import { Icon } from '../icons'

function versionLabel(instance: InstanceSummary): string {
  return `${instance.name} · ${instance.mcVersion ?? '版本未知'}`
}

/**
 * Copy a save into another instance (version), or quick-play that save with the
 * target instance (`--quickPlaySingleplayer` for 1.20+).
 *
 * Conflicts are resolved explicitly: the first call omits `conflict`, the backend
 * returns `status: "conflict"` without writing, and the dialog re-runs with the
 * strategy the user picked (overwrite / skip / rename).
 */
export function SaveTransferDialog({
  mode,
  source,
  saveName,
  targets,
  accountId,
  onClose,
  onCopied,
  onLaunched,
}: {
  mode: 'copy' | 'launch'
  source: InstanceSummary
  saveName: string
  targets: InstanceSummary[]
  accountId: string | null
  onClose: () => void
  onCopied: (result: SaveCopyResult) => void
  onLaunched: (target: InstanceSummary, sessionId: string) => void
}) {
  const backend = useBackend()
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [conflict, setConflict] = useState(false)
  const [plan, setPlan] = useState<LaunchPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [copyJobId, setCopyJobId] = useState<string | null>(null)
  const [copyProgress, setCopyProgress] = useState<SaveCopyProgress | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const target = targets.find((instance) => instance.id === targetId) ?? null
  const crossVersion = target
    ? source.mcVersion !== target.mcVersion || source.loader.type !== target.loader.type
    : false

  useEffect(() => {
    if (mode !== 'launch' || !targetId || !accountId) {
      setPlan(null)
      return
    }
    let cancelled = false
    setPlanning(true)
    setError(null)
    void backend.launch.plan(targetId, accountId, saveName).then(
      (next) => { if (!cancelled) setPlan(next) },
      (cause) => {
        if (cancelled) return
        setPlan(null)
        setError(describeError(cause))
      },
    ).finally(() => {
      if (!cancelled) setPlanning(false)
    })
    return () => { cancelled = true }
  }, [accountId, backend, mode, saveName, targetId])

  useEffect(() => {
    if (!copyJobId) return
    const off = backend.assets.subscribeCopySaveProgress((event) => {
      if (event.jobId === copyJobId) setCopyProgress(event)
    })
    return off
  }, [backend, copyJobId])

  const copy = async (strategy?: SaveConflictStrategy) => {
    if (!target) return
    setBusy(true)
    setError(null)
    setConflict(false)
    setNotice(null)
    try {
      const started = await backend.assets.copySaveJob(source.id, saveName, target.id, undefined, strategy)
      if (started.kind === 'conflict') {
        setConflict(true)
        return
      }
      if (started.kind === 'skipped') {
        onCopied(started.result)
        return
      }
      setCopyJobId(started.jobId)
      setCopyProgress(null)
      const finished = await waitForJob<SaveCopyFinished>({
        jobId: started.jobId,
        subscribe: backend.assets.subscribeCopySaveFinished,
        fetchResult: () => backend.assets.copySaveResult(started.jobId),
      })
      setCopyJobId(null)
      if (finished.state === 'cancelled') {
        setNotice('复制已取消；目标世界目录已被主进程清理。')
        return
      }
      assertJobSucceeded(finished, '复制存档失败')
      if (finished.result) onCopied(finished.result)
      else setNotice('复制任务已结束，但没有返回结果；请到目标实例的存档页确认。')
    } catch (cause) {
      setConflict(false)
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const cancelCopy = async () => {
    if (!copyJobId) return
    setCancelling(true)
    setError(null)
    try {
      await backend.assets.cancelCopySave(copyJobId)
      setNotice('已请求取消复制，等待主进程清理…')
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setCancelling(false)
    }
  }

  const launch = async () => {
    if (!target) return
    setBusy(true)
    setError(null)
    try {
      const started = await backend.launch.start(target.id, accountId, saveName)
      onLaunched(target, started.sessionId)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const title = mode === 'copy' ? '复制存档到其他版本' : '用其他版本启动'
  const footer = (
    <>
      {mode === 'copy' && copyJobId ? (
        <Button variant="danger-ghost" icon="close" loading={cancelling} onClick={() => void cancelCopy()}>取消复制</Button>
      ) : null}
      <Button variant="secondary" onClick={onClose} disabled={busy}>取消</Button>
      {mode === 'copy' ? (
        <Button variant="primary" icon="copy" loading={busy && copyJobId === null} disabled={!target || busy || copyJobId !== null} onClick={() => void copy()}>复制到该版本</Button>
      ) : (
        <Button
          variant="primary"
          icon="play"
          loading={busy}
          disabled={!target || busy || planning || !plan || !accountId}
          onClick={() => void launch()}
        >
          启动游戏
        </Button>
      )}
    </>
  )

  return (
    <Dialog
      title={title}
      subtitle={`${source.name} · 世界「${saveName}」`}
      icon={mode === 'copy' ? 'copy' : 'play'}
      onClose={copyJobId ? () => { /* keep the dialog open while the copy job runs */ } : onClose}
      footer={footer}
    >
      <div className="save-transfer">
        <label className="save-transfer__label" htmlFor="save-transfer-target">
          {mode === 'copy' ? '目标版本（实例）' : '启动所用的版本（实例）'}
        </label>
        <Select
          id="save-transfer-target"
          aria-label="目标版本"
          value={targetId}
          onChange={(event) => { setTargetId(event.target.value); setConflict(false) }}
          disabled={busy || targets.length === 0}
        >
          {targets.length === 0
            ? <option value="">没有其他版本</option>
            : targets.map((instance) => <option key={instance.id} value={instance.id}>{versionLabel(instance)}</option>)}
        </Select>
        {target ? (
          <div className="save-transfer__meta">
            <Tag variant={target.loader.type === 'fabric' ? 'fabric' : target.loader.type === 'forge' ? 'forge' : target.loader.type === 'neoforge' ? 'neo' : target.loader.type === 'quilt' ? 'pack' : 'vanilla'}>
              {target.loader.type}
            </Tag>
            <span>{target.mcVersion ?? '版本未知'}</span>
            <span className="subtle">{target.state === 'ready' ? '可读写' : target.state}</span>
          </div>
        ) : null}

        {crossVersion ? (
          <Banner tone="warning" title="跨版本复制/启动">
            源与目标实例的 MC 版本或加载器不同：模组方块、实体和数据包可能丢失，部分方块会变成未知方块。
          </Banner>
        ) : null}

        {mode === 'launch' ? (
          accountId === null ? (
            <Banner tone="warning" title="没有可用的启动账户">
              先在「设置 → 账户」创建一个离线账户或登录正版账户，再使用「用其他版本启动」。
            </Banner>
          ) : planning ? (
            <div className="save-transfer__planning"><span className="spinner" /><span>正在检查目标版本的启动配置…</span></div>
          ) : plan ? (
            <div className="save-transfer__plan">
              <div className="save-transfer__plan-row">
                <span>启动版本</span>
                <span className="mono">{plan.versionId}</span>
              </div>
              <div className="save-transfer__plan-row">
                <span>世界直达参数</span>
                <span className="mono">--quickPlaySingleplayer {saveName}</span>
              </div>
              {plan.warnings.length > 0 ? (
                <Banner tone="warning" title="启动检查提示">
                  {plan.warnings.join('；')}
                </Banner>
              ) : (
                <Badge tone="success">启动计划检查通过</Badge>
              )}
            </div>
          ) : null
        ) : null}

        {conflict ? (
          <Banner
            tone="warning"
            title="目标版本已有同名世界"
            actions={(
              <>
                <Button size="sm" variant="secondary" icon="copy" loading={busy} onClick={() => void copy('overwrite')}>覆盖</Button>
                <Button size="sm" variant="secondary" icon="edit" loading={busy} onClick={() => void copy('rename')}>自动改名</Button>
                <Button size="sm" variant="ghost" loading={busy} onClick={() => void copy('skip')}>跳过</Button>
              </>
            )}
          >
            覆盖会先备份目标世界再替换；跳过保持目标世界不变；自动改名会生成 -2/-3 后缀。
          </Banner>
        ) : null}

        {copyJobId ? (
          <div className="save-transfer__progress" role="status" aria-live="polite">
            <div className="save-transfer__plan-row">
              <span>复制进度</span>
              <span>{copyProgress ? `${copyProgress.files}/${copyProgress.totalFiles} 个文件 · ${Math.round(copyProgress.bytes / 1024 / 1024)}/${Math.round(copyProgress.totalBytes / 1024 / 1024)} MB` : '准备中…'}</span>
            </div>
            <Progress
              value={copyProgress
                ? copyProgress.totalFiles > 0
                  ? copyProgress.files / copyProgress.totalFiles * 100
                  : copyProgress.totalBytes > 0 ? copyProgress.bytes / copyProgress.totalBytes * 100 : null
                : null}
              label="存档复制进度"
            />
            <span className="save-transfer__hint">{copyProgress?.message ?? copyProgress?.phase ?? '后台复制中，可取消。'}</span>
          </div>
        ) : null}

        {notice ? <Banner tone="warning" title="操作提示">{notice}</Banner> : null}

        {error ? (
          <div className="nw-inline-error" role="alert">
            <Icon name="alert-circle" /> {error.title}：{error.detail}
          </div>
        ) : null}

        {mode === 'copy' ? (
          <p className="save-transfer__hint">
            源世界保持不动；目标实例运行中或与源实例相同时，主进程会拒绝复制。
          </p>
        ) : (
          <p className="save-transfer__hint">
            目标是另一个实例（版本）；<strong>1.20+</strong> 会用 quickPlay 直接进入该世界，更早版本会正常启动并给出提示。
          </p>
        )}
      </div>
    </Dialog>
  )
}
