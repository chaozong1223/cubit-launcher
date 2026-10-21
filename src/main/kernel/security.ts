import { app, protocol, session, type BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { isInside } from './paths'

export const APP_SCHEME = 'app'
export const APP_HOST = 'mc-launcher'
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/index.html`

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
}

/** Must run before app.whenReady(). */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ])
}

export interface TrustedUrlOptions {
  isPackaged?: boolean
  /** Dev renderer URL; only this exact origin is trusted in development. */
  devUrl?: string | null
}

export function isTrustedUrl(rawUrl: string, options: TrustedUrlOptions = {}): boolean {
  try {
    const url = new URL(rawUrl)
    if (url.protocol === `${APP_SCHEME}:`) return url.host === APP_HOST
    const packaged = options.isPackaged ?? app.isPackaged
    if (packaged) return false
    const devUrl =
      options.devUrl === undefined ? process.env.ELECTRON_RENDERER_URL : options.devUrl
    if (!devUrl) return false
    const dev = new URL(devUrl)
    return (
      (dev.protocol === 'http:' || dev.protocol === 'https:') &&
      url.protocol === dev.protocol &&
      url.origin === dev.origin
    )
  } catch {
    return false
  }
}

/**
 * Serves the built renderer from a custom, read-only protocol. Using a
 * standard scheme gives the renderer a stable origin (`app://mc-launcher`) for
 * CSP and sender validation, instead of a file:// origin.
 */
export function installAppProtocol(rendererRoot: string): void {
  const root = path.resolve(rendererRoot)
  protocol.handle(APP_SCHEME, async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host !== APP_HOST) return new Response('Not found', { status: 404 })

      let pathname = decodeURIComponent(url.pathname)
      if (pathname === '' || pathname === '/') pathname = '/index.html'
      const filePath = path.resolve(root, `.${pathname}`)
      if (!isInside(root, filePath)) return new Response('Forbidden', { status: 403 })

      const data = await fs.promises.readFile(filePath)
      const extension = path.extname(filePath).toLowerCase()
      const mime = MIME[extension] ?? 'application/octet-stream'
      const headers: Record<string, string> = {
        'content-type': mime,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      }
      if (extension === '.html') {
        // Production CSP is a response header (meta CSP would also constrain
        // the Vite dev server and block React refresh's dev preamble).
        headers['content-security-policy'] =
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      }
      return new Response(data, { status: 200, headers })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

export function loadRenderer(win: BrowserWindow): Promise<void> {
  const devUrl = process.env.ELECTRON_RENDERER_URL
  return win.loadURL(devUrl && devUrl.length > 0 ? devUrl : APP_URL)
}

/** Hardens a window against navigation, popups and webview embedding. */
export function applyWindowSecurity(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (!isTrustedUrl(url)) event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => {
    event.preventDefault()
  })
}

/** App-wide permission policy: deny by default, clipboard comes later if needed. */
export function applySessionSecurity(): void {
  const defaultSession = session.defaultSession
  defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  defaultSession.setPermissionCheckHandler(() => false)
}

export function appVersionSafe(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}
