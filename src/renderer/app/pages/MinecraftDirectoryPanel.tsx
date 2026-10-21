import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { MinecraftCandidate, SetGameDirResult } from '@shared/instance'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { Badge, Banner, Button, Card, DataStateNotice, Skeleton } from '../ui'
import { Icon } from '../icons'

function sourceLabel(source: MinecraftCandidate['source']): string {
  switch (source) {
    case 'appdata': return 'APPDATA'
    case 'userprofile': return '用户目录'
    case 'install': return '安装目录旁'
    case 'drive': return '磁盘根目录'
    case 'configured': return '已配置'
    case 'manual': return '手动指定'
    default: return source
  }
}

function formatModified(ts: number | null): string {
  if (!ts) return '未知修改时间'
  return new Date(ts).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Discover/import a .minecraft root. Uses the same instance.import contract as folder drops. */
export function MinecraftDirectoryPanel({ onImported }: { onImported?: () => void }) {
  const backend = useBackend()
  const discover = useAsync(() => backend.instances.discover(), [])
  const folderInput = useRef<HTMLInputElement>(null)
  const [busyPath, setBusyPath] = useState<string | null>(null)
  const [result, setResult] = useState<SetGameDirResult | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [pickerMode, setPickerMode] = useState<'select' | 'existing'>('select')

  useEffect(() => {
    const input = folderInput.current
    if (!input) return
    input.setAttribute('webkitdirectory', '')
    input.setAttribute('directory', '')
    input.multiple = true
  }, [])

  useEffect(() => {
    const refresh = () => discover.reload()
    const off = backend.instances.subscribeChanged(refresh)
    window.addEventListener('mcl:instances-changed', refresh)
    return () => {
      off()
      window.removeEventListener('mcl:instances-changed', refresh)
    }
  }, [backend, discover.reload])

  const notifyImported = () => {
    window.dispatchEvent(new CustomEvent('mcl:instances-changed'))
    onImported?.()
  }

  const importPath = async (path: string) => {
    setBusyPath(path)
    setError(null)
    setResult(null)
    try {
      const imported = await backend.instances.importRoot(path)
      setResult(imported)
      discover.reload()
      notifyImported()
      if (!imported.hasVersions) {
        setError({
          kind: 'error',
          title: '目录已保存，但没有发现 versions/',
          detail: '这个目录可能是普通文件夹而不是 .minecraft。请确认目录中有 versions、assets 或 options.txt；若不是，请重新选择。',
          retryable: false,
        })
      }
    } catch (cause) {
      const info = describeError(cause)
      setError({
        ...info,
        detail: info.code === 'INSTANCE.DIRECTORY_UNAVAILABLE'
          ? `${info.detail} 请检查目录是否存在、是否有读取权限，以及它是否为 .minecraft 或其父目录。`
          : info.detail,
      })
    } finally {
      setBusyPath(null)
    }
  }

  const openFolderPicker = (mode: 'select' | 'existing') => {
    setPickerMode(mode)
    setError(null)
    setResult(null)
    if (folderInput.current) {
      folderInput.current.value = ''
      folderInput.current.click()
    }
  }

  const onFolderSelected = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : []
    event.target.value = ''
    if (files.length === 0) {
      setError({
        kind: 'error',
        title: '无法读取文件夹',
        detail: '文件夹为空、没有可读取的文件，或当前账户没有读取权限。请选择包含 versions 的 .minecraft；若系统对话框被取消，可忽略此提示。',
        retryable: false,
      })
      return
    }
    const first = files[0]
    const fullPath = backend.system.getPathForFile(first)
    if (!fullPath) {
      setError({
        kind: 'error',
        title: '无法读取所选目录的绝对路径',
        detail: '系统文件夹选择器返回了文件，但 preload 的 webUtils.getPathForFile 未返回路径。请改用拖入文件夹。',
        retryable: false,
      })
      return
    }
    const relative = (first.webkitRelativePath || first.name).replace(/\//g, '\\')
    const relativeParts = relative.split('\\').filter(Boolean)
    const fullParts = fullPath.split(/[\\/]/)
    if (relativeParts.length === 0 || fullParts.length <= relativeParts.length) {
      setError({ kind: 'error', title: '无法推断目录', detail: '文件夹选择结果中没有可用的相对路径；请直接拖入 .minecraft 文件夹。', retryable: false })
      return
    }
    const root = fullParts.slice(0, fullParts.length - relativeParts.length).join('\\')
    const markers = files.map((file) => (file.webkitRelativePath || file.name).toLowerCase())
    const looksLikeMinecraft = markers.some((path) =>
      /(^|\/)(versions|mods|saves|assets|libraries|resourcepacks|shaderpacks|options\.txt|launcher_profiles\.json)(\/|$)/.test(path),
    )
    if (!looksLikeMinecraft) {
      setError({
        kind: 'error',
        title: '这不是 Minecraft 目录',
        detail: `所选文件夹（${pickerMode === 'existing' ? '使用已有 .minecraft' : '选择目录'}）没有 versions、mods、saves、assets、options.txt 等标志。请选择 .minecraft 或其父目录。`,
        retryable: false,
      })
      return
    }
    await importPath(root)
  }

  const current = discover.data?.currentRoot ?? null
  const candidates = discover.data?.candidates ?? []
  const busy = busyPath !== null

  return (
    <Card className="mc-dir-panel">
      <input
        ref={folderInput}
        type="file"
        className="mc-dir-folder-input"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => void onFolderSelected(event)}
      />
      <div className="mc-dir-head">
        <div>
          <div className="eyebrow">Minecraft 目录</div>
          <h2><Icon name="folder" />{current ? '当前游戏目录' : '还没有配置游戏目录'}</h2>
          <div className="mc-dir-path">{current ?? '未配置：拖入 .minecraft 文件夹，或从下方自动发现/选择目录。'}</div>
        </div>
        <Badge tone={current ? 'success' : 'warning'} dot>{current ? '已配置' : '未配置'}</Badge>
      </div>

      <div className="mc-dir-actions">
        <Button size="sm" variant="secondary" icon="search" loading={discover.status === 'loading'} onClick={() => discover.reload()}>
          自动发现
        </Button>
        <Button size="sm" variant="secondary" icon="folder" disabled={busy} onClick={() => openFolderPicker('select')}>
          选择目录
        </Button>
        <Button size="sm" variant="ghost" icon="cube" disabled={busy} onClick={() => openFolderPicker('existing')}>
          使用已有 .minecraft
        </Button>
        {result ? <span className="mc-dir-saved"><Icon name="check" />已保存，重启后仍生效</span> : null}
      </div>
      <div className="mc-dir-note">选择目录会打开系统文件夹选择器；也可以用窗口级拖放直接把 .minecraft 文件夹拖进来。</div>

      {error ? <Banner tone="danger" title={error.title}>{error.detail}</Banner> : null}
      {result ? (
        <Banner
          tone={result.hasVersions ? 'success' : 'danger'}
          title={`已切换目录 · ${result.instanceCount} 个实例`}
        >
          <span className="mono">{result.mcRoot}</span>
          {result.guidance.length ? <div className="mc-dir-guidance">{result.guidance.join(' ')}</div> : null}
        </Banner>
      ) : null}

      {discover.status === 'loading' ? (
        <div className="mc-dir-loading"><Skeleton className="skeleton--text" style={{ width: '62%' }} /><Skeleton className="skeleton--text" style={{ width: '44%', marginTop: 8 }} /></div>
      ) : discover.status === 'error' || discover.status === 'not-wired' ? (
        <DataStateNotice info={describeError(discover.error)} onRetry={discover.reload} retryLabel="重新发现" />
      ) : (
        <>
          {candidates.length > 0 ? (
            <div className="mc-dir-candidates">
              <div className="mc-dir-candidates__head">
                <strong>发现的候选目录</strong>
                <span>{candidates.length} 个 · 扫描时间 {discover.data ? new Date(discover.data.scannedAt).toLocaleTimeString('zh-CN') : '—'}</span>
              </div>
              {candidates.map((candidate) => (
                <div className={`mc-dir-candidate${candidate.recommended ? ' is-recommended' : ''}`} key={candidate.path}>
                  <div className="mc-dir-candidate__main">
                    <div className="mc-dir-candidate__title">
                      <span className="mono">{candidate.path}</span>
                      {candidate.recommended ? <Badge tone="success">推荐</Badge> : null}
                      <Badge tone="outline">{sourceLabel(candidate.source)}</Badge>
                    </div>
                    <div className="mc-dir-candidate__meta">
                      <span><Icon name="instances" />{candidate.versionCount} 个版本</span>
                      <span><Icon name="package" />模组：{candidate.hasMods ? '有' : '无'}</span>
                      <span><Icon name="folder" />存档：{candidate.hasSaves ? '有' : '无'}</span>
                      <span>{formatModified(candidate.lastModified)}</span>
                    </div>
                    {candidate.warning ? <div className="mc-dir-warning">{candidate.warning}</div> : null}
                  </div>
                  <Button
                    size="sm"
                    variant="primary"
                    icon="check"
                    loading={busyPath === candidate.path}
                    disabled={busy}
                    onClick={() => void importPath(candidate.path)}
                  >
                    一键导入
                  </Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="mc-dir-empty">
              <Icon name="folder" />
              <div>
                <strong>没有自动发现候选目录</strong>
                <span>{discover.data?.guidance[0] ?? '可以手动选择 .minecraft，或先安装一个版本。'}</span>
              </div>
            </div>
          )}
          {discover.data?.guidance.length ? (
            <div className="mc-dir-guidance">{discover.data.guidance.map((line) => <div key={line}>{line}</div>)}</div>
          ) : null}
          {discover.data?.errors.length ? (
            <div className="mc-dir-scan-errors">{discover.data.errors.map((line) => <div key={line}>{line}</div>)}</div>
          ) : null}
        </>
      )}
    </Card>
  )
}
