const standardHeaders = new Set([
  'assert.h', 'complex.h', 'ctype.h', 'errno.h', 'fenv.h', 'float.h', 'inttypes.h',
  'iso646.h', 'limits.h', 'locale.h', 'math.h', 'setjmp.h', 'signal.h', 'stdalign.h',
  'stdarg.h', 'stdatomic.h', 'stdbool.h', 'stddef.h', 'stdint.h', 'stdio.h', 'stdlib.h',
  'stdnoreturn.h', 'string.h', 'tgmath.h', 'threads.h', 'time.h', 'uchar.h', 'wchar.h', 'wctype.h',
])

export const maxAutomaticSourceBytes = 128 * 1024
export interface SavedTestSource {
  revision: string
  digest: string
}

/** Reject unsupported preprocessing syntax rather than guessing what the compiler will read. */
export function isSelfContainedC(text: string): boolean {
  if (text.length > maxAutomaticSourceBytes
    || /[^\t\n\r -~]|\r(?!\n)|\\[ \t]*\r?\n|\?\?|%:|\\[uU]|\b(?:asm|__asm|__asm__|_Pragma|__pragma)\b/.test(text)) return false
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('#')) continue
    const header = /^[ \t]*#[ \t]*include[ \t]+<([a-z0-9_]+\.h)>[ \t]*$/.exec(line)?.[1]
    if (!header || !standardHeaders.has(header)) return false
  }
  return true
}

/** One timer and one cancellable drain, with only the latest saved revision per source. */
export class SavedTestQueue {
  private pending = new Map<string, SavedTestSource>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private active: AbortController | undefined
  private activeSource: string | undefined

  constructor(
    private readonly execute: (source: string, saved: SavedTestSource, signal: AbortSignal) => Promise<void>,
    private readonly debounceMs = 650,
  ) {}

  push(source: string, saved: SavedTestSource): void {
    if (this.activeSource === source) this.active?.abort()
    if (!this.pending.has(source) && this.pending.size >= 16) return
    this.pending.set(source, saved)
    clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.drain()
    }, this.debounceMs)
  }

  clear(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.pending.clear()
    this.active?.abort()
  }

  remove(source: string): void {
    if (this.activeSource === source) this.active?.abort()
    if (!this.pending.delete(source) || this.pending.size) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private async drain(): Promise<void> {
    if (this.active || !this.pending.size) return
    const active = new AbortController()
    this.active = active
    try {
      while (!this.timer && !active.signal.aborted && this.pending.size) {
        const next = this.pending.entries().next().value
        if (!next) break
        const [source, saved] = next
        this.pending.delete(source)
        this.activeSource = source
        await this.execute(source, saved, active.signal).catch(() => undefined)
      }
    } finally {
      this.activeSource = undefined
      this.active = undefined
      if (!this.timer && this.pending.size) void this.drain()
    }
  }
}
