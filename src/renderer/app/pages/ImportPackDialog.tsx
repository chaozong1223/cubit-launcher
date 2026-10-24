import { useEffect, useState } from 'react'
import type { CurseForgeConfigView, LinkImportFinished, PackLinkPlan } from '@shared/catalog'
import type { ModpackImportFinished, ModpackImportProgress } from '@shared/mods'
import type { LoaderType } from '@shared/loader'
import { useBackend } from '../data/BackendContext'
import {
  BackendError,
  describeError,
  type CatalogLinkProgressEvent,
  type UiErrorInfo,
} from '../data/backend'
import { assertJobSucceeded, waitForJob } from '../data/waitJob'
import { Badge, Banner, Button, Dialog, Field, Input, Progress, Segmented } from '../ui'
import { Icon } from '../icons'

function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '未知'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

function providerLabel(provider: PackLinkPlan['provider']): string {
  return provider === 'curseforge' ? 'CurseForge' : 'Modrinth'
}

type Mode = 'link' | 'local'

/**
 * The main process reports a missing loader as a plain message:
 * "未找到整合包所需的 forge 14.23.5.2864 加载器（Minecraft 1.12.2）；…".
 * Parse it so the dialog can offer to install exactly that loader and continue.
 */
function parseMissingLoader(
  detail: string,
): { type: LoaderType; version: string; mcVersion: string } | null {
  const match = /(forge|neoforge|fabric|quilt)\s+([0-9A-Za-z._+-]+)\s*加载器（Minecraft\s+([0-9A-Za-z._+-]+)）/i.exec(
    detail,
  )
  if (!match) return null
  const type = match[1].toLowerCase() as LoaderType
  if (!['forge', 'neoforge', 'fabric', 'quilt'].includes(type)) return null
  return { type, version: match[2], mcVersion: match[3] }
}

/**
 * Import dialog for integration packs:
 * - paste a Modrinth / CurseForge pack link → plan → explicit confirm → download + import job;
 * - or pick a local .mrpack/.zip and watch the same cancellable mods import job.
 *
 * The pack link download phase has no main-process cancel channel yet; the cancel
 * button targets the mods import job once it starts.
 */
