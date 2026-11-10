import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ToolReply, ToolSnapshot } from '../../shared/language-tools'
import { javaToolsFor } from '../run-console/plans'
import source from './IonJava.java'

interface Pending {
  snapshot: ToolSnapshot
  resolve(value: ToolReply | null): void
  reject(reason: Error): void
}

const encode = (value: string) => Buffer.from(value, 'utf8').toString('base64')
const decode = (value: string) => Buffer.from(value, 'base64').toString('utf8')
const maxReplyBytes = 2 * 1024 * 1024

export class JavaService {
  private current?: Pending
  private diagnostics?: Pending
  private interactive?: Pending
  private sequence = 0
  private response = ''
  private deadline?: ReturnType<typeof setTimeout>
  private stopped = false
  readonly done: Promise<void>

  private constructor(private readonly child: ChildProcessWithoutNullStreams, directory: string) {
    this.done = new Promise((resolve) => {
      child.once('close', () => {
        this.fail(new Error('The local Java service exited.'))
        void rm(directory, { recursive: true, force: true }).finally(resolve).catch(() => {})
      })
    })
    child.on('error', () => this.fail(new Error('The local Java service could not start. Check the installed JDK.')))
    child.stdin.on('error', () => this.fail(new Error('The local Java service connection closed.')))
    child.stderr.resume()
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => this.receive(chunk))
  }

  static async start(root: string | null, path: string, signal: AbortSignal) {
    const directory = await mkdtemp(join(tmpdir(), 'ion-java-tools-'))
    try {
      const { java, environment } = await javaToolsFor(root ?? dirname(path), directory, signal)
      const entry = join(directory, 'IonJava.java')
      await writeFile(entry, source, { mode: 0o600, flag: 'wx' })
      signal.throwIfAborted()
      const child = spawn(java, [
        '-Xms16m', '-Xmx192m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', entry, ...(root ? [root] : []),
      ], {
        cwd: directory, env: environment, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      })
      return new JavaService(child, directory)
    } catch (error) {
      await rm(directory, { recursive: true, force: true })
      throw error
    }
  }

  get closed() { return this.stopped }

  query(snapshot: ToolSnapshot): Promise<ToolReply | null> {
    if (this.stopped) return Promise.reject(new Error('The local Java service has stopped.'))
    return new Promise((resolve, reject) => {
      const slot = snapshot.operation === 'diagnostics' ? 'diagnostics' : 'interactive'
      this[slot]?.resolve(null)
      this[slot] = { snapshot, resolve, reject }
      this.send()
    })
  }

  stop() {
    this.fail(new Error('The local Java service stopped.'))
    return this.done
  }

  private send() {
    if (this.stopped || this.current) return
    const slot = this.interactive ? 'interactive' : 'diagnostics'
    this.current = this[slot]
    if (!this.current) return
    this[slot] = undefined
    const { operation, path, text, offset } = this.current.snapshot
    this.child.stdin.write([++this.sequence, operation, encode(path), offset, encode(text)].join('\t') + '\n')
    this.deadline = setTimeout(() => this.fail(new Error('Java analysis timed out. Try again in a smaller file.')), 8000)
  }

  private receive(chunk: string) {
    if (this.stopped) return
    this.response += chunk
    if (this.response.length > maxReplyBytes) {
      this.fail(new Error('The Java analysis result exceeded its limit.'))
      return
    }
    const end = this.response.indexOf('\n')
    if (end < 0) return
    const [sequence, response] = this.response.slice(0, end).trimEnd().split('\t')
    // An empty result still has its tab separator.
    const payload = response ?? (this.response.slice(0, end).includes('\t') ? '' : undefined)
    this.response = this.response.slice(end + 1)
    if (!this.current || Number(sequence) !== this.sequence || payload === undefined) {
      this.fail(new Error('The local Java service sent an unexpected response.'))
      return
    }
    clearTimeout(this.deadline)
    const { snapshot, resolve, reject } = this.current
    this.current = undefined
    if (payload.startsWith('!')) reject(new Error('The installed JDK could not analyze this Java source.'))
    else {
      const data = decode(payload)
      resolve({ version: snapshot.version, rows: data ? data.split('\n').map((line) => line.split('\t').map(decode)) : [] })
    }
    this.send()
  }

  private fail(reason: Error) {
    if (this.stopped) return
    this.stopped = true
    clearTimeout(this.deadline)
    this.current?.reject(reason)
    this.diagnostics?.resolve(null)
    this.interactive?.resolve(null)
    this.current = this.diagnostics = this.interactive = undefined
    this.response = ''
    this.child.stdin.destroy()
    if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
  }
}
