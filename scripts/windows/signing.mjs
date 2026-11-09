import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const commandOptions = { windowsHide: true, timeout: 120_000 }

function localAbsolutePath(value) {
  return typeof value === 'string' && /^[a-z]:[\\/]/i.test(value)
}

export function windowsSignatureOptions(environment = process.env, platform = process.platform) {
  if (platform !== 'win32') throw new Error('Windows signature verification requires native Windows.')
  const { ION_WIN_SIGNTOOL: signTool, ION_WIN_SIGN_CERT_SHA1: thumbprint,
    ION_WIN_SIGN_PUBLISHER: publisher, SystemRoot: systemRoot } = environment
  if (!localAbsolutePath(signTool) || win32.basename(signTool).toLowerCase() !== 'signtool.exe') {
    throw new Error('Set ION_WIN_SIGNTOOL to the full path of the Windows SDK signtool.exe.')
  }
  if (!/^[\da-f]{40}$/i.test(thumbprint ?? '')) {
    throw new Error('Set ION_WIN_SIGN_CERT_SHA1 to the 40-character certificate thumbprint.')
  }
  // Also used in NSIS version metadata. Keep preprocessor and escape characters out.
  if (!publisher || publisher !== publisher.trim() || !/^[\p{L}\p{M}\p{N} .,&'()_-]{1,120}$/u.test(publisher)) {
    throw new Error('Set ION_WIN_SIGN_PUBLISHER to the exact certificate publisher name, without quotes or dollar signs.')
  }
  if (!localAbsolutePath(systemRoot)) throw new Error('The Windows SystemRoot path is unavailable.')
  return {
    signTool, thumbprint: thumbprint.toUpperCase(), publisher,
    powershell: win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  }
}

export function windowsSigningOptions(environment = process.env, platform = process.platform) {
  const enabled = environment.ION_WIN_SIGN
  if (enabled === undefined || enabled === '0') return undefined
  if (enabled !== '1') throw new Error('ION_WIN_SIGN must be 0 or 1.')
  if (platform !== 'win32') throw new Error('Windows release signing requires native Windows with a configured code-signing key.')
  const options = windowsSignatureOptions(environment, platform)
  let timestamp
  try {
    timestamp = new URL(environment.ION_WIN_TIMESTAMP_URL)
  } catch {
    throw new Error('Set ION_WIN_TIMESTAMP_URL to your CA’s HTTPS RFC 3161 timestamp endpoint.')
  }
  if (timestamp.protocol !== 'https:' || timestamp.username || timestamp.password || timestamp.search || timestamp.hash) {
    throw new Error('Set ION_WIN_TIMESTAMP_URL to an HTTPS endpoint without credentials, query, or fragment.')
  }
  return { ...options, timestamp: timestamp.href }
}

export async function verifyWindowsSignature(binary, options) {
  const { signTool, powershell, thumbprint, publisher } = options
  // SignTool verifies the embedded Authenticode signature and its chain. /tw
  // makes a missing timestamp a warning, which execFile treats as failure.
  await run(signTool, ['verify', '/pa', '/all', '/tw', binary], commandOptions)
  await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', `
    $ErrorActionPreference = 'Stop'
    $signature = Get-AuthenticodeSignature -LiteralPath $env:ION_SIGNATURE_FILE
    if ($signature.Status -ne 'Valid' -or $signature.SignatureType -ne 'Authenticode' -or
        $signature.SignerCertificate.Thumbprint -ne $env:ION_SIGNATURE_THUMBPRINT -or
        !$signature.TimeStamperCertificate) {
      throw 'The embedded signature, expected signer, or timestamp could not be verified.'
    }
    $name = $signature.SignerCertificate.GetNameInfo('SimpleName', $false)
    if ($name -cne $env:ION_SIGNATURE_PUBLISHER) {
      throw 'The certificate publisher does not match the expected publisher.'
    }
    if ($env:ION_SIGNATURE_COMPANY_REQUIRED -eq '1') {
      $company = (Get-Item -LiteralPath $env:ION_SIGNATURE_FILE).VersionInfo.CompanyName
      if ($company -cne $env:ION_SIGNATURE_PUBLISHER) {
        throw 'The executable CompanyName does not match the expected publisher.'
      }
    }
  `], {
    ...commandOptions, env: {
      ...process.env, ION_SIGNATURE_FILE: binary, ION_SIGNATURE_THUMBPRINT: thumbprint, ION_SIGNATURE_PUBLISHER: publisher,
      ION_SIGNATURE_COMPANY_REQUIRED: win32.basename(binary).toLowerCase() === 'ion-pty.exe' ? '0' : '1',
    },
  })
}

export async function signWindowsBinary(binary, options) {
  await run(options.signTool, [
    'sign', '/s', 'My', '/sha1', options.thumbprint, '/fd', 'SHA256',
    '/tr', options.timestamp, '/td', 'SHA256', '/d', 'Ion IDE', binary,
  ], commandOptions)
  await verifyWindowsSignature(binary, options)
}
