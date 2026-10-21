import { createHash, type Hash } from 'node:crypto'
import { createReadStream } from 'node:fs'

/**
 * Hash helpers (SEC-DL-01 / SEC-DL-03).
 *
 * The strongest available upstream hash wins: sha512 → sha256 → sha1. That is
 * what Modrinth requires (API-03) and what makes a resumed download safe: after
 * a Range continuation the *whole* file is hashed again, never just the tail.
 */
export type HashAlgorithm = 'sha1' | 'sha256' | 'sha512'

export interface HashExpectation {
  sha1?: string | null
  sha256?: string | null
  sha512?: string | null
}

export interface ResolvedHash {
  algorithm: HashAlgorithm
  expected: string
}

export interface HasherSet {
  algorithms: HashAlgorithm[]
  update(chunk: Buffer | Uint8Array): void
  digest(): Partial<Record<HashAlgorithm, string>>
}

const ALGORITHMS: HashAlgorithm[] = ['sha1', 'sha256', 'sha512']

export function normalizeHash(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().toLowerCase()
  if (!/^[a-f0-9]{40}$|^[a-f0-9]{64}$|^[a-f0-9]{128}$/.test(trimmed)) return null
  return trimmed
}

/** Strongest available expectation; `null` means "no trusted hash" (SEC-DL-04). */
export function resolveExpectedHash(hashes: HashExpectation): ResolvedHash | null {
  const sha512 = normalizeHash(hashes.sha512)
  if (sha512) return { algorithm: 'sha512', expected: sha512 }
  const sha256 = normalizeHash(hashes.sha256)
  if (sha256) return { algorithm: 'sha256', expected: sha256 }
  const sha1 = normalizeHash(hashes.sha1)
  if (sha1) return { algorithm: 'sha1', expected: sha1 }
  return null
}

export function algorithmsFor(hash: ResolvedHash | null): HashAlgorithm[] {
  return hash ? [hash.algorithm] : []
}

export function createHasherSet(algorithms: HashAlgorithm[]): HasherSet {
  const unique = ALGORITHMS.filter((algorithm) => algorithms.includes(algorithm))
  const hashers = new Map<HashAlgorithm, Hash>()
  for (const algorithm of unique) hashers.set(algorithm, createHash(algorithm))

  return {
    algorithms: unique,
    update(chunk) {
      for (const hasher of hashers.values()) hasher.update(chunk)
    },
    digest() {
      const out: Partial<Record<HashAlgorithm, string>> = {}
      for (const [algorithm, hasher] of hashers) out[algorithm] = hasher.digest('hex')
      return out
    },
  }
}

export function hashBuffer(buffer: Buffer, algorithms: HashAlgorithm[]): Partial<Record<HashAlgorithm, string>> {
  const set = createHasherSet(algorithms)
  set.update(buffer)
  return set.digest()
}

export interface HashFileOptions {
  /** Stop after this many bytes (used to hash the already-downloaded prefix). */
  limit?: number
  signal?: AbortSignal
}

export async function hashFile(
  file: string,
  algorithms: HashAlgorithm[],
  options: HashFileOptions = {},
): Promise<Partial<Record<HashAlgorithm, string>>> {
  const set = createHasherSet(algorithms)
  if (algorithms.length === 0) return {}

  let remaining = options.limit ?? Number.POSITIVE_INFINITY
  if (remaining <= 0) return set.digest()

  const stream = createReadStream(file, {
    highWaterMark: 1024 * 1024,
  })

  try {
    for await (const chunk of stream) {
      if (options.signal?.aborted) throw new Error('hash aborted')
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      if (buffer.length <= remaining) {
        set.update(buffer)
        remaining -= buffer.length
        if (remaining === 0) break
      } else {
        set.update(buffer.subarray(0, remaining))
        remaining = 0
        break
      }
    }
  } finally {
    stream.destroy()
  }

  return set.digest()
}

export interface HashCheck {
  ok: boolean
  algorithm: HashAlgorithm | null
  expected: string | null
  actual: string | null
}

export function checkDigest(
  expected: ResolvedHash | null,
  actual: Partial<Record<HashAlgorithm, string>>,
): HashCheck {
  if (!expected) return { ok: true, algorithm: null, expected: null, actual: null }
  const value = actual[expected.algorithm] ?? null
  return {
    ok: value !== null && value === expected.expected,
    algorithm: expected.algorithm,
    expected: expected.expected,
    actual: value,
  }
}
