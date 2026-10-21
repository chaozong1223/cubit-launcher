import crypto from 'node:crypto'
import type {
  Account,
  AuthCodePollResult,
  AuthCodeStart,
  AuthlibInfo,
  AuthlibPreset,
  AuthlibSessionValidation,
  AuthlibValidation,
  AuthProfile,
  AuthReauthResult,
  AuthRefreshResult,
  AuthSessionStatus,
  DeviceCode,
  MicrosoftConfig,
  PollDeviceCodeResult,
} from '@shared/auth'
import { AppError } from '@shared/errors'
import type { AuthlibInjection, LaunchAccount } from '../../core/launch/args'
import type { ScopedLogger } from '../../kernel/logger'
import { appError, MCE_REVIEW_URL, toAuthError } from './errors'
import type { HttpPort } from './http'
import { createFetchHttp } from './http'
import { MicrosoftOAuth, type DeviceCodeInfo } from './microsoft'
import {
  buildAuthorizationUrl,
  HMCL_MICROSOFT_SCOPE,
  LoopbackOAuthServer,
  type LoopbackResult,
} from './hmcl-port/oauth'
import { parseMinecraftProfileTextures } from './hmcl-port/microsoft'
import { parseAuthlibServerMetadata, parseTexturesProperty } from './hmcl-port/yggdrasil'
import { ProfileCache } from './hmcl-port/skin-cache'
import {
  AUTHLIB_PRESETS,
  AUTHLIB_SHA256,
  AUTHLIB_VERSION,
  authlibInfo as authlibInfoOf,
  ensureAuthlibInjector,
} from './authlib'
import {
  AccountStore,
  AuthConfigStore,
  maskClientId,
  SessionStore,
  type AuthConfig,
  type StoredSession,
  type TokenCipher,
} from './store'
import { offlineUuid, validOfflineName } from './uuid'

const REFRESH_MARGIN_MS = 5 * 60_000
const REFRESH_MAX_AGE_MS = 90 * 24 * 3600 * 1000

interface FlowState {
  flowId: string
  device: DeviceCodeInfo
  clientId: string
  tenant: string
  interval: number
  lastPollAt: number
  startedAt: number
}

export interface AuthServiceOptions {
  dataRoot: string
  log: ScopedLogger
  cipher?: TokenCipher
  http?: HttpPort
  fetchImpl?: typeof fetch
  now?: () => number
  /** Electron adapter injects shell.openExternal; tests may pass a spy. */
  openExternal?: (url: string) => Promise<void> | void
}

interface AuthCodeFlowState {
  server: LoopbackOAuthServer
  clientId: string
  tenant: string
  startedAt: number
}

function dashedUuid(value: string): string {
  const compact = value.replaceAll('-', '')
  if (compact.length !== 32) return value
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20, 32),
  ].join('-')
}

function unavailableCipher(): TokenCipher {
  return {
    available: false,
    backend: 'none',
    encrypt() {
      throw new Error('secure storage is not configured')
    },
    decrypt() {
      throw new Error('secure storage is not configured')
    },
  }
}

/**
 * Account domain service. Electron-free: the OS cipher is injected by the
 * module adapter (safeStorage/DPAPI), HTTP by a port, and time by `now`.
 *
 * Security invariants:
 *  - refresh tokens only leave this class through SessionStore (encrypted);
 *  - logs contain account names/ids, never tokens or device codes;
 *  - failures are mapped to Chinese actionable AppErrors, never fake success.
 */
function redactAuthlibSnippet(raw: string | null | undefined): string | null {
  if (!raw) return null
  let text = raw
    .replace(
      /("?(?:accessToken|clientToken|refreshToken|password|token)"?\s*:\s*")([^"]*)(")/gi,
      '$1[REDACTED]$3',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[REDACTED_JWT]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length > 200) text = `${text.slice(0, 200)}…`
  return text || null
}

function authlibCategoryLabel(category: AuthlibValidation['category']): string {
  switch (category) {
    case 'unreachable':
      return '地址不通'
    case 'not-authlib':
      return '不是 Authlib 站点'
    case 'server-error':
      return '服务器 5xx'
    case 'invalid-url':
      return '地址格式错误'
    default:
      return '未知错误'
  }
}

export class AuthService {
  private readonly accounts: AccountStore
  private readonly sessions: SessionStore
  private readonly configStore: AuthConfigStore
  private readonly http: HttpPort
  private readonly now: () => number
  private readonly flows = new Map<string, FlowState>()
  private readonly authCodeFlows = new Map<string, AuthCodeFlowState>()
  private readonly listeners = new Set<(payload: unknown) => void>()
  private readonly refreshInFlight = new Map<string, Promise<StoredSession>>()
  private readonly profileCache: ProfileCache<AuthProfile>

  constructor(private readonly options: AuthServiceOptions) {
    this.accounts = new AccountStore(options.dataRoot)
    this.sessions = new SessionStore(options.dataRoot, options.cipher ?? unavailableCipher())
    this.configStore = new AuthConfigStore(options.dataRoot)
    this.http = options.http ?? createFetchHttp(options.fetchImpl)
    this.now = options.now ?? Date.now
    this.profileCache = new ProfileCache(5 * 60_000, () => this.now())
  }

