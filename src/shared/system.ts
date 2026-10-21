import { z } from 'zod'
import { defineContract } from './kernel'

export const AppInfoSchema = z.object({
  version: z.string(),
  name: z.string(),
  electron: z.string(),
  chrome: z.string(),
  node: z.string(),
  platform: z.string(),
  arch: z.string(),
  dataRoot: z.string(),
  mcRoot: z.string().nullable(),
  portable: z.boolean(),
  configFile: z.string(),
  logFile: z.string(),
  modules: z.array(z.string()),
  failedModules: z.array(z.string()),
  security: z.object({
    contextIsolation: z.boolean(),
    nodeIntegration: z.boolean(),
    sandbox: z.boolean(),
  }),
})

export type AppInfo = z.infer<typeof AppInfoSchema>

export const RendererReadySchema = z.object({
  version: z.string(),
  errors: z.array(z.string()),
  nodeRequire: z.boolean(),
  nodeProcess: z.boolean(),
  blockedChannelRejected: z.boolean(),
  href: z.string(),
})

export const systemContract = defineContract({
  id: 'system',
  methods: {
    info: {
      input: z.void(),
      output: AppInfoSchema,
    },
    openDataDir: {
      input: z.void(),
      output: z.object({ opened: z.boolean() }),
    },
  },
  events: {},
})
