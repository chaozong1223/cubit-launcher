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
import {
  buildAuthorizationUrl,
  createPkce,
  HMCL_MICROSOFT_SCOPE,
  LoopbackOAuthServer,
} from '../hmcl-port/oauth'
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
const AUTHLIB_SERVER = 'https://skin.example/api/yggdrasil'

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
      body: {
        id: '069a79f444e94726a5befca90e38aaf5',
        name: 'TestUser',
        skins: [{ id: 'skin', state: 'ACTIVE', url: 'https://textures.example/skin.png' }],
        capes: [{ id: 'cape', state: 'ACTIVE', url: 'https://textures.example/cape.png' }],
      },
    },
    [AUTHLIB_SERVER]: {
      body: {
        meta: { serverName: 'Example Skin' },
        skinDomains: ['skin.example'],
        signaturePublickey: 'public-key',
      },
    },
    [`${AUTHLIB_SERVER}/authserver/authenticate`]: {
      body: {
        accessToken: 'authlib-access-token',
        clientToken: 'authlib-client-token',
        selectedProfile: {
          id: '11111111111111111111111111111111',
          name: 'SkinUser',
        },
        availableProfiles: [{ id: '11111111111111111111111111111111', name: 'SkinUser' }],
      },
    },
    [`${AUTHLIB_SERVER}/authserver/refresh`]: {
      body: {
        accessToken: 'authlib-access-token-2',
        clientToken: 'authlib-client-token',
        selectedProfile: {
          id: '11111111111111111111111111111111',
          name: 'SkinUser',
        },
      },
    },
    [`${AUTHLIB_SERVER}/authserver/validate`]: { status: 204, body: {} },
    [`${AUTHLIB_SERVER}/authserver/invalidate`]: { status: 204, body: {} },
    ...overrides,
  }
}

