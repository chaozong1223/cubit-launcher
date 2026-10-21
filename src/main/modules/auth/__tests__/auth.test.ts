import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ScopedLogger } from '../../../kernel/logger'
import type { HttpPort, HttpResponse } from '../http'
import { classifyAuthFailure, MCE_REVIEW_URL } from '../errors'
import { offlineUuid } from '../uuid'
import type { TokenCipher } from '../store'
import { AuthService } from '../service'
import { ensureAuthlibInjector, AUTHLIB_SHA256, AUTHLIB_VERSION } from '../authlib'

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-auth-'))
  cleanup.push(root)
  return root
}

const testCipher: TokenCipher = {
  available: true,
  backend: 'test',
  encrypt(plain) {
    return Buffer.from(Buffer.from(plain, 'utf8').toString('base64'), 'utf8')
  },
  decrypt(data) {
    return Buffer.from(data.toString('utf8'), 'base64').toString('utf8')
  },
}

interface Route {
  status?: number
  body: unknown
}

type FakeRoute = Route | ((body: string) => Route)

function fakeHttp(routes: Record<string, FakeRoute>): HttpPort {
  return {
    async request(url, init): Promise<HttpResponse> {
      const route = routes[url]
      if (!route) return { status: 404, body: '{}', headers: {} }
      const resolved = typeof route === 'function' ? route(init.body ?? '') : route
      return {
        status: resolved.status ?? 200,
        body: JSON.stringify(resolved.body),
        headers: {},
      }
    },
  }
}

const DEVICE_URL = 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/devicecode'
const TOKEN_URL = 'https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token'
const XBL_URL = 'https://user.auth.xboxlive.com/user/authenticate'
const XSTS_URL = 'https://xsts.auth.xboxlive.com/xsts/authorize'
const MC_LOGIN_URL = 'https://api.minecraftservices.com/authentication/login_with_xbox'
const MC_PROFILE_URL = 'https://api.minecraftservices.com/minecraft/profile'

function successRoutes(
  overrides: Partial<Record<string, FakeRoute>> = {},
): Record<string, FakeRoute> {
  return {
    [DEVICE_URL]: {
      body: {
        device_code: 'device-secret-code',
        user_code: 'ABCD-EFGH',
        verification_uri: 'https://microsoft.com/devicelogin',
        expires_in: 900,
        interval: 5,
        message: '打开页面并输入代码',
      },
    },
    [TOKEN_URL]: {
      body: {
        access_token: 'ms-access-token',
        refresh_token: 'ms-refresh-token',
        expires_in: 3600,
      },
    },
    [XBL_URL]: { body: { Token: 'xbl-token' } },
    [XSTS_URL]: {
      body: {
        Token: 'xsts-token',
        DisplayClaims: { xui: [{ uhs: 'user-hash', xid: '1234567890' }] },
      },
    },
    [MC_LOGIN_URL]: { body: { access_token: 'mc-access-token', expires_in: 86_400 } },
    [MC_PROFILE_URL]: {
      body: { id: '069a79f444e94726a5befca90e38aaf5', name: 'TestUser' },
    },
    ...overrides,
  }
}

function createService(options: {
  dataRoot: string
  http: HttpPort
  now?: () => number
}): { service: AuthService; logs: string[]; logger: ScopedLogger } {
  const logs: string[] = []
  const logger = {
    trace: (m: string, f?: unknown) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
    debug: (m: string, f?: unknown) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
    info: (m: string, f?: unknown) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
    warn: (m: string, f?: unknown) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
    error: (m: string, f?: unknown) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
    fatal: (m: string, f?: unknown) => logs.push(`${m} ${JSON.stringify(f ?? {})}`),
  } as unknown as ScopedLogger
  const service = new AuthService({
    dataRoot: options.dataRoot,
    log: logger,
    cipher: testCipher,
    http: options.http,
    now: options.now ?? (() => 1_000_000),
  })
  return { service, logs, logger }
}

