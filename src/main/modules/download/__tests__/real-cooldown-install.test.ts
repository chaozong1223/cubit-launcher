import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Logger } from '../../../kernel/logger'
import { HttpClient } from '../core/http'
import { createSourceRegistry } from '../core/sources'
import { DownloadService } from '../service'

/**
 * Opt-in fresh-root 1.20.1 install with a dead mirror (B1/t46):
 *   MCL_REAL_COOLDOWN_INSTALL=1 npm.cmd --prefix mc-launcher run test -- \
 *     src/main/modules/download/__tests__/real-cooldown-install.test.ts
 *
 * The mirror base points at a closed loopback port, so every mirror attempt
 * fails exactly like a CDN timeout. Per-source cooling must switch to Mojang
 * and finish all 3,641 files. No launcher window is involved, so this also
 * avoids the renderer crash seen in the packaged CDP e2e under load.
 */

const enabled = process.env.MCL_REAL_COOLDOWN_INSTALL === '1'
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-cooldown-data-'))
const mcRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcl-cooldown-mc-'))

afterAll(() => {
  fs.rmSync(dataRoot, { recursive: true, force: true })
  fs.rmSync(mcRoot, { recursive: true, force: true })
})

describe.skipIf(!enabled)('real fresh install with mirror outage (t46)', () => {
  it('cools the dead mirror, completes 1.20.1 from the official source', async () => {
    const log = new Logger({ dataRoot, console: false })
    const http = new HttpClient({
      userAgent: 'mc-launcher/0.1.0 (+https://example.test; test@example.test)',
      allowInsecureHosts: ['127.0.0.1'],
    })
    const sources = createSourceRegistry({
      preference: 'auto',
      mirrorEnabled: true,
      mirrorBase: 'http://127.0.0.1:9',
      allowInsecureHosts: ['127.0.0.1'],
    })
    const service = new DownloadService({
      roots: { dataRoot, mcRoot },
      log: log.child('module:download'),
      appVersion: '0.1.0',
      http,
      sources,
      freeSpace: async () => 50 * 1024 * 1024 * 1024,
    })
    try {
      const started = await service.install({ versionId: '1.20.1' })
      expect(started.plan.files).toBeGreaterThan(3000)
      const final = await service.waitForJob(started.jobId, 20 * 60_000)
      expect(final.state).toBe('done')
      expect(final.done).toBeGreaterThan(3000)
      expect(fs.existsSync(path.join(mcRoot, 'versions', '1.20.1', '1.20.1.jar'))).toBe(true)
      const logText = fs.readFileSync(path.join(dataRoot, 'logs', 'launcher.log'), 'utf8')
      expect(logText).toContain('source":"official"')
      expect(logText).toContain('127.0.0.1:9')
    } finally {
      service.dispose()
    }
  }, 20 * 60_000)
})