export function ImportPackDialog({
  open,
  onClose,
  onImported,
}: {
  open: boolean
  onClose: () => void
  onImported: (instanceId: string, name: string) => void
}) {
  const backend = useBackend()
  const [mode, setMode] = useState<Mode>('link')
  const [link, setLink] = useState('')
  const [plan, setPlan] = useState<PackLinkPlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<UiErrorInfo | null>(null)
  const [starting, setStarting] = useState(false)
  const [linkJobId, setLinkJobId] = useState<string | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [jobProgress, setJobProgress] = useState<ModpackImportProgress | null>(null)
  const [linkProgress, setLinkProgress] = useState<CatalogLinkProgressEvent | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [picking, setPicking] = useState(false)
  const [missingLoader, setMissingLoader] = useState<
    { type: LoaderType; version: string; mcVersion: string; packPath: string } | null
  >(null)
  const [loaderBusy, setLoaderBusy] = useState(false)
  const [pendingPackPath, setPendingPackPath] = useState<string | null>(null)
  const [cf, setCf] = useState<CurseForgeConfigView | null>(null)
  const [cfKey, setCfKey] = useState('')
  const [cfMirror, setCfMirror] = useState('')
  const [cfBusy, setCfBusy] = useState(false)
  const [cfMessage, setCfMessage] = useState<string | null>(null)

  const running = starting || picking || jobId !== null || linkJobId !== null
  const canCancel = (jobId !== null || linkJobId !== null) && !cancelling

  useEffect(() => {
    if (!open) return
    let cancelled = false
    backend.catalog.getCurseForgeConfig().then(
      (config) => {
        if (cancelled) return
        setCf(config)
        setCfMirror(config.mirrorBase ?? '')
      },
      () => { /* settings are optional; the plan reports whether a key is needed */ },
    )
    return () => { cancelled = true }
  }, [backend, open])

  useEffect(() => {
    if (!open) return
    const off = backend.catalog.subscribeLinkProgress((event) => {
      setLinkProgress((current) => current?.planId === event.planId || plan?.planId === event.planId ? event : current)
    })
    return off
  }, [backend, open, plan?.planId])

  useEffect(() => {
    if (!jobId) return
    const off = backend.mods.subscribeImportProgress((event) => {
      if (event.jobId === jobId) setJobProgress(event)
    })
    return off
  }, [backend, jobId])

  useEffect(() => {
    if (open) return
    setPlan(null)
    setPlanError(null)
    setPlanning(false)
    setStarting(false)
    setLinkJobId(null)
    setJobId(null)
    setJobProgress(null)
    setLinkProgress(null)
    setError(null)
    setNotice(null)
    setLink('')
    setPicking(false)
  }, [open])

  if (!open) return null

  const parseLink = async () => {
    const value = link.trim()
    if (!value) {
      setPlanError({ kind: 'error', title: '请先粘贴链接', detail: '支持 Modrinth / CurseForge 的整合包项目或文件链接。', retryable: false })
      return
    }
    setPlanning(true)
    setPlanError(null)
    setError(null)
    setNotice(null)
    setPlan(null)
    setLinkProgress(null)
    setJobProgress(null)
    try {
      setPlan(await backend.catalog.planLinkImport(value))
    } catch (cause) {
      setPlanError(describeError(cause))
    } finally {
      setPlanning(false)
    }
  }

  const awaitImportJob = async (id: string, startedNotice: string) => {
    setJobId(id)
    setJobProgress(null)
    setNotice(startedNotice)
    const finished = await waitForJob<ModpackImportFinished>({
      jobId: id,
      subscribe: backend.mods.subscribeImportFinished,
      fetchResult: () => backend.mods.importResult(id),
    })
    setJobId(null)
    if (finished.state === 'cancelled') {
      setNotice('导入已取消；主进程已清理临时文件。')
      return
    }
    assertJobSucceeded(finished, '整合包导入失败')
    const result = finished.result
    if (!result) throw new BackendError('PACK.IMPORT_FAILED', '整合包导入没有返回结果', false)
    onImported(result.instanceId, result.name)
  }

  const confirmLinkImport = async () => {
    if (!plan?.canProceed) return
    setStarting(true)
    setError(null)
    setNotice(null)
    setJobProgress(null)
    setLinkProgress(null)
    try {
      const started = await backend.catalog.startLinkImport(plan.planId)
      setLinkJobId(started.jobId)
      setNotice('开始下载整合包…可在下载过程中取消。')
      const finished = await waitForJob<LinkImportFinished>({
        jobId: started.jobId,
        subscribe: backend.catalog.subscribeLinkFinished,
        fetchResult: () => backend.catalog.linkImportResult(started.jobId),
      })
      setLinkJobId(null)
      if (finished.state === 'cancelled') {
        setNotice('下载已取消；主进程已清理 .part 与临时文件。')
        return
      }
      assertJobSucceeded(finished, '整合包下载失败')
      const result = finished.result
      if (!result) throw new BackendError('CATALOG.LINK_IMPORT_FAILED', '链接导入没有返回结果', false)
      await awaitImportJob(result.import.jobId, `已下载 ${formatBytes(result.downloadBytes)}，开始导入整合包…`)
    } catch (cause) {
      setLinkJobId(null)
      setError(describeError(cause))
    } finally {
      setStarting(false)
    }
  }

  const pickLocal = async () => {
    setPicking(true)
    setError(null)
    setPlanError(null)
    setNotice(null)
    setLinkProgress(null)
    setJobProgress(null)
    let chosenPath = ''
    try {
      const picked = await backend.system.pickFiles({
        title: '选择整合包',
        filters: [{ name: '整合包（.mrpack / .zip）', extensions: ['mrpack', 'zip'] }],
      })
      if (picked.cancelled || picked.paths.length === 0) return
      chosenPath = picked.paths[0]
      const started = await backend.mods.importModpack(chosenPath)
      setPendingPackPath(chosenPath)
      await awaitImportJob(started.jobId, `已开始后台导入「${started.name}」（${started.totalFiles} 个文件）…`)
    } catch (cause) {
      const info = describeError(cause)
      // The pack needs a loader that is not installed yet: offer the one-click
      // "install the loader, then import" path instead of a dead end.
      const missing = parseMissingLoader(info.detail)
      if (missing && chosenPath) {
        setMissingLoader({ ...missing, packPath: chosenPath })
        setError(null)
      } else {
        setError(info)
      }
    } finally {
      setPicking(false)
    }
  }

  const installMissingLoader = async () => {
    if (!missingLoader) return
    setLoaderBusy(true)
    setError(null)
    setNotice(`正在安装 ${missingLoader.type} ${missingLoader.version}（Minecraft ${missingLoader.mcVersion}）…`)
    try {
      const started = await backend.loader.install({
        type: missingLoader.type,
        mcVersion: missingLoader.mcVersion,
        loaderVersion: missingLoader.version,
      })
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const progress = await backend.loader.status(started.jobId)
        if (progress) {
          setNotice(
            `安装 ${missingLoader.type} ${missingLoader.version} · ${progress.stage}` +
              (progress.percent === null ? '' : ` ${Math.round(progress.percent)}%`),
          )
          if (progress.state === 'done') break
          if (progress.state === 'failed' || progress.state === 'cancelled') {
            throw new BackendError(
              'LOADER.INSTALL_FAILED',
              `加载器安装${progress.state === 'cancelled' ? '已取消' : '失败'}：${progress.message ?? '没有更多信息'}`,
              true,
            )
          }
        }
      }
      const packPath = missingLoader.packPath
      setMissingLoader(null)
      setNotice('加载器已安装，继续导入整合包…')
      const retry = await backend.mods.importModpack(packPath)
      setPendingPackPath(packPath)
      await awaitImportJob(retry.jobId, `继续导入「${retry.name}」（${retry.totalFiles} 个文件）…`)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setLoaderBusy(false)
    }
  }

  const cancelImport = async () => {
    if (!jobId && !linkJobId) return
    setCancelling(true)
    setError(null)
    try {
      if (linkJobId) {
        await backend.catalog.cancelLinkImport(linkJobId)
        setNotice('已请求取消下载；主进程会停止连接并删除 .part 文件…')
      } else if (jobId) {
        await backend.mods.cancelImport(jobId)
        setNotice('已请求取消导入，等待主进程停止并清理临时文件…')
      }
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setCancelling(false)
    }
  }

  const saveCurseForge = async () => {
    setCfBusy(true)
    setCfMessage(null)
    setError(null)
    try {
      const key = cfKey.trim()
      const mirror = cfMirror.trim()
      const patch: { apiKey?: string; mirrorBase?: string | null } = {}
      if (key) patch.apiKey = key
      if (mirror !== (cf?.mirrorBase ?? '')) patch.mirrorBase = mirror ? mirror : null
      if (Object.keys(patch).length === 0) {
        setCfMessage('没有变化。')
        return
      }
      const next = await backend.catalog.updateCurseForgeConfig(patch)
      setCf(next)
      setCfKey('')
      setCfMirror(next.mirrorBase ?? '')
      setCfMessage(`已保存：${next.hasApiKey ? 'API Key 已配置' : '未配置 API Key'}${next.mirrorBase ? ` · 镜像 ${next.mirrorBase}` : ''}。重新解析链接后会使用新设置。`)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setCfBusy(false)
    }
  }

  const progressValue = jobProgress
    ? (jobProgress.total > 0 ? jobProgress.done / jobProgress.total * 100 : jobProgress.bytesTotal > 0 ? jobProgress.bytesDone / jobProgress.bytesTotal * 100 : null)
    : linkProgress && linkProgress.totalBytes && linkProgress.totalBytes > 0
      ? linkProgress.bytes / linkProgress.totalBytes * 100
      : null
  const progressLabel = jobProgress
    ? `${jobProgress.stage} · ${jobProgress.done}/${jobProgress.total} 个文件${jobProgress.currentFile ? ` · ${jobProgress.currentFile}` : ''}`
    : linkProgress
      ? linkProgress.state === 'downloading'
        ? `下载整合包 · ${formatBytes(linkProgress.bytes)} / ${formatBytes(linkProgress.totalBytes)}`
        : linkProgress.state === 'verifying' ? '校验整合包…' : linkProgress.state === 'importing' ? '准备导入…' : linkProgress.state
      : '正在准备…'

  return (
    <Dialog
      title="导入整合包"
      subtitle="链接导入（Modrinth / CurseForge）或选择本地 .mrpack / .zip；导入是后台作业，可取消。"
      icon="package"
      wide
      onClose={running ? () => { /* keep dialog open while a job runs; cancel first */ } : onClose}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={running}>关闭</Button>
          {mode === 'local' ? (
            <Button variant="primary" icon="package" loading={picking} disabled={running} onClick={() => void pickLocal()}>选择本地整合包</Button>
          ) : plan ? (
            <Button variant="primary" icon="download" loading={starting} disabled={running || !plan.canProceed} onClick={() => void confirmLinkImport()}>开始下载并导入</Button>
          ) : (
            <Button variant="primary" icon="search" loading={planning} disabled={running} onClick={() => void parseLink()}>解析链接</Button>
          )}
          {canCancel ? (
            <Button variant="danger-ghost" icon="close" loading={cancelling} onClick={() => void cancelImport()}>取消导入</Button>
          ) : null}
        </>
      )}
    >
      <div className="import-pack">
        <Segmented
          value={mode}
          ariaLabel="导入方式"
          options={[{ value: 'link', label: '粘贴链接' }, { value: 'local', label: '本地文件' }]}
          onChange={(next) => {
            if (running) return
            setMode(next)
            setError(null)
            setNotice(null)
            setPlanError(null)
          }}
        />

        {mode === 'link' ? (
          <>
            <div className="import-pack__linkrow">
              <Input
                value={link}
                onChange={(event) => setLink(event.target.value)}
                placeholder="https://modrinth.com/modpack/… 或 https://www.curseforge.com/minecraft/modpacks/…"
                aria-label="整合包链接"
                disabled={running}
                onKeyDown={(event) => { if (event.key === 'Enter' && !planning && !running) void parseLink() }}
              />
              <Button size="sm" variant="secondary" icon="search" loading={planning} disabled={running} onClick={() => void parseLink()}>解析</Button>
            </div>
            <p className="import-pack__hint">
              先解析出项目/版本/文件并展示警告，点「开始下载并导入」才会真正下载；非法或私密链接会给出可读错误。
            </p>

            {planError ? <Banner tone="danger" title={planError.title}>{planError.detail}{planError.code ? `（${planError.code}）` : ''}</Banner> : null}

            {missingLoader ? (
              <Banner
                tone="warning"
                title={`需要先安装 ${missingLoader.type} ${missingLoader.version}`}
                actions={
                  <div className="row gap-8">
                    <Button size="sm" variant="primary" icon="download" loading={loaderBusy} onClick={() => void installMissingLoader()}>
                      安装加载器并继续导入
                    </Button>
                    <Button size="sm" variant="ghost" disabled={loaderBusy} onClick={() => setMissingLoader(null)}>
                      取消
                    </Button>
                  </div>
                }
              >
                这个整合包基于 Minecraft {missingLoader.mcVersion}，还没装对应的 {missingLoader.type} 加载器。
                点按钮会先安装加载器，装好后自动继续导入同一个文件。
              </Banner>
            ) : null}

            {plan ? (
              <div className="import-pack__plan">
                <div className="import-pack__plan-head">
                  <Badge tone="accent">{providerLabel(plan.provider)}</Badge>
                  <strong>{plan.projectTitle}</strong>
                  <span className="mono subtle">{plan.slug}</span>
                </div>
                <div className="import-pack__meta">
                  <span>版本</span><span>{plan.versionName ?? plan.versionId ?? '默认最新'}</span>
                  <span>文件</span><span className="mono">{plan.fileName ?? '—'}</span>
                  <span>大小</span><span>{formatBytes(plan.fileSize)}</span>
                  <span>下载主机</span><span className="mono">{plan.downloadHost ?? '—'}</span>
                  <span>API 主机</span><span className="mono">{plan.apiSourceHost ?? '—'}</span>
                  <span>凭据</span>
                  <span>
                    {plan.provider === 'curseforge'
                      ? plan.apiKeyConfigured ? 'API Key 已配置' : plan.requiresApiKey ? '缺少 API Key' : '无需 Key'
                      : '无需 Key'}
                    {plan.mirrorConfigured ? ' · 已配置镜像' : ''}
                  </span>
                </div>
                {plan.warnings.length > 0 ? (
                  <Banner tone="warning" title="解析警告">{plan.warnings.join('；')}</Banner>
                ) : null}
                {!plan.canProceed ? (
                  <Banner tone="danger" title="暂时不能导入">
                    {plan.reason ?? '解析结果不可用'}。{plan.provider === 'curseforge' ? '可展开下方 CurseForge 设置填写 API Key 后重新解析。' : ''}
                  </Banner>
                ) : null}
              </div>
            ) : null}

            <details className="import-pack__cf">
              <summary><Icon name="settings" /> CurseForge 设置（可选）</summary>
              <div className="import-pack__cf-body">
                <p>
                  Key 只作为 <code>x-api-key</code> 请求头发给 CurseForge API 主机，不会写入 URL、日志或分享包。
                  {cf ? (cf.hasApiKey ? ' 当前已保存一个 Key。' : ' 当前未配置 Key。') : ''}
                  {cf && !cf.secureStorageAvailable
                    ? ' 本机没有可用的安全存储（safeStorage），Key 只保留在本次会话，重启后需重新填写。'
                    : cf?.hasApiKey && !cf.persisted
                      ? ' 当前 Key 未加密持久化，重启后需重新填写。'
                      : ''}
                </p>
                <Field label="API Key" hint="留空保持不变；不会回显已保存的 Key。">
                  <Input
                    type="password"
                    value={cfKey}
                    onChange={(event) => setCfKey(event.target.value)}
                    placeholder={cf?.hasApiKey ? '已保存，留空保持不变' : '粘贴 CurseForge API Key'}
                    disabled={cfBusy}
                    autoComplete="off"
                  />
                </Field>
                <Field label="镜像 API 基址（可选）" hint="例如 https://…；留空使用官方 api.curseforge.com。">
                  <Input
                    value={cfMirror}
                    onChange={(event) => setCfMirror(event.target.value)}
                    placeholder="https://api.curseforge.com"
                    disabled={cfBusy}
                  />
                </Field>
                <div className="import-pack__cf-actions">
                  <Button size="sm" variant="secondary" icon="check" loading={cfBusy} onClick={() => void saveCurseForge()}>保存设置</Button>
                  {cfMessage ? <span className="muted">{cfMessage}</span> : null}
                </div>
              </div>
            </details>
          </>
        ) : (
          <div className="import-pack__local">
            <span className="import-pack__local-icon"><Icon name="package" /></span>
            <div>
              <strong>选择本地 .mrpack / .zip</strong>
              <p>整合包会按清单创建实例并下载缺失内容；也可以直接把文件拖进启动器窗口。</p>
            </div>
            <Button variant="secondary" icon="folder" loading={picking} disabled={running} onClick={() => void pickLocal()}>选择文件…</Button>
          </div>
        )}

        {running || notice || jobProgress || linkProgress ? (
          <div className="import-pack__progress" role="status" aria-live="polite">
            <div className="import-pack__progress-head">
              <strong>{jobProgress?.message ?? (starting && linkProgress ? '链接导入进行中' : '后台导入进行中')}</strong>
              {jobId ? <Badge tone="accent">job</Badge> : <Badge tone="outline">{linkProgress?.phase ?? 'starting'}</Badge>}
            </div>
            <Progress value={progressValue} tone={jobProgress?.state === 'failed' ? 'danger' : 'accent'} label="导入进度" />
            <div className="import-pack__progress-meta">
              <span>{progressLabel}</span>
              {jobProgress && jobProgress.bytesTotal > 0 ? <span>{formatBytes(jobProgress.bytesDone)} / {formatBytes(jobProgress.bytesTotal)}</span> : null}
            </div>
            {notice ? <p className="import-pack__hint">{notice}</p> : null}
            {jobId ? <Button size="xs" variant="danger-ghost" icon="close" loading={cancelling} onClick={() => void cancelImport()}>取消导入</Button> : null}
            {!jobId && starting ? <p className="import-pack__hint">链接下载/校验阶段由主进程完成，暂不支持取消；进入导入阶段后可取消。</p> : null}
          </div>
        ) : null}

        {notice && !running && !jobProgress ? <p className="import-pack__hint">{notice}</p> : null}
        {error ? <div className="nw-inline-error" role="alert">{error.title}：{error.detail}</div> : null}
      </div>
    </Dialog>
  )
}