describe('offline accounts', () => {
  it('computes the documented offline UUID', () => {
    expect(offlineUuid('TestUser')).toBe('097d3392-865a-3f3c-8b4a-da1c3473466c')
    expect(offlineUuid('SecondUser')).toBe('a06ca53b-ae4a-364c-aa73-1254960523a6')
  })

  it('creates/selects/logs out offline accounts and returns launch credentials', async () => {
    const { service } = createService({
      dataRoot: tempRoot(),
      http: fakeHttp({}),
    })
    const account = await service.createOffline('TestUser')
    expect(account).toMatchObject({
      kind: 'offline',
      name: 'TestUser',
      uuid: '097d3392-865a-3f3c-8b4a-da1c3473466c',
    })
    const listed = await service.list()
    expect(listed.accounts).toHaveLength(1)
    expect(listed.selectedId).toBe(account.id)

    const launch = await service.getLaunchAccount(account.id)
    expect(launch).toEqual({
      kind: 'offline',
      name: 'TestUser',
      uuid: '097d3392-865a-3f3c-8b4a-da1c3473466c',
      accessToken: '0',
      userType: 'legacy',
    })

    expect(await service.logout(account.id)).toEqual({ ok: true })
    expect((await service.list()).accounts).toHaveLength(0)
    await expect(service.getLaunchAccount(null)).rejects.toMatchObject({ code: 'AUTH.NO_ACCOUNT' })
  })

  it('rejects invalid names and HTTP authlib servers', async () => {
    const { service } = createService({ dataRoot: tempRoot(), http: fakeHttp({}) })
    for (const name of ['ab', 'a b', 'abcdefghijklmnopq', '张三']) {
      await expect(service.createOffline(name)).rejects.toMatchObject({ code: 'AUTH.INVALID_NAME' })
    }
    await expect(service.createAuthlib('TestUser', 'http://insecure.example')).rejects.toMatchObject({
      code: 'AUTH.AUTHLIB_INSECURE',
    })
    const authlib = await service.createAuthlib('TestUser', 'https://skin.example/api/yggdrasil')
    expect(authlib.kind).toBe('authlib')
    expect(authlib.authlibServer).toBe('https://skin.example/api/yggdrasil')
  })
})

