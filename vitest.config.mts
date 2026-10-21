import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const root = dirname(fileURLToPath(import.meta.url))

/**
 * Unit tests import the same aliases the electron-vite build uses. Keeping the
 * aliases here means a test can exercise a module exactly as it is bundled.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(root, 'src/shared'),
      '@main': resolve(root, 'src/main'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Windows + child-process tests need a little more headroom than the default.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // `forks` keeps native handles (spawned java/node stand-ins, file watchers)
    // isolated per test file instead of sharing a worker thread.
    pool: 'forks',
  },
})
