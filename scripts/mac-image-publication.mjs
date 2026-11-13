import { execFileSync } from 'node:child_process'
import { cp, mkdtemp, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

// Validate the exact inode that will be published, independently of the image
// author's inode and any advisory locks retained by its conversion helper.
export async function publishMacImage(source, destination, { verbose = false } = {}) {
  const directory = await mkdtemp(join(dirname(destination), '.ion-dmg-'))
  const image = join(directory, basename(destination))
  let published = false
  let phase = 'copy'
  try {
    await cp(source, image)
    phase = 'verification'
    execFileSync('/usr/bin/hdiutil', ['verify', ...(verbose ? ['-verbose'] : []), image], { stdio: 'inherit' })
    phase = 'atomic-rename'
    await rename(image, destination)
    published = true
  } catch (error) {
    // The caller records authoring and staging paths. Keep invalid bytes for
    // diagnosis; never replace an existing release when verification fails.
    error.imageStage = { directory, image, phase }
    throw error
  } finally {
    if (published) await rm(directory, { recursive: true, force: true })
  }
}
