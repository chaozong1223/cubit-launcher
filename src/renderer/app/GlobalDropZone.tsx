import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { InstanceSummary } from '@shared/instance'
import type { DownloadFinished, DownloadProgress } from '@shared/download'
import type { LoaderFinished, LoaderProgress, LoaderType } from '@shared/loader'
import type { ModKind, ModpackImportResult } from '@shared/mods'
import { useBackend } from './data/BackendContext'
import { BackendError, describeError } from './data/backend'
import { detectArchive, type ArchiveDetection, type DetectedLoader } from './data/archiveDetect'
import { useAsync } from './data/useAsync'
import { navigate, useRoute } from './router'
import { Badge, Button, Progress } from './ui'
import { Icon as SvgIcon } from './icons'

type FeedbackTone = 'info' | 'success' | 'warning' | 'error'

interface Feedback {
  tone: FeedbackTone
  title: string
  detail: string
  action?: { label: string; to: string; onClick?: () => void }
}

type TaskPhase = 'detect' | 'base' | 'loader' | 'pack' | 'files'

interface TaskProgress {
  phase: TaskPhase
  label: string
  percent: number | null
  detail: string
}

interface WaitResult {
  ok: boolean
  message?: string
}

interface UnknownDrop {
  file: File
  path: string
  evidence: string[]
  targetId: string | null
  targetName: string | null
  defaultKind: 'resourcepacks' | 'shaderpacks' | 'modpack'
}

type PackDetection = Extract<ArchiveDetection, { kind: 'modpack' }>

function extensionOf(filePath: string): string {
  const name = filePath.split(/[\\/]/).pop() ?? filePath
  const index = name.lastIndexOf('.')
  return index >= 0 ? name.slice(index).toLowerCase() : ''
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).pop() ?? filePath
}

function targetLabel(instance: InstanceSummary | null): string {
  if (!instance) return '尚未选择实例'
  return `${instance.name} · ${instance.mcVersion ?? '版本未知'} · ${instance.loader.type}`
}

function isFolderEntry(file: File, path: string): boolean {
  const ext = extensionOf(path)
  if (ext === '.jar' || ext === '.zip' || ext === '.mrpack') return false
  if (baseName(path).toLowerCase() === '.minecraft') return true
  return file.size === 0 && file.type === ''
}

