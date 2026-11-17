import { useState } from 'react'
import type { JavaInstallProgress } from '@shared/java'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { Badge, Banner, Button, Progress } from '../ui'

/** Common release trains; the backend validates the major anyway. */
const MAJORS = [8, 11, 17, 21, 25] as const

type SourceId = 'auto' | 'adoptium' | 'microsoft'

const STATE_LABEL: Record<string, string> = {
  queued: '排队中',
  resolving: '解析下载地址',
  downloading: '下载中',
  verifying: '校验中',
  extracting: '解压中',
  validating: '验证中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * One-click Java install. The backend already exposed download/downloadStatus;
 * this is the missing surface (VersePC2 has the same card).
 */
export function JavaDownloadPanel({ onInstalled }: { onInstalled?: () => void }) {
  const backend = useBackend()
  const providers = useAsync(() => backend.java.providers(), [])
  const [major, setMajor] = useState<number>(21)
  const [source, setSource] = useState<SourceId>('auto')
  const [progress, setProgress] = useState<JavaInstallProgress | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiErrorInfo | null>(null)

  const start = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setProgress(null)
    try {
      const job = await backend.java.download({ major, source, force: false })
      for (;;) {
        await sleep(900)
        const next = await backend.java.downloadStatus(job.jobId)
        if (!next) continue
        setProgress(next)
        if (next.state === 'done') {
          onInstalled?.()
          break
        }
        if (next.state === 'failed' || next.state === 'cancelled') {
          if (next.state === 'failed') {
            setError({
              kind: 'error',
              title: 'Java 下载失败',
              detail: next.message ?? '下载器返回失败，但没有给出原因',
              retryable: true,
            })
          }
          break
        }
      }
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const cancel = async (): Promise<void> => {
    const jobId = progress?.jobId
    if (!jobId) return
    try {
      await backend.java.cancelDownload(jobId)
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  const list = providers.data ?? []
  const available = list.filter((provider) => provider.available)
  const pct = progress?.percent ?? null

  return (
    <div className="nw-stack">
      <div className="settings-section__head">
        <div>
          <h2>下载 Java</h2>
          <p>选择需要的 Java 版本下载，启动器会在可用下载源之间自动尝试。</p>
        </div>
      </div>

      {error ? <Banner tone="danger" title={`${error.title}：${error.detail}`} /> : null}

      <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label className="nw-stack" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>主版本</span>
          <select className="input" value={major} onChange={(event) => setMajor(Number(event.target.value))} disabled={busy}>
            {MAJORS.map((value) => (
              <option key={value} value={value}>Java {value}</option>
            ))}
          </select>
        </label>
        <label className="nw-stack" style={{ gap: 4 }}>
          <span className="muted" style={{ fontSize: 12 }}>下载源</span>
          <select className="input" value={source} onChange={(event) => setSource(event.target.value as SourceId)} disabled={busy}>
            <option value="auto">自动</option>
            {available.map((provider) => (
              <option key={provider.id} value={provider.id}>{provider.displayName}</option>
            ))}
          </select>
        </label>
        <Button variant="primary" icon="download" onClick={() => void start()} loading={busy}>下载并安装</Button>
        {busy ? <Button variant="ghost" onClick={() => void cancel()}>取消</Button> : null}
      </div>

      {progress ? (
        <div className="nw-stack">
          <Progress value={pct} tone={progress.state === 'failed' ? 'danger' : progress.state === 'done' ? 'success' : 'accent'} label="下载进度" />
          <div className="muted" style={{ fontSize: 12 }}>
            <Badge tone={progress.state === 'failed' ? 'danger' : progress.state === 'done' ? 'success' : 'accent'}>
              {STATE_LABEL[progress.state] ?? progress.state}
            </Badge>
            {' '}
            {pct === null ? '大小未知' : `${pct.toFixed(1)}%`}
            {progress.totalBytes > 0 ? ` · ${(progress.downloadedBytes / 1024 / 1024).toFixed(1)} / ${(progress.totalBytes / 1024 / 1024).toFixed(1)} MB` : ''}
            {progress.currentFile ? ` · ${progress.currentFile}` : ''}
            {progress.message ? ` · ${progress.message}` : ''}
          </div>
        </div>
      ) : null}

      {available.length === 0 ? (
        <div className="muted" style={{ fontSize: 12 }}>当前没有可用的下载源；检查网络后刷新。</div>
      ) : null}
    </div>
  )
}
