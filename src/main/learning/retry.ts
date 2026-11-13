import { createHash } from 'node:crypto'
import type { RunLanguage } from '../../shared/run-console'
import { cRetryFingerprint } from './c-retry'

const maximum = 128 * 1024
const quoted = /"(?:\\[^\r\n]|[^"\\\r\n])*"|'(?:\\[^\r\n]|[^'\\\r\n])*'/.source
const identifier = /[a-zA-Z_$][a-zA-Z0-9_$]*/.source
const number = /(?:[0-9]|\.[0-9])(?:[eEpP][+-]|[a-zA-Z0-9_.])*/.source
const punctuation = />>>=|===|!==|>>>|<<=|>>=|\*\*=|=>|->|::|\.\.\.|\?\.|\?\?|\*\*|\+\+|--|<<|>>|[!<>=]=|&&|\|\||[*/%+\-&^|]=|[()[\]{}~!*/%+\-<>=&^|?:;,.@]/.source
const pythonPunctuation = /\*\*=|\/\/=|<<=|>>=|:=|->|\.\.\.|\*\*|\/\/|<<|>>|[!<>=]=|[*/%+\-&^|]=|[()[\]{}~!*/%+\-<>=&^|?:;,.@]/.source

// Evidence for retry counting, not a parser or semantic-equivalence claim.
// Unsupported/ambiguous source must not create a repeated-mistake event.
export function retryFingerprint(language: RunLanguage, source: string, exactHash: string): string | undefined {
  if (language === 'c') return cRetryFingerprint(source, exactHash)
  if (!['java', 'python', 'javascript'].includes(language) || source.length > maximum
    || createHash('sha256').update(source).digest('hex') !== exactHash) return
  const fingerprint = createHash('sha256').update(language + '-retry-v1\0')
  const emit = (token: string) => { fingerprint.update(token).update('\0') }
  if (language === 'python') {
    if (/'{3}|"{3}|\\(?:\r\n|\r|\n)|\f/.test(source)) return
    const tokens = new RegExp('([ \\t]+|#[^\\r\\n]*)|' + [quoted, identifier, number, pythonPunctuation].join('|'), 'y')
    const brackets: string[] = []
    for (const line of source.split(/\r\n|\r|\n/)) {
      const indent = line.match(/^[ \t]*/)![0]
      if (indent.includes('\t')) return
      const body = line.slice(indent.length)
      if (!body || body.startsWith('#')) continue
      if (!brackets.length) emit('indent:' + indent.length)
      tokens.lastIndex = 0
      while (tokens.lastIndex < body.length) {
        const offset = tokens.lastIndex
        const match = tokens.exec(body)
        if (!match) return
        if (match[1]) continue
        const token = match[0]
        if (token.includes('$') || token === '@' || token === '/' && body[offset + 1] === '*') return
        if (/^(?:r|u|b|f|br|rb|fr|rf)$/i.test(token) && /['"]/.test(body[tokens.lastIndex] ?? '')) return
        if ('([{'.includes(token)) brackets.push(token)
        if (')]}'.includes(token) && brackets.pop() !== ({ ')': '(', ']': '[', '}': '{' } as Record<string, string>)[token]) return
        emit(token)
      }
      if (!brackets.length) emit('\n')
    }
    if (brackets.length) return
  } else {
    if (language === 'java' && (/\\u/.test(source) || /"{3}/.test(source))) return
    if (language === 'javascript' && (source.includes('`') || source.includes('#'))) return
    const trivia = /[ \t\v\f\r\n]+|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//.source
    const tokens = new RegExp('(' + trivia + ')|' + [quoted, identifier, number, punctuation].join('|'), 'y')
    while (tokens.lastIndex < source.length) {
      const offset = tokens.lastIndex
      const match = tokens.exec(source)
      if (!match) return
      if (match[1]) continue
      const token = match[0]
      if (source.startsWith('/*', offset)) return
      // Distinguishing JS regexp literals from division needs parser context.
      if (language === 'javascript' && token.startsWith('/')) return
      emit(token)
    }
  }
  return fingerprint.digest('hex').slice(0, 32)
}
