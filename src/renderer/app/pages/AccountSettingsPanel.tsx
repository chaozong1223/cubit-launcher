import { useEffect, useState } from 'react'
import type { Account, DeviceCode, MicrosoftConfig } from '@shared/auth'
import { useBackend } from '../data/BackendContext'
import { describeError, type UiErrorInfo } from '../data/backend'
import { useAsync } from '../data/useAsync'
import {
  Badge,
  Banner,
  Button,
  DataStateNotice,
  EmptyState,
  Field,
  Input,
} from '../ui'
import { Icon } from '../icons'

function authFailureText(cause: unknown): UiErrorInfo {
  const info = describeError(cause)
  return { ...info, detail: info.detail || (cause instanceof Error ? cause.message : String(cause)) }
}

function authlibFailureText(cause: unknown): UiErrorInfo {
  const info = authFailureText(cause)
  const haystack = `${info.code ?? ''} ${info.detail}`.toLowerCase()
  const withCode = (title: string, detail: string, retryable: boolean): UiErrorInfo => ({
    ...info,
    title,
    detail: `${detail}${info.code ? `（${info.code}）` : ''}`,
    retryable,
  })
  if (/profile[^ ]*missing|没有.*(档案|角色)|selectedprofile/.test(haystack)) {
    return withCode('皮肤站账号还没有游戏角色', '请先打开皮肤站创建 Minecraft 角色（selectedProfile），再回到启动器登录。', false)
  }
  if (/login[^ ]*required|reauth|重新登录|登录已失效/.test(haystack)) {
    return withCode('需要重新登录皮肤站', '当前皮肤站登录已失效，请在下方重新输入密码登录；账户和历史配置会保留。', true)
  }
  if (/email[^ ]*(verify|verification|verified)|邮箱.*(验证|未验证)|需要.*邮箱/.test(haystack)) {
    return withCode('需要先验证邮箱', '该皮肤站要求先完成邮箱验证。请打开皮肤站验证邮箱后再登录。', false)
  }
  if (/network|unreachable|econn|etimedout|timeout|connection|无法连接|连接失败|超时/.test(haystack)) {
    return withCode('无法连接皮肤站', '请检查网络、代理与证书，并确认地址是 HTTPS 的 /api/yggdrasil 根地址。', true)
  }
  if (/invalid_grant|token.*(expir|invalid)|session.*expir|登录.*过期|令牌.*过期/.test(haystack)) {
    return withCode('登录已过期', '登录令牌已过期，请重新输入密码完成 Authlib 重新登录。', true)
  }
  if (/invalid.?credential|wrong.?password|auth.*failed|login.*failed|bad.?password|authenticate.*fail|用户名或密码|密码错误/.test(haystack)) {
    return withCode('用户名或密码错误', '请检查皮肤站账户名与密码；连续失败可能触发站点限流。密码不会保存，也不会写入日志。', true)
  }
  return info
}

function AuthlibAvatar({ account }: { account: Account }) {
  const backend = useBackend()
  const profile = useAsync(() => backend.auth.profile(account.id), [account.id])
  const [broken, setBroken] = useState(false)
  const url = profile.data?.avatarUrl ?? profile.data?.skinUrl ?? null

  useEffect(() => {
    setBroken(false)
  }, [url])

  useEffect(() => {
    const off = backend.auth.subscribeChanged(() => profile.reload())
    return off
  }, [backend, profile.reload])

  if (url && !broken) {
    return (
      <img
        className="avatar avatar--sm authlib-avatar"
        src={url}
        alt=""
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    )
  }
  return <span className="avatar avatar--sm" aria-hidden="true">{account.name.slice(0, 1).toUpperCase()}</span>
}

function deviceFailure(message: string, hint?: string): UiErrorInfo {
  return {
    kind: 'error',
    title: message,
    detail: hint ? `${message} — ${hint}` : message,
    retryable: true,
  }
}

