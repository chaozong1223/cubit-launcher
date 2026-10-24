import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const JOURNAL = 'E:/MC/.minecraft/versions/1.20.1/1.20.1.json'

function pickLargeArtifact(): { url: string; sha1: string; size: number } | null {
  if (!fs.existsSync(JOURNAL)) return null
  const json = JSON.parse(fs.readFileSync(JOURNAL, 'utf8')) as {
    libraries?: Array<{ downloads?: { artifact?: { url?: string; sha1?: string; size?: number } } }>
  }
  for (const lib of json.libraries ?? []) {
    const artifact = lib.downloads?.artifact
    if (!artifact?.url || !artifact.sha1 || !artifact.size) continue
    if (artifact.size > 4 * 1024 * 1024 && artifact.url.startsWith('https://')) {
      return { url: artifact.url, sha1: artifact.sha1, size: artifact.size }
    }
  }
  return null
}

async function rangeProbe(url: string): Promise<{ ok: boolean; total: number }> {
  const res = await fetch(url, { headers: { range: 'bytes=0-1023' } })
  const contentRange = res.headers.get('content-range') ?? ''
  await res.arrayBuffer()
  const match = /^bytes 0-1023\/(\d+)$/.exec(contentRange)
  return { ok: res.status === 206 && Boolean(match), total: match ? Number(match[1]) : 0 }
}

describe('parallel range downloads', () => {
  // Network-dependent: opt in with MCL_NETWORK_TESTS=1 so a flaky CDN never
  // reddens the default suite.
  const networkTest = process.env.MCL_NETWORK_TESTS === '1' ? it : it.skip
  networkTest('the Mojang CDN honours byte ranges for large artifacts', async () => {
    const artifact = pickLargeArtifact()
    if (!artifact) {
      console.log('SKIP: no local journal with a large artifact')
      return
    }
    const probe = await rangeProbe(artifact.url)
    console.log(
      JSON.stringify({ url: artifact.url.split('/').slice(-2).join('/'), size: artifact.size, probe }),
    )
    expect(probe.ok).toBe(true)
  }, 60_000)
})
