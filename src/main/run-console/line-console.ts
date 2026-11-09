import { execute } from '../runner'
import type { PtyOptions, PtySession } from './pty'

const maxLineLength = 16 * 1024

// Windows uses pipes for stdin, stdout and stderr. Edit a single input line
// locally and deliver it on Enter, without starting a shell or native helper.
export function startLineConsole(options: Omit<PtyOptions, 'helper' | 'columns' | 'rows'>): PtySession {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, options.signal])
  let write: ((text: string | null) => boolean) | undefined
  let line = ''
  let endsWithCarriageReturn = false
  const result = execute(options.executable, options.args, {
    cwd: options.cwd, input: '', environment: options.environment, signal,
    timeoutMs: options.timeoutMs, budget: options.budget,
    interactive(send) {
      write = send
      options.ready()
    },
    onOutput(text) {
      const output = text.replace(/(?<!\r)\n/g, '\r\n')
      options.onOutput(endsWithCarriageReturn && text.startsWith('\n') ? output.slice(1) : output)
      endsWithCarriageReturn = text.endsWith('\r')
    },
  }).then((outcome) => {
    write = undefined
    line = ''
    return { ...outcome, outputComplete: outcome.outputComplete ?? true }
  })

  return {
    result,
    resize() {},
    input(data) {
      if (!write || signal.aborted) return
      let echo = ''
      const text = data.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|O.)?/g, '').replace(/\r\n/g, '\n')
      for (const character of text) {
        if (character === '\x03') {
          controller.abort()
          break
        }
        if (character === '\x04' || character === '\x1a') {
          if (line && !write(line)) break
          line = ''
          write(null)
          write = undefined
          break
        }
        if (character === '\r' || character === '\n') {
          if (!write(line + '\n')) break
          echo += '\r\n'
          line = ''
        } else if (character === '\x7f' || character === '\b') {
          if (line) {
            const pair = (line.codePointAt(line.length - 2) ?? 0) > 0xffff
            line = line.slice(0, pair ? -2 : -1)
            echo += '\b \b'
          }
        } else if (character >= ' ' && !/[\u0080-\u009f]/.test(character) && line.length + character.length <= maxLineLength) {
          line += character
          echo += character
        }
      }
      if (echo) options.onOutput(echo)
    },
  }
}
