import { z } from 'zod'
import { defineContract } from './kernel'

export const AccountKind = z.enum(['offline', 'microsoft', 'authlib'])
export type AccountKind = z.infer<typeof AccountKind>

export const AccountSchema = z.object({
  id: z.string(),
  kind: AccountKind,
  name: z.string(),
  uuid: z.string(),
  authlibServer: z.string().url().nullable(),
  createdAt: z.number().int(),
})
export type Account = z.infer<typeof AccountSchema>

export const DeviceCodeSchema = z.object({
  flowId: z.string(),
  userCode: z.string(),
  verificationUri: z.string(),
  /** Provider-supplied human message (Chinese where available). */
  message: z.string().nullable(),
  expiresIn: z.number().int().positive(),
  interval: z.number().int().positive(),
})
export type DeviceCode = z.infer<typeof DeviceCodeSchema>

export const AuthErrorShapeSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
})
export type AuthErrorShape = z.infer<typeof AuthErrorShapeSchema>

export const PollDeviceCodeResultSchema = z.union([
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('ok'), account: AccountSchema }),
  z.object({ status: z.literal('failed'), error: AuthErrorShapeSchema }),
])
export type PollDeviceCodeResult = z.infer<typeof PollDeviceCodeResultSchema>

export const MicrosoftConfigSchema = z.object({
  configured: z.boolean(),
  /** Masked for display; the raw id is only in the module config/env. */
  clientId: z.string().nullable(),
  tenant: z.string(),
})
export type MicrosoftConfig = z.infer<typeof MicrosoftConfigSchema>

export const AuthlibInfoSchema = z.object({
  version: z.string(),
  sha256: z.string(),
  jarPath: z.string(),
  downloaded: z.boolean(),
  /** Optional skin site bound to the selected authlib account. */
  server: z.string().nullable(),
})
export type AuthlibInfo = z.infer<typeof AuthlibInfoSchema>

export const contract = defineContract({
  id: 'auth',
  methods: {
    list: {
      input: z.void(),
      output: z.object({
        accounts: z.array(AccountSchema),
        selectedId: z.string().nullable(),
      }),
    },
    createOffline: {
      input: z.object({ name: z.string().regex(/^[A-Za-z0-9_]{3,16}$/) }),
      output: AccountSchema,
    },
    createAuthlib: {
      input: z.object({
        name: z.string().regex(/^[A-Za-z0-9_]{3,16}$/),
        server: z.string().url(),
      }),
      output: AccountSchema,
    },
    select: {
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    beginDeviceCode: {
      input: z.void(),
      output: DeviceCodeSchema,
    },
    pollDeviceCode: {
      input: z.object({ flowId: z.string() }),
      output: PollDeviceCodeResultSchema,
    },
    logout: {
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    setAuthlib: {
      input: z.object({ id: z.string(), server: z.string().url() }),
      output: AccountSchema,
    },
    /** P0-7: client id / tenant are injected via module config or env. */
    configureMicrosoft: {
      input: z.object({
        clientId: z.string().nullable().optional(),
        tenant: z.string().min(1).optional(),
      }),
      output: MicrosoftConfigSchema,
    },
    getMicrosoftConfig: {
      input: z.void(),
      output: MicrosoftConfigSchema,
    },
    authlibInfo: {
      input: z.void(),
      output: AuthlibInfoSchema,
    },
    ensureAuthlib: {
      input: z.void(),
      output: AuthlibInfoSchema,
    },
  },
  events: {
    changed: {
      payload: z.object({ selectedId: z.string().nullable() }),
    },
  },
})

export const authContract = contract

/** Structural service surface used by the launch bridge and tests. */
export interface AuthService {
  list(): Promise<{
    accounts: z.infer<typeof AccountSchema>[]
    selectedId: string | null
  }>
  createOffline(name: string): Promise<z.infer<typeof AccountSchema>>
  createAuthlib(name: string, server: string): Promise<z.infer<typeof AccountSchema>>
  select(id: string): Promise<{ ok: boolean }>
  beginDeviceCode(): Promise<z.infer<typeof DeviceCodeSchema>>
  pollDeviceCode(flowId: string): Promise<PollDeviceCodeResult>
  logout(id: string): Promise<{ ok: boolean }>
  setAuthlib(id: string, server: string): Promise<z.infer<typeof AccountSchema>>
  configureMicrosoft(input: {
    clientId?: string | null
    tenant?: string
  }): Promise<MicrosoftConfig>
  getMicrosoftConfig(): MicrosoftConfig
  authlibInfo(): AuthlibInfo
  ensureAuthlib(): Promise<AuthlibInfo>
}
