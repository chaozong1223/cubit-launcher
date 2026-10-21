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
  /** Non-secret Yggdrasil login name (may be an email) for relogin prefill. */
  loginName: z.string().nullable().optional(),
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

export const AuthlibPresetSchema = z.object({
  id: z.string(),
  name: z.string(),
  server: z.string().url(),
  homepage: z.string().url().nullable(),
})
export type AuthlibPreset = z.infer<typeof AuthlibPresetSchema>

export const AuthlibValidationSchema = z.object({
  ok: z.boolean(),
  server: z.string(),
  canonicalServer: z.string().url().nullable(),
  serverName: z.string().nullable(),
  skinDomains: z.array(z.string()),
  reason: z.string().nullable(),
  category: z
    .enum(['unreachable', 'not-authlib', 'server-error', 'invalid-url'])
    .nullable(),
  attemptedUrl: z.string().nullable(),
  attemptedUrls: z.array(z.string()),
  statusCode: z.number().int().nullable(),
  responseSnippet: z.string().nullable(),
  checkedAt: z.number().int(),
})
export type AuthlibValidation = z.infer<typeof AuthlibValidationSchema>

export const AuthProfileSchema = z.object({
  accountId: z.string(),
  kind: AccountKind,
  name: z.string(),
  uuid: z.string(),
  skinUrl: z.string().url().nullable(),
  capeUrl: z.string().url().nullable(),
  /** Same as skinUrl when present; UI can fall back to a built-in head. */
  avatarUrl: z.string().url().nullable(),
  /** CSP-safe avatar bytes (data:image/...;base64,...), null on failure. */
  avatarDataUrl: z.string().nullable(),
  fallback: z.enum(['steve', 'alex', 'none']),
  error: z.string().nullable(),
  fetchedAt: z.number().int(),
})
export type AuthProfile = z.infer<typeof AuthProfileSchema>

export const AuthSessionStatusSchema = z.object({
  accountId: z.string(),
  kind: AccountKind,
  hasSession: z.boolean(),
  mcExpiresAt: z.number().int().nullable(),
  refreshIssuedAt: z.number().int().nullable(),
  reauthRequired: z.boolean(),
  reason: z.string().nullable(),
})
export type AuthSessionStatus = z.infer<typeof AuthSessionStatusSchema>

export const AuthRefreshResultSchema = z.object({
  accountId: z.string(),
  ok: z.boolean(),
  mcExpiresAt: z.number().int().nullable(),
  refreshedAt: z.number().int(),
})
export type AuthRefreshResult = z.infer<typeof AuthRefreshResultSchema>

export const AuthReauthResultSchema = z.object({
  accountId: z.string(),
  required: z.boolean(),
  action: z.enum(['beginDeviceCode', 'loginAuthlib']),
  hint: z.string(),
})
export type AuthReauthResult = z.infer<typeof AuthReauthResultSchema>

export const AuthlibSessionValidationSchema = z.object({
  valid: z.boolean(),
  reason: z.string().nullable(),
})
export type AuthlibSessionValidation = z.infer<typeof AuthlibSessionValidationSchema>

export const AuthCodeStartSchema = z.object({
  flowId: z.string(),
  authorizationUrl: z.string().url(),
  redirectUri: z.string().url(),
  expiresAt: z.number().int(),
})
export type AuthCodeStart = z.infer<typeof AuthCodeStartSchema>

export const AuthCodePollResultSchema = z.union([
  z.object({ status: z.literal('pending') }),
  z.object({ status: z.literal('ok'), account: AccountSchema }),
  z.object({ status: z.literal('failed'), error: AuthErrorShapeSchema }),
])
export type AuthCodePollResult = z.infer<typeof AuthCodePollResultSchema>

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
        /** Yggdrasil login name; may be an email, display name comes from profile. */
        name: z.string().min(1).max(64),
        server: z.string().url(),
        /** When supplied, performs real Yggdrasil authentication. */
        password: z.string().min(1).max(512).optional(),
      }),
      output: AccountSchema,
    },
    loginAuthlib: {
      input: z.object({
        name: z.string().min(1).max(64),
        password: z.string().min(1).max(512),
        server: z.string().url(),
      }),
      output: AccountSchema,
    },
    validateAuthlibSession: {
      input: z.object({ id: z.string() }),
      output: AuthlibSessionValidationSchema,
    },
    signoutAuthlib: {
      input: z.object({ id: z.string() }),
      output: z.object({ ok: z.boolean() }),
    },
    profile: {
      input: z.object({ id: z.string() }),
      output: AuthProfileSchema,
    },
    sessionStatus: {
      input: z.object({ id: z.string() }),
      output: AuthSessionStatusSchema,
    },
    refresh: {
      input: z.object({ id: z.string() }),
      output: AuthRefreshResultSchema,
    },
    reauth: {
      input: z.object({ id: z.string() }),
      output: AuthReauthResultSchema,
    },
    authlibPresets: {
      input: z.void(),
      output: z.object({ presets: z.array(AuthlibPresetSchema) }),
    },
    validateAuthlib: {
      input: z.object({ server: z.string().min(1) }),
      output: AuthlibValidationSchema,
    },
    beginAuthCode: {
      input: z.void(),
      output: AuthCodeStartSchema,
    },
    pollAuthCode: {
      input: z.object({ flowId: z.string() }),
      output: AuthCodePollResultSchema,
    },
    cancelAuthCode: {
      input: z.object({ flowId: z.string() }),
      output: z.object({ ok: z.boolean() }),
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
  createAuthlib(name: string, server: string, password?: string): Promise<z.infer<typeof AccountSchema>>
  loginAuthlib(name: string, password: string, server: string): Promise<z.infer<typeof AccountSchema>>
  validateAuthlibSession(id: string): Promise<AuthlibSessionValidation>
  signoutAuthlib(id: string): Promise<{ ok: boolean }>
  profile(id: string): Promise<AuthProfile>
  sessionStatus(id: string): AuthSessionStatus
  refresh(id: string): Promise<AuthRefreshResult>
  reauth(id: string): AuthReauthResult
  authlibPresets(): AuthlibPreset[]
  validateAuthlib(server: string): Promise<AuthlibValidation>
  select(id: string): Promise<{ ok: boolean }>
  beginDeviceCode(): Promise<z.infer<typeof DeviceCodeSchema>>
  beginAuthCode(): Promise<AuthCodeStart>
  pollAuthCode(flowId: string): Promise<AuthCodePollResult>
  cancelAuthCode(flowId: string): Promise<{ ok: boolean }>
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