export function AccountSettingsPanel() {
  const backend = useBackend()
  const auth = useAsync(() => backend.auth.list(), [])
  const microsoft = useAsync(() => backend.auth.getMicrosoftConfig(), [])
  const authlib = useAsync(() => backend.auth.authlibInfo(), [])
  const [offlineName, setOfflineName] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<UiErrorInfo | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [device, setDevice] = useState<DeviceCode | null>(null)
  const [deviceError, setDeviceError] = useState<UiErrorInfo | null>(null)
  const [msClientId, setMsClientId] = useState('')
  const [msTenant, setMsTenant] = useState('')
  const [authlibName, setAuthlibName] = useState('')
  const [authlibServer, setAuthlibServer] = useState('')
  const [authlibPassword, setAuthlibPassword] = useState('')
  const [authlibReloginId, setAuthlibReloginId] = useState<string | null>(null)
  const [authlibNotice, setAuthlibNotice] = useState<string | null>(null)

  const selected = auth.data?.accounts.find((account) => account.id === auth.data?.selectedId) ?? null
  const selectedAuthlib = selected?.kind === 'authlib' ? selected : null

  useEffect(() => {
    const off = backend.auth.subscribeChanged(() => auth.reload())
    return off
  }, [backend, auth.reload])

  useEffect(() => {
    if (microsoft.data) setMsTenant((current) => current || microsoft.data?.tenant || '')
  }, [microsoft.data])

  useEffect(() => {
    if (authlib.data?.server) setAuthlibServer((current) => current || authlib.data?.server || '')
    else if (selectedAuthlib?.authlibServer) setAuthlibServer((current) => current || selectedAuthlib.authlibServer || '')
  }, [authlib.data?.server, selectedAuthlib?.authlibServer])

  const run = async (key: string, task: () => Promise<void>, mapError: (cause: unknown) => UiErrorInfo = authFailureText) => {
    setBusy(key)
    setError(null)
    setNotice(null)
    try {
      await task()
    } catch (cause) {
      setError(mapError(cause))
    } finally {
      setBusy(null)
    }
  }

  const createOffline = () => run('offline', async () => {
    await backend.auth.createOffline(offlineName.trim())
    setOfflineName('')
    auth.reload()
    setNotice('离线账户已创建并选中。')
  })

  const selectAccount = (id: string) => run(`select:${id}`, async () => {
    await backend.auth.select(id)
    auth.reload()
  })

  const beginMicrosoft = () => run('microsoft', async () => {
    setDeviceError(null)
    if (microsoft.data && !microsoft.data.configured) {
      setDevice(null)
      setDeviceError({
        kind: 'not-wired',
        title: '未配置微软应用 ID',
        detail: '设置环境变量 MCL_MS_CLIENT_ID（可选 MCL_MS_TENANT），或在下方填入 Azure 应用客户端 ID 后保存；离线账户可正常使用。',
        code: 'MS_CLIENT_ID_MISSING',
        feature: '微软登录',
        retryable: false,
      })
      return
    }
    setDevice(await backend.auth.beginDeviceCode())
  })

  const pollMicrosoft = () => run('poll', async () => {
    if (!device) return
    setDeviceError(null)
    const result = await backend.auth.pollDeviceCode(device.flowId)
    if (result.status === 'pending') {
      setNotice('仍在等待微软授权，请完成浏览器中的登录后再检查。')
      return
    }
    setDevice(null)
    if (result.status === 'ok') {
      auth.reload()
      setNotice(`微软账户 ${result.account.name} 登录成功并已选中。`)
      return
    }
    const hint = typeof result.error.details?.hint === 'string' ? result.error.details.hint : undefined
    setDeviceError(deviceFailure(result.error.message, hint))
  })

  const saveMicrosoftConfig = () => run('ms-config', async () => {
    const config: MicrosoftConfig = await backend.auth.configureMicrosoft({
      clientId: msClientId.trim() || null,
      ...(msTenant.trim() ? { tenant: msTenant.trim() } : {}),
    })
    microsoft.reload()
    setMsClientId('')
    setNotice(config.configured ? '微软应用配置已保存。' : '已清空/未保存 client id；微软登录仍不可用。')
  })

  const createAuthlib = () => run(authlibReloginId ? 'authlib-relogin' : 'authlib', async () => {
    const name = authlibName.trim()
    const server = authlibServer.trim()
    const password = authlibPassword
    if (!name || name.length > 64) throw new Error('Authlib 登录名需为 1–64 个字符（可以是账号名或邮箱）')
    if (!/^https:\/\//i.test(server)) throw new Error('Authlib 皮肤站地址必须使用 HTTPS')
    if (!password) throw new Error('请输入 Authlib 密码')
    // The password exists only in this call frame. Clear the React state before
    // awaiting IPC so it cannot be reused by a later render or persisted.
    setAuthlibPassword('')
    const relogin = Boolean(authlibReloginId)
    if (relogin) await backend.auth.loginAuthlib(name, password, server)
    else await backend.auth.createAuthlib(name, server, password)
    setAuthlibName('')
    setAuthlibReloginId(null)
    auth.reload()
    authlib.reload()
    setAuthlibNotice(relogin ? 'Authlib 重新登录成功；令牌已由 auth 模块接管。' : 'Authlib 账户已创建并选中；启动时会注入 authlib-injector。')
  }, authlibFailureText)

  const beginAuthlibRelogin = (account: Account) => {
    setAuthlibReloginId(account.id)
    setAuthlibName(account.name)
    setAuthlibServer(account.authlibServer ?? authlib.data?.server ?? '')
    setAuthlibPassword('')
    setError(null)
    setAuthlibNotice(`正在重新登录 ${account.name}；请输入密码，提交后密码会立即从内存中清空。`)
  }

  const cancelAuthlibRelogin = () => {
    setAuthlibReloginId(null)
    setAuthlibPassword('')
    setAuthlibNotice(null)
  }

  const logoutAuthlib = (account: Account) => run(`authlib-logout:${account.id}`, async () => {
    await backend.auth.signoutAuthlib(account.id)
    setAuthlibReloginId(null)
    setAuthlibPassword('')
    setAuthlibName('')
    setAuthlibServer('')
    auth.reload()
    authlib.reload()
    setAuthlibNotice(`已退出 Authlib 登录：${account.name}（账户仍保留，可重新登录）。`)
  }, authlibFailureText)

  const updateAuthlib = () => run('authlib-update', async () => {
    if (!selectedAuthlib) return
    const server = authlibServer.trim()
    if (!/^https:\/\//i.test(server)) throw new Error('Authlib 皮肤站地址必须使用 HTTPS')
    await backend.auth.setAuthlib(selectedAuthlib.id, server)
    auth.reload()
    authlib.reload()
    setAuthlibNotice('当前 Authlib 账户的皮肤站地址已更新。')
  })

  const ensureAuthlib = () => run('authlib-ensure', async () => {
    const info = await backend.auth.ensureAuthlib()
    authlib.reload()
    setAuthlibNotice(info.downloaded ? `authlib-injector ${info.version} 已就绪（${info.jarPath}）。` : 'authlib-injector 尚未下载。')
  })

  const copy = async (text: string) => {
    await navigator.clipboard.writeText(text).catch(() => undefined)
    setNotice('已复制到剪贴板。')
  }

  return (
    <div className="settings-account-panel">
      <div className="settings-section__head">
        <div><h2>账户</h2><p>离线、微软设备码与 Authlib 账户均来自 auth 模块；没有后端成功响应时不会伪造账户。</p></div>
        <Badge tone="accent" dot>真实 IPC</Badge>
      </div>

      {auth.status === 'not-wired' || auth.status === 'error' ? <DataStateNotice info={describeError(auth.error)} onRetry={auth.reload} /> : null}
      {error ? <div className="nw-inline-error" role="alert">{error.title}：{error.detail}{error.code ? `（${error.code}）` : ''}</div> : null}
      {notice ? <Banner tone="info">{notice}</Banner> : null}

      {auth.status === 'ready' && auth.data?.accounts.length ? (
        <div className="nw-account-list">
          {auth.data.accounts.map((account) => (
            <div className={`nw-account-row${account.id === auth.data?.selectedId ? ' is-selected' : ''}`} key={account.id}>
              {account.kind === 'authlib'
                ? <AuthlibAvatar account={account} />
                : <span className="avatar avatar--sm" aria-hidden="true">{account.name.slice(0, 1).toUpperCase()}</span>}
              <span className="nw-account-name">{account.name}</span>
              <Badge tone={account.kind === 'microsoft' ? 'success' : account.kind === 'authlib' ? 'accent' : 'outline'}>{account.kind}</Badge>
              {account.kind === 'authlib' && account.authlibServer ? <span className="subtle mono">{account.authlibServer}</span> : null}
              {account.id === auth.data?.selectedId
                ? <Badge tone="accent">当前</Badge>
                : <Button size="xs" variant="ghost" onClick={() => void selectAccount(account.id)} loading={busy === `select:${account.id}`}>选择</Button>}
            </div>
          ))}
          {selectedAuthlib ? (
            <div className="settings-authlib-account">
              <AuthlibAvatar account={selectedAuthlib} />
              <div className="settings-authlib-account__text">
                <strong>{selectedAuthlib.name}</strong>
                <span className="mono">{selectedAuthlib.authlibServer}</span>
              </div>
              <Button
                size="xs"
                variant="secondary"
                icon="refresh"
                onClick={() => beginAuthlibRelogin(selectedAuthlib)}
                disabled={busy === `authlib-logout:${selectedAuthlib.id}`}
              >
                重新登录
              </Button>
              <Button
                size="xs"
                variant="danger-ghost"
                icon="close"
                onClick={() => void logoutAuthlib(selectedAuthlib)}
                loading={busy === `authlib-logout:${selectedAuthlib.id}`}
              >
                退出登录
              </Button>
            </div>
          ) : null}
        </div>
      ) : auth.status === 'ready' ? (
        <EmptyState icon="user" title="还没有账户" description="创建离线账户即可启动；微软账户需要 client id 与 MCE 审批。" />
      ) : null}

      <div className="settings-auth-grid">
        <section className="settings-auth-block">
          <h3><Icon name="user" />离线账户</h3>
          <Field label="用户名" hint="3–16 位字母/数字/下划线；仅用于单机或 online-mode=false 服务器。">
            <div className="row gap-8">
              <Input value={offlineName} onChange={(event) => setOfflineName(event.target.value)} placeholder="例如 Player" aria-label="离线用户名" />
              <Button size="sm" variant="primary" icon="plus" onClick={() => void createOffline()} loading={busy === 'offline'} disabled={!offlineName.trim()}>创建</Button>
            </div>
          </Field>
        </section>

        <section className="settings-auth-block">
          <h3><Icon name="user" />微软登录（设备码）</h3>
          {microsoft.status === 'not-wired' || microsoft.status === 'error' ? <DataStateNotice info={describeError(microsoft.error)} onRetry={microsoft.reload} /> : null}
          {microsoft.status === 'ready' && !microsoft.data?.configured ? (
            <Banner tone="warning" title="未配置微软应用 ID">
              设置环境变量 <code className="mono">MCL_MS_CLIENT_ID</code>（可选 <code className="mono">MCL_MS_TENANT</code>），或在下方填入 Azure 应用客户端 ID。未配置时点击登录会明确报错，不会假成功。
            </Banner>
          ) : null}
          {microsoft.data?.configured ? (
            <div className="settings-inline-meta">
              <Badge tone="success">已配置</Badge>
              <span className="mono">{microsoft.data.clientId}</span>
              <span>tenant {microsoft.data.tenant}</span>
            </div>
          ) : null}
          <div className="row gap-8" style={{ marginTop: 8 }}>
            <Button size="sm" variant="primary" icon="link" onClick={() => void beginMicrosoft()} loading={busy === 'microsoft'}>开始微软登录</Button>
            {device ? <Button size="sm" variant="ghost" icon="close" onClick={() => setDevice(null)}>取消设备码</Button> : null}
          </div>
          {deviceError ? <div className="nw-inline-error">{deviceError.title}：{deviceError.detail}</div> : null}
          {device ? (
            <div className="settings-device-code">
              <div>请在浏览器打开 <span className="mono">{device.verificationUri}</span>，输入设备码：</div>
              <div className="settings-device-code__code">{device.userCode}</div>
              <div className="row gap-6" style={{ marginTop: 6 }}>
                <Button size="xs" variant="secondary" icon="copy" onClick={() => void copy(device.userCode)}>复制设备码</Button>
                <Button size="xs" variant="secondary" icon="copy" onClick={() => void copy(device.verificationUri)}>复制验证链接</Button>
                <Button size="xs" variant="primary" icon="refresh" onClick={() => void pollMicrosoft()} loading={busy === 'poll'}>我已完成授权，检查</Button>
              </div>
              <div className="muted">有效期 {device.expiresIn} 秒；完成后点击检查。登录成功只会创建后端返回的真实账户。</div>
            </div>
          ) : null}
          <Banner tone="warning" title="MCE 审批待批/未通过时不会假成功">
            微软应用还需通过 Minecraft API（MCE）审批；审批待批或未通过时会返回 <code className="mono">MS_AUTH_NOT_APPROVED</code>/403。此时请使用离线或 Authlib 账户，启动器不会伪造正版登录。
          </Banner>
          <details className="settings-auth-config">
            <summary>配置 Azure 应用 client id / tenant</summary>
            <div className="settings-field-row">
              <Field label="Client ID" hint="保存到 auth 模块配置；留空会清除应用 ID。">
                <Input value={msClientId} onChange={(event) => setMsClientId(event.target.value)} placeholder={microsoft.data?.clientId ?? 'Azure application client id'} aria-label="微软 client id" />
              </Field>
              <Field label="Tenant" hint="租户 ID 或域名，不带 https://。">
                <Input value={msTenant} onChange={(event) => setMsTenant(event.target.value)} placeholder="consumers" aria-label="微软 tenant" />
              </Field>
            </div>
            <Button size="sm" variant="secondary" icon="check" onClick={() => void saveMicrosoftConfig()} loading={busy === 'ms-config'}>保存微软配置</Button>
          </details>
        </section>

        <section className="settings-auth-block">
          <h3><Icon name="package" />Authlib 皮肤站</h3>
          <Field label="皮肤站地址" hint="必须 HTTPS；创建账户后在启动时注入 authlib-injector，不改原版客户端文件。">
            <Input value={authlibServer} onChange={(event) => setAuthlibServer(event.target.value)} placeholder="https://littleskin.cn/api/yggdrasil" aria-label="Authlib 皮肤站地址" />
          </Field>
          <Field label="Authlib 登录名（账号或邮箱）" hint="1–64 个字符；可以是皮肤站账号名或邮箱。登录后显示名取皮肤站角色名。">
            <Input value={authlibName} onChange={(event) => setAuthlibName(event.target.value)} placeholder="账号名或邮箱" aria-label="Authlib 用户名" />
          </Field>
          <Field label="Authlib 密码" hint="只在提交时短暂保存在内存；提交后立即清空，不写入 localStorage、配置或日志。">
            <Input
              type="password"
              value={authlibPassword}
              onChange={(event) => setAuthlibPassword(event.target.value)}
              placeholder="皮肤站密码"
              aria-label="Authlib 密码"
              autoComplete="off"
              spellCheck={false}
            />
          </Field>
          {authlibReloginId ? (
            <Banner
              tone="info"
              title={`正在重新登录 ${authlibName}`}
              actions={<Button size="xs" variant="ghost" onClick={cancelAuthlibRelogin}>取消重新登录</Button>}
            >
              输入新密码后提交；旧令牌会由 auth 模块按后端结果处理，不会把密码写入任何文件。
            </Banner>
          ) : null}
          <div className="row gap-8" style={{ marginTop: 8 }}>
            <Button
              size="sm"
              variant="primary"
              icon={authlibReloginId ? 'refresh' : 'plus'}
              onClick={() => void createAuthlib()}
              loading={busy === 'authlib' || busy === 'authlib-relogin'}
              disabled={!authlibName.trim() || !authlibServer.trim() || !authlibPassword}
            >
              {authlibReloginId ? '重新登录 Authlib' : '创建 Authlib 账户'}
            </Button>
          </div>
          {selectedAuthlib ? (
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => void updateAuthlib()} loading={busy === 'authlib-update'}>更新当前 Authlib 账户地址</Button>
          ) : null}
          {authlibNotice ? <Banner tone="info">{authlibNotice}</Banner> : null}
          {authlib.status === 'ready' ? (
            <div className="settings-inline-meta">
              <Badge tone={authlib.data?.downloaded ? 'success' : 'warning'}>{authlib.data?.downloaded ? 'injector 已就绪' : 'injector 未下载'}</Badge>
              <span className="mono">v{authlib.data?.version}</span>
              <span className="subtle">{authlib.data?.jarPath}</span>
              <Button size="xs" variant="ghost" icon="download" onClick={() => void ensureAuthlib()} loading={busy === 'authlib-ensure'}>校验/下载 injector</Button>
            </div>
          ) : authlib.status === 'not-wired' || authlib.status === 'error' ? (
            <DataStateNotice info={describeError(authlib.error)} onRetry={authlib.reload} />
          ) : null}
        </section>
      </div>
    </div>
  )
}
