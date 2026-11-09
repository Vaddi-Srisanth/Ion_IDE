import assert from 'node:assert/strict'
import { test } from 'node:test'
import { windowsSignatureOptions, windowsSigningOptions } from './signing.mjs'

const configuration = {
  ION_WIN_SIGN: '1',
  ION_WIN_SIGNTOOL: 'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\x64\\signtool.exe',
  ION_WIN_SIGN_CERT_SHA1: 'a'.repeat(40),
  ION_WIN_SIGN_PUBLISHER: 'Example Publisher',
  ION_WIN_TIMESTAMP_URL: 'https://timestamp.example.test/rfc3161',
  SystemRoot: 'C:\\Windows',
}

test('signing requires an explicit opt-in and native Windows', () => {
  assert.equal(windowsSigningOptions({}, 'darwin'), undefined)
  assert.equal(windowsSigningOptions({ ...configuration, ION_WIN_SIGN: '0' }, 'win32'), undefined)
  assert.throws(() => windowsSigningOptions({ ION_WIN_SIGN: 'true' }, 'win32'), /must be 0 or 1/)
  assert.throws(() => windowsSigningOptions(configuration, 'darwin'), /requires native Windows/)
})

test('signing and verification pin the publisher, thumbprint and trusted tool paths', () => {
  const verify = windowsSignatureOptions(configuration, 'win32')
  assert.deepEqual(verify, {
    signTool: configuration.ION_WIN_SIGNTOOL,
    publisher: configuration.ION_WIN_SIGN_PUBLISHER,
    thumbprint: 'A'.repeat(40),
    powershell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  })
  assert.deepEqual(windowsSigningOptions(configuration, 'win32'), {
    ...verify, timestamp: configuration.ION_WIN_TIMESTAMP_URL,
  })
  assert.throws(() => windowsSignatureOptions({ ...configuration, ION_WIN_SIGN_CERT_SHA1: 'non-hex' }, 'win32'), /thumbprint/)
  assert.throws(() => windowsSignatureOptions({ ...configuration, ION_WIN_SIGNTOOL: 'signtool.exe' }, 'win32'), /full path/)
  assert.throws(() => windowsSignatureOptions({ ...configuration, ION_WIN_SIGN_PUBLISHER: 'Example $Name' }, 'win32'), /publisher/)
})

test('timestamp requests reject insecure or credential-bearing endpoints', () => {
  for (const value of ['http://timestamp.example.test', 'https://name:secret@timestamp.example.test',
    'https://timestamp.example.test?token=secret', 'https://timestamp.example.test#secret']) {
    assert.throws(() => windowsSigningOptions({ ...configuration, ION_WIN_TIMESTAMP_URL: value }, 'win32'), /HTTPS endpoint/)
  }
})
