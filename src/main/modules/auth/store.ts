import fs from 'node:fs'
import path from 'node:path'
import type { Account } from '@shared/auth'
import { AppError } from '@shared/errors'

interface AccountsFile {
  schemaVersion: 1
  selectedId: string | null
  accounts: Account[]
}

function atomicWrite(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, contents, 'utf8')
  try {
    fs.renameSync(tmp, file)
  } catch {
    fs.rmSync(file, { force: true })
    fs.renameSync(tmp, file)
  }
}

/** `$DATA/accounts.json` — only public account metadata, never tokens. */
export class AccountStore {
  private readonly file: string
  private data: AccountsFile

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, 'accounts.json')
    this.data = this.load()
  }

  private load(): AccountsFile {
    try {
      if (!fs.existsSync(this.file)) {
        return { schemaVersion: 1, selectedId: null, accounts: [] }
      }
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AccountsFile>
      const accounts = Array.isArray(parsed.accounts)
        ? parsed.accounts.filter(
            (account): account is Account =>
              Boolean(account) &&
              typeof account.id === 'string' &&
              typeof account.name === 'string' &&
              typeof account.uuid === 'string' &&
              ['offline', 'microsoft', 'authlib'].includes(account.kind),
          )
        : []
      const selectedId =
        typeof parsed.selectedId === 'string' &&
        accounts.some((account) => account.id === parsed.selectedId)
          ? parsed.selectedId
          : accounts[0]?.id ?? null
      return { schemaVersion: 1, selectedId, accounts }
    } catch {
      return { schemaVersion: 1, selectedId: null, accounts: [] }
    }
  }

  private save(): void {
    atomicWrite(this.file, `${JSON.stringify(this.data, null, 2)}\n`)
  }

  list(): { accounts: Account[]; selectedId: string | null } {
    return {
      accounts: this.data.accounts.map((account) => ({ ...account })),
      selectedId: this.data.selectedId,
    }
  }

  get(id: string): Account | null {
    return this.data.accounts.find((account) => account.id === id) ?? null
  }

  selected(): Account | null {
    const id = this.data.selectedId
    return id ? this.get(id) : null
  }

  findByUuid(kind: Account['kind'], uuid: string): Account | null {
    return (
      this.data.accounts.find(
        (account) => account.kind === kind && account.uuid.toLowerCase() === uuid.toLowerCase(),
      ) ?? null
    )
  }

  add(account: Account): Account {
    this.data.accounts.push(account)
    if (!this.data.selectedId) this.data.selectedId = account.id
    this.save()
    return account
  }

  update(account: Account): Account {
    const index = this.data.accounts.findIndex((item) => item.id === account.id)
    if (index >= 0) this.data.accounts[index] = account
    else this.data.accounts.push(account)
    this.save()
    return account
  }

  select(id: string): void {
    if (!this.get(id)) {
      throw new AppError('AUTH.NO_ACCOUNT', '账户不存在', { retryable: false })
    }
    this.data.selectedId = id
    this.save()
  }

  remove(id: string): boolean {
    const index = this.data.accounts.findIndex((account) => account.id === id)
    if (index < 0) return false
    this.data.accounts.splice(index, 1)
    if (this.data.selectedId === id) this.data.selectedId = this.data.accounts[0]?.id ?? null
    this.save()
    return true
  }
}

export interface TokenCipher {
  readonly available: boolean
  readonly backend: string
  encrypt(plain: string): Buffer
  decrypt(data: Buffer): string
}

export interface StoredSession {
  refreshToken: string
  refreshIssuedAt: number
  msAccessToken?: string
  mcAccessToken?: string
  mcExpiresAt?: number
  xuid?: string | null
}

interface SessionEntry {
  cipher: 'safeStorage' | 'test'
  data: string
}

interface SessionFile {
  schemaVersion: 1
  sessions: Record<string, SessionEntry>
}

/**
 * Refresh tokens are only persisted through an OS cipher (DPAPI/safeStorage).
 * `basic_text` is refused: we would rather fail honestly than write a plaintext
 * token to disk (docs/02 SEC-AUTH).
 */
