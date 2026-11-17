import { useEffect, useMemo, useState } from 'react'
import type { ServerInfo, ServerVersion } from '@shared/server'
import type { RoomInfo } from '@shared/net'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { Badge, Banner, Button, Card, EmptyState, Field, Input, copyToClipboard } from '../ui'
import { Icon } from '../icons'

const STATE_LABEL: Record<ServerInfo['state'], string> = {
  stopped: '已停止',
  starting: '启动中',
  running: '运行中',
  stopping: '停止中',
  crashed: '已崩溃',
}

const STATE_TONE: Record<ServerInfo['state'], 'success' | 'accent' | 'danger' | 'neutral'> = {
  stopped: 'neutral',
  starting: 'accent',
  running: 'success',
  stopping: 'accent',
  crashed: 'danger',
}

function formatTime(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN')
}

export function ServerPage() {
  const backend = useBackend()
  const servers = useAsync(() => backend.server.list(), [])
  const versions = useAsync(() => backend.server.versions(), [])
  const [selected, setSelected] = useState<string | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [command, setCommand] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  // Room created by "share this server"; the code is what friends type in 联机.
  const [sharedRoom, setSharedRoom] = useState<RoomInfo | null>(null)

  const share = async (server: ServerInfo): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const room = await backend.link.shareServer({
        port: server.port,
        mcVersion: server.mcVersion,
      })
      setSharedRoom(room)
      setNotice(`已分享：房间码 ${room.code}`)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const copyShared = async (): Promise<void> => {
    if (!sharedRoom) return
    const ok = await copyToClipboard(sharedRoom.code)
    setNotice(ok ? '房间码已复制' : '复制失败，请手动选中复制')
  }

  // create form
  const [name, setName] = useState('')
  const [versionId, setVersionId] = useState('')
  const [port, setPort] = useState('25565')
  const [memoryMb, setMemoryMb] = useState('2048')
  const [onlineMode, setOnlineMode] = useState(true)
  const [eula, setEula] = useState(false)

  const list = servers.data ?? []
  const current = useMemo(() => list.find((server) => server.id === selected) ?? null, [list, selected])

  useEffect(() => {
    const off = backend.server.subscribeChanged(() => servers.reload())
    return () => off()
  }, [backend, servers.reload])

  useEffect(() => {
    if (selected || list.length === 0) return
    setSelected(list[0].id)
  }, [list, selected])

  useEffect(() => {
    if (!current || current.state === 'stopped' || current.state === 'crashed') {
      if (current) void backend.server.logs(current.id, 300).then((result) => setLogs(result.lines)).catch(() => undefined)
      return
    }
    const timer = window.setInterval(() => {
      void backend.server.logs(current.id, 300)
        .then((result) => setLogs(result.lines))
        .catch(() => undefined)
    }, 2000)
    return () => window.clearInterval(timer)
  }, [backend, current])

  const run = async (fn: () => Promise<unknown>, message?: string): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      servers.reload()
      if (message) {
        setNotice(message)
        window.setTimeout(() => setNotice(null), 2500)
      }
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const create = async (): Promise<void> => {
    if (!eula) {
      setError({ kind: 'error', title: '需要先同意 EULA', detail: 'Minecraft 服务端要求同意 EULA 才能运行；勾选后创建。', retryable: false })
      return
    }
    if (!versionId) {
      setError({ kind: 'error', title: '选择版本', detail: '先选一个带服务端下载的版本。', retryable: false })
      return
    }
    await run(
      () => backend.server.create({
        name: name.trim() || versionId,
        versionId,
        port: Number(port) || 25565,
        memoryMb: Number(memoryMb) || 2048,
        onlineMode,
        acceptEula: true,
      }),
      '服务器已创建',
    )
  }

  const canCreate = (versions.data ?? []).length > 0

  return (
    <div className="page">
      <header className="page__head">
        <div>
          <h1 className="page__title">开服</h1>
          <p className="page__sub">在启动器里下载并运行原版服务端；Forge/Fabric 服务端需要安装器，暂不支持一键创建。</p>
        </div>
      </header>

      {error ? <Banner tone="danger" title={`${error.title}：${error.detail}`} /> : null}
      {notice ? <Banner tone="success" title={notice} /> : null}

      <Card>
        <div className="card__head">
          <div>
            <h2 className="card__title">创建服务器</h2>
            <div className="card__sub">选择一个可开服的版本，下载 server.jar 并初始化配置。</div>
          </div>
        </div>
        {!canCreate ? (
          <EmptyState
            icon="network"
            title="没有可一键开服的版本"
            description="先在「安装与下载」里装一个原版版本（版本 JSON 里带服务端下载地址），再回来创建服务器。"
          />
        ) : (
          <div className="nw-stack">
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              <Field label="名称">
                <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="我的服务器" />
              </Field>
              <Field label="版本">
                <select
                  className="input"
                  value={versionId}
                  onChange={(event) => setVersionId(event.target.value)}
                >
                  <option value="">选择版本…</option>
                  {(versions.data ?? []).map((version: ServerVersion) => (
                    <option key={version.id} value={version.id}>
                      {version.loader === 'vanilla'
                        ? version.id
                        : `${version.id}（${version.loader}${version.loaderVersion ? ` ${version.loaderVersion}` : ''}）`}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
              <Field label="端口">
                <Input value={port} onChange={(event) => setPort(event.target.value)} />
              </Field>
              <Field label="内存 (MB)">
                <Input value={memoryMb} onChange={(event) => setMemoryMb(event.target.value)} />
              </Field>
              <Field label="正版验证">
                <label className="row gap-8" style={{ alignItems: 'center', height: 38 }}>
                  <input type="checkbox" checked={onlineMode} onChange={(event) => setOnlineMode(event.target.checked)} />
                  <span className="muted">online-mode={String(onlineMode)}</span>
                </label>
              </Field>
            </div>
            <label className="row gap-8" style={{ alignItems: 'center' }}>
              <input type="checkbox" checked={eula} onChange={(event) => setEula(event.target.checked)} />
              <span className="muted">
                我同意 <a href="https://aka.ms/MinecraftEULA" target="_blank" rel="noreferrer">Minecraft EULA</a>（服务端要求）
              </span>
            </label>
            <div>
              <Button variant="primary" icon="plus" onClick={() => void create()} loading={busy} disabled={!eula}>
                创建并下载服务端
              </Button>
            </div>
          </div>
        )}
      </Card>

      <Card>
        <div className="card__head">
          <div>
            <h2 className="card__title">我的服务器</h2>
            <div className="card__sub">{list.length > 0 ? `${list.length} 个服务器` : '还没有服务器'}</div>
          </div>
          <Button size="sm" variant="secondary" icon="refresh" onClick={() => servers.reload()}>刷新</Button>
        </div>
        {list.length === 0 ? (
          <EmptyState icon="network" title="还没有服务器" description="在上面创建一个：会下载服务端、写入 eula 与 server.properties。" />
        ) : (
          <div className="nw-stack">
            {list.map((server) => (
              <div
                key={server.id}
                className="instance-settings-card"
                style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', outline: server.id === selected ? '1px solid var(--accent)' : undefined }}
                onClick={() => setSelected(server.id)}
              >
                <div style={{ flex: '1 1 320px', minWidth: 0 }}>
                  <div className="row gap-8" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
                    <strong>{server.name}</strong>
                    <Badge tone={STATE_TONE[server.state]}>{STATE_LABEL[server.state]}</Badge>
                    <span className="muted">{server.mcVersion ?? server.versionId}</span>
                  </div>
                  <div className="muted mono" style={{ fontSize: 12, marginTop: 4 }}>
                    端口 {server.port} · 内存 {server.memoryMb} MB · {server.onlineMode ? '正版验证' : '离线模式'} · 创建于 {formatTime(server.createdAt)}
                  </div>
                </div>
                <div className="row gap-8">
                  {server.state === 'running' || server.state === 'starting' ? (
                    <Button size="sm" variant="danger-ghost" onClick={() => void run(() => backend.server.stop(server.id), '已请求停止')} disabled={busy}>停止</Button>
                  ) : (
                    <Button size="sm" variant="primary" onClick={() => void run(() => backend.server.start(server.id), '服务端启动中')} disabled={busy}>启动</Button>
                  )}
                  {server.state === 'running' && server.port === 25565 ? (
                    <Button size="sm" variant="secondary" icon="link" onClick={() => void share(server)} disabled={busy}>分享到联机</Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => void run(() => backend.server.remove(server.id), '服务器已删除')} disabled={busy}>删除</Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {sharedRoom ? (
        <Card>
          <div className="card__head">
            <div>
              <h2 className="card__title">已分享到联机</h2>
              <div className="card__sub">把这个房间码发给朋友，对方在「联机」页粘贴后加入。</div>
            </div>
          </div>
          <div className="invite-box">
            <div>
              <div className="invite-box__label">房间码</div>
              <div className="invite-code">{sharedRoom.code}</div>
              <div className="invite-box__hint">
                朋友：联机页 → 加入 → 粘贴房间码 → 进游戏（会自动连到你的服务器）
              </div>
            </div>
            <Button variant="primary" icon="copy" onClick={() => void copyShared()}>复制房间码</Button>
          </div>
        </Card>
      ) : null}

      {current ? (
        <Card>
          <div className="card__head">
            <div>
              <h2 className="card__title">控制台 · {current.name}</h2>
              <div className="card__sub">
                {current.pid ? `PID ${current.pid}` : '未运行'} · {STATE_LABEL[current.state]}
              </div>
            </div>
          </div>
          <pre
            className="mono"
            style={{ maxHeight: 320, overflow: 'auto', fontSize: 12, background: 'var(--surface-2)', padding: 10, borderRadius: 8 }}
          >
            {logs.length > 0 ? logs.join('\n') : '（暂无输出；启动后这里会显示服务端日志）'}
          </pre>
          <div className="row gap-8" style={{ marginTop: 8 }}>
            <Input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="输入命令，例如 list / say hello / stop"
            />
            <Button
              variant="secondary"
              icon="terminal"
              disabled={!command.trim() || current.state !== 'running'}
              onClick={() => {
                const value = command.trim()
                if (!value) return
                void run(() => backend.server.command(current.id, value))
                setCommand('')
              }}
            >
              发送
            </Button>
          </div>
          <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
            <Icon name="info" /> 服务端控制台命令；离线模式仍需要 op 才能执行管理命令。
          </div>
        </Card>
      ) : null}
    </div>
  )
}