function createService(options: {
  dataRoot: string
  http: HttpPort
  now?: () => number
  fetchImpl?: typeof fetch
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
    fetchImpl:
      options.fetchImpl ??
      (async () => new Response('no avatar in unit test', { status: 404 })),
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
    const { service } = createService({ dataRoot: tempRoot(), http: fakeHttp(successRoutes()) })
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
  it('ships a built-in client id so a fresh install can sign in', async () => {
    const { service } = createService({ dataRoot: tempRoot(), http: fakeHttp({}) })
    const config = await service.getMicrosoftConfig()
    // The default id is public and baked in; users no longer configure it.
    expect(config.configured).toBe(true)
    expect(typeof config.clientId).toBe('string')
    expect(config.tenant).toBe('consumers')
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

describe('HMCL OAuth loopback port', () => {
  it('builds a PKCE authorization URL with our client id, never HMCL client id', () => {
    const pkce = createPkce()
    expect(pkce.verifier.length).toBeGreaterThanOrEqual(43)
    expect(pkce.challenge).not.toBe(pkce.verifier)
    const url = new URL(
      buildAuthorizationUrl({
        clientId: 'our-client-id',
        tenant: 'tenant-id',
        redirectUri: 'http://localhost:53117/',
        state: pkce.state,
        challenge: pkce.challenge,
      }),
    )
    expect(url.searchParams.get('client_id')).toBe('our-client-id')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('code_challenge')).toBe(pkce.challenge)
    expect(url.searchParams.get('scope')).toBe(HMCL_MICROSOFT_SCOPE)
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:53117/')
    expect(url.toString()).not.toContain('hmcl.microsoft.auth.id')
  })

  it('serves the localhost callback, validates state and returns the code', async () => {
    const server = await LoopbackOAuthServer.start([0])
    try {
      expect(server.redirectUri).toBe('http://localhost:' + String(server.port) + '/')
      const response = await fetch(
        `${server.redirectUri}?code=authorization-code&state=${server.pkce.state}`,
      )
      expect(response.status).toBe(200)
      expect(server.poll()).toMatchObject({
        status: 'ok',
        code: 'authorization-code',
      })
    } finally {
      server.close()
    }
  })

  it('rejects a callback with the wrong state', async () => {
    const server = await LoopbackOAuthServer.start([0])
    try {
      const response = await fetch(`${server.redirectUri}?code=code&state=wrong`)
      expect(response.status).toBe(400)
      expect(server.poll()).toMatchObject({
        status: 'failed',
        code: 'AUTH.OAUTH_STATE_MISMATCH',
      })
    } finally {
      server.close()
    }
  })

  it('completes the loopback flow through the auth service with our client id', async () => {
    // The real launcher may already hold the registered 53117 port on a dev
    // machine, so let this test grab any free port instead.
    const previousPorts = process.env.MCL_AUTH_CALLBACK_PORTS
    process.env.MCL_AUTH_CALLBACK_PORTS = '0'
    // The developer machine may export MCL_MS_CLIENT_ID; it outranks the stored
    // config, so clear it for this test and restore it afterwards.
    const previousClientIdEnv = process.env.MCL_MS_CLIENT_ID
    delete process.env.MCL_MS_CLIENT_ID
    try {
      const routes = successRoutes()
      const service = createService({
        dataRoot: tempRoot(),
        http: fakeHttp(routes),
      }).service
    await service.configureMicrosoft({ clientId: 'our-client-id', tenant: 'tenant-id' })
    const opened: string[] = []
    ;(service as unknown as { options: { openExternal?: (url: string) => void } }).options.openExternal =
      (url: string) => {
        opened.push(url)
      }
    const start = await service.beginAuthCode()
    const authorization = new URL(start.authorizationUrl)
    expect(authorization.searchParams.get('client_id')).toBe('our-client-id')
    expect(opened[0]).toBe(start.authorizationUrl)
    const state = authorization.searchParams.get('state')
    const response = await fetch(`${start.redirectUri}?code=loopback-code&state=${state}`)
    expect(response.status).toBe(200)
    const result = await service.pollAuthCode(start.flowId)
    expect(result.status).toBe('ok')
    if (result.status !== 'ok') throw new Error('expected loopback login')
    expect(result.account.kind).toBe('microsoft')
    expect((await service.list()).selectedId).toBe(result.account.id)
    // P3: the flow record is consumed on success, but polling again must stay
    // idempotent instead of degrading into AUTH.FLOW_NOT_FOUND.
    const replay = await service.pollAuthCode(start.flowId)
    expect(replay).toEqual({ status: 'ok', account: result.account })
    const replayAgain = await service.pollAuthCode(start.flowId)
    expect(replayAgain.status).toBe('ok')
    } finally {
      if (previousPorts === undefined) delete process.env.MCL_AUTH_CALLBACK_PORTS
      else process.env.MCL_AUTH_CALLBACK_PORTS = previousPorts
      if (previousClientIdEnv === undefined) delete process.env.MCL_MS_CLIENT_ID
      else process.env.MCL_MS_CLIENT_ID = previousClientIdEnv
    }
  })
})

describe('profiles, sessions and multi-account switching', () => {
  it('exposes presets and validates Authlib metadata, including API-root fallback', async () => {
    const routes = successRoutes()
    const service = createService({ dataRoot: tempRoot(), http: fakeHttp(routes) }).service
    expect(service.authlibPresets().some((preset) => preset.id === 'littleskin')).toBe(true)
    const direct = await service.validateAuthlib(AUTHLIB_SERVER)
    expect(direct).toMatchObject({
      ok: true,
      canonicalServer: AUTHLIB_SERVER,
      serverName: 'Example Skin',
    })
    const fallback = await service.validateAuthlib('https://skin.example')
    expect(fallback.canonicalServer).toBe(AUTHLIB_SERVER)
    routes['https://bad.example/api/yggdrasil'] = { status: 503, body: {} }
    const bad = await service.validateAuthlib('https://bad.example/api/yggdrasil')
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('503')
    await expect(
      service.createAuthlib('SkinUser', 'https://bad.example/api/yggdrasil'),
    ).rejects.toMatchObject({ code: 'AUTH.AUTHLIB_INVALID' })
  })

  it('reports Authlib validation diagnostics for unreachable, non-JSON and 5xx sites', async () => {
    const unreachableHttp: HttpPort = {
      async request() {
        throw new Error('getaddrinfo ENOTFOUND dead.example')
      },
    }
    const unreachable = createService({ dataRoot: tempRoot(), http: unreachableHttp })
    const down = await unreachable.service.validateAuthlib(
      'https://dead.example/api/yggdrasil',
    )
    expect(down).toMatchObject({
      ok: false,
      category: 'unreachable',
      attemptedUrl: 'https://dead.example/api/yggdrasil',
      statusCode: null,
    })
    expect(down.responseSnippet).toContain('ENOTFOUND')
    expect(down.reason).toContain('https://dead.example/api/yggdrasil')
    expect(unreachable.logs.join('\n')).toContain('https://dead.example/api/yggdrasil')

    const nonJsonRoutes = successRoutes({
      [AUTHLIB_SERVER]: { body: '<html>not an authlib site</html>' },
    })
    const nonJson = createService({
      dataRoot: tempRoot(),
      http: fakeHttp(nonJsonRoutes),
    }).service
    const notAuthlib = await nonJson.validateAuthlib(AUTHLIB_SERVER)
    expect(notAuthlib).toMatchObject({
      ok: false,
      category: 'not-authlib',
      attemptedUrl: AUTHLIB_SERVER,
      statusCode: 200,
    })
    expect(notAuthlib.responseSnippet).toContain('not an authlib site')

    const routes = successRoutes({ [AUTHLIB_SERVER]: { status: 502, body: { error: 'Bad Gateway' } } })
    const fiveHundred = createService({ dataRoot: tempRoot(), http: fakeHttp(routes) }).service
    const serverError = await fiveHundred.validateAuthlib(AUTHLIB_SERVER)
    expect(serverError).toMatchObject({
      ok: false,
      category: 'server-error',
      attemptedUrl: AUTHLIB_SERVER,
      statusCode: 502,
    })
    expect(serverError.reason).toContain('502')
  })

  it('includes URL, HTTP status and redacted response body in authenticate errors', async () => {
    const routes = successRoutes({
      [`${AUTHLIB_SERVER}/authserver/authenticate`]: {
        status: 401,
        body: {
          error: 'ForbiddenOperationException',
          errorMessage: 'Invalid credentials. Invalid username or password.',
          password: 'should-never-appear',
          accessToken: 'should-never-appear-token',
        },
      },
    })
    const { service, logs } = createService({ dataRoot: tempRoot(), http: fakeHttp(routes) })
    let caught: unknown
    try {
      await service.loginAuthlib('SkinUser', 'super-secret-password', AUTHLIB_SERVER)
    } catch (error) {
      caught = error
    }
    expect(caught).toMatchObject({
      code: 'AUTH.AUTHLIB_INVALID_CREDENTIALS',
      details: {
        url: `${AUTHLIB_SERVER}/authserver/authenticate`,
        status: 401,
      },
    })
    const details = (caught as { details: { responseSnippet: string } }).details
    expect(details.responseSnippet).toContain('ForbiddenOperationException')
    expect(details.responseSnippet).toContain('[REDACTED]')
    expect(details.responseSnippet).not.toContain('should-never-appear')
    expect(logs.join('\n')).toContain(`${AUTHLIB_SERVER}/authserver/authenticate`)
    expect(logs.join('\n')).not.toContain('super-secret-password')
    expect(logs.join('\n')).not.toContain('should-never-appear')
  })

  it('returns Microsoft skin/cape and degrades to Steve when avatar fetch fails', async () => {
    const routes = successRoutes()
    const service = createService({ dataRoot: tempRoot(), http: fakeHttp(routes) }).service
    await service.configureMicrosoft({ clientId: 'client-id', tenant: 'tenant-id' })
    const device = await service.beginDeviceCode()
    const login = await service.pollDeviceCode(device.flowId)
    if (login.status !== 'ok') throw new Error('expected login')
    const profile = await service.profile(login.account.id)
    expect(profile).toMatchObject({
      kind: 'microsoft',
      name: 'TestUser',
      skinUrl: 'https://textures.example/skin.png',
      capeUrl: 'https://textures.example/cape.png',
      fallback: 'none',
    })
    expect(profile.uuid).toBe(login.account.uuid)

    routes[MC_PROFILE_URL] = { status: 500, body: {} }
    ;(service as unknown as { profileCache: { clear(): void } }).profileCache.clear()
    const degraded = await service.profile(login.account.id)
    expect(degraded.skinUrl).toBeNull()
    expect(degraded.fallback).toBe('steve')
    expect(degraded.error).toContain('500')
  })

  it('reads Authlib skin textures and uses offline fallback', async () => {
    const routes = successRoutes()
    const service = createService({ dataRoot: tempRoot(), http: fakeHttp(routes) }).service
    const account = await service.createAuthlib('SkinUser', AUTHLIB_SERVER)
    const textures = Buffer.from(
      JSON.stringify({
        textures: {
          SKIN: { url: 'https://skin.example/textures/skin.png' },
          CAPE: { url: 'https://skin.example/textures/cape.png' },
        },
      }),
    ).toString('base64')
    routes[
      `${AUTHLIB_SERVER}/sessionserver/session/minecraft/profile/${account.uuid.replaceAll('-', '')}?unsigned=false`
    ] = { body: { id: account.uuid.replaceAll('-', ''), properties: [{ name: 'textures', value: textures }] } }
    const profile = await service.profile(account.id)
    expect(profile).toMatchObject({
      kind: 'authlib',
      name: 'SkinUser',
      skinUrl: 'https://skin.example/textures/skin.png',
      capeUrl: 'https://skin.example/textures/cape.png',
      fallback: 'none',
    })
    const offline = await service.createOffline('OfflineUser')
    const offlineProfile = await service.profile(offline.id)
    expect(offlineProfile).toMatchObject({
      kind: 'offline',
      skinUrl: null,
      fallback: 'steve',
    })
  })

  it('reports session validity and reauthentication guidance after token loss', async () => {
    const service = createService({ dataRoot: tempRoot(), http: fakeHttp(successRoutes()) }).service
    await service.configureMicrosoft({ clientId: 'client-id', tenant: 'tenant-id' })
    const device = await service.beginDeviceCode()
    const login = await service.pollDeviceCode(device.flowId)
    if (login.status !== 'ok') throw new Error('expected login')
    expect(service.sessionStatus(login.account.id)).toMatchObject({
      hasSession: true,
      reauthRequired: false,
    })
    expect(service.reauth(login.account.id).required).toBe(false)
    expect((await service.refresh(login.account.id)).ok).toBe(true)

    ;(service as unknown as { sessions: { delete(id: string): void } }).sessions.delete(
      login.account.id,
    )
    const status = service.sessionStatus(login.account.id)
    expect(status.reauthRequired).toBe(true)
    expect(service.reauth(login.account.id)).toMatchObject({
      required: true,
      action: 'beginDeviceCode',
    })
    await expect(service.refresh(login.account.id)).rejects.toMatchObject({
      code: 'AUTH.INVALID_GRANT',
      details: { reauthRequired: true, action: 'beginDeviceCode' },
    })
    const offline = await service.createOffline('OtherUser')
    await expect(service.refresh(offline.id)).rejects.toMatchObject({
      code: 'AUTH.NOT_REFRESHABLE',
    })
  })

  it('keeps offline, Microsoft and Authlib accounts independent and switches cleanly', async () => {
    const service = createService({ dataRoot: tempRoot(), http: fakeHttp(successRoutes()) }).service
    const offline = await service.createOffline('OfflineOne')
    const authlib = await service.loginAuthlib('SkinUser', 'correct-password', AUTHLIB_SERVER)
    await service.configureMicrosoft({ clientId: 'client-id', tenant: 'tenant-id' })
    const device = await service.beginDeviceCode()
    const login = await service.pollDeviceCode(device.flowId)
    if (login.status !== 'ok') throw new Error('expected login')
    const accounts = (await service.list()).accounts
    expect(accounts.map((account) => account.kind).sort()).toEqual([
      'authlib',
      'microsoft',
      'offline',
    ])
    for (const account of [offline, authlib, login.account]) {
      await service.select(account.id)
      expect((await service.list()).selectedId).toBe(account.id)
      const launch = await service.getLaunchAccount(account.id)
      expect(launch).toMatchObject({
        kind: account.kind,
        name: account.name,
        uuid: account.uuid,
      })
    }
    expect(offline.kind).toBe('offline')
    expect(authlib.kind).toBe('authlib')
    expect(login.account.kind).toBe('microsoft')
  })
})

describe('Authlib Yggdrasil authentication and token lifecycle', () => {
  it('returns a CSP-safe avatar data URL and a Steve fallback on download failure', async () => {
    const image = Buffer.from('fake-png-bytes')
    const routes = successRoutes()
    const root = tempRoot()
    const service = createService({
      dataRoot: root,
      http: fakeHttp(routes),
      fetchImpl: async () => new Response(image, {
        status: 200,
        headers: { 'content-type': 'image/png' },
      }),
    }).service
    await service.configureMicrosoft({ clientId: 'client-id', tenant: 'tenant-id' })
    const device = await service.beginDeviceCode()
    const login = await service.pollDeviceCode(device.flowId)
    if (login.status !== 'ok') throw new Error('expected login')
    const profile = await service.profile(login.account.id)
    expect(profile.skinUrl).toBe('https://textures.example/skin.png')
    expect(profile.avatarDataUrl).toBe(
      `data:image/png;base64,${image.toString('base64')}`,
    )

    const offline = await service.createOffline('OfflineUser')
    const fallback = await service.profile(offline.id)
    expect(fallback.avatarDataUrl).toBeNull()
    expect(fallback.fallback).toBe('steve')
  })

  it('authenticates with username/password, stores encrypted tokens, and launches with the real profile', async () => {
    const root = tempRoot()
    const { service, logs } = createService({ dataRoot: root, http: fakeHttp(successRoutes()) })
    const account = await service.loginAuthlib('skin@example.com', 'correct-password', AUTHLIB_SERVER)
    expect(account).toMatchObject({
      kind: 'authlib',
      name: 'SkinUser',
      uuid: '11111111-1111-1111-1111-111111111111',
      authlibServer: AUTHLIB_SERVER,
      loginName: 'skin@example.com',
    })
    const launch = await service.getLaunchAccount(account.id)
    expect(launch).toMatchObject({
      kind: 'authlib',
      name: 'SkinUser',
      uuid: '11111111-1111-1111-1111-111111111111',
      accessToken: 'authlib-access-token',
      userType: 'legacy',
    })
    const sessionFile = path.join(root, 'modules', 'auth', 'sessions.bin')
    const raw = fs.readFileSync(sessionFile, 'utf8')
    expect(raw).not.toContain('correct-password')
    expect(raw).not.toContain('authlib-access-token')
    expect(logs.join('\n')).not.toContain('correct-password')
    expect(logs.join('\n')).not.toContain('authlib-access-token')
    expect(service.sessionStatus(account.id)).toMatchObject({
      kind: 'authlib',
      hasSession: true,
      reauthRequired: false,
    })
    expect(await service.validateAuthlibSession(account.id)).toMatchObject({ valid: true })
    const refreshed = await service.refresh(account.id)
    expect(refreshed.ok).toBe(true)
    expect((await service.getLaunchAccount(account.id))?.accessToken).toBe('authlib-access-token-2')
    expect(await service.signoutAuthlib(account.id)).toEqual({ ok: true })
    expect(service.sessionStatus(account.id).hasSession).toBe(false)
  })

  it('maps wrong password, unverified email and unreachable servers to stable codes', async () => {
    const wrong = successRoutes({
      [`${AUTHLIB_SERVER}/authserver/authenticate`]: {
        status: 403,
        body: { error: 'ForbiddenOperationException', errorMessage: 'Invalid credentials. Invalid username or password.' },
      },
    })
    const service = createService({ dataRoot: tempRoot(), http: fakeHttp(wrong) }).service
    await expect(service.loginAuthlib('SkinUser', 'bad', AUTHLIB_SERVER)).rejects.toMatchObject({
      code: 'AUTH.AUTHLIB_INVALID_CREDENTIALS',
    })

    const unverified = successRoutes({
      [`${AUTHLIB_SERVER}/authserver/authenticate`]: {
        status: 403,
        body: { error: 'ForbiddenOperationException', errorMessage: 'Please verify your email address.' },
      },
    })
    const service2 = createService({ dataRoot: tempRoot(), http: fakeHttp(unverified) }).service
    await expect(service2.loginAuthlib('SkinUser', 'pw', AUTHLIB_SERVER)).rejects.toMatchObject({
      code: 'AUTH.AUTHLIB_EMAIL_NOT_VERIFIED',
    })

    const down = successRoutes({
      [`${AUTHLIB_SERVER}/authserver/authenticate`]: { status: 503, body: {} },
    })
    const service3 = createService({ dataRoot: tempRoot(), http: fakeHttp(down) }).service
    await expect(service3.loginAuthlib('SkinUser', 'pw', AUTHLIB_SERVER)).rejects.toMatchObject({
      code: 'AUTH.AUTHLIB_SERVER_ERROR',
    })
  })

  it('refreshes only the selected authlib account and requires relogin when refresh/validate fail', async () => {
    const root = tempRoot()
    const routes = successRoutes()
    const service = createService({ dataRoot: root, http: fakeHttp(routes) }).service
    const first = await service.loginAuthlib('SkinUser', 'pw', AUTHLIB_SERVER)
    // A second account on another server must keep its own clientToken/session.
    const secondServer = 'https://skin2.example/api/yggdrasil'
    routes[secondServer] = {
      body: { meta: { serverName: 'Skin 2' }, skinDomains: ['skin2.example'] },
    }
    routes[`${secondServer}/authserver/authenticate`] = {
      body: {
        accessToken: 'second-access',
        clientToken: 'second-client',
        selectedProfile: { id: '22222222222222222222222222222222', name: 'SecondSkin' },
      },
    }
    routes[`${secondServer}/authserver/refresh`] = {
      body: {
        accessToken: 'second-access-2',
        clientToken: 'second-client',
        selectedProfile: { id: '22222222222222222222222222222222', name: 'SecondSkin' },
      },
    }
    routes[`${secondServer}/authserver/validate`] = { status: 204, body: {} }
    const second = await service.loginAuthlib('SecondSkin', 'pw', secondServer)
    await service.select(first.id)
    expect((await service.getLaunchAccount(first.id))?.accessToken).toBe('authlib-access-token')
    expect((await service.getLaunchAccount(second.id))?.accessToken).toBe('second-access')
    await service.refresh(second.id)
    expect((await service.getLaunchAccount(first.id))?.accessToken).toBe('authlib-access-token')
    expect((await service.getLaunchAccount(second.id))?.accessToken).toBe('second-access-2')

    routes[`${AUTHLIB_SERVER}/authserver/validate`] = { status: 403, body: {} }
    routes[`${AUTHLIB_SERVER}/authserver/refresh`] = { status: 403, body: {} }
    await expect(service.getLaunchAccount(first.id)).rejects.toMatchObject({
      code: 'AUTH.AUTHLIB_LOGIN_REQUIRED',
      details: { reauthRequired: true, action: 'loginAuthlib' },
    })
    expect(await service.validateAuthlibSession(first.id)).toMatchObject({ valid: false })
  })
})
