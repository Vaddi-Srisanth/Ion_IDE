import { rm } from 'node:fs/promises'

type Remove = typeof rm

export function serviceScratchRemovalOptions(platform = process.platform) {
  return {
    recursive: true,
    force: true,
    // Windows can report a transient ENOTEMPTY while a just-exited Node
    // language server finishes publishing its compile-cache entries. Node's
    // recursive remover retries only when maxRetries is explicitly enabled.
    maxRetries: platform === 'win32' ? 5 : 0,
    retryDelay: 100,
  } as const
}

export async function removeServiceScratch(directory: string, remove: Remove = rm,
  platform = process.platform) {
  await remove(directory, serviceScratchRemovalOptions(platform))
}
