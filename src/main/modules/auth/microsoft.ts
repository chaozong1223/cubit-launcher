/*
 * Ported/adapted from HMCL (Hello Minecraft! Launcher)
 * Copyright (C) 2021 huangyuhui <huanghongxun2008@126.com> and contributors
 *
 * Source: https://github.com/HMCL-dev/HMCL
 * Commit: e7b9a95df0acf79b9797dcef38463e2b22e37a6a
 * File: HMCLCore/src/main/java/org/jackhuang/hmcl/auth/microsoft/MicrosoftService.java
 * GPL-3.0; see LICENSE. Modifications (t62): HMCL OAuth/SCOPE behaviour adapted
 * to our HttpPort/AppError mapping; HMCL's application client_id is never used.
 */
import { toAuthError } from './errors'
import { HttpNetworkError, type HttpPort } from './http'

export interface MicrosoftConfig {
  clientId: string | null
  tenant: string
}

export interface DeviceCodeInfo {
  deviceCode: string
  userCode: string
  verificationUri: string
  message: string | null
  expiresIn: number
  interval: number
}

export interface MsToken {
  accessToken: string
  refreshToken: string
  expiresIn: number
}

export interface MinecraftProfile {
  id: string
  name: string
}

export interface MinecraftAuthResult {
  accessToken: string
  expiresIn: number
  profile: MinecraftProfile
  xuid: string | null
}

export type PollTokenResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'ok'; token: MsToken }

const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

export const DEVICE_CODE_SCOPE = 'XboxLive.signin offline_access'

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

export class MicrosoftOAuth {
  constructor(
    private readonly config: () => MicrosoftConfig,
    private readonly http: HttpPort,
    private readonly now: () => number = Date.now,
  ) {}

  private authority(): string {
    const { tenant } = this.config()
    return `https://login.microsoftonline.com/${encodeURIComponent(tenant || 'consumers')}`
  }

  private requireClientId(): string {
    const clientId = this.config().clientId
    if (!clientId) {
      throw toAuthError({ stage: 'devicecode', error: 'MS_CLIENT_ID_MISSING' })
    }
    return clientId
  }

