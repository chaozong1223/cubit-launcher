import crypto from 'node:crypto'
import type {
  Account,
  AuthlibInfo,
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
export class AuthService {
  private readonly accounts: AccountStore
  private readonly sessions: SessionStore
  private readonly configStore: AuthConfigStore
  private readonly http: HttpPort
  private readonly now: () => number
  private readonly flows = new Map<string, FlowState>()
  private readonly listeners = new Set<(payload: unknown) => void>()
  private readonly refreshInFlight = new Map<string, Promise<StoredSession>>()

  constructor(private readonly options: AuthServiceOptions) {
    this.accounts = new AccountStore(options.dataRoot)
    this.sessions = new SessionStore(options.dataRoot, options.cipher ?? unavailableCipher())
    this.configStore = new AuthConfigStore(options.dataRoot)
    this.http = options.http ?? createFetchHttp(options.fetchImpl)
    this.now = options.now ?? Date.now
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

  async createAuthlib(name: string, server: string): Promise<Account> {
    if (!validOfflineName(name)) {
      throw appError('AUTH.INVALID_NAME', '用户名需为 3–16 位字母、数字或下划线')
    }
    const url = new URL(server)
    if (url.protocol !== 'https:') {
      throw appError('AUTH.AUTHLIB_INSECURE', 'Authlib 服务器必须使用 HTTPS', {
        hint: 'http 地址会泄露登录令牌，已拒绝。',
      })
    }
    const account = this.createAccount('authlib', name, url.toString())
    this.accounts.add(account)
    this.accounts.select(account.id)
    this.options.log.info('authlib account created', { id: account.id, name, server: url.host })
    this.emitChanged()
    return { ...account }
  }

  async select(id: string): Promise<{ ok: boolean }> {
    this.accounts.select(id)
    this.emitChanged()
    return { ok: true }
  }

  async logout(id: string): Promise<{ ok: boolean }> {
    this.sessions.delete(id)
    const removed = this.accounts.remove(id)
    this.emitChanged()
    return { ok: removed }
  }

  async setAuthlib(id: string, server: string): Promise<Account> {
    const account = this.accounts.get(id)
    if (!account) throw new AppError('AUTH.NO_ACCOUNT', '账户不存在')
    const url = new URL(server)
    if (url.protocol !== 'https:') {
      throw appError('AUTH.AUTHLIB_INSECURE', 'Authlib 服务器必须使用 HTTPS')
    }
    const next = { ...account, kind: 'authlib' as const, authlibServer: url.toString() }
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
    if (account.kind !== 'microsoft') {
      return {
        kind: account.kind,
        name: account.name,
        uuid: account.uuid,
        accessToken: '0',
        userType: 'legacy',
      }
    }

    let session = this.sessions.get(account.id)
    if (!session) {
      throw toAuthError({ stage: 'refresh', error: 'invalid_grant' })
    }
    const stillValid =
      typeof session.mcAccessToken === 'string' &&
      typeof session.mcExpiresAt === 'number' &&
      session.mcExpiresAt - this.now() > REFRESH_MARGIN_MS
    if (!stillValid) {
      session = await this.singleFlightRefresh(account, session)
    }
    if (!session.mcAccessToken) {
      throw toAuthError({ stage: 'refresh', error: 'invalid_grant' })
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