  onEvent(event: string, listener: (payload: unknown) => void): () => void {
    if (event !== 'changed') return () => undefined
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitChanged(): void {
    const payload = { selectedId: this.accounts.list().selectedId }
    for (const listener of this.listeners) {
      try {
        listener(payload)
      } catch {
        // auth events must never break the account operation
      }
    }
  }

  private baseConfig(): AuthConfig {
    return this.configStore.load()
  }

  private effectiveConfig(): AuthConfig {
    const base = this.baseConfig()
    return {
      clientId: process.env.MCL_MS_CLIENT_ID?.trim() || base.clientId,
      tenant: process.env.MCL_MS_TENANT?.trim() || base.tenant || 'consumers',
    }
  }

  getMicrosoftConfig(): MicrosoftConfig {
    const config = this.effectiveConfig()
    return {
      configured: Boolean(config.clientId),
      clientId: maskClientId(config.clientId),
      tenant: config.tenant,
    }
  }

  async configureMicrosoft(input: {
    clientId?: string | null
    tenant?: string
  }): Promise<MicrosoftConfig> {
    const current = this.baseConfig()
    const next: AuthConfig = {
      clientId:
        input.clientId === undefined
          ? current.clientId
          : input.clientId && input.clientId.trim().length > 0
            ? input.clientId.trim()
            : null,
      tenant:
        input.tenant === undefined
          ? current.tenant
          : input.tenant.trim() || 'consumers',
    }
    if (!/^[A-Za-z0-9.-]+$/.test(next.tenant)) {
      throw appError('MS_CONFIG_INVALID', '租户格式不正确', {
        hint: 'tenant 使用租户 ID（GUID）或域名，例如 contoso.onmicrosoft.com；不要带 https://。',
      })
    }
    this.configStore.save(next)
    this.options.log.info('microsoft config updated', {
      configured: Boolean(next.clientId),
      tenant: next.tenant,
    })
    return this.getMicrosoftConfig()
  }

  async list(): Promise<{ accounts: Account[]; selectedId: string | null }> {
    return this.accounts.list()
  }

  private createAccount(kind: Account['kind'], name: string, server: string | null): Account {
    return {
      id: crypto.randomUUID(),
      kind,
      name,
      uuid: offlineUuid(name),
      authlibServer: server,
      loginName: kind === 'authlib' ? name : null,
      createdAt: this.now(),
    }
  }

  async createOffline(name: string): Promise<Account> {
    if (!validOfflineName(name)) {
      throw appError('AUTH.INVALID_NAME', '用户名需为 3–16 位字母、数字或下划线', {
        hint: '只允许 A–Z a–z 0–9 _，不能包含中文或空格。',
      })
    }
    const uuid = offlineUuid(name)
    const existing = this.accounts.findByUuid('offline', uuid)
    if (existing) return { ...existing }
    const account = this.createAccount('offline', name, null)
    this.accounts.add(account)
    this.accounts.select(account.id)
    this.options.log.info('offline account created', { id: account.id, name })
    this.emitChanged()
    return { ...account }
  }

  async createAuthlib(name: string, server: string, password?: string): Promise<Account> {
    if (!name.trim() || name.length > 64) {
      throw appError('AUTH.INVALID_NAME', '皮肤站登录名需为 1–64 个字符')
    }
    try {
      if (new URL(server).protocol !== 'https:') {
        throw appError('AUTH.AUTHLIB_INSECURE', 'Authlib 服务器必须使用 HTTPS', {
          hint: 'http 地址会泄露登录令牌，已拒绝。',
        })
      }
    } catch (error) {
      if (error instanceof AppError) throw error
      throw appError('AUTH.AUTHLIB_INVALID', '皮肤站地址格式不正确', {
        hint: '请输入完整的 https:// 地址。',
      })
    }
    const validation = await this.validateAuthlib(server)
    if (!validation.ok || !validation.canonicalServer) {
      throw appError(
        'AUTH.AUTHLIB_INVALID',
        `皮肤站不可用：${validation.reason ?? '地址校验失败'}`,
        {
          hint: '请检查地址是否可访问、证书是否有效，并确认它是 Authlib-Injector 皮肤站 API 根地址（通常以 /api/yggdrasil 结尾）。',
          details: { server, validation },
        },
      )
    }
    if (password) {
      return this.authenticateAuthlib(name, password, validation.canonicalServer)
    }
    const account = this.createAccount('authlib', name, validation.canonicalServer)
    this.accounts.add(account)
    this.accounts.select(account.id)
    this.options.log.info('authlib account created without session', {
      id: account.id,
      name,
      server: new URL(validation.canonicalServer).host,
    })
    this.emitChanged()
    return { ...account }
  }

  async loginAuthlib(name: string, password: string, server: string): Promise<Account> {
    const validation = await this.validateAuthlib(server)
    if (!validation.ok || !validation.canonicalServer) {
      throw appError('AUTH.AUTHLIB_INVALID', `皮肤站不可用：${validation.reason ?? '地址校验失败'}`, {
        hint: '请检查地址、证书与 /api/yggdrasil 路径。',
        details: { server, validation },
      })
    }
    return this.authenticateAuthlib(name, password, validation.canonicalServer)
  }

  private authlibError(
    status: number,
    body: unknown,
    url: string,
    raw?: string | null,
  ): AppError {
    const record =
      body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
    const error = typeof record.error === 'string' ? record.error : ''
    const message =
      typeof record.errorMessage === 'string'
        ? record.errorMessage
        : typeof record.message === 'string'
          ? record.message
          : ''
    const combined = `${error} ${message}`.toLowerCase()
    const snippet = redactAuthlibSnippet(raw)
    const details = {
      url,
      status,
      responseSnippet: snippet,
      error: error || undefined,
    }
    let mapped: AppError
    if (/verify|verification|邮箱/.test(combined)) {
      mapped = appError('AUTH.AUTHLIB_EMAIL_NOT_VERIFIED', '皮肤站账号尚未完成邮箱验证', {
        hint: '请先到皮肤站网页完成邮箱验证，再回到启动器登录。',
        details,
      })
    } else if (
      status === 401 ||
      status === 403 ||
      /invalid credentials|invalid password|forbiddenoperationexception/.test(combined)
    ) {
      mapped = appError(
        'AUTH.AUTHLIB_INVALID_CREDENTIALS',
        `皮肤站用户名或密码错误（HTTP ${status}）`,
        {
          hint: '请检查账号密码；若服务器要求邮箱验证，请先在皮肤站完成验证。',
          details,
        },
      )
    } else if (status >= 500) {
      mapped = appError('AUTH.AUTHLIB_SERVER_ERROR', `皮肤站服务器错误（HTTP ${status}）`, {
        retryable: true,
        hint: '这是皮肤站服务端问题，请稍后重试；若持续出现，请联系皮肤站管理员。',
        details,
      })
    } else if (status >= 400) {
      mapped = appError('AUTH.AUTHLIB_NOT_AUTHLIB', `该地址不是有效的 Authlib 站点（HTTP ${status}）`, {
        hint: '请核对地址是否以 /api/yggdrasil 结尾；不要填写网站首页或登录页地址。',
        details,
      })
    } else {
      mapped = appError('AUTH.AUTHLIB_AUTH_FAILED', `皮肤站认证失败（HTTP ${status}）`, {
        hint: message || '请检查账号、密码与皮肤站状态后重试。',
        details,
      })
    }
    this.options.log.warn('authlib request failed', {
      url,
      status,
      responseSnippet: snippet,
      code: mapped.code,
    })
    return mapped
  }

  private async authlibPost(
    server: string,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{
    status: number
    body: Record<string, unknown> | null
    url: string
    raw: string | null
  }> {
    const url = `${server.replace(/\/+$/, '')}${path}`
    let response: Awaited<ReturnType<HttpPort['request']>>
    try {
      response = await this.http.request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        timeoutMs: 15_000,
      })
    } catch (error) {
      const snippet = redactAuthlibSnippet(error instanceof Error ? error.message : String(error))
      const mapped = appError('AUTH.AUTHLIB_UNREACHABLE', '无法连接皮肤站（地址不通）', {
        retryable: true,
        hint: '请检查皮肤站地址、证书与网络连接后重试。',
        details: { url, status: null, responseSnippet: snippet },
      })
      this.options.log.warn('authlib request unreachable', {
        url,
        responseSnippet: snippet,
        code: mapped.code,
      })
      throw mapped
    }
    const raw = typeof response.body === 'string' ? response.body : null
    let body: Record<string, unknown> | null = null
    try {
      const parsed = response.body ? JSON.parse(response.body) : null
      body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
    } catch {
      body = null
    }
    return { status: response.status, body, url, raw }
  }

