import { createHash } from 'node:crypto'

const maxSourceLength = 128 * 1024
const triviaPattern = /[ \t\v\f\r\n]+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//.source
const literalPattern = /(?:u8|[LuU])?(?:"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*')/.source
const identifierPattern = /[a-zA-Z_][a-zA-Z0-9_]*/.source
const numberPattern = /(?:[0-9]|\.[0-9])(?:[eEpP][+-]|[a-zA-Z0-9_.])*/.source
const punctuatorPattern = /%:%:|<<=|>>=|\.\.\.|->|\+\+|--|<<|>>|[!<>=]=|&&|\|\||[*/%+\-&^|]=|##|<%|%>|<:|:>|%:|[()[\]{}~!*/%+\-<>=&^|?:;,.#]/.source

// Compare preprocessing tokens for ordinary C source. Uncertain input keeps the
// exact source hash, so a new construct cannot be mistaken for a cosmetic edit.
export function cRetryFingerprint(source: string, exactHash: string): string | undefined {
  if (source.length > maxSourceLength || /\\(?:\r\n|\r|\n)|\?\?[=/'()!<>-]/.test(source)
    || createHash('sha256').update(source).digest('hex') !== exactHash) return

  const tokens = new RegExp('(' + triviaPattern + ')|' + [
    literalPattern, identifierPattern, numberPattern, punctuatorPattern,
  ].join('|'), 'y')
  const include = /(?:#|%:)[ \t]*include[ \t]*(?:<[^>\r\n]+>|"[^"\r\n]+")[ \t]*(?:\/\/[^\r\n]*)?(?=\r|\n|$)/y
  const fingerprint = createHash('sha256').update('c-retry-v1\0')
  let pending = ''
  let lineStart = true

  while (tokens.lastIndex < source.length) {
    const offset = tokens.lastIndex
    const match = tokens.exec(source)
    if (!match) return
    const trivia = match[1]
    if (trivia) {
      if (trivia[0] !== '/' && /[\r\n]/.test(trivia)) lineStart = true
      continue
    }
    let token = match[0]
    if (token === '__LINE__' || source.startsWith('/*', offset)) return
    if (token === '#' || token === '%:') {
      if (!lineStart) return
      include.lastIndex = offset
      const directive = include.exec(source)
      if (!directive) return
      token = directive[0]
      tokens.lastIndex = include.lastIndex
    }
    lineStart = false
    pending += token + '\0'
    if (pending.length >= 8192) {
      fingerprint.update(pending)
      pending = ''
    }
  }
  return fingerprint.update(pending).digest('hex').slice(0, 32)
}