  private async postForm(url: string, params: Record<string, string>): Promise<{
    status: number
    body: string
  }> {
    const response = await this.http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      timeoutMs: 20_000,
    })
    return { status: response.status, body: response.body }
  }

  private async postJson(
    url: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string }> {
    const response = await this.http.request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      timeoutMs: 20_000,
    })
    return { status: response.status, body: response.body }
  }

  private async getJson(
    url: string,
    headers: Record<string, string>,
  ): Promise<{ status: number; body: string }> {
    const response = await this.http.request(url, {
      method: 'GET',
      headers,
      timeoutMs: 20_000,
    })
    return { status: response.status, body: response.body }
  }

  async beginDeviceCode(): Promise<DeviceCodeInfo> {
    const clientId = this.requireClientId()
    let result: { status: number; body: string }
    try {
      result = await this.postForm(`${this.authority()}/oauth2/v2.0/devicecode`, {
        client_id: clientId,
        scope: DEVICE_CODE_SCOPE,
      })
    } catch (error) {
      throw networkError(error, 'devicecode')
    }

    const body = parseJson(result.body)
    if (result.status !== 200 || !body) {
      throw toAuthError({
        stage: 'devicecode',
        status: result.status,
        error: asString(body?.error) ?? undefined,
        errorDescription: asString(body?.error_description) ?? undefined,
      })
    }

    const deviceCode = asString(body.device_code)
    const userCode = asString(body.user_code)
    const verificationUri =
      asString(body.verification_uri) ?? asString(body.verification_url) ?? null
    if (!deviceCode || !userCode || !verificationUri) {
      throw toAuthError({ stage: 'devicecode', status: result.status })
    }

    return {
      deviceCode,
      userCode,
      verificationUri,
      message: asString(body.message),
      expiresIn: asNumber(body.expires_in) ?? 900,
      interval: Math.max(1, asNumber(body.interval) ?? 5),
    }
  }

  async pollToken(deviceCode: string): Promise<PollTokenResult> {
    const clientId = this.requireClientId()
    let result: { status: number; body: string }
    try {
      result = await this.postForm(`${this.authority()}/oauth2/v2.0/token`, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: clientId,
        device_code: deviceCode,
      })
    } catch (error) {
      throw networkError(error, 'token')
    }

    const body = parseJson(result.body)
    if (result.status === 200 && body) {
      const accessToken = asString(body.access_token)
      const refreshToken = asString(body.refresh_token)
      if (!accessToken || !refreshToken) {
        throw toAuthError({ stage: 'token', status: result.status })
      }
      return {
        status: 'ok',
        token: {
          accessToken,
          refreshToken,
          expiresIn: asNumber(body.expires_in) ?? 3600,
        },
      }
    }

    const error = asString(body?.error) ?? ''
    if (error === 'authorization_pending') return { status: 'pending' }
    if (error === 'slow_down') {
      return { status: 'slow_down', interval: Math.max(1, asNumber(body?.interval) ?? 5) }
    }

    throw toAuthError({
      stage: 'token',
      status: result.status,
      error,
      errorDescription: asString(body?.error_description) ?? undefined,
    })
  }

  async refresh(refreshToken: string): Promise<MsToken> {
    const clientId = this.requireClientId()
    let result: { status: number; body: string }
    try {
      result = await this.postForm(`${this.authority()}/oauth2/v2.0/token`, {
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
        scope: DEVICE_CODE_SCOPE,
      })
    } catch (error) {
      throw networkError(error, 'refresh')
    }

    const body = parseJson(result.body)
    if (result.status !== 200 || !body) {
      throw toAuthError({
        stage: 'refresh',
        status: result.status,
        error: asString(body?.error) ?? undefined,
        errorDescription: asString(body?.error_description) ?? undefined,
      })
    }
    const accessToken = asString(body.access_token)
    if (!accessToken) throw toAuthError({ stage: 'refresh', status: result.status })
    return {
      accessToken,
      refreshToken: asString(body.refresh_token) ?? refreshToken,
      expiresIn: asNumber(body.expires_in) ?? 3600,
    }
  }

  /** Microsoft token → Xbox Live → XSTS → Minecraft services profile. */
  async authenticateMinecraft(msAccessToken: string): Promise<MinecraftAuthResult> {
    let xbl: { status: number; body: string }
    try {
      xbl = await this.postJson(XBL_URL, {
        Properties: {
          AuthMethod: 'RPS',
          SiteName: 'user.auth.xboxlive.com',
          RpsTicket: `d=${msAccessToken}`,
        },
        RelyingParty: 'http://auth.xboxlive.com',
        TokenType: 'JWT',
      })
    } catch (error) {
      throw networkError(error, 'xbl')
    }
    const xblBody = parseJson(xbl.body)
    const xblToken = asString(xblBody?.Token)
    if (xbl.status !== 200 || !xblToken) {
      throw toAuthError({
        stage: 'xbl',
        status: xbl.status,
        error: asString(xblBody?.error) ?? undefined,
        errorDescription: asString(xblBody?.error_description) ?? undefined,
        xerr: asNumber(xblBody?.XErr),
      })
    }

    let xsts: { status: number; body: string }
    try {
      xsts = await this.postJson(XSTS_URL, {
        Properties: { SandboxId: 'RETAIL', UserTokens: [xblToken] },
        RelyingParty: 'rp://api.minecraftservices.com/',
        TokenType: 'JWT',
      })
    } catch (error) {
      throw networkError(error, 'xsts')
    }
    const xstsBody = parseJson(xsts.body)
    const xstsToken = asString(xstsBody?.Token)
    const claims = asRecord(xstsBody?.DisplayClaims)
    const xui = Array.isArray(claims?.xui) ? claims?.xui : []
    const firstClaim = asRecord(xui[0])
    const uhs = asString(firstClaim?.uhs)
    if (xsts.status !== 200 || !xstsToken || !uhs) {
      throw toAuthError({
        stage: 'xsts',
        status: xsts.status,
        error: asString(xstsBody?.error) ?? undefined,
        errorDescription: asString(xstsBody?.error_description) ?? undefined,
        xerr: asNumber(xstsBody?.XErr),
      })
    }

    let mc: { status: number; body: string }
    try {
      mc = await this.postJson(MC_LOGIN_URL, {
        identityToken: `XBL3.0 x=${uhs};${xstsToken}`,
      })
    } catch (error) {
      throw networkError(error, 'mc-login')
    }
    const mcBody = parseJson(mc.body)
    const accessToken = asString(mcBody?.access_token)
    if (mc.status !== 200 || !accessToken) {
      throw toAuthError({ stage: 'mc-login', status: mc.status })
    }

    let profile: { status: number; body: string }
    try {
      profile = await this.getJson(MC_PROFILE_URL, {
        authorization: `Bearer ${accessToken}`,
      })
    } catch (error) {
      throw networkError(error, 'profile')
    }
    const profileBody = parseJson(profile.body)
    const id = asString(profileBody?.id)
    const name = asString(profileBody?.name)
    if (profile.status !== 200 || !id || !name) {
      throw toAuthError({ stage: 'profile', status: profile.status })
    }

    return {
      accessToken,
      expiresIn: asNumber(mcBody?.expires_in) ?? 86_400,
      profile: { id, name },
      xuid: asString(firstClaim?.xid) ?? null,
    }
  }
}

function networkError(error: unknown, stage: 'devicecode' | 'token' | 'refresh' | 'xbl' | 'xsts' | 'mc-login' | 'profile'): Error {
  if (error instanceof HttpNetworkError) {
    return toAuthError({ stage: 'network', errorDescription: `${stage}: ${error.message}` })
  }
  return toAuthError({ stage: 'network', errorDescription: String(error) })
}

export type { MicrosoftConfig as MicrosoftOAuthConfig }
