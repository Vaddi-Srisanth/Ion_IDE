import { resolve } from 'node:path'
import { verifyWindowsSignature, windowsSignatureOptions } from './windows/signing.mjs'

const binaries = process.argv.slice(2)
if (!binaries.length) throw new Error('Pass the path of each Windows binary to verify.')
const options = windowsSignatureOptions()
for (const binary of binaries) {
  const path = resolve(binary)
  await verifyWindowsSignature(path, options)
  console.log(`Verified the embedded timestamped signature and publisher for ${path}`)
}