describe('microsoft device code flow', () => {
  it('refuses to start without a configured client id', async () => {
    const { service } = createService({ dataRoot: tempRoot(), http: fakeHttp({}) })
    await expect(service.beginDeviceCode()).rejects.toMatchObject({
      code: 'MS_CLIENT_ID_MISSING',
      retryable: false,
    })
  })

  it('completes device code → Xbox → profile and persists tokens encrypted only', async () => {
    const root = tempRoot()
    const { service, logs } = createService({
      dataRoot: root,
      http: fakeHttp(successRoutes()),
    })
    await service.configureMicrosoft({ clientId: 'client-id', tenant: 'tenant-id' })
    const device = await service.beginDeviceCode()
    expect(device).toMatchObject({
      userCode: 'ABCD-EFGH',
      verificationUri: 'https://microsoft.com/devicelogin',
      interval: 5,
    })
    expect(device.flowId.length).toBeGreaterThan(0)

    const result = await service.pollDeviceCode(device.flowId)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected ok')
    expect(result.account).toMatchObject({
      kind: 'microsoft',
      name: 'TestUser',
      uuid: '069a79f4-44e9-4726-a5be-fca90e38aaf5',
    })

    const launch = await service.getLaunchAccount(result.account.id)
    expect(launch).toMatchObject({
      kind: 'microsoft',
      name: 'TestUser',
      accessToken: 'mc-access-token',
      userType: 'msa',
      xuid: '1234567890',
    })

    // No plaintext token in any persistent file or log.
    const accountText = fs.readFileSync(path.join(root, 'accounts.json'), 'utf8')
    const sessionText = fs.readFileSync(path.join(root, 'modules', 'auth', 'sessions.bin'), 'utf8')
    expect(accountText).not.toContain('ms-refresh-token')
    expect(accountText).not.toContain('mc-access-token')
    expect(sessionText).not.toContain('ms-refresh-token')
    expect(sessionText).not.toContain('mc-access-token')
    expect(logs.join('\n')).not.toContain('ms-refresh-token')
    expect(logs.join('\n')).not.toContain('mc-access-token')
  })

  it('refreshes an expired Minecraft token with single-flight rotation', async () => {
    const root = tempRoot()
    let now = 1_000_000
    let tokenCalls = 0
    let mcLoginCalls = 0
    const routes = successRoutes({
      [TOKEN_URL]: (body: string) => {
        if (body.includes('grant_type=refresh_token')) {
          tokenCalls += 1
          return {
            body: {
              access_token: 'ms-access-2',
              refresh_token: 'ms-refresh-2',
              expires_in: 3600,
            },
          }
        }
        return {
          body: {
            access_token: 'ms-access-token',
            refresh_token: 'ms-refresh-token',
            expires_in: 3600,
          },
        }
      },
      [MC_LOGIN_URL]: () => {
        mcLoginCalls += 1
        return {
          body: {
            access_token: mcLoginCalls === 1 ? 'mc-access-token' : 'mc-access-2',
            expires_in: 86_400,
          },
        }
      },
    })
    const { service } = createService({
      dataRoot: root,
      http: fakeHttp(routes),
      now: () => now,
    })
    await service.configureMicrosoft({ clientId: 'client-id', tenant: 'tenant-id' })
    const device = await service.beginDeviceCode()
    const result = await service.pollDeviceCode(device.flowId)
    if (result.status !== 'ok') throw new Error('expected login')
    expect((await service.getLaunchAccount(result.account.id))?.accessToken).toBe('mc-access-token')

    now += 25 * 3600 * 1000
    const [a, b] = await Promise.all([
      service.getLaunchAccount(result.account.id),
      service.getLaunchAccount(result.account.id),
    ])
    expect(a?.accessToken).toBe('mc-access-2')
    expect(b?.accessToken).toBe('mc-access-2')
    expect(tokenCalls).toBe(1) // single-flight refresh
  })

  it('surfaces AADSTS650053 and Minecraft 403 as honest failures, never fake success', async () => {
    const root = tempRoot()
    const deviceBlocked = createService({
      dataRoot: root,
      http: fakeHttp(
        successRoutes({
          [TOKEN_URL]: {
            status: 400,
            body: {
              error: 'invalid_request',
              error_description:
                'AADSTS650053: The application asked for scope XboxLive.signin that does not exist on the resource.',
            },
          },
        }),
      ),
    })
    await deviceBlocked.service.configureMicrosoft({ clientId: 'client-id', tenant: 'tenant-id' })
    const device = await deviceBlocked.service.beginDeviceCode()
    const failed = await deviceBlocked.service.pollDeviceCode(device.flowId)
    expect(failed.status).toBe('failed')
    if (failed.status !== 'failed') throw new Error('expected failed')
    expect(failed.error.code).toBe('MS_AUTH_NOT_APPROVED')
    expect(failed.error.details?.hint).toContain(MCE_REVIEW_URL)
    expect((await deviceBlocked.service.list()).accounts).toHaveLength(0)

    const profile403 = createService({
      dataRoot: tempRoot(),
      http: fakeHttp(successRoutes({ [MC_PROFILE_URL]: { status: 403, body: {} } })),
    })
    await profile403.service.configureMicrosoft({ clientId: 'client-id', tenant: 'tenant-id' })
    const device2 = await profile403.service.beginDeviceCode()
    const failed2 = await profile403.service.pollDeviceCode(device2.flowId)
    expect(failed2.status).toBe('failed')
    if (failed2.status !== 'failed') throw new Error('expected failed')
    expect(failed2.error.code).toBe('MS_AUTH_NOT_APPROVED')
  })
})