/** A window-level drop target: works on every page, not only the mods tab. */
export function GlobalDropZone() {
  const backend = useBackend()
  const route = useRoute()
  const instances = useAsync(() => backend.instances.list(), [])
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const [progress, setProgress] = useState<TaskProgress | null>(null)
  const [unknown, setUnknown] = useState<UnknownDrop | null>(null)
  const dragDepth = useRef(0)
  const downloadWaiters = useRef(new Map<string, (result: WaitResult) => void>())
  const loaderWaiters = useRef(new Map<string, (result: WaitResult) => void>())

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
    const offDownloadProgress = backend.downloads.subscribeProgress((event: DownloadProgress) => {
      setProgress((current) => current && current.phase === 'base'
        ? {
            ...current,
            percent: event.bytesTotal > 0 ? event.bytesDone / event.bytesTotal * 100 : null,
            detail: event.currentFile
              ? `${event.stage} · ${event.currentFile}`
              : `${event.stage} · ${event.done}/${event.total} 文件 · ${event.failed} 失败`,
          }
        : current)
    })
    const offDownloadFinished = backend.downloads.subscribeFinished((event: DownloadFinished) => {
      const waiter = downloadWaiters.current.get(event.jobId)
      if (!waiter) return
      downloadWaiters.current.delete(event.jobId)
      waiter({
        ok: event.ok,
        message: event.ok
          ? undefined
          : event.failed[0]?.userMessage ?? event.failed[0]?.message ?? '下载任务失败',
      })
    })
    const offLoaderProgress = backend.loader.subscribeProgress((event: LoaderProgress) => {
      setProgress((current) => current && current.phase === 'loader'
        ? {
            ...current,
            percent: event.percent,
            detail: event.currentTask ?? event.message ?? event.stage,
          }
        : current)
    })
    const offLoaderFinished = backend.loader.subscribeFinished((event: LoaderFinished) => {
      const waiter = loaderWaiters.current.get(event.jobId)
      if (!waiter) return
      loaderWaiters.current.delete(event.jobId)
      waiter({
        ok: event.ok,
        message: event.ok ? undefined : event.error?.message ?? '加载器安装失败',
      })
    })
    return () => {
      offDownloadProgress()
      offDownloadFinished()
      offLoaderProgress()
      offLoaderFinished()
    }
  }, [backend])

  const target = useMemo(() => {
    const list = instances.data ?? []
    if (route.name === 'instance' && route.id) {
      const routed = list.find((instance) => instance.id === route.id)
      if (routed) return routed
    }
    const savedId = localStorage.getItem('mcl.global.instanceId')
    const saved = savedId ? list.find((instance) => instance.id === savedId) : undefined
    if (saved) return saved
    return list.find((instance) => instance.state === 'ready') ?? list[0] ?? null
  }, [instances.data, route.name, route.id])

  const showTargetRequired = useCallback(() => {
    setFeedback({
      tone: 'error',
      title: '这个文件需要目标实例',
      detail: '模组、资源包和光影要装进一个实例；整合包会自己创建实例。请先在「实例」页创建或导入一个实例。',
      action: { label: '去实例页', to: '/instances' },
    })
  }, [])

  const waitDownload = useCallback((jobId: string): Promise<WaitResult> => {
    return new Promise((resolve) => {
      const waiter = (result: WaitResult) => resolve(result)
      downloadWaiters.current.set(jobId, waiter)
      void backend.downloads.status(jobId).then((current) => {
        if (!current || !['done', 'failed', 'cancelled'].includes(current.state)) return
        if (downloadWaiters.current.get(jobId) !== waiter) return
        downloadWaiters.current.delete(jobId)
        resolve({ ok: current.state === 'done', message: current.message ?? current.state })
      }).catch(() => undefined)
    })
  }, [backend])

  const waitLoader = useCallback((jobId: string): Promise<WaitResult> => {
    return new Promise((resolve) => {
      const waiter = (result: WaitResult) => resolve(result)
      loaderWaiters.current.set(jobId, waiter)
      void backend.loader.status(jobId).then((current) => {
        if (!current || !['done', 'failed', 'cancelled'].includes(current.state)) return
        if (loaderWaiters.current.get(jobId) !== waiter) return
        loaderWaiters.current.delete(jobId)
        resolve({ ok: current.state === 'done', message: current.message ?? current.state })
      }).catch(() => undefined)
    })
  }, [backend])

  const ensureBase = useCallback(async (mcVersion: string) => {
    const versions = await backend.versions.list()
    if (versions.some((version) => version.id === mcVersion && version.state === 'ready')) return
    setProgress({
      phase: 'base',
      label: `安装原版 ${mcVersion}`,
      percent: null,
      detail: '整合包需要基础版本，先走 download 安装链',
    })
    const install = await backend.downloads.install(mcVersion)
    const result = await waitDownload(install.jobId)
    if (!result.ok) {
      throw new BackendError('PACK.BASE_INSTALL_FAILED', result.message ?? `原版 ${mcVersion} 安装失败`, true)
    }
  }, [backend, waitDownload])

  const ensureLoader = useCallback(async (mcVersion: string, loader: DetectedLoader) => {
    if (loader.type === 'vanilla') return
    if (loader.type === 'unknown' || !loader.version) {
      throw new BackendError('PACK.LOADER_UNKNOWN', '整合包声明了加载器，但清单没有可识别的类型或版本', false)
    }
    const type = loader.type as LoaderType
    const plan = await backend.loader.plan(type, mcVersion, loader.version)
    const versions = await backend.versions.list()
    if (versions.some((version) => version.id === plan.versionId && version.state === 'ready')) return
    setProgress({
      phase: 'loader',
      label: `安装加载器 ${type} ${loader.version}`,
      percent: null,
      detail: plan.installer?.hashSource === 'none'
        ? '安装器没有上游哈希，自动流程将记录风险并继续'
        : `安装计划 ${plan.versionId}`,
    })
    const install = await backend.loader.install({
      type,
      mcVersion,
      loaderVersion: loader.version,
      confirmSha1: plan.installer?.sha1 ?? null,
      allowUnverifiedInstaller: plan.installer?.hashSource === 'none',
    })
    const result = await waitLoader(install.jobId)
    if (!result.ok) {
      throw new BackendError('PACK.LOADER_INSTALL_FAILED', result.message ?? '加载器安装失败', true)
    }
  }, [backend, waitLoader])

  const importPack = useCallback(async (filePath: string, detection: PackDetection | null) => {
    setBusy(true)
    try {
      const warnings: string[] = []
      if (detection) {
        if (!detection.gameVersion) {
          throw new BackendError('PACK.NO_GAME_VERSION', '整合包清单没有声明 Minecraft 版本，无法自动安装基础版本', false)
        }
        await ensureBase(detection.gameVersion)
        await ensureLoader(detection.gameVersion, detection.loader)
      }
      setProgress({
        phase: 'pack',
        label: `导入整合包 ${detection?.name ?? baseName(filePath)}`,
        percent: null,
        detail: '按清单写入实例、overrides 和模组文件',
      })
      const result: ModpackImportResult = await backend.mods.importModpack(filePath)
      instances.reload()
      localStorage.setItem('mcl.global.instanceId', result.instanceId)
      window.dispatchEvent(new CustomEvent('mcl:select-instance', { detail: { id: result.instanceId } }))
      window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
      if (result.needsBaseInstall && result.mcVersion) {
        await ensureBase(result.mcVersion)
        warnings.push(`基础版本 ${result.mcVersion} 是导入后补装的；实例可能需要重新校验版本配置`)
      }
      if (result.loader.type !== 'vanilla' && result.loader.type !== 'unknown') {
        warnings.push(detection
          ? '加载器已按清单安装；若启动失败，请到实例详情执行校验'
          : '未从清单识别加载器，未自动安装；请到实例详情校验加载器')
      }
      const evidence = detection?.evidence.join('；') ?? '扩展名/清单识别为整合包'
      setFeedback({
        tone: warnings.length > 0 ? 'warning' : 'success',
        title: `整合包已导入：${result.name}`,
        detail: `${result.format} · MC ${result.mcVersion ?? '未知'} · ${result.loader.type}${result.loader.version ? ` ${result.loader.version}` : ''} · 文件 ${result.downloaded} 新 / ${result.skipped} 跳过 · ${evidence}${warnings.length ? `。${warnings.join('；')}` : ''}`,
        action: {
          label: '去主页启动',
          to: '/home',
          onClick: () => {
            navigate('/home')
            // Wait for Home to mount/create its listener, then select the new instance.
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent('mcl:select-instance', { detail: { id: result.instanceId } }))
            }, 0)
          },
        },
      })
    } catch (cause) {
      setFeedback({
        tone: 'error',
        title: '整合包安装失败',
        detail: describeError(cause).detail,
        action: { label: '查看实例页', to: '/instances' },
      })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [backend, ensureBase, ensureLoader, instances.reload])

  const installLocal = useCallback(async (
    instance: InstanceSummary,
    filePath: string,
    kind: ModKind,
    evidence: string,
  ) => {
    setBusy(true)
    setProgress({ phase: 'files', label: `安装 ${kind}`, percent: null, detail: baseName(filePath) })
    try {
      const result = await backend.mods.installLocalFile(instance.id, filePath, kind)
      setFeedback({
        tone: 'success',
        title: `已安装到 ${result.kind}`,
        detail: `目标实例：${targetLabel(instance)}；依据：${evidence}`,
        action: { label: '查看实例', to: `/instances/${encodeURIComponent(instance.id)}` },
      })
    } catch (cause) {
      const info = describeError(cause)
      setFeedback({
        tone: 'error',
        title: info.title,
        detail: info.detail,
        action: { label: '查看实例', to: `/instances/${encodeURIComponent(instance.id)}` },
      })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [backend])

  const importFolder = useCallback(async (path: string) => {
    setBusy(true)
    setProgress({ phase: 'files', label: '导入 Minecraft 目录', percent: null, detail: path })
    try {
      const result = await backend.instances.importRoot(path)
      instances.reload()
      window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
      if (!result.hasVersions) {
        setFeedback({
          tone: 'error',
          title: '已切换到目录，但没有发现 versions/',
          detail: `已保存 ${result.mcRoot}，但该目录没有 versions，看起来不是完整的 .minecraft。请确认选择的是 .minecraft；重启后仍会使用此目录。`,
          action: { label: '管理实例目录', to: '/instances' },
        })
      } else {
        setFeedback({
          tone: 'success',
          title: `已导入 Minecraft 目录 · ${result.instanceCount} 个实例`,
          detail: result.guidance.join(' ') || `已保存到 ${result.mcRoot}，重启后仍生效。`,
          action: { label: '打开实例列表', to: '/instances' },
        })
      }
    } catch (cause) {
      const info = describeError(cause)
      setFeedback({
        tone: 'error',
        title: info.title,
        detail: info.code === 'INSTANCE.DIRECTORY_UNAVAILABLE'
          ? `${info.detail} 请检查目录是否存在、是否有读取权限，以及它是否为 .minecraft。`
          : info.detail,
        action: { label: '打开实例页', to: '/instances' },
      })
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }, [backend, instances.reload])

  const handleFileEntries = useCallback(async (entries: Array<{ file: File; path: string }>) => {
    for (const entry of entries) {
      const ext = extensionOf(entry.path)
      if (ext === '.jar') {
        if (!target) {
          showTargetRequired()
          return
        }
        await installLocal(target, entry.path, 'mods', '扩展名 .jar')
        continue
      }
      if (ext !== '.zip' && ext !== '.mrpack') {
        setFeedback({
          tone: 'error',
          title: '不支持的文件类型',
          detail: `支持 .jar（模组）、.zip（整合包/资源包/光影）、.mrpack（整合包）和文件夹；收到：${baseName(entry.path)}`,
        })
        continue
      }
      setProgress({ phase: 'detect', label: '识别文件内容', percent: null, detail: baseName(entry.path) })
      let detection: ArchiveDetection
      try {
        detection = await detectArchive(entry.file, entry.path)
      } catch (cause) {
        detection = {
          kind: 'unknown',
          evidence: [`读取 ZIP 失败：${cause instanceof Error ? cause.message : String(cause)}`],
        }
      }
      setProgress(null)
      if (detection.kind === 'modpack') {
        await importPack(entry.path, detection)
        continue
      }
      if (detection.kind === 'resourcepack' || detection.kind === 'shaderpack') {
        if (!target) {
          showTargetRequired()
          return
        }
        await installLocal(
          target,
          entry.path,
          detection.kind === 'resourcepack' ? 'resourcepacks' : 'shaderpacks',
          detection.evidence.join('；'),
        )
        continue
      }
      setUnknown({
        file: entry.file,
        path: entry.path,
        evidence: detection.evidence,
        targetId: target?.id ?? null,
        targetName: target?.name ?? null,
        defaultKind: 'resourcepacks',
      })
      return
    }
  }, [importPack, installLocal, showTargetRequired, target])

  const handleDrop = useCallback(async (files: File[]) => {
    if (files.length === 0) return
    const entries = files
      .map((file) => ({ file, path: backend.system.getPathForFile(file) }))
      .filter((entry): entry is { file: File; path: string } => Boolean(entry.path))
    if (entries.length === 0) {
      setFeedback({
        tone: 'error',
        title: '无法读取拖入文件/文件夹的绝对路径',
        detail: 'preload 的 webUtils.getPathForFile 返回空值；请用实例页的“选择文件”系统对话框，或重试拖拽。',
        action: { label: '打开实例页', to: '/instances' },
      })
      return
    }
    const folders = entries.filter((entry) => isFolderEntry(entry.file, entry.path))
    const fileEntries = entries.filter((entry) => !isFolderEntry(entry.file, entry.path))
    if (folders.length > 0) {
      await importFolder(folders[0].path)
      if (folders.length > 1) {
        setFeedback({
          tone: 'warning',
          title: '一次只能导入一个 Minecraft 目录',
          detail: `已导入 ${folders[0].path}；其余文件夹未处理：${folders.slice(1).map((entry) => entry.path).join('、')}`,
        })
      }
      if (fileEntries.length === 0) return
    }
    await handleFileEntries(fileEntries)
  }, [backend, handleFileEntries, importFolder])

  useEffect(() => {
    const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files')
    const enter = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      dragDepth.current += 1
      setDragging(true)
    }
    const over = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
      setDragging(true)
    }
    const leave = (event: DragEvent) => {
      if (!hasFiles(event)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragging(false)
    }
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      ;(event as DragEvent & { __mclGlobalDrop?: boolean }).__mclGlobalDrop = true
      dragDepth.current = 0
      setDragging(false)
      void handleDrop(Array.from(event.dataTransfer?.files ?? []))
    }
    const reset = () => {
      dragDepth.current = 0
      setDragging(false)
    }
    window.addEventListener('dragenter', enter, true)
    window.addEventListener('dragover', over, true)
    window.addEventListener('dragleave', leave, true)
    window.addEventListener('drop', drop, true)
    window.addEventListener('dragend', reset, true)
    window.addEventListener('blur', reset)
    return () => {
      window.removeEventListener('dragenter', enter, true)
      window.removeEventListener('dragover', over, true)
      window.removeEventListener('dragleave', leave, true)
      window.removeEventListener('drop', drop, true)
      window.removeEventListener('dragend', reset, true)
      window.removeEventListener('blur', reset)
    }
  }, [handleDrop])

  const resolveUnknown = async (kind: 'resourcepacks' | 'shaderpacks' | 'modpack') => {
    const pending = unknown
    setUnknown(null)
    if (!pending || busy) return
    if (kind === 'modpack') {
      await importPack(pending.path, null)
      return
    }
    const instance = instances.data?.find((item) => item.id === pending.targetId) ?? target
    if (!instance) {
      showTargetRequired()
      return
    }
    await installLocal(instance, pending.path, kind, pending.evidence.join('；'))
  }

  return (
    <>
      {dragging ? (
        <div className={`global-drop-overlay${target ? '' : ' global-drop-overlay--missing'}`} aria-hidden="true">
          <div className="global-drop-card">
            <div className="global-drop-card__icon"><SvgIcon name="upload" /></div>
            <div className="global-drop-card__eyebrow">拖入后自动识别 · 任意页面</div>
            <h2>{target ? `目标实例：${target.name}` : '整合包无需实例；资源包/光影需要一个实例'}</h2>
            <p>
              {target
                ? `${target.mcVersion ?? '版本未知'} · ${target.loader.type} · 先读清单/目录结构，再直接执行安装`
                : '整合包会自动创建实例；模组/资源包/光影需要先在实例页选择一个实例。'}
            </p>
            <div className="global-drop-card__types">
              <span><Badge tone="outline">.jar</Badge> 模组</span>
              <span><Badge tone="outline">.zip</Badge> 自动识别整合包 / 资源包 / 光影</span>
              <span><Badge tone="outline">.mrpack</Badge> 整合包（含原版+加载器）</span>
              <span><Badge tone="outline">文件夹</Badge> Minecraft 目录</span>
            </div>
            <div className="global-drop-card__hint">整合包会按清单自动安装缺失的原版和加载器；只有内容无法判断时才询问一次</div>
          </div>
        </div>
      ) : null}

      {progress ? (
        <div className="global-drop-task" role="status" aria-live="polite">
          <div className="global-drop-task__head">
            <strong>{progress.label}</strong>
            <span>{progress.phase === 'base' ? 'download' : progress.phase === 'loader' ? 'loader' : progress.phase === 'pack' ? 'modpack' : 'local'}</span>
          </div>
          <Progress
            value={progress.percent}
            tone={progress.phase === 'base' ? 'accent' : progress.phase === 'loader' ? 'warning' : 'accent'}
            label={progress.label}
          />
          <div className="global-drop-task__detail">{progress.detail}</div>
        </div>
      ) : null}

      {unknown ? (
        <div className="global-drop-panel" role="dialog" aria-label="确认拖入文件类型">
          <div className="global-drop-panel__head">
            <div>
              <strong>无法可靠判断这个文件</strong>
              <span>{baseName(unknown.path)} · {unknown.targetName ? `当前实例 ${unknown.targetName}` : '没有选择实例'}</span>
            </div>
            <Button size="xs" variant="ghost" icon="close" aria-label="取消识别" onClick={() => setUnknown(null)} />
          </div>
          <div className="global-drop-evidence">
            {unknown.evidence.map((line) => <span key={line}>{line}</span>)}
          </div>
          <div className="global-drop-panel__actions">
            <Button size="sm" variant="primary" icon="package" onClick={() => void resolveUnknown('resourcepacks')}>作为资源包（默认）</Button>
            <Button size="sm" variant="secondary" icon="sun" onClick={() => void resolveUnknown('shaderpacks')}>作为光影</Button>
            <Button size="sm" variant="secondary" icon="upload" onClick={() => void resolveUnknown('modpack')}>作为整合包导入</Button>
            <Button size="sm" variant="ghost" onClick={() => setUnknown(null)}>取消</Button>
          </div>
        </div>
      ) : null}

      {feedback ? (
        <div className={`global-drop-feedback global-drop-feedback--${feedback.tone}`} role="status" aria-live="polite">
          <span className="global-drop-feedback__icon"><SvgIcon name={feedback.tone === 'success' ? 'check' : feedback.tone === 'info' ? 'upload' : 'alert'} /></span>
          <div className="global-drop-feedback__body">
            <strong>{feedback.title}</strong>
            <span>{feedback.detail}</span>
            {feedback.action ? <Button size="xs" variant="secondary" onClick={() => feedback.action!.onClick ? feedback.action!.onClick() : navigate(feedback.action!.to)}>{feedback.action.label}</Button> : null}
          </div>
          <Button size="xs" variant="ghost" icon="close" aria-label="关闭提示" onClick={() => setFeedback(null)} />
        </div>
      ) : null}

      {!target && !dragging && !feedback && !unknown && !progress && instances.status === 'ready' ? (
        <div className="global-drop-hint" aria-hidden="true">拖入 .jar / .zip / .mrpack 或 .minecraft 文件夹：整合包会自动创建实例</div>
      ) : null}
    </>
  )
}
