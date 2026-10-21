import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'

const root = process.cwd()
const shared = resolve(root, 'src/shared')
const main = resolve(root, 'src/main')
const renderer = resolve(root, 'src/renderer')

export default defineConfig({
  main: {
    resolve: {
      alias: {
        '@shared': shared,
        '@main': main,
      },
    },
    build: {
      outDir: resolve(root, 'out/main'),
      rollupOptions: {
        input: resolve(main, 'index.ts'),
        external: ['electron'],
      },
    },
  },
  preload: {
    resolve: {
      alias: {
        '@shared': shared,
      },
    },
    build: {
      outDir: resolve(root, 'out/preload'),
      rollupOptions: {
        input: resolve(root, 'src/preload/index.ts'),
        external: ['electron'],
      },
    },
  },
  renderer: {
    root: renderer,
    base: './',
    resolve: {
      alias: {
        '@shared': shared,
        '@renderer': renderer,
      },
    },
    plugins: [react()],
    build: {
      outDir: resolve(root, 'out/renderer'),
      emptyOutDir: true,
    },
  },
})