export class SessionStore {
  private readonly file: string

  constructor(
    dataRoot: string,
    private readonly cipher: TokenCipher,
  ) {
    this.file = path.join(dataRoot, 'modules', 'auth', 'sessions.bin')
  }

  private load(): SessionFile {
    try {
      if (!fs.existsSync(this.file)) return { schemaVersion: 1, sessions: {} }
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<SessionFile>
      return {
        schemaVersion: 1,
        sessions:
          parsed.sessions && typeof parsed.sessions === 'object' ? parsed.sessions : {},
      }
    } catch {
      return { schemaVersion: 1, sessions: {} }
    }
  }

  private save(file: SessionFile): void {
    atomicWrite(this.file, `${JSON.stringify(file, null, 2)}\n`)
  }

  private requireCipher(): void {
    if (!this.cipher.available) {
      throw new AppError('AUTH.STORAGE_UNAVAILABLE', '系统加密不可用，令牌不会以明文落盘', {
        retryable: false,
        details: {
          hint: '请使用 Windows 登录会话运行启动器（safeStorage/DPAPI）；basic_text 后端被拒绝。',
          backend: this.cipher.backend,
        },
      })
    }
  }

  get(accountId: string): StoredSession | null {
    const entry = this.load().sessions[accountId]
    if (!entry) return null
    try {
      const plain = this.cipher.decrypt(Buffer.from(entry.data, 'base64'))
      const parsed = JSON.parse(plain) as StoredSession
      return typeof parsed.refreshToken === 'string' ? parsed : null
    } catch {
      return null
    }
  }

  set(accountId: string, session: StoredSession): void {
    this.requireCipher()
    const plain = JSON.stringify(session)
    const encrypted = this.cipher.encrypt(plain)
    const file = this.load()
    file.sessions[accountId] = {
      cipher: this.cipher.backend === 'test' ? 'test' : 'safeStorage',
      data: encrypted.toString('base64'),
    }
    this.save(file)
  }

  delete(accountId: string): void {
    const file = this.load()
    if (!(accountId in file.sessions)) return
    delete file.sessions[accountId]
    this.save(file)
  }

  /** Test/diagnostic helper: raw encrypted file contents (never decrypted). */
  readRaw(): string {
    try {
      return fs.existsSync(this.file) ? fs.readFileSync(this.file, 'utf8') : ''
    } catch {
      return ''
    }
  }
}

export interface AuthConfig {
  clientId: string | null
  tenant: string
}

interface AuthConfigFile {
  schemaVersion: 1
  microsoft: AuthConfig
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = { clientId: null, tenant: 'consumers' }

/** `$DATA/modules/auth/config.json`; env overrides are applied by the service. */
export class AuthConfigStore {
  private readonly file: string

  constructor(dataRoot: string) {
    this.file = path.join(dataRoot, 'modules', 'auth', 'config.json')
  }

  load(): AuthConfig {
    try {
      if (!fs.existsSync(this.file)) return { ...DEFAULT_AUTH_CONFIG }
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Partial<AuthConfigFile>
      const microsoft = parsed.microsoft
      return {
        clientId:
          typeof microsoft?.clientId === 'string' && microsoft.clientId.length > 0
            ? microsoft.clientId
            : null,
        tenant:
          typeof microsoft?.tenant === 'string' && microsoft.tenant.length > 0
            ? microsoft.tenant
            : DEFAULT_AUTH_CONFIG.tenant,
      }
    } catch {
      return { ...DEFAULT_AUTH_CONFIG }
    }
  }

  save(config: AuthConfig): void {
    const file: AuthConfigFile = { schemaVersion: 1, microsoft: config }
    atomicWrite(this.file, `${JSON.stringify(file, null, 2)}\n`)
  }
}

export function maskClientId(clientId: string | null): string | null {
  if (!clientId) return null
  if (clientId.length <= 12) return `${clientId.slice(0, 4)}…`
  return `${clientId.slice(0, 8)}…${clientId.slice(-4)}`
}
