/*
 * Ported from HMCL (Hello Minecraft! Launcher)
 * Copyright (C) 2021 huangyuhui <huanghongxun2008@126.com> and contributors
 *
 * Source: https://github.com/HMCL-dev/HMCL
 * Commit: e7b9a95df0acf79b9797dcef38463e2b22e37a6a
 * Files: HMCLCore/src/main/java/org/jackhuang/hmcl/auth/OAuth.java
 *        HMCL/src/main/java/org/jackhuang/hmcl/game/OAuthServer.java
 *
 * This program is free software: you can redistribute it and/or modify it under
 * the terms of the GNU General Public License as published by the Free Software
 * Foundation, version 3 (GPL-3.0). See LICENSE.
 *
 * TS port modifications (t62):
 *  - Java CompletableFuture/NanoHTTPD replaced by a Node http server and a
 *    result holder; JavaFX events/browser UI are injected via openExternal().
 *  - The HMCL application client_id is never used; the caller supplies our
 *    configurable client_id. Microsoft Entra endpoints are used for our app.
 *  - PKCE/state generation and callback parsing preserve HMCL behaviour.
 */
import crypto from 'node:crypto'
import http from 'node:http'

export const HMCL_OAUTH_ENDPOINTS = {
  /** Device code is the same Microsoft Entra endpoint HMCL uses. */
  deviceCode: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/devicecode',
  token: 'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
} as const

/** HMCL uses this scope for the Microsoft/Xbox chain. */
export const HMCL_MICROSOFT_SCOPE = 'XboxLive.signin offline_access'

/**
 * Registered redirect port, overridable for tests via MCL_AUTH_CALLBACK_PORTS
 * (comma separated, "0" means "any free port" - only valid when the caller does
 * not need Azure to accept the redirect URI).
 */
export function defaultCallbackPorts(env: NodeJS.ProcessEnv = process.env): number[] {
  const raw = env.MCL_AUTH_CALLBACK_PORTS?.trim()
  if (!raw) return [53117]
  const parsed = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((port) => Number.isInteger(port) && port >= 0 && port <= 65535)
  return parsed.length > 0 ? parsed : [53117]
}

export function base64Url(bytes: Buffer): string {
  return bytes.toString('base64').replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export interface PkcePair {
  verifier: string
  challenge: string
  state: string
}

/** RFC 7636 S256 challenge, same construction as HMCL OAuth. */
export function createPkce(random: (size: number) => Buffer = crypto.randomBytes): PkcePair {
  const verifier = base64Url(random(64))
  const state = base64Url(random(32))
  const challenge = base64Url(crypto.createHash('sha256').update(verifier, 'ascii').digest())
  return { verifier, challenge, state }
}

export interface AuthorizationUrlInput {
  clientId: string
  redirectUri: string
  state: string
  challenge: string
  scope?: string
  tenant?: string
}

/** Mirrors HMCL's authorization-code request parameters (PKCE + state). */
export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const tenant = input.tenant?.trim() || 'consumers'
  const endpoint = `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`
  const url = new URL(endpoint)
  url.searchParams.set('client_id', input.clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', input.redirectUri)
  url.searchParams.set('scope', input.scope ?? HMCL_MICROSOFT_SCOPE)
  url.searchParams.set('prompt', 'select_account')
  url.searchParams.set('code_challenge', input.challenge)
  url.searchParams.set('state', input.state)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

export type LoopbackResult =
  | { status: 'pending' }
  | { status: 'ok'; code: string; idToken: string | null }
  | { status: 'failed'; code: string; message: string }

export class LoopbackOAuthServer {
  private readonly server: http.Server
  private result: LoopbackResult = { status: 'pending' }
  private readonly waiters = new Set<(result: LoopbackResult) => void>()
  private closed = false

  private constructor(
    public port: number,
    readonly pkce: PkcePair,
  ) {
    this.server = http.createServer((request, response) => this.handle(request, response))
  }

  static async start(
    // 53117 is the redirect URI registered in our Entra app as
    // `http://localhost:53117/`. Azure validates the port, so we cannot use a
    // random one: a free port here would still be rejected at authorize time.
    // Tests override it with MCL_AUTH_CALLBACK_PORTS (e.g. "0") because the real
    // launcher may already hold 53117 on the developer machine.
    preferredPorts: number[] = defaultCallbackPorts(),
    pkce: PkcePair = createPkce(),
  ): Promise<LoopbackOAuthServer> {
    let lastError: unknown = null
    for (const port of preferredPorts) {
      const session = new LoopbackOAuthServer(port, pkce)
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (error: unknown): void => {
            session.server.off('listening', onListening)
            reject(error)
          }
          const onListening = (): void => {
            session.server.off('error', onError)
            resolve()
          }
          session.server.once('error', onError)
          session.server.once('listening', onListening)
          session.server.listen(port, '127.0.0.1')
        })
        if (session.port === 0) {
          const address = session.server.address()
          if (address && typeof address === 'object') session.port = address.port
        }
        return session
      } catch (error) {
        lastError = error
        try {
          session.server.close()
        } catch {
          // try the next HMCL fallback port
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error('no OAuth callback port available')
  }

  get redirectUri(): string {
    // Must match the registered redirect URI exactly, including the trailing
    // slash and the absence of a path segment.
    return `http://localhost:${this.port}/`
  }

  private complete(result: LoopbackResult): void {
    if (this.result.status !== 'pending') return
    this.result = result
    for (const waiter of this.waiters) waiter(result)
    this.waiters.clear()
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    // The registered redirect URI is the site root, so the authorization code
    // arrives at `/` (query params included). Ignore favicon and other probes.
    const path = request.url?.split('?')[0] ?? '/'
    if (path !== '/' && path !== '/auth-response') {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    if (!request.url?.includes('code=') && !request.url?.includes('error=')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    const url = new URL(request.url ?? '/', `http://localhost:${this.port}`)
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const idToken = url.searchParams.get('id_token')
    if (code && state === this.pkce.state) {
      this.complete({ status: 'ok', code, idToken })
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      response.end(
        '<!doctype html><meta charset="utf-8"><title>登录完成</title><p>登录完成，可以关闭此页面。</p>',
      )
      return
    }
    this.complete({
      status: 'failed',
      code: code ? 'AUTH.OAUTH_STATE_MISMATCH' : 'AUTH.OAUTH_CALLBACK_INVALID',
      message: code ? 'OAuth state 不匹配，请重新登录' : '回调缺少授权码',
    })
    response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><meta charset="utf-8"><p>登录失败，请回到启动器重试。</p>')
  }

  poll(): LoopbackResult {
    return this.result
  }

  wait(timeoutMs = 0): Promise<LoopbackResult> {
    if (this.result.status !== 'pending') return Promise.resolve(this.result)
    if (timeoutMs <= 0) return Promise.resolve({ status: 'pending' })
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(waiter)
        resolve({ status: 'pending' })
      }, timeoutMs)
      const waiter = (result: LoopbackResult): void => {
        clearTimeout(timer)
        resolve(result)
      }
      this.waiters.add(waiter)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.complete({
      status: 'failed',
      code: 'AUTH.OAUTH_CANCELLED',
      message: '登录已取消',
    })
    try {
      this.server.close()
    } catch {
      // already closed
    }
  }
}
