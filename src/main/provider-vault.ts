import { safeStorage } from 'electron'
import { join } from 'node:path'
import { ProviderVault } from './projects/provider'

/** Main creates one shared instance lazily; retain the existing encrypted file. */
export function createProviderVault(profile: string): ProviderVault {
  return new ProviderVault(join(profile, 'planning-provider-v1.json'), {
    async available() {
      if (!await safeStorage.isAsyncEncryptionAvailable()) return false
      return process.platform !== 'linux' || ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(safeStorage.getSelectedStorageBackend())
    },
    encrypt: value => safeStorage.encryptStringAsync(value),
    async decrypt(value) {
      const result = await safeStorage.decryptStringAsync(value)
      if (result.shouldReEncrypt) return (await safeStorage.decryptStringAsync(value)).result
      return result.result
    },
  })
}
