/*
 * Ported from HMCL (Hello Minecraft! Launcher)
 * Copyright (C) 2021 huangyuhui <huanghongxun2008@126.com> and contributors
 *
 * Source: https://github.com/HMCL-dev/HMCL
 * Commit: e7b9a95df0acf79b9797dcef38463e2b22e37a6a
 * Files: HMCLCore/src/main/java/org/jackhuang/hmcl/auth/microsoft/MicrosoftService.java
 *        HMCLCore/src/main/java/org/jackhuang/hmcl/auth/yggdrasil/Texture.java
 *
 * GPL-3.0; see LICENSE. TS port modifications (t62):
 *  - Gson models replaced by structural JSON parsing.
 *  - ObservableOptionalCache/Java thread pools removed; callers keep the
 *    behaviour with their own async cache.
 *  - HMCL's skin list handling is preserved (first skin/cape URL wins).
 */
import type { Texture } from './yggdrasil'

export interface XboxProfile {
  id: string
  name: string
  skinUrl: string | null
  capeUrl: string | null
}

export function parseMinecraftProfileTextures(body: unknown): XboxProfile | null {
  if (!body || typeof body !== 'object') return null
  const record = body as {
    id?: unknown
    name?: unknown
    skins?: Array<{ url?: unknown }>
    capes?: Array<{ url?: unknown }>
  }
  if (typeof record.id !== 'string' || typeof record.name !== 'string') return null
  const textureUrl = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    try {
      const url = new URL(value)
      return url.protocol === 'https:' ? url.toString() : null
    } catch {
      return null
    }
  }
  return {
    id: record.id,
    name: record.name,
    skinUrl: textureUrl(record.skins?.[0]?.url),
    capeUrl: textureUrl(record.capes?.[0]?.url),
  }
}

/** HMCL Texture record, reduced to the fields the launcher displays. */
export function toTexture(url: string | null, model: string | null = null): Texture | null {
  return url ? { url, model } : null
}