  private async authenticateAuthlib(
    name: string,
    password: string,
    server: string,
  ): Promise<Account> {
    const existing = this.accounts
      .list()
      .accounts.find(
        (account) =>
          account.kind === 'authlib' &&
          account.authlibServer === server &&
          account.name.toLowerCase() === name.toLowerCase(),
      )
    const previous = existing ? this.sessions.get(existing.id) : null
    const clientToken = previous?.authlib?.clientToken ?? crypto.randomUUID()
    const result = await this.authlibPost(server, '/authserver/authenticate', {
      username: name,
      password,
      clientToken,
      agent: { name: 'Minecraft', version: 1 },
      requestUser: false,
    })
    if (result.status < 200 || result.status >= 300) {
      throw this.authlibError(result.status, result.body, result.url, result.raw)
    }
    if (!result.body) {
      const snippet = redactAuthlibSnippet(result.raw)
      this.options.log.warn('authlib authenticate returned non-JSON', {
        url: result.url,
        status: result.status,
        responseSnippet: snippet,
        code: 'AUTH.AUTHLIB_NOT_AUTHLIB',
      })
      throw appError(
        'AUTH.AUTHLIB_NOT_AUTHLIB',
        `该地址不是有效的 Authlib 站点（HTTP ${result.status}，响应不是 JSON）`,
        {
          hint: '请核对地址是否以 /api/yggdrasil 结尾；不要填写网站首页或登录页地址。',
          details: {
            url: result.url,
            status: result.status,
            responseSnippet: snippet,
          },
        },
      )
    }
    const accessToken =
      typeof result.body?.accessToken === 'string' ? result.body.accessToken : null
    const selectedProfile =
      result.body?.selectedProfile && typeof result.body.selectedProfile === 'object'
        ? (result.body.selectedProfile as { id?: unknown; name?: unknown })
        : null
    const profileId = typeof selectedProfile?.id === 'string' ? selectedProfile.id : null
    const profileName =
      typeof selectedProfile?.name === 'string' ? selectedProfile.name : null
    if (!accessToken || !profileId || !profileName) {
      throw appError('AUTH.AUTHLIB_PROFILE_MISSING', '皮肤站没有返回可用的游戏档案', {
        hint: '请确认该账号已创建 Minecraft 角色；或在皮肤站网页检查角色状态。',
      })
    }
    const uuid = dashedUuid(profileId)
    let account =
      existing ??
      this.accounts.findByUuid('authlib', uuid) ??
      this.accounts.findByUuid('authlib', offlineUuid(name))
    if (account) {
      account = {
        ...account,
        kind: 'authlib',
        name: profileName,
        uuid,
        authlibServer: server,
        loginName: name,
      }
      this.accounts.update(account)
    } else {
      account = {
        id: crypto.randomUUID(),
        kind: 'authlib',
        name: profileName,
        uuid,
        authlibServer: server,
        loginName: name,
        createdAt: this.now(),
      }
      this.accounts.add(account)
    }
    this.sessions.set(account.id, {
      refreshToken: '',
      refreshIssuedAt: this.now(),
      authlib: {
        accessToken,
        clientToken:
          typeof result.body?.clientToken === 'string' ? result.body.clientToken : clientToken,
        profileId: uuid,
        profileName,
        server,
      },
    })
    this.accounts.select(account.id)
    this.profileCache.delete(account.id)
    this.emitChanged()
    this.options.log.info('authlib authenticated', {
      accountId: account.id,
      name: profileName,
      server: new URL(server).host,
    })
    return { ...account }
  }

  authlibPresets(): AuthlibPreset[] {
    return AUTHLIB_PRESETS.map((preset) => ({ ...preset }))
  }

