import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
// The only backup work on ordinary startup: one fixed-name existence check.
// No ZIP library, profile scan, timer or service is initialized here.
export async function hasPendingRestore(profile: string): Promise<boolean> {
  try {
    const info = await lstat(join(profile, 'ion-pending-restore.json'))
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024) throw new Error('Invalid pending restore marker. Preserve your profile and repair it before editing.')
    return true
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}
