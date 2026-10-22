import { useEffect, useState } from 'react'
import type { SdkEntry, SdkList } from '@shared/sdk'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  EmptyState,
  PageHeader,
  Skeleton,
} from '../ui'
import { Icon } from '../icons'

function SdkRow({
  entry,
  busy,
  onStart,
  onStop,
}: {
  entry: SdkEntry
  busy: string | null
  onStart: () => void
  onStop: () => void
}) {
  return (
    <tr>
      <td>
        <div className="row gap-8">
          <Icon name="network" />
          <div>
            <strong>{entry.name}</strong>
            <div className="muted mono">{entry.manifestPath}</div>
          </div>
        </div>
      </td>
      <td>{entry.version}</td>
      <td className="mono">{entry.command}</td>
      <td>{entry.hashVerified ? <Badge tone="success">SHA-256 已验证</Badge> : <Badge tone="neutral">未提供哈希</Badge>}</td>
      <td>{entry.running ? <Badge tone="accent">运行中 · PID {entry.pid}</Badge> : <Badge tone="neutral">未启动</Badge>}</td>
      <td className="row-actions">
        {entry.running ? (
          <Button size="xs" variant="danger-ghost" icon="close" loading={busy === `stop:${entry.id}`} onClick={onStop}>停止</Button>
        ) : (
          <Button size="xs" variant="primary" icon="play" loading={busy === `start:${entry.id}`} onClick={onStart} disabled={!entry.valid}>启动</Button>
        )}
      </td>
    </tr>
  )
}

export function SdkPage({ embedded = false }: { embedded?: boolean } = {}) {
  const backend = useBackend()
  const list = useAsync(() => backend.sdk.list(), [])
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'success' | 'info' | 'warning' | 'danger'; text: string } | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [folder, setFolder] = useState<string | null>(null)

  useEffect(() => {
    backend.sdk.list().then(
      (result) => setFolder(result.directory),
      () => undefined,
    )
  }, [backend])

  const start = async (entry: SdkEntry) => {
    setBusy(`start:${entry.id}`)
    setError(null)
    setNotice(null)
    try {
      const result = await backend.sdk.start(entry.id)
      setNotice({ tone: 'success', text: `已启动 ${entry.name}（PID ${result.pid}）。请回到联机页连接。` })
      list.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  const stop = async (entry: SdkEntry) => {
    setBusy(`stop:${entry.id}`)
    setError(null)
    try {
      await backend.sdk.stop(entry.id)
      setNotice({ tone: 'info', text: `已请求停止 ${entry.name}。` })
      list.reload()
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(null)
    }
  }

  const openFolder = async () => {
    try {
      const result = await backend.sdk.openFolder()
      setFolder(result.path)
      if (!result.opened) setNotice({ tone: 'warning', text: `无法自动打开目录；请手动打开：${result.path}` })
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  const data: SdkList | null = list.data
  const actions = (
    <div className="row gap-8">
      <Button variant="secondary" icon="folder" onClick={() => void openFolder()}>打开清单目录</Button>
      <Button variant="primary" icon="refresh" loading={list.status === 'loading'} onClick={() => list.reload()}>重新扫描</Button>
    </div>
  )
  return (
    <>
      {embedded ? (
        <>
          <p className="page-sub">
            内置 EasyTier 仍是默认联机通道；这里是可选的第三方 sidecar 清单。清单不通过校验就不会出现在可启动列表里。
          </p>
          <div className="instance-settings-card__footer">{actions}</div>
        </>
      ) : (
        <PageHeader
          title="联机 SDK"
          subtitle="内置 EasyTier 仍是默认联机通道；这里是可选的第三方 sidecar 清单。清单不通过校验就不会出现在可启动列表里。"
          actions={actions}
        />
      )}

      {notice ? <Banner tone={notice.tone}>{notice.text}</Banner> : null}
      {error ? <div className="nw-inline-error" role="alert">{error.title}：{error.detail}{error.code ? `（${error.code}）` : ''}</div> : null}

      <Banner tone="info" title="如何添加第三方 SDK">
        在清单目录里为每个 SDK 建一个子目录，放入 <code className="mono">manifest.json</code> 与可执行文件（也支持根目录下的 *.json）。
        必填：<code className="mono">schemaVersion=1 / id / name / version / command</code>；命令必须是白名单内的 .exe 基名，不能是 shell/解释器，
        参数不能包含 shell 元字符；可选 <code className="mono">sha256</code>。未通过校验的条目会被拒绝加载。
        {folder ? <div className="mono" style={{ marginTop: 6 }}>{folder}</div> : null}
      </Banner>

      {list.status === 'loading' ? <Skeleton className="skeleton--text" style={{ width: '50%' }} /> : null}
      {list.status === 'error' || list.status === 'not-wired' ? (
        <DataStateNotice info={describeError(list.error)} onRetry={list.reload} />
      ) : null}

      {data ? (
        <Card>
          <div className="row gap-8" style={{ marginBottom: 12 }}>
            <Icon name="network" />
            <strong>已通过校验</strong>
            <Badge tone="success">{data.entries.length}</Badge>
            {data.rejected.length > 0 ? <Badge tone="warning">拒绝 {data.rejected.length}</Badge> : null}
          </div>
          {data.entries.length === 0 ? (
            <EmptyState icon="package" title="还没有可用的第三方 SDK" description="把符合格式的清单放进目录后点击“重新扫描”。内置 EasyTier 不受影响。" />
          ) : (
            <table className="table asset-table">
              <thead><tr><th>SDK</th><th>版本</th><th>命令</th><th>哈希</th><th>状态</th><th className="num">操作</th></tr></thead>
              <tbody>
                {data.entries.map((entry) => (
                  <SdkRow
                    key={entry.id}
                    entry={entry}
                    busy={busy}
                    onStart={() => void start(entry)}
                    onStop={() => void stop(entry)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {data && data.rejected.length > 0 ? (
        <Card>
          <div className="row gap-8" style={{ marginBottom: 12 }}>
            <Icon name="alert" />
            <strong>拒绝加载</strong>
            <Badge tone="danger">{data.rejected.length}</Badge>
          </div>
          <div className="nw-stack">
            {data.rejected.map((entry) => (
              <div key={entry.path} className="nw-inline-error" role="alert">
                <strong className="mono">{entry.path}</strong>
                <div>{entry.errors.join('；')}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}
    </>
  )
}
