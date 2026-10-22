import { AppError } from '@shared/errors'

/**
 * Parses a pasted Modrinth/CurseForge modpack URL.
 *
 * Supported shapes (docs/01 §P1 链接触达):
 *   https://modrinth.com/modpack/<slug>[/version/<id>]
 *   https://modrinth.com/modpacks/<slug>[/version/<id>]  (legacy path)
 *   https://www.curseforge.com/minecraft/modpacks/<slug>[/files/<id>]
 *   https://minecraft.curseforge.com/projects/<slug>[/files/<id>]  (legacy)
 *
 * Extensions/query strings are ignored. Other curveforge project classes
 * (mods/resource packs) are rejected with a readable error.
 */

export type PackLinkProvider = 'modrinth' | 'curseforge'

export interface ParsedPackLink {
  provider: PackLinkProvider
  slug: string
  /** Modrinth version id or CurseForge file id, when the URL pins one. */
  versionId: string | null
  fileId: number | null
  pageUrl: string
  legacy: boolean
}

const MODRINTH_HOSTS = new Set(['modrinth.com', 'www.modrinth.com'])
const CURSEFORGE_HOSTS = new Set([
  'curseforge.com',
  'www.curseforge.com',
  'minecraft.curseforge.com',
  'legacy.curseforge.com',
])
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i

function invalid(message: string, details?: Record<string, unknown>): never {
  throw new AppError('CATALOG.LINK_INVALID', message, { details })
}

function unsupported(message: string, details?: Record<string, unknown>): never {
  throw new AppError('CATALOG.LINK_UNSUPPORTED', message, { details })
}

function parseSlug(value: string | undefined): string {
  if (!value) invalid('链接缺少整合包标识')
  const decoded = decodeURIComponent(value)
  if (!SLUG.test(decoded)) invalid('整合包标识格式不正确', { slug: decoded })
  return decoded
}

export function parsePackLink(input: string): ParsedPackLink {
  const raw = input.trim()
  if (!raw) invalid('请输入 Modrinth 或 CurseForge 整合包链接')
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    invalid('链接格式不正确')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    invalid('只支持 http/https 链接')
  }
  const host = url.hostname.toLowerCase()
  const segments = url.pathname
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment))

  if (MODRINTH_HOSTS.has(host)) {
    // /modpack/<slug> (canonical) or /modpacks/<slug> (legacy path).
    if (segments[0] !== 'modpack' && segments[0] !== 'modpacks') {
      unsupported('这不是 Modrinth 整合包链接（需要 /modpack/<slug>）', { path: url.pathname })
    }
    const slug = parseSlug(segments[1])
    let versionId: string | null = null
    if (segments.length >= 4) {
      if (segments[2] !== 'version') {
        unsupported('Modrinth 链接只支持 /modpack/<slug>/version/<id> 形式', {
          path: url.pathname,
        })
      }
      versionId = parseSlug(segments[3])
    } else if (segments.length > 2) {
      unsupported('Modrinth 链接格式不正确', { path: url.pathname })
    }
    return {
      provider: 'modrinth',
      slug,
      versionId,
      fileId: null,
      pageUrl: `https://modrinth.com/modpack/${encodeURIComponent(slug)}`,
      legacy: segments[0] === 'modpacks',
    }
  }

  if (CURSEFORGE_HOSTS.has(host)) {
    let slug: string | null = null
    let fileId: number | null = null
    let legacy = false
    if (host === 'minecraft.curseforge.com' && segments[0] === 'projects') {
      // Legacy project URL: /projects/<slug>[/files/<id>]
      legacy = true
      slug = parseSlug(segments[1])
      if (segments.length >= 4) {
        if (segments[2] !== 'files') unsupported('CurseForge 旧链接格式不正确', { path: url.pathname })
        fileId = Number(segments[3])
      } else if (segments.length > 2) {
        unsupported('CurseForge 旧链接格式不正确', { path: url.pathname })
      }
    } else if (segments[0] === 'minecraft' && segments[1] === 'modpacks') {
      legacy = host === 'legacy.curseforge.com'
      slug = parseSlug(segments[2])
      if (segments.length >= 5) {
        if (segments[3] !== 'files') unsupported('CurseForge 链接格式不正确', { path: url.pathname })
        fileId = Number(segments[4])
      } else if (segments.length > 3) {
        unsupported('CurseForge 链接格式不正确', { path: url.pathname })
      }
    } else {
      unsupported('这不是 CurseForge 整合包链接（需要 /minecraft/modpacks/<slug>）', {
        path: url.pathname,
      })
    }
    if (fileId !== null && (!Number.isInteger(fileId) || fileId <= 0)) {
      invalid('CurseForge 文件 id 不合法')
    }
    const pageSlug = slug as string
    return {
      provider: 'curseforge',
      slug: pageSlug,
      versionId: null,
      fileId,
      pageUrl: `https://www.curseforge.com/minecraft/modpacks/${encodeURIComponent(pageSlug)}`,
      legacy,
    }
  }

  unsupported('只支持 modrinth.com 或 curseforge.com 的整合包链接', { host })
}
