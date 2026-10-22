import { safeStorage } from 'electron'
import type { CurseForgeCipher } from '../../core/curseforge/settings'

/**
 * Electron safeStorage-backed cipher for the CurseForge user key.
 *
 * Windows = DPAPI, macOS = Keychain, Linux = libsecret/kwallet. The `basic_text`
 * Linux backend means "no encryption" and is treated as unavailable, matching
 * docs/02 SEC-AUTH-03 (refuse persistence, keep the key in memory only).
 */
export function createSafeStorageCurseForgeCipher(): CurseForgeCipher {
  const backend = (() => {
    try {
      return safeStorage.getSelectedStorageBackend()
    } catch {
      return 'unknown'
    }
  })()
  const available = (() => {
    try {
      return safeStorage.isEncryptionAvailable() && backend !== 'basic_text'
    } catch {
      return false
    }
  })()

  return {
    available,
    backend,
    async encrypt(plain: string): Promise<Buffer> {
      if (!available) throw new Error(`secure storage unavailable (${backend})`)
      return safeStorage.encryptStringAsync(plain)
    },
    async decrypt(encrypted: Buffer): Promise<{ plain: string; shouldReEncrypt: boolean }> {
      if (!available) throw new Error(`secure storage unavailable (${backend})`)
      const result = await safeStorage.decryptStringAsync(encrypted)
      return { plain: result.result, shouldReEncrypt: result.shouldReEncrypt }
    },
  }
}