  /** Validate an Authlib API root before it is stored for an account. */
  async validateAuthlib(server: string): Promise<AuthlibValidation> {
    const checkedAt = this.now()
    const fail = (
      category: AuthlibValidation['category'],
      reason: string,
      extra: {
        attemptedUrl?: string | null
        attemptedUrls?: string[]
        statusCode?: number | null
        responseSnippet?: string | null
      } = {},
    ): AuthlibValidation => {
      const result: AuthlibValidation = {
        ok: false,
        server,
        canonicalServer: null,
        serverName: null,
        skinDomains: [],
        reason,
        category,
        attemptedUrl: extra.attemptedUrl ?? null,
        attemptedUrls: extra.attemptedUrls ?? [],
        statusCode: extra.statusCode ?? null,
        responseSnippet: extra.responseSnippet ?? null,
        checkedAt,
      }
      this.options.log.warn('authlib validation failed', {
        server,
        category,
        attemptedUrl: result.attemptedUrl,
        attemptedUrls: result.attemptedUrls,
        statusCode: result.statusCode,
        responseSnippet: result.responseSnippet,
        reason,
      })
      return result
    }
    let parsed: URL
    try {
      parsed = new URL(server.trim())
    } catch {
      return fail('invalid-url', '地址格式不正确（无法解析 URL）')
    }
    if (parsed.protocol !== 'https:') {
      return fail('invalid-url', '必须使用 HTTPS（http 会泄露登录令牌）', {
        attemptedUrl: parsed.toString(),
        attemptedUrls: [parsed.toString()],
      })
    }
    parsed.hash = ''
    parsed.search = ''
    const trimmed = parsed.toString().replace(/\/+$/, '')
    const candidates =
      parsed.pathname === '/' || parsed.pathname === ''
        ? [trimmed, `${trimmed}/api/yggdrasil`]
        : [trimmed]
    const attemptedUrls: string[] = []
    let lastUrl: string | null = null
    let lastStatus: number | null = null
    let lastSnippet: string | null = null
    let lastCategory: AuthlibValidation['category'] = 'not-authlib'
    let lastReason = '皮肤站没有返回 Authlib-Injector 元数据'
    for (const candidate of candidates) {
      attemptedUrls.push(candidate)
      lastUrl = candidate
      try {
        const response = await this.http.request(candidate, {
          method: 'GET',
          headers: { accept: 'application/json' },
          timeoutMs: 8_000,
        })
        lastStatus = response.status
        lastSnippet = redactAuthlibSnippet(response.body)
        if (response.status < 200 || response.status >= 300) {
          lastCategory = response.status >= 500 ? 'server-error' : 'not-authlib'
          lastReason = `${authlibCategoryLabel(lastCategory)}：${candidate} 返回 HTTP ${response.status}；响应：${lastSnippet ?? '(空)'}`
          continue
        }
        const metadata = parseAuthlibServerMetadata(response.body)
        if (!metadata) {
          lastCategory = 'not-authlib'
          lastReason = `不是 Authlib 站点：${candidate} 返回 HTTP ${response.status} 但不是 Authlib-Injector 元数据（缺少 meta/skinDomains）；响应：${lastSnippet ?? '(空)'}`
          continue
        }
        return {
          ok: true,
          server,
          canonicalServer: candidate,
          serverName: metadata.serverName,
          skinDomains: metadata.skinDomains,
          reason: null,
          category: null,
          attemptedUrl: candidate,
          attemptedUrls,
          statusCode: response.status,
          responseSnippet: null,
          checkedAt,
        }
      } catch (error) {
        lastStatus = null
        lastSnippet = redactAuthlibSnippet(
          error instanceof Error ? error.message : String(error),
        )
        lastCategory = 'unreachable'
        lastReason = `地址不通：${candidate}（${lastSnippet ?? '连接失败'}）`
      }
    }
    return fail(lastCategory, lastReason, {
      attemptedUrl: lastUrl,
      attemptedUrls,
      statusCode: lastStatus,
      responseSnippet: lastSnippet,
    })
  }

  async select(id: string): Promise<{ ok: boolean }> {
    this.accounts.select(id)
    this.emitChanged()
    return { ok: true }
  }

  async logout(id: string): Promise<{ ok: boolean }> {
    this.profileCache.delete(id)
    this.sessions.delete(id)
    const removed = this.accounts.remove(id)
    this.emitChanged()
    return { ok: removed }
  }

  async setAuthlib(id: string, server: string): Promise<Account> {
    const account = this.accounts.get(id)
    if (!account) throw new AppError('AUTH.NO_ACCOUNT', '账户不存在')
    const validation = await this.validateAuthlib(server)
    if (!validation.ok || !validation.canonicalServer) {
      throw appError('AUTH.AUTHLIB_INVALID', `皮肤站不可用：${validation.reason ?? '地址校验失败'}`, {
        hint: '请检查地址、证书与 /api/yggdrasil 路径后再保存。',
        details: { server, validation },
      })
    }
    const next = {
      ...account,
      kind: 'authlib' as const,
      authlibServer: validation.canonicalServer,
    }
    this.profileCache.delete(id)
    this.accounts.update(next)
    this.emitChanged()
    return { ...next }
  }

  private makeOAuth(config: { clientId: string; tenant: string }): MicrosoftOAuth {
    return new MicrosoftOAuth(() => config, this.http, this.now)
  }

  async beginDeviceCode(): Promise<DeviceCode> {
    const config = this.effectiveConfig()
    if (!config.clientId) {
      throw appError('MS_CLIENT_ID_MISSING', '未配置微软应用 ID，正版登录暂不可用', {
        hint: '设置 MCL_MS_CLIENT_ID（可选 MCL_MS_TENANT），或在设置页填入 Azure 应用的客户端 ID；离线账户可正常使用。',
        docs: 'https://learn.microsoft.com/entra/identity-platform/quickstart-register-app',
      })
    }

    const oauth = this.makeOAuth({ clientId: config.clientId, tenant: config.tenant })
    const device = await oauth.beginDeviceCode()
    const flowId = crypto.randomUUID()
    this.flows.set(flowId, {
      flowId,
      device,
      clientId: config.clientId,
      tenant: config.tenant,
      interval: device.interval,
      lastPollAt: 0,
      startedAt: this.now(),
    })
    this.options.log.info('device code started', {
      flowId,
      tenant: config.tenant,
      interval: device.interval,
    })
    return {
      flowId,
      userCode: device.userCode,
      verificationUri: device.verificationUri,
      message: device.message,
      expiresIn: device.expiresIn,
      interval: device.interval,
    }
  }

  /**
   * HMCL-style loopback authorization-code flow (OAuth.java + OAuthServer.java).
   * The app's own client_id is injected; HMCL's id is never used.
   */
  async beginAuthCode(): Promise<AuthCodeStart> {
    const config = this.effectiveConfig()
    if (!config.clientId) {
      throw appError('MS_CLIENT_ID_MISSING', '未配置微软应用 ID，正版登录暂不可用', {
        hint: '设置 MCL_MS_CLIENT_ID（可选 MCL_MS_TENANT），或在设置页填入 Azure 应用的客户端 ID；离线账户可正常使用。',
      })
    }
    const server = await LoopbackOAuthServer.start()
    const authorizationUrl = buildAuthorizationUrl({
      clientId: config.clientId,
      tenant: config.tenant,
      redirectUri: server.redirectUri,
      state: server.pkce.state,
      challenge: server.pkce.challenge,
      scope: HMCL_MICROSOFT_SCOPE,
    })
    const flowId = crypto.randomUUID()
    this.authCodeFlows.set(flowId, {
      server,
      clientId: config.clientId,
      tenant: config.tenant,
      startedAt: this.now(),
    })
    try {
      await this.options.openExternal?.(authorizationUrl)
    } catch (error) {
      server.close()
      this.authCodeFlows.delete(flowId)
      throw appError('AUTH.BROWSER_OPEN_FAILED', '无法打开系统浏览器完成登录', {
        hint: '请手动复制授权地址到浏览器；若浏览器未安装，请使用设备码登录。',
        details: {
          authorizationUrl,
          cause: error instanceof Error ? error.message : String(error),
        },
      })
    }
    this.options.log.info('authorization code flow started', { flowId, port: server.port })
    return {
      flowId,
      authorizationUrl,
      redirectUri: server.redirectUri,
      expiresAt: this.now() + 10 * 60_000,
    }
  }

