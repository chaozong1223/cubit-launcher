import { useEffect, useMemo, useState } from 'react'
import type { CreateRoomInput, LanWorld, LanWorldsOutput, RoomInfo, RoomMember, Transport } from '@shared/net'
import type { LaunchState } from '@shared/launch'
import { useBackend } from '../data/BackendContext'
import { describeError, type LaunchStatusEvent, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import { useCurrentAccount } from '../data/useAccount'
import { navigate } from '../router'
import {
  Badge,
  Banner,
  Button,
  Card,
  DataStateNotice,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Segmented,
  Select,
  Skeleton,
  Switch,
  Tag,
} from '../ui'
import { Icon } from '../icons'

type Role = 'host' | 'member'

const ROLE_OPTIONS = [
  { value: 'host' as const, label: '我是房主' },
  { value: 'member' as const, label: '我是成员' },
]

const TRANSPORT_LABEL: Record<Transport, string> = {
  lan: '局域网直连',
  p2p: 'P2P 直连',
  relay: '中继',
  manual: '手动映射',
  none: '未建立',
}

function memberPath(path: RoomMember['path']): string {
  return path === 'direct' ? '直连' : path === 'relay' ? '中继' : '未知'
}

function memberStatusLabel(status: RoomMember['status']): string {
  if (status === 'connected') return '已连接'
  if (status === 'reconnecting') return '重连中'
  if (status === 'disconnected') return '已断线'
  return '未知'
}

function memberPingLabel(member: RoomMember): string {
  if (member.role === 'host') return '0 ms（房主）'
  if (!member.pingKnown) return member.pingLabel || '未知'
  return member.pingMs === null ? '未知' : `${member.pingMs} ms`
}

function TunnelBadge({ room }: { room: RoomInfo }) {
  const tunnel = room.tunnel
  const tone = tunnel.state === 'up' ? 'success' : tunnel.state === 'failed' ? 'danger' : tunnel.state === 'degraded' ? 'warning' : 'outline'
  return <Badge tone={tone} dot>{tunnel.state}{tunnel.relay ? ' · 中继' : ''}</Badge>
}

function RoomView({ room, isHost, onCopy, onLeave, onEnter, busy, enterLabel }: {
  room: RoomInfo
  isHost: boolean
  onCopy: () => void
  onLeave: () => void
  onEnter: () => void
  busy: boolean
  enterLabel: string
}) {
  return (
    <>
      <Card className="room-card">
        <div className="room-head">
          <div>
            <div className="eyebrow">{isHost ? '房主视图' : '成员视图'}</div>
            <h2>{room.state === 'connected' ? '房间已连接' : room.state === 'waiting' ? '等待成员加入' : `房间 · ${room.state}`}</h2>
            <div className="room-head__sub">
              {TRANSPORT_LABEL[room.transport]} · 房主 {room.host.name} · {room.host.mcVersion} / {room.host.loader}
            </div>
          </div>
          <div className="row gap-8"><TunnelBadge room={room} /><Badge tone={room.state === 'connected' ? 'success' : 'warning'}>{room.state}</Badge></div>
        </div>

        <div className="invite-box">
          <div>
            <div className="invite-box__label">房间邀请码</div>
            <div className="invite-code">{room.code}</div>
            <div className="invite-box__hint">
              {room.invite} · 有效期至 {room.expiresAt ? new Date(room.expiresAt).toLocaleString('zh-CN') : '长期'}
            </div>
          </div>
          <Button variant="primary" icon="copy" onClick={onCopy}>复制完整邀请</Button>
        </div>

        <div className="nw-room-meta">
          <span><Icon name="network" />隧道 <strong>{room.tunnel.state}</strong>{room.tunnel.version ? ` · ${room.tunnel.version}` : ''}</span>
          <span><Icon name="wifi" />世界端口 <strong>{room.world.port ?? '—'}</strong></span>
          <span><Icon name="activity" />控制端口 <strong>{room.ports.control ?? '—'}</strong></span>
          <span><Icon name="link" />最大成员 <strong>{room.maxMembers}</strong></span>
        </div>

        <div className="member-block">
          <div className="member-block__head">
            <h3>成员 <span className="muted">({room.members.length}/{room.maxMembers})</span></h3>
            <Badge tone="outline">{TRANSPORT_LABEL[room.transport]}</Badge>
          </div>
          {room.members.length === 0 ? (
            <EmptyState icon="user" title="还没有成员" description="把完整邀请码发给朋友；加入后会显示真实成员与网络信息。" />
          ) : (
            <div className="nw-member-list">
              {room.members.map((member) => (
                <div className="member-row" key={member.id}>
                  <span className="avatar avatar--sm" aria-hidden="true">{member.name.slice(0, 1).toUpperCase()}</span>
                  <span className="member-row__name">{member.name}{member.role === 'host' ? ' · 房主' : ''}</span>
                  <Tag>{member.mcVersion}</Tag>
                  <Tag>{member.loader}</Tag>
                  <span className="muted">{memberPingLabel(member)}</span>
                  <Badge tone={member.status === 'connected' ? 'success' : member.status === 'reconnecting' ? 'warning' : member.status === 'disconnected' ? 'danger' : 'outline'} dot>
                    {memberStatusLabel(member.status)}
                  </Badge>
                  <Badge tone={member.path === 'direct' ? 'success' : 'warning'}>{memberPath(member.path)}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="banner banner--info" style={{ marginTop: 14 }}>
          <Icon name="info" />
          <div className="banner__body">
            <div className="banner__title">进服前请对局域网开放</div>
            <div>进入世界后按 Esc →「对局域网开放」；房间的世界端口 {room.world.port ? `为 ${room.world.port}` : '尚未检测到'}。</div>
          </div>
        </div>

        {room.error ? (
          <div className="nw-inline-error">联机返回错误：{room.error.message}（{room.error.code}{room.error.retryable ? ' · 可重试' : ''}）</div>
        ) : null}

        <div className="room-actions">
          <Button variant="primary" size="lg" icon="play" onClick={onEnter} loading={busy}>{enterLabel}</Button>
          <Button variant="secondary" size="lg" icon="copy" onClick={onCopy}>复制邀请</Button>
          <Button variant="danger-ghost" size="lg" icon="close" onClick={onLeave} disabled={busy}>关闭房间</Button>
        </div>
      </Card>

      <Card className="link-card" style={{ marginTop: 14 }}>
        <h3>端口与网络</h3>
        <div className="check-list">
          <div className="check-item"><Icon name="network" />世界端口<span className="value">{room.world.port ?? '—'}</span></div>
          <div className="check-item"><Icon name="activity" />控制端口<span className="value">{room.ports.control ?? '—'}</span></div>
          <div className="check-item"><Icon name="wifi" />本机世界端口<span className="value">{room.ports.localWorld ?? '—'}</span></div>
          <div className="check-item"><Icon name="link" />隧道版本<span className="value">{room.tunnel.version ?? '—'}</span></div>
        </div>
        {room.manual ? (
          <div className="nw-manual">
            <div className="nw-manual__title">需要手动映射：{room.manual.reason}</div>
            <ol>{room.manual.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          </div>
        ) : null}
      </Card>
    </>
  )
}

function EnterWorldGuide({
  room,
  instanceName,
  accountLabel,
  premium,
  onClose,
}: {
  room: RoomInfo
  instanceName: string
  accountLabel: string
  premium: boolean
  onClose: () => void
}) {
  const [copied, setCopied] = useState(false)
  const steps = [
    '在游戏主菜单点击「多人游戏」',
    '进入「局域网世界」（LAN 世界）列表',
    `选择房主「${room.host.name}」的世界；如果还没看到，让房主按 Esc →「对局域网开放」并稍等刷新`,
  ]
  const text = [
    `使用 ${instanceName}（${accountLabel}）进入房主 ${room.host.name} 的世界：`,
    ...steps.map((step, index) => `${index + 1}. ${step}`),
    premium
      ? '说明：一键直连当前不可用，已改为启动游戏并手动进入多人菜单。'
      : '说明：离线/皮肤站账户不使用 --quickPlayMultiplayer 一键直连，避免原版「无效会话」错误。',
  ].join('\n')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setCopied(true)
  }

  return (
    <Card className="link-enter-guide">
      <div className="link-enter-guide__head">
        <div>
          <div className="eyebrow">游戏已启动 · 进入方式引导</div>
          <h3><Icon name="play" />进入房主的世界</h3>
          <p>
            {premium
              ? '一键直连不可用，已改为启动游戏后手动进入；请按下面步骤操作。'
              : `${accountLabel} 不支持原版一键直连；请按下面的步骤通过多人菜单进入，避免「登录失败：无效会话」。`}
          </p>
        </div>
        <Badge tone="success" dot>已启动</Badge>
      </div>
      <ol className="link-enter-guide__steps">
        {steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
      <div className="link-enter-guide__foot">
        <span className="muted">世界端口：{room.world.port ?? '等待房主对局域网开放'}</span>
        <div className="row gap-8">
          <Button size="sm" variant="secondary" icon="copy" onClick={() => void copy()}>{copied ? '已复制步骤' : '复制步骤'}</Button>
          <Button size="sm" variant="ghost" icon="close" onClick={onClose}>关闭提示</Button>
        </div>
      </div>
    </Card>
  )
}

function LanWorldPanel({ instanceId, instanceName, premium, onStartGuided }: { instanceId: string | null; instanceName?: string; premium: boolean; onStartGuided?: () => void }) {
  const backend = useBackend()
  const [worlds, setWorlds] = useState<LanWorld[]>([])
  const [scanning, setScanning] = useState(false)
  const [joining, setJoining] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)

  useEffect(() => {
    const off = backend.link.subscribeLanWorlds((event: LanWorldsOutput) => setWorlds(event.worlds))
    return off
  }, [backend])

  const scan = async () => {
    setScanning(true)
    setError(null)
    setNotice(null)
    try {
      setWorlds((await backend.link.lanWorlds({ timeoutMs: 1500 })).worlds)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setScanning(false)
    }
  }

  const join = async (world: LanWorld) => {
    if (!instanceId) {
      setError({ kind: 'error', title: '没有目标实例', detail: '先选择要启动的实例，再加入局域网世界。', retryable: false })
      return
    }
    if (!premium) {
      setError(null)
      setNotice('离线/皮肤站账户不发起一键直连。正在启动游戏，请从「多人游戏 → 局域网世界」手动选择房主世界。')
      onStartGuided?.()
      return
    }
    setJoining(world.id)
    setError(null)
    setNotice(null)
    try {
      const result = await backend.link.joinLanWorld({
        worldId: world.id,
        host: world.host,
        port: world.port,
        instanceId,
        accountId: null,
      })
      setNotice(`已启动 ${instanceName ?? instanceId}，目标 ${result.server.host}:${result.server.port}；session ${result.sessionId.slice(0, 8)}。`)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setJoining(null)
    }
  }

  return (
    <Card className="link-card lan-world-card">
      <div className="lan-world-head">
        <div>
          <h3><Icon name="wifi" />发现局域网世界</h3>
          <p>来自 UDP 4445 与房主游戏日志；加入会直接启动当前实例并注入服务器地址。</p>
        </div>
        <Button size="sm" variant="secondary" icon="search" loading={scanning} onClick={() => void scan()}>扫描 LAN 世界</Button>
      </div>
      {notice ? <Banner tone="success">{notice}</Banner> : null}
      {error ? <div className="nw-inline-error">{error.title}：{error.detail}</div> : null}
      {worlds.length === 0 ? (
        <div className="lan-world-empty">
          <span>还没有发现 LAN 世界。让房主在游戏内「对局域网开放」，或点击扫描。</span>
        </div>
      ) : (
        <div className="lan-world-list">
          {worlds.map((world) => (
            <div className="lan-world-row" key={world.id}>
              <div className="lan-world-row__main">
                <strong>{world.motd || '未命名 LAN 世界'}</strong>
                <span className="mono">{world.host}:{world.port} · {world.source === 'local-log' ? '房主日志' : '组播发现'} · {new Date(world.lastSeen).toLocaleTimeString('zh-CN')}</span>
              </div>
              <Button
                size="sm"
                variant="primary"
                icon="play"
                loading={joining === world.id}
                disabled={!instanceId || Boolean(joining)}
                title={!instanceId ? '先选择实例' : '启动游戏并加入此 LAN 世界'}
                onClick={() => void join(world)}
              >
                一键加入
              </Button>
            </div>
          ))}
        </div>
      )}
      {!instanceId ? <div className="lan-world-hint">加入前需要可启动的实例；当前没有选择。</div> : null}
    </Card>
  )
}

export function LinkPage() {
  const backend = useBackend()
  const link = useAsync(() => backend.link.status(), [])
  const instances = useAsync(() => backend.instances.list(), [])
  const [role, setRole] = useState<Role>('host')
  const [instanceId, setInstanceId] = useState('')
  const [invite, setInvite] = useState('')
  const [consentTunnel, setConsentTunnel] = useState(false)
  const [transport, setTransport] = useState<'auto' | 'lan'>('auto')
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const [actionError, setActionError] = useState<UiErrorInfo | null>(null)
  const [copied, setCopied] = useState(false)
  const [strategyNotice, setStrategyNotice] = useState<string | null>(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const [guideReady, setGuideReady] = useState(false)
  const auth = useCurrentAccount()

  const firstReady = useMemo(() => instances.data?.find((instance) => instance.state === 'ready') ?? null, [instances.data])
  const selectedInstance = instances.data?.find((instance) => instance.id === (instanceId || firstReady?.id)) ?? null
  const currentAccount = auth.data?.accounts.find((account) => account.id === auth.data?.selectedId) ?? auth.data?.accounts[0] ?? null
  const premium = currentAccount?.kind === 'microsoft'
  const accountLabel = currentAccount?.kind === 'microsoft'
    ? 'Microsoft 正版账户'
    : currentAccount?.kind === 'authlib'
      ? 'Authlib/皮肤站账户'
      : currentAccount
        ? '离线账户'
        : '未选择账户'
  const room = link.data
  const pending = link.status === 'not-wired' || link.status === 'error'
  const info = pending ? describeError(link.error) : null

  useEffect(() => {
    if (!room) return
    if (!instanceId && firstReady) setInstanceId(firstReady.id)
  }, [room, instanceId, firstReady])

  useEffect(() => {
    const offs = [
      backend.link.subscribeState(() => link.reload()),
      backend.link.subscribeMembers(() => link.reload()),
      backend.link.subscribeWorld(() => link.reload()),
      backend.link.subscribeError(() => link.reload()),
    ]
    return () => offs.forEach((off) => off())
  }, [backend, link.reload])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setActionError(null)
    try {
      await fn()
      link.reload()
    } catch (cause) {
      setActionError(describeError(cause))
    } finally {
      setBusy(false)
    }
  }

  const create = () => {
    if (!selectedInstance) {
      setActionError({ kind: 'error', title: '需要先选择实例', detail: '开房需要实例的真实版本与加载器信息；当前没有可用实例。', retryable: false })
      return
    }
    setRole('host')
    const input: CreateRoomInput = { instanceId: selectedInstance.id, transport, consentTunnel }
    void run(() => backend.link.create(input))
  }

  const join = () => {
    if (!invite.trim()) {
      setActionError({ kind: 'error', title: '邀请码为空', detail: '请输入完整的 MCL1 邀请串，而不是 6 位房间号。', retryable: false })
      return
    }
    void run(() => backend.link.join({ ticket: invite.trim(), instanceId: selectedInstance?.id ?? null }))
    setRole('member')
  }

  const copyInvite = () => {
    void (async () => {
      try {
        const result = await backend.link.copyInvite()
        try {
          await navigator.clipboard.writeText(result.ticket)
        } catch {
          const area = document.createElement('textarea')
          area.value = result.ticket
          document.body.appendChild(area)
          area.select()
          document.execCommand('copy')
          area.remove()
        }
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1800)
      } catch (cause) {
        setActionError(describeError(cause))
      }
    })()
  }

  const waitForRunning = (instanceId: string): Promise<LaunchState> => new Promise((resolve, reject) => {
    let settled = false
    let off: () => void = () => undefined
    const finish = (state: LaunchState) => {
      if (settled) return
      settled = true
      off()
      if (state === 'running') resolve(state)
      else reject(new Error('游戏进程没有进入运行状态；请检查启动日志。'))
    }
    off = backend.launch.subscribeStatus((event: LaunchStatusEvent) => {
      if (event.instanceId !== instanceId) return
      if (event.state === 'running' || event.state === 'crashed' || event.state === 'exited') finish(event.state)
    })
    void backend.launch.status(instanceId).then((status) => {
      if (status.state === 'running' || status.state === 'crashed' || status.state === 'exited') finish(status.state)
    }).catch(() => undefined)
  })

  const startGuided = async (fallbackReason?: string) => {
    let instance = selectedInstance
    let account = currentAccount
    if (!instance) {
      const list = await backend.instances.list().catch(() => [])
      instance = list.find((item) => item.state === 'ready') ?? list[0] ?? null
      if (instance) setInstanceId(instance.id)
    }
    if (!account) {
      const state = await backend.auth.list().catch(() => null)
      account = state?.accounts.find((item) => item.id === state.selectedId) ?? state?.accounts[0] ?? null
    }
    if (!instance) {
      setActionError({ kind: 'error', title: '没有可启动实例', detail: '请先在联机页选择实例，或到实例页安装一个版本。', retryable: false })
      return
    }
    if (!account) {
      setActionError({ kind: 'error', title: '还没有启动账户', detail: '请先到「设置 → 账户」创建离线账户或登录正版账户。', retryable: false })
      return
    }
    setStarting(true)
    setActionError(null)
    setGuideOpen(false)
    setGuideReady(false)
    setStrategyNotice(fallbackReason ? `${fallbackReason}；正在改为启动游戏并引导进入多人菜单。` : null)
    try {
      const current = await backend.launch.status(instance.id)
      const alreadyStarting = current.state === 'precheck' || current.state === 'java' || current.state === 'args' || current.state === 'spawning'
      if (current.state !== 'running' && !alreadyStarting) {
        await backend.launch.start(instance.id, account.id)
      }
      const state = await waitForRunning(instance.id)
      if (state !== 'running') throw new Error('游戏未能进入运行状态')
      setGuideReady(true)
      setGuideOpen(true)
      setStrategyNotice(
        fallbackReason
          ? `${fallbackReason}；已启动游戏，请按步骤手动进入多人菜单。`
          : '游戏已启动。离线/皮肤站账户请按步骤进入多人菜单，不发起一键直连。',
      )
    } catch (cause) {
      const info = describeError(cause)
      setActionError(fallbackReason ? { ...info, detail: `${fallbackReason}；${info.detail}` } : info)
    } finally {
      setStarting(false)
    }
  }

  const enterWorld = () => {
    if (starting || busy) return
    if (!premium) {
      // Offline / Authlib accounts must not use --quickPlayMultiplayer: the
      // vanilla client rejects their session. Start normally and guide instead.
      void startGuided()
      return
    }
    setBusy(true)
    setActionError(null)
    void (async () => {
      try {
        await backend.link.enterWorld({ instanceId: selectedInstance?.id ?? null, accountId: currentAccount?.id ?? null })
        setGuideOpen(false)
        setGuideReady(false)
        setStrategyNotice('Microsoft 正版账户：已通过一键直连启动游戏并注入房间地址。')
      } catch (cause) {
        const info = describeError(cause)
        await startGuided(`一键直连不可用：${info.title}`)
      } finally {
        setBusy(false)
      }
    })()
  }

  return (
    <>
      <PageHeader
        title="联机"
        subtitle={room ? `房间 ${room.code} · ${room.state} · ${TRANSPORT_LABEL[room.transport]}` : '把朋友的设备组成虚拟局域网；房间与隧道状态来自 net 模块真实事件。'}
        actions={(
          <>
            <Badge tone={room ? 'success' : 'outline'} dot>{room ? room.state : '未加入房间'}</Badge>
            <Button variant="secondary" size="sm" onClick={() => navigate('/settings/link')}>联机设置</Button>
          </>
        )}
      />

      {info ? <DataStateNotice info={info} onRetry={link.reload} /> : null}

      <Banner
        tone={!currentAccount ? 'warning' : premium ? 'success' : 'info'}
        title={!currentAccount ? '还没有启动账户' : premium ? '进入方式：一键直连' : '进入方式：启动游戏 + 多人菜单引导'}
      >
        {!currentAccount
          ? '请先在「设置 → 账户」创建离线账户或登录 Microsoft 正版账户。'
          : premium
            ? 'Microsoft 正版账户可使用一键直连；若直连不可用，会自动回退到启动游戏并显示进入步骤。'
            : `${accountLabel} 不使用 --quickPlayMultiplayer 直连，避免原版「登录失败：无效会话」。启动游戏后会显示可复制的进世界步骤。`}
      </Banner>
      {strategyNotice ? <Banner tone="info">{strategyNotice}</Banner> : null}

      <div className="link-toolbar">
        {room ? <Badge tone="accent">当前房间 · {room.code}</Badge> : (
          <Segmented value={role} options={ROLE_OPTIONS} onChange={setRole} ariaLabel="房间角色" />
        )}
        <span className="link-toolbar__state">
          <span className={`status-dot status-dot--${room ? (room.state === 'connected' ? 'ok' : 'warn') : 'muted'}`} />
          {room ? `${room.members.length} 位成员 · ${TRANSPORT_LABEL[room.transport]}` : '尚未建立房间'}
        </span>
        <div className="toolbar__spacer" />
        {room ? <Button size="sm" variant="ghost" icon="refresh" onClick={link.reload}>刷新状态</Button> : null}
      </div>

      {link.status === 'loading' ? (
        <Card className="nw-loading"><Skeleton className="skeleton--title" style={{ width: '34%' }} /><Skeleton className="skeleton--text" style={{ width: '72%', marginTop: 12 }} /><Skeleton className="skeleton--block" style={{ height: 80, marginTop: 16 }} /></Card>
      ) : room ? (
        <div className="link-grid">
          <div className="link-main">
            {guideOpen ? (
              <EnterWorldGuide
                room={room}
                instanceName={selectedInstance?.name ?? '当前实例'}
                accountLabel={accountLabel}
                premium={premium}
                onClose={() => setGuideOpen(false)}
              />
            ) : guideReady ? (
              <Button size="sm" variant="secondary" icon="info" onClick={() => setGuideOpen(true)}>显示进世界步骤</Button>
            ) : null}
            <RoomView room={room} isHost={role === 'host'} onCopy={copyInvite} onLeave={() => void run(() => backend.link.leave())} onEnter={enterWorld} busy={busy || starting} enterLabel={premium ? '启动游戏并进服' : '启动游戏并进入多人菜单'} />
            <LanWorldPanel instanceId={selectedInstance?.id ?? null} instanceName={selectedInstance?.name} premium={premium} onStartGuided={() => void startGuided()} />
            {copied ? <div className="nw-copy-note"><Icon name="check" />完整邀请已复制到剪贴板（不会写入日志）。</div> : null}
            {actionError ? <div className="nw-inline-error">{actionError.title}：{actionError.detail}</div> : null}
          </div>
          <aside className="link-aside">
            <Card className="link-card">
              <h3>实例一致性</h3>
              <div className="check-list">
                <div className="check-item"><Icon name="lock" />游戏版本<span className="value">{room.host.mcVersion}</span></div>
                <div className="check-item"><Icon name="lock" />加载器<span className="value">{room.host.loader}</span></div>
                <div className="check-item"><Icon name="coffee" />Java<span className="value">由 launch 预检</span></div>
              </div>
            </Card>
            <Card className="link-card">
              <h3>隧道状态</h3>
              <div className="info-list">
                <div className="info-row"><span className="info-row__label">状态</span><span className="info-row__value"><TunnelBadge room={room} /></span></div>
                <div className="info-row"><span className="info-row__label">EasyTier</span><span className="info-row__value mono">{room.tunnel.version ?? '—'}</span></div>
                <div className="info-row"><span className="info-row__label">中继</span><span className="info-row__value">{room.tunnel.relay ? '是' : '否'}</span></div>
              </div>
            </Card>
            <Card className="link-card">
              <h3>怎么玩</h3>
              <div className="steps">
                <div className="step"><span><strong>双方使用同一实例</strong>（版本/加载器一致）</span></div>
                <div className="step"><span><strong>房主创建房间</strong>，把完整邀请码发给朋友</span></div>
                <div className="step"><span><strong>成员加入后启动游戏</strong></span></div>
                <div className="step"><span><strong>房主对局域网开放</strong>，成员在多人游戏加入</span></div>
              </div>
            </Card>
          </aside>
        </div>
      ) : (
        <div className="link-grid">
          <div className="link-main">
            <Card className="room-card">
              <div className="room-head">
                <div>
                  <div className="eyebrow">{role === 'host' ? '房主视图' : '成员视图'}</div>
                  <h2>{role === 'host' ? '创建房间' : '加入房间'}</h2>
                  <div className="room-head__sub">
                    {role === 'host'
                      ? '选择真实实例后创建房间；隧道与成员状态来自 net 模块。'
                      : '输入完整邀请码；加入前会校验版本与加载器。'}
                  </div>
                </div>
                <Badge tone="outline">{role === 'host' ? '未开房' : '未加入'}</Badge>
              </div>

              {role === 'host' ? (
                <>
                  <div className="form-grid" style={{ marginTop: 16 }}>
                    <Field label="实例" hint={instances.data ? '真实实例列表，来自 mc:instance:list' : '实例列表不可用'}>
                      <Select value={instanceId || firstReady?.id || ''} onChange={(event) => setInstanceId(event.target.value)} aria-label="开房实例" disabled={instances.status !== 'ready' || !instances.data?.length}>
                        <option value="">{instances.status === 'loading' ? '正在读取实例…' : instances.data?.length ? '选择一个实例' : '没有可用实例'}</option>
                        {instances.data?.filter((instance) => instance.state === 'ready').map((instance) => (
                          <option key={instance.id} value={instance.id}>{instance.name} · {instance.mcVersion ?? '版本未知'} · {instance.loader.type}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="连接方式" hint="自动优先局域网，必要时下载/启动隧道组件">
                      <Select value={transport} onChange={(event) => setTransport(event.target.value as 'auto' | 'lan')} aria-label="连接方式">
                        <option value="auto">自动选择</option>
                        <option value="lan">仅局域网</option>
                      </Select>
                    </Field>
                  </div>
                  <div className="setting-group" style={{ border: 0, padding: '10px 0' }}>
                    <div className="setting-group__text"><div className="setting-group__title">允许下载并启动联机隧道组件</div><div className="setting-group__desc">EasyTier (LGPL-3.0) 独立进程；需要你的明确同意。</div></div>
                    <div className="setting-control"><Switch checked={consentTunnel} onChange={setConsentTunnel} label="允许联机隧道组件" /></div>
                  </div>
                  {!instances.data?.length && instances.status === 'ready' ? (
                    <Banner tone="warning" title="还没有可用实例" actions={<Button size="sm" variant="secondary" onClick={() => navigate('/instances')}>管理实例</Button>}>
                      开房需要实例的版本与加载器信息。安装一个版本后再回来。
                    </Banner>
                  ) : null}
                  <div className="room-actions">
                    <Button variant="primary" size="lg" icon="link" onClick={create} loading={busy} disabled={!selectedInstance || instances.status !== 'ready'}>创建房间</Button>
                    <Button variant="secondary" size="lg" onClick={() => setRole('member')}>改用邀请码加入</Button>
                  </div>
                </>
              ) : (
                <>
                  <div className="join-form" style={{ marginTop: 16 }}>
                    <Field label="完整邀请码" hint="形如 MCL1.XXXXXX.…；6 位房间号不足以跨网加入">
                      <Input value={invite} onChange={(event) => setInvite(event.target.value)} placeholder="粘贴完整邀请码" aria-label="完整邀请码" />
                    </Field>
                    <Button variant="primary" size="lg" icon="link" onClick={join} loading={busy} disabled={!invite.trim()}>加入房间</Button>
                  </div>
                  <div className="setting-group" style={{ border: 0, padding: '10px 0' }}>
                    <div className="setting-group__text"><div className="setting-group__title">加入后使用实例</div><div className="setting-group__desc">用于版本/加载器一致性检查；可选择不指定。</div></div>
                    <div className="setting-control">
                      <Select value={instanceId} onChange={(event) => setInstanceId(event.target.value)} aria-label="加入后使用实例" disabled={instances.status !== 'ready'}>
                        <option value="">不指定</option>
                        {instances.data?.filter((instance) => instance.state === 'ready').map((instance) => (
                          <option key={instance.id} value={instance.id}>{instance.name}</option>
                        ))}
                      </Select>
                    </div>
                  </div>
                  <div className="room-actions">
                    <Button variant="primary" size="lg" icon="link" onClick={join} loading={busy} disabled={!invite.trim()}>加入房间</Button>
                    <Button variant="secondary" size="lg" onClick={() => setRole('host')}>改为创建房间</Button>
                  </div>
                </>
              )}

              {actionError ? <div className="nw-inline-error">{actionError.title}：{actionError.detail}</div> : null}
            </Card>
            <LanWorldPanel instanceId={selectedInstance?.id ?? null} instanceName={selectedInstance?.name} premium={premium} onStartGuided={() => void startGuided()} />
          </div>

          <aside className="link-aside">
            <Card className="link-card">
              <h3>联机检查</h3>
              <div className="check-list">
                <div className="check-item"><Icon name="lock" />实例版本<span className="value">加入时校验</span></div>
                <div className="check-item"><Icon name="lock" />加载器<span className="value">加入时校验</span></div>
                <div className="check-item"><Icon name="network" />隧道<span className="value">{consentTunnel ? '已同意' : '未同意'}</span></div>
              </div>
            </Card>
            <Card className="link-card">
              <h3>怎么玩</h3>
              <div className="steps">
                <div className="step"><span><strong>双方使用同一实例</strong>（模组清单一致）</span></div>
                <div className="step"><span><strong>房主创建房间</strong>，把完整邀请码发给朋友</span></div>
                <div className="step"><span><strong>成员加入后启动游戏</strong></span></div>
                <div className="step"><span><strong>房主对局域网开放</strong>，成员在多人游戏加入</span></div>
              </div>
            </Card>
          </aside>
        </div>
      )}
    </>
  )
}
