/*
 * Ported from HMCL (Hello Minecraft! Launcher)
 * Copyright (C) 2020 huangyuhui <huanghongxun2008@126.com> and contributors
 *
 * Source: https://github.com/HMCL-dev/HMCL
 * Commit: e7b9a95df0acf79b9797dcef38463e2b22e37a6a
 * Files: HMCLCore/src/main/java/org/jackhuang/hmcl/auth/authlibinjector/AuthlibInjectorServer.java
 *        HMCLCore/src/main/java/org/jackhuang/hmcl/auth/yggdrasil/YggdrasilService.java
 *        HMCLCore/src/main/java/org/jackhuang/hmcl/auth/yggdrasil/Texture.java
 *
 * GPL-3.0; see LICENSE. TS port modifications (t62):
 *  - JsonObject/Gson replaced by structural parsing.
 *  - Metadata is fetched by the caller through HttpPort; this module only
 *    parses/validates the same meta/links/feature.non_email_login fields.
 *  - Texture base64/JSON decoding keeps HMCL's "textures" property contract.
 */

export interface Texture {
  url: string
  model: string | null
}

export interface AuthlibMetadata {
  serverName: string | null
  links: Record<string, string>
  nonEmailLogin: boolean
  skinDomains: string[]
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

/** HMCL AuthlibInjectorServer.setMetadataResponse semantics. */
export function parseAuthlibServerMetadata(text: string): AuthlibMetadata | null {
  let response: unknown
  try {
    response = JSON.parse(text)
  } catch {
    return null
  }
  const root = asObject(response)
  if (!root) return null
  const meta = asObject(root.meta)
  const serverName =
    meta && typeof meta.serverName === 'string' ? meta.serverName : null
  const links: Record<string, string> = {}
  const linksObject = meta ? asObject(meta.links) : null
  if (linksObject) {
    for (const [key, value] of Object.entries(linksObject)) {
      if (typeof value === 'string') links[key] = value
    }
  }
  const nonEmailLoginRaw = meta?.['feature.non_email_login']
  const nonEmailLogin = nonEmailLoginRaw === true || nonEmailLoginRaw === 'true'
  const skinDomains = Array.isArray(root.skinDomains)
    ? root.skinDomains.filter((item): item is string => typeof item === 'string')
    : []
  // HMCL accepts metadata with a meta object even if optional fields are absent.
  if (!meta && skinDomains.length === 0) return null
  return { serverName, links, nonEmailLogin, skinDomains }
}

/** HMCL YggdrasilService.getTextures: base64 textures property -> SKIN/CAPE. */
export function parseTexturesProperty(value: string): {
  skin: Texture | null
  cape: Texture | null
} {
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as {
      textures?: Record<string, { url?: unknown; metadata?: { model?: unknown } }>
    }
    const parse = (texture: { url?: unknown; metadata?: { model?: unknown } } | undefined): Texture | null => {
      if (!texture || typeof texture.url !== 'string') return null
      try {
        const url = new URL(texture.url)
        if (url.protocol !== 'https:') return null
        const model = typeof texture.metadata?.model === 'string' ? texture.metadata.model : null
        return { url: url.toString(), model }
      } catch {
        return null
      }
    }
    return {
      skin: parse(decoded.textures?.SKIN),
      cape: parse(decoded.textures?.CAPE),
    }
  } catch {
    return { skin: null, cape: null }
  }
}
