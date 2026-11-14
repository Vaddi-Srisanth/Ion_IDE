// Test-host error metadata only: never publish arbitrary messages or paths.
const { createHash } = require('node:crypto')
exports.safeHostError = error => {
  const match = String(error?.stack ?? '').match(/gcc-diagnostic-host\.cjs:(\d{1,6}):(\d{1,6})/)
  const codes = new Set(['ERR_ASSERTION', 'ENOENT', 'EACCES', 'EPERM', 'MODULE_NOT_FOUND', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE'])
  return { code: codes.has(error?.code) ? error.code : 'HOST_ERROR',
    line: match ? Number(match[1]) : null, column: match ? Number(match[2]) : null,
    messageSha256: createHash('sha256').update(String(error?.message ?? '')).digest('hex') }
}
