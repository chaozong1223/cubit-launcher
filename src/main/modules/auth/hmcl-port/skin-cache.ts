/*
 * Adapted from HMCL (Hello Minecraft! Launcher)
 * Copyright (C) 2021 huangyuhui <huanghongxun2008@126.com> and contributors
 *
 * Source: https://github.com/HMCL-dev/HMCL
 * Commit: e7b9a95df0acf79b9797dcef38463e2b22e37a6a
 * File: HMCLCore/src/main/java/org/jackhuang/hmcl/auth/microsoft/MicrosoftService.java
 *       (ObservableOptionalCache<UUID, CompleteGameProfile> usage)
 * GPL-3.0; see LICENSE. Modifications (t62): JavaFX ObservableOptionalCache and
 * thread pool replaced with a small TTL cache; profile data is a plain object.
 */
export interface CacheEntry<T> {
  value: T
  expiresAt: number
}

export class ProfileCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | null {
    const entry = this.entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key)
      return null
    }
    return entry.value
  }

  set(key: string, value: T): void {
    this.entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }

  delete(key: string): void {
    this.entries.delete(key)
  }

  clear(): void {
    this.entries.clear()
  }
}