  async pollAuthCode(flowId: string): Promise<AuthCodePollResult> {
    const flow = this.authCodeFlows.get(flowId)
    if (!flow) {
      return {
        status: 'failed',
        error: {
          code: 'AUTH.FLOW_NOT_FOUND',
          message: '登录流程不存在或已结束',
          retryable: true,
          details: { hint: '请重新点击微软登录。' },
        },
      }
    }
    if (this.now() - flow.startedAt > 10 * 60_000) {
      flow.server.close()
      this.authCodeFlows.delete(flowId)
      return {
        status: 'failed',
        error: {
          code: 'AUTH.DEVICE_CODE_EXPIRED',
          message: '授权登录已超时',
          retryable: true,
          details: { hint: '请重新发起微软登录。' },
        },
      }
    }
    const callback: LoopbackResult = flow.server.poll()
    if (callback.status === 'pending') return { status: 'pending' }
    if (callback.status === 'failed') {
      flow.server.close()
      this.authCodeFlows.delete(flowId)
      return {
        status: 'failed',
        error: {
          code: callback.code,
          message: callback.message,
          retryable: true,
          details: { hint: '请重新发起微软登录。' },
        },
      }
    }
    try {
      const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(flow.tenant)}/oauth2/v2.0/token`
      const response = await this.http.request(tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: flow.clientId,
          code: callback.code,
          grant_type: 'authorization_code',
          code_verifier: flow.server.pkce.verifier,
          redirect_uri: flow.server.redirectUri,
          scope: HMCL_MICROSOFT_SCOPE,
        }).toString(),
        timeoutMs: 20_000,
      })
      let body: Record<string, unknown> | null = null
      try {
        body = response.body ? (JSON.parse(response.body) as Record<string, unknown>) : null
      } catch {
        body = null
      }
      const accessToken = typeof body?.access_token === 'string' ? body.access_token : null
      const refreshToken = typeof body?.refresh_token === 'string' ? body.refresh_token : null
      if (response.status < 200 || response.status >= 300 || !accessToken || !refreshToken) {
        throw toAuthError({
          stage: 'token',
          status: response.status,
          error: typeof body?.error === 'string' ? body.error : undefined,
          errorDescription:
            typeof body?.error_description === 'string' ? body.error_description : undefined,
        })
      }
      const oauth = this.makeOAuth({ clientId: flow.clientId, tenant: flow.tenant })
      const minecraft = await oauth.authenticateMinecraft(accessToken)
      const account = this.upsertMicrosoftAccount(minecraft.profile)
      this.sessions.set(account.id, {
        refreshToken,
        refreshIssuedAt: this.now(),
        mcAccessToken: minecraft.accessToken,
        mcExpiresAt: this.now() + minecraft.expiresIn * 1000,
        xuid: minecraft.xuid,
      })
      this.accounts.select(account.id)
      flow.server.close()
      this.authCodeFlows.delete(flowId)
      this.emitChanged()
      this.options.log.info('authorization code login completed', {
        accountId: account.id,
        name: account.name,
      })
      return { status: 'ok', account: { ...account } }
    } catch (error) {
      flow.server.close()
      this.authCodeFlows.delete(flowId)
      const shape =
        error instanceof AppError
          ? error.toShape()
          : toAuthError({ stage: 'token', errorDescription: String(error) }).toShape()
      return { status: 'failed', error: shape }
    }
  }

  async cancelAuthCode(flowId: string): Promise<{ ok: boolean }> {
    const flow = this.authCodeFlows.get(flowId)
    if (!flow) return { ok: false }
    flow.server.close()
    this.authCodeFlows.delete(flowId)
    return { ok: true }
  }

  async pollDeviceCode(flowId: string): Promise<PollDeviceCodeResult> {
    const flow = this.flows.get(flowId)
    if (!flow) {
      return {
        status: 'failed',
        error: {
          code: 'AUTH.FLOW_NOT_FOUND',
          message: '登录流程不存在或已结束',
          retryable: true,
          details: { hint: '请重新点击微软登录。' },
        },
      }
    }
    if (this.now() - flow.startedAt > flow.device.expiresIn * 1000) {
      this.flows.delete(flowId)
      return {
        status: 'failed',
        error: {
          code: 'AUTH.DEVICE_CODE_EXPIRED',
          message: '设备码已过期',
          retryable: true,
          details: { hint: '请重新点击“微软登录”获取新的设备码。' },
        },
      }
    }
    if (this.now() - flow.lastPollAt < flow.interval * 1000) {
      return { status: 'pending' }
    }
    flow.lastPollAt = this.now()

    try {
      const oauth = this.makeOAuth({ clientId: flow.clientId, tenant: flow.tenant })
      const polled = await oauth.pollToken(flow.device.deviceCode)
      if (polled.status === 'pending') return { status: 'pending' }
      if (polled.status === 'slow_down') {
        flow.interval = Math.max(flow.interval + 5, polled.interval)
        return { status: 'pending' }
      }

      // Only a complete Xbox/XSTS/Minecraft chain counts as success.
      const minecraft = await oauth.authenticateMinecraft(polled.token.accessToken)
      const account = this.upsertMicrosoftAccount(minecraft.profile)
      const session: StoredSession = {
        refreshToken: polled.token.refreshToken,
        refreshIssuedAt: this.now(),
        mcAccessToken: minecraft.accessToken,
        mcExpiresAt: this.now() + minecraft.expiresIn * 1000,
        xuid: minecraft.xuid,
      }
      // Encryption happens before the account is persisted; a failure here
      // surfaces as an honest error instead of a plaintext token.
      this.sessions.set(account.id, session)
      this.accounts.select(account.id)
      this.flows.delete(flowId)
      this.options.log.info('microsoft login completed', {
        accountId: account.id,
        name: account.name,
      })
      this.emitChanged()
      return { status: 'ok', account: { ...account } }
    } catch (error) {
      const shape =
        error instanceof AppError
          ? error.toShape()
          : toAuthError({ stage: 'token', errorDescription: String(error) }).toShape()
      this.options.log.warn('microsoft login failed', {
        flowId,
        code: shape.code,
      })
      return { status: 'failed', error: shape }
    }
  }

  private upsertMicrosoftAccount(profile: { id: string; name: string }): Account {
    const uuid = dashedUuid(profile.id)
    const existing = this.accounts.findByUuid('microsoft', uuid)
    if (existing) {
      const next = { ...existing, name: profile.name, uuid }
      this.accounts.update(next)
      return next
    }
    const account: Account = {
      id: crypto.randomUUID(),
      kind: 'microsoft',
      name: profile.name,
      uuid,
      authlibServer: null,
      createdAt: this.now(),
    }
    this.accounts.add(account)
    return account
  }

  private async refreshSession(account: Account, session: StoredSession): Promise<StoredSession> {
    if (this.now() - session.refreshIssuedAt > REFRESH_MAX_AGE_MS) {
      throw toAuthError({ stage: 'refresh', error: 'invalid_grant' })
    }
    const config = this.effectiveConfig()
    if (!config.clientId) {
      throw appError('MS_CLIENT_ID_MISSING', '未配置微软应用 ID，无法刷新登录', {
        hint: '设置 MCL_MS_CLIENT_ID 后重新登录。',
      })
    }
    const oauth = this.makeOAuth({ clientId: config.clientId, tenant: config.tenant })
    const refreshed = await oauth.refresh(session.refreshToken)
    const minecraft = await oauth.authenticateMinecraft(refreshed.accessToken)
    const next: StoredSession = {
      refreshToken: refreshed.refreshToken,
      refreshIssuedAt: this.now(),
      mcAccessToken: minecraft.accessToken,
      mcExpiresAt: this.now() + minecraft.expiresIn * 1000,
      xuid: minecraft.xuid,
    }
    this.sessions.set(account.id, next)
    this.options.log.info('microsoft session refreshed', { accountId: account.id })
    return next
  }

  private singleFlightRefresh(account: Account, session: StoredSession): Promise<StoredSession> {
    const existing = this.refreshInFlight.get(account.id)
    if (existing) return existing
    const promise = this.refreshSession(account, session).finally(() => {
      this.refreshInFlight.delete(account.id)
    })
    this.refreshInFlight.set(account.id, promise)
    return promise
  }

  /** Launch chain account resolver: offline/authlib tokens are placeholders. */
  async getLaunchAccount(accountId: string | null): Promise<LaunchAccount | null> {
    const account = accountId ? this.accounts.get(accountId) : this.accounts.selected()
    if (!account) throw new AppError('AUTH.NO_ACCOUNT', '还没有选择账户')
    if (account.kind === 'offline') {
      return {
        kind: account.kind,
        name: account.name,
        uuid: account.uuid,
        accessToken: '0',
        userType: 'legacy',
      }
    }
    if (account.kind === 'authlib') {
      let session = this.sessions.get(account.id)
      if (!session?.authlib) throw this.authlibLoginRequired(account)
      try {
        const validation = await this.validateAuthlibSession(account.id)
        if (!validation.valid) {
          await this.refreshAuthlib(account, session.authlib)
          session = this.sessions.get(account.id)
        }
      } catch (error) {
        if (
          error instanceof AppError &&
          (error.code === 'AUTH.AUTHLIB_TOKEN_EXPIRED' ||
            error.code === 'AUTH.AUTHLIB_TOKEN_INVALID')
        ) {
          throw this.authlibLoginRequired(account)
        }
        if (error instanceof AppError) throw error
        throw this.authlibLoginRequired(account)
      }
      const authlib = session?.authlib
      if (!authlib) throw this.authlibLoginRequired(account)
      return {
        kind: 'authlib',
        name: authlib.profileName,
        uuid: authlib.profileId,
        accessToken: authlib.accessToken,
        userType: 'legacy',
      }
    }

    let session = this.sessions.get(account.id)
    if (!session) {
      throw this.reauthRequired(account)
    }
    const stillValid =
      typeof session.mcAccessToken === 'string' &&
      typeof session.mcExpiresAt === 'number' &&
      session.mcExpiresAt - this.now() > REFRESH_MARGIN_MS
    if (!stillValid) {
      try {
        session = await this.singleFlightRefresh(account, session)
      } catch (error) {
        if (error instanceof AppError && error.code === 'AUTH.INVALID_GRANT') {
          throw this.reauthRequired(account)
        }
        throw error
      }
    }
    if (!session.mcAccessToken) {
      throw this.reauthRequired(account)
    }

    return {
      kind: 'microsoft',
      name: account.name,
      uuid: account.uuid,
      accessToken: session.mcAccessToken,
      userType: 'msa',
      xuid: session.xuid ?? null,
    }
  }

  private reauthRequired(account: Account): AppError {
    return appError('AUTH.INVALID_GRANT', '登录已过期，需要重新登录', {
      hint: '刷新令牌已失效；请重新发起微软设备码登录。其它离线/皮肤站账户不受影响。',
      retryable: false,
      details: {
        accountId: account.id,
        reauthRequired: true,
        action: 'beginDeviceCode',
      },
    })
  }

  sessionStatus(id: string): AuthSessionStatus {
    const account = this.accounts.get(id)
    if (!account) throw new AppError('AUTH.NO_ACCOUNT', '账户不存在')
    if (account.kind === 'offline') {
      return {
        accountId: id,
        kind: account.kind,
        hasSession: false,
        mcExpiresAt: null,
        refreshIssuedAt: null,
        reauthRequired: false,
        reason: null,
      }
    }
    if (account.kind === 'authlib') {
      const session = this.sessions.get(id)
      const authlib = session?.authlib
      return {
        accountId: id,
        kind: account.kind,
        hasSession: Boolean(authlib),
        mcExpiresAt: null,
        refreshIssuedAt: session?.refreshIssuedAt ?? null,
        reauthRequired: !authlib,
        reason: authlib ? null : '皮肤站账户尚未登录，需要用户名和密码',
      }
    }
    const session = this.sessions.get(id)
    if (!session) {
      return {
        accountId: id,
        kind: account.kind,
        hasSession: false,
        mcExpiresAt: null,
        refreshIssuedAt: null,
        reauthRequired: true,
        reason: '没有可用的登录会话，需要重新登录',
      }
    }
    const stale = this.now() - session.refreshIssuedAt > REFRESH_MAX_AGE_MS
    return {
      accountId: id,
      kind: account.kind,
      hasSession: true,
      mcExpiresAt: session.mcExpiresAt ?? null,
      refreshIssuedAt: session.refreshIssuedAt,
      reauthRequired: stale,
      reason: stale ? '刷新令牌已超过 90 天，需要重新登录' : null,
    }
  }

  async refresh(id: string): Promise<AuthRefreshResult> {
    const account = this.accounts.get(id)
    if (!account) throw new AppError('AUTH.NO_ACCOUNT', '账户不存在')
    if (account.kind === 'offline') {
      throw appError('AUTH.NOT_REFRESHABLE', '离线账户不需要刷新令牌', {
        hint: '离线账户使用占位令牌，不会过期。',
      })
    }
    if (account.kind === 'authlib') {
      const session = this.sessions.get(id)
      if (!session?.authlib) throw this.authlibLoginRequired(account)
      try {
        const next = await this.refreshAuthlib(account, session.authlib)
        return {
          accountId: id,
          ok: true,
          mcExpiresAt: null,
          refreshedAt: this.now(),
        }
      } catch (error) {
        if (error instanceof AppError && error.code === 'AUTH.AUTHLIB_TOKEN_EXPIRED') {
          throw this.authlibLoginRequired(account)
        }
        throw error
      }
    }
    const session = this.sessions.get(id)
    if (!session) throw this.reauthRequired(account)
    try {
      const next = await this.singleFlightRefresh(account, session)
      return {
        accountId: id,
        ok: true,
        mcExpiresAt: next.mcExpiresAt ?? null,
        refreshedAt: this.now(),
      }
    } catch (error) {
      if (error instanceof AppError && error.code === 'AUTH.INVALID_GRANT') {
        throw this.reauthRequired(account)
      }
      throw error
    }
  }

  private authlibLoginRequired(account: Account): AppError {
    return appError('AUTH.AUTHLIB_LOGIN_REQUIRED', '皮肤站登录已失效，需要重新输入密码', {
      hint: '请在账户设置里重新登录该皮肤站账户；密码只在登录时使用，不会保存。',
      retryable: false,
      details: {
        accountId: account.id,
        reauthRequired: true,
        action: 'loginAuthlib',
      },
    })
  }

  private async refreshAuthlib(
    account: Account,
    authlib: NonNullable<StoredSession['authlib']>,
  ): Promise<void> {
    const result = await this.authlibPost(authlib.server, '/authserver/refresh', {
      accessToken: authlib.accessToken,
      clientToken: authlib.clientToken,
    })
    if (result.status === 401 || result.status === 403) {
      const snippet = redactAuthlibSnippet(result.raw)
      this.options.log.warn('authlib refresh rejected', {
        url: result.url,
        status: result.status,
        responseSnippet: snippet,
        code: 'AUTH.AUTHLIB_TOKEN_EXPIRED',
      })
      throw appError('AUTH.AUTHLIB_TOKEN_EXPIRED', '皮肤站登录已过期', {
        hint: '请重新输入皮肤站密码登录。',
        details: {
          url: result.url,
          status: result.status,
          responseSnippet: snippet,
        },
      })
    }
    if (result.status < 200 || result.status >= 300) {
      throw this.authlibError(result.status, result.body, result.url, result.raw)
    }
    const accessToken =
      typeof result.body?.accessToken === 'string' ? result.body.accessToken : null
    const clientToken =
      typeof result.body?.clientToken === 'string' ? result.body.clientToken : authlib.clientToken
    const selected = result.body?.selectedProfile as { id?: unknown; name?: unknown } | undefined
    const profileId = typeof selected?.id === 'string' ? selected.id : authlib.profileId
    const profileName = typeof selected?.name === 'string' ? selected.name : authlib.profileName
    if (!accessToken) {
      throw appError('AUTH.AUTHLIB_TOKEN_INVALID', '皮肤站没有返回新的访问令牌', {
        hint: '请重新登录。',
      })
    }
    this.sessions.set(account.id, {
      refreshToken: '',
      refreshIssuedAt: this.now(),
      authlib: {
        ...authlib,
        accessToken,
        clientToken,
        profileId: dashedUuid(profileId),
        profileName,
      },
    })
    if (profileName !== account.name || dashedUuid(profileId) !== account.uuid) {
      this.accounts.update({
        ...account,
        name: profileName,
        uuid: dashedUuid(profileId),
      })
    }
    this.profileCache.delete(account.id)
    this.emitChanged()
    this.options.log.info('authlib session refreshed', { accountId: account.id })
  }

  async validateAuthlibSession(id: string): Promise<AuthlibSessionValidation> {
    const account = this.accounts.get(id)
    if (!account) throw new AppError('AUTH.NO_ACCOUNT', '账户不存在')
    if (account.kind !== 'authlib') {
      return { valid: false, reason: '不是皮肤站账户' }
    }
    const session = this.sessions.get(id)
    if (!session?.authlib) return { valid: false, reason: '尚未登录' }
    const result = await this.authlibPost(account.authlibServer ?? '', '/authserver/validate', {
      accessToken: session.authlib.accessToken,
      clientToken: session.authlib.clientToken,
    })
    if (result.status === 204 || (result.status >= 200 && result.status < 300)) {
      return { valid: true, reason: null }
    }
    if (result.status === 401 || result.status === 403) {
      return { valid: false, reason: '访问令牌已失效，需要重新登录' }
    }
    const error = this.authlibError(result.status, result.body, result.url, result.raw)
    return { valid: false, reason: error.message }
  }

  async signoutAuthlib(id: string): Promise<{ ok: boolean }> {
    const account = this.accounts.get(id)
    if (!account) throw new AppError('AUTH.NO_ACCOUNT', '账户不存在')
    if (account.kind !== 'authlib') return { ok: false }
    const session = this.sessions.get(id)
    if (session?.authlib) {
      try {
        await this.authlibPost(account.authlibServer ?? '', '/authserver/invalidate', {
          accessToken: session.authlib.accessToken,
          clientToken: session.authlib.clientToken,
        })
      } catch (error) {
        this.options.log.warn('authlib invalidate failed; removing local session', {
          accountId: id,
          message: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.sessions.delete(id)
    this.profileCache.delete(id)
    this.emitChanged()
    return { ok: true }
  }

  reauth(id: string): AuthReauthResult {
    const account = this.accounts.get(id)
    if (!account) throw new AppError('AUTH.NO_ACCOUNT', '账户不存在')
    const status = this.sessionStatus(id)
    const authlib = account.kind === 'authlib'
    return {
      accountId: id,
      required: status.reauthRequired,
      action: authlib ? 'loginAuthlib' : 'beginDeviceCode',
      hint: status.reauthRequired
        ? authlib
          ? '请输入该皮肤站的用户名和密码重新登录；密码不会保存。'
          : '请重新点击“微软登录”完成设备码认证；原有离线/皮肤站账户不会被修改。'
        : '当前账户仍有效，无需重新登录。',
    }
  }

  private async avatarDataUrl(url: string | null): Promise<string | null> {
    if (!url) return null
    try {
      if (new URL(url).protocol !== 'https:') return null
      const fetchImpl = this.options.fetchImpl ?? fetch
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      try {
        const response = await fetchImpl(url, {
          signal: controller.signal,
          headers: { accept: 'image/png,image/jpeg,image/webp' },
          redirect: 'follow',
        })
        const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
        if (!response.ok || !type || !/^image\/(png|jpeg|webp)$/.test(type)) return null
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length === 0 || bytes.length > 2 * 1024 * 1024) return null
        return `data:${type};base64,${bytes.toString('base64')}`
      } finally {
        clearTimeout(timer)
      }
    } catch {
      return null
    }
  }

  /** Display profile (name/UUID/skin) with a local fallback on network errors. */
  async profile(id: string): Promise<AuthProfile> {
    const cached = this.profileCache.get(id)
    if (cached) return cached
    const account = this.accounts.get(id)
    if (!account) throw new AppError('AUTH.NO_ACCOUNT', '账户不存在')
    let skinUrl: string | null = null
    let capeUrl: string | null = null
    let error: string | null = null
    const fetchedAt = this.now()
    try {
      if (account.kind === 'microsoft') {
        const launch = await this.getLaunchAccount(id)
        const response = await this.http.request(
          'https://api.minecraftservices.com/minecraft/profile',
          {
            method: 'GET',
            headers: { authorization: `Bearer ${launch?.accessToken ?? ''}` },
            timeoutMs: 10_000,
          },
        )
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`Minecraft profile HTTP ${response.status}`)
        }
        const parsed = parseMinecraftProfileTextures(JSON.parse(response.body))
        skinUrl = parsed?.skinUrl ?? null
        capeUrl = parsed?.capeUrl ?? null
      } else if (account.kind === 'authlib' && account.authlibServer) {
        const compact = account.uuid.replaceAll('-', '')
        const response = await this.http.request(
          `${account.authlibServer.replace(/\/+$/, '')}/sessionserver/session/minecraft/profile/${compact}?unsigned=false`,
          {
            method: 'GET',
            headers: { accept: 'application/json' },
            timeoutMs: 10_000,
          },
        )
        if (response.status < 200 || response.status >= 300) {
          throw new Error(`皮肤站档案 HTTP ${response.status}`)
        }
        const body = JSON.parse(response.body) as {
          properties?: Array<{ name?: unknown; value?: unknown }>
        }
        const texturesProperty = Array.isArray(body.properties)
          ? body.properties.find(
              (property) =>
                property &&
                property.name === 'textures' &&
                typeof property.value === 'string',
            )
          : undefined
        const texturesValue =
          typeof texturesProperty?.value === 'string' ? texturesProperty.value : null
        const textures = texturesValue
          ? parseTexturesProperty(texturesValue)
          : { skin: null, cape: null }
        skinUrl = textures.skin?.url ?? null
        capeUrl = textures.cape?.url ?? null
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
    const hasSkin = Boolean(skinUrl)
    const result: AuthProfile = {
      accountId: account.id,
      kind: account.kind,
      name: account.name,
      uuid: account.uuid,
      skinUrl,
      capeUrl,
      avatarUrl: skinUrl,
      avatarDataUrl: await this.avatarDataUrl(skinUrl),
      fallback: hasSkin ? 'none' : 'steve',
      error,
      fetchedAt,
    }
    this.profileCache.set(id, result)
    return result
  }

  private selectedAuthlibServer(): string | null {
    const selected = this.accounts.selected()
    return selected?.kind === 'authlib' ? selected.authlibServer : null
  }

  authlibInfo(): AuthlibInfo {
    return authlibInfoOf(this.options.dataRoot, this.selectedAuthlibServer())
  }

  async ensureAuthlib(): Promise<AuthlibInfo> {
    const info = await ensureAuthlibInjector({
      dataRoot: this.options.dataRoot,
      fetchImpl: this.options.fetchImpl,
    })
    return { ...info, server: this.selectedAuthlibServer() }
  }

  async getAuthlibInjection(accountId: string): Promise<AuthlibInjection | null> {
    const account = this.accounts.get(accountId)
    if (!account || account.kind !== 'authlib' || !account.authlibServer) return null
    const info = await ensureAuthlibInjector({ dataRoot: this.options.dataRoot })
    return { javaagentPath: info.jarPath, apiRoot: account.authlibServer }
  }

  async getAuthlibInjectionForLaunchAccount(
    account: LaunchAccount,
  ): Promise<AuthlibInjection | null> {
    if (account.kind !== 'authlib') return null
    const stored = this.accounts.findByUuid('authlib', account.uuid)
    if (!stored) return null
    return this.getAuthlibInjection(stored.id)
  }

  /** Version/SHA info for docs/tests. */
  static readonly authlib = { version: AUTHLIB_VERSION, sha256: AUTHLIB_SHA256 }
  static readonly mceReviewUrl = MCE_REVIEW_URL
}