describe('microsoft pre-condition error mapping', () => {
  const hasChinese = (value: string) => /[\u4e00-\u9fa5]/.test(value)

  it('maps AADSTS70002 to public-client guidance', () => {
    const failure = classifyAuthFailure({
      stage: 'token',
      status: 400,
      error: 'unauthorized_client',
      errorDescription: "AADSTS70002: The client must be 'mobile' or a public client.",
    })
    expect(failure.code).toBe('AUTH.AADSTS70002')
    expect(failure.hint).toContain('isFallbackPublicClient')
    expect(hasChinese(failure.message)).toBe(true)
  })

  it('maps AADSTS50149 to PKCE guidance', () => {
    const failure = classifyAuthFailure({
      stage: 'token',
      status: 400,
      error: 'invalid_grant',
      errorDescription: 'AADSTS50149: PKCE is not supported for this account type.',
    })
    expect(failure.code).toBe('AUTH.AADSTS50149')
    expect(failure.hint).toContain('PKCE')
  })

  it('maps unauthorized_client to tenant routing guidance', () => {
    const failure = classifyAuthFailure({
      stage: 'devicecode',
      status: 400,
      error: 'unauthorized_client',
      errorDescription: 'The client does not exist in this tenant.',
    })
    expect(failure.code).toBe('AUTH.UNAUTHORIZED_CLIENT')
    expect(failure.hint).toContain('租户')
  })

  it('maps AADSTS650053 to MCE approval guidance', () => {
    const failure = classifyAuthFailure({
      stage: 'devicecode',
      status: 400,
      error: 'invalid_request',
      errorDescription: 'AADSTS650053: XboxLive.signin is not available.',
    })
    expect(failure.code).toBe('MS_AUTH_NOT_APPROVED')
    expect(failure.docs).toBe(MCE_REVIEW_URL)
    expect(failure.hint).toContain(MCE_REVIEW_URL)
  })

  it('maps Minecraft service 403 to entitlement/approval guidance', () => {
    const failure = classifyAuthFailure({ stage: 'profile', status: 403 })
    expect(failure.code).toBe('MS_AUTH_NOT_APPROVED')
    expect(failure.hint).toContain('MCE')
    expect(hasChinese(failure.message)).toBe(true)
  })

  it('maps XSTS errors and invalid_grant', () => {
    expect(classifyAuthFailure({ stage: 'xsts', xerr: 2148916233 }).code).toBe('AUTH.XSTS_NO_XBOX')
    expect(classifyAuthFailure({ stage: 'xsts', xerr: 2148916238 }).code).toBe('AUTH.XSTS_CHILD')
    expect(
      classifyAuthFailure({ stage: 'refresh', status: 400, error: 'invalid_grant' }).code,
    ).toBe('AUTH.INVALID_GRANT')
  })
})

describe('authlib-injector fixed artifact', () => {
  it('downloads, verifies and caches the fixed jar', async () => {
    const root = tempRoot()
    const bytes = Buffer.from('tiny-authlib-fixture', 'utf8')
    const digest = crypto.createHash('sha256').update(bytes).digest('hex')
    const fetchImpl = vi.fn(
      async () => new Response(bytes as never, { status: 200 }),
    ) as unknown as typeof fetch

    const first = await ensureAuthlibInjector({
      dataRoot: root,
      fetchImpl,
      expectedSha256: digest,
    })
    expect(first.downloaded).toBe(true)
    expect(fs.readFileSync(first.jarPath)).toEqual(bytes)

    const second = await ensureAuthlibInjector({
      dataRoot: root,
      fetchImpl,
      expectedSha256: digest,
    })
    expect(second.downloaded).toBe(false)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('rejects a hash mismatch and keeps the fixed public constants', async () => {
    const root = tempRoot()
    const fetchImpl = vi.fn(async () => new Response('bad', { status: 200 })) as unknown as typeof fetch
    await expect(
      ensureAuthlibInjector({
        dataRoot: root,
        fetchImpl,
        expectedSha256: crypto.createHash('sha256').update('expected').digest('hex'),
      }),
    ).rejects.toMatchObject({ code: 'AUTHLIB.HASH_MISMATCH' })
    expect(AUTHLIB_VERSION).toBe('1.2.8')
    expect(AUTHLIB_SHA256).toBe(
      '9c7f4343e6c82034958ffb48c14a2cb0c85928be7283103ce17da00c6d5a7b10',
    )
  })
})
