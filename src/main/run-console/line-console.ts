import { execute } from '../runner'
import type { PtyOptions, PtySession } from './pty'

const maxLineLength = 16 * 1024

// When Windows ConPTY is unavailable, edit a single input line locally and
// deliver it through pipes on Enter, without starting a shell or native helper.
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
      // Preflight the bounded line before changing/echoing any of this input.
      // A rejected paste must not leave an invisible truncated prefix behind.
      let pending = line
      for (const character of text) {
        if (character === '\x03' || character === '\x04' || character === '\x1a') break
        if (character === '\r' || character === '\n') pending = ''
        else if (character === '\x7f' || character === '\b') {
          const pair = (pending.codePointAt(pending.length - 2) ?? 0) > 0xffff
          pending = pending.slice(0, pair ? -2 : -1)
        } else if (character >= ' ' && !/[\u0080-\u009f]/.test(character)) {
          if (pending.length + character.length > maxLineLength) throw new Error(`Input was not sent: line input supports at most ${maxLineLength} characters.`)
          pending += character
        }
      }
      for (const character of text) {
        if (character === '\x03') {
          controller.abort()
          break
        }
        if (character === '\x04' || character === '\x1a') {
          if (line && !write(line)) throw new Error('Input could not be sent: the program input buffer is busy.')
          line = ''
          write(null)
          write = undefined
          break
        }
        if (character === '\r' || character === '\n') {
          if (!write(line + '\n')) throw new Error('Input could not be sent: the program input buffer is busy.')
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
