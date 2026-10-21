import { safeStorage } from 'electron'
import type { TokenCipher } from './store'

/**
 * Electron safeStorage: DPAPI on Windows, Keychain on macOS, libsecret on Linux.
 * `basic_text` means there is no encryption and must never receive tokens.
 */
export function createSafeStorageCipher(): TokenCipher {
  const backend = (() => {
    try {
      const getBackend = (safeStorage as unknown as {
        getSelectedStorageBackend?: () => string
      }).getSelectedStorageBackend
      return typeof getBackend === 'function' ? getBackend.call(safeStorage) : 'unknown'
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
    get available() {
      return available
    },
    get backend() {
      return backend
    },
    encrypt(plain: string): Buffer {
      if (!available) throw new Error(`secure storage unavailable (${backend})`)
      return safeStorage.encryptString(plain)
    },
    decrypt(data: Buffer): string {
      if (!available) throw new Error(`secure storage unavailable (${backend})`)
      return safeStorage.decryptString(data)
    },
  }
}
