import type { AppInfo } from '@shared/system'

export interface RendererState {
  loading: boolean
  error: string | null
  info: AppInfo | null
  version: string | null
  nodeRequire: boolean
  nodeProcess: boolean
  blockedChannelRejected: boolean | null
}

export type { AppInfo }
