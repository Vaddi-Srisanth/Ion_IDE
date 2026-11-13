import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir, tmpdir, userInfo } from 'node:os'
import { basename, delimiter, isAbsolute, join } from 'node:path'
import { maxTerminalSessions, type TerminalEvent, type TerminalSessionInfo } from '../../shared/terminal'
import { startPty } from '../run-console/pty'
import { windowsEnvironment, windowsSystemDirectory, workspaceSafeWindowsToolPaths } from '../windows-process'

const maxInputBytes = 16 * 1024
const sessionId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/
const systemPath = '/usr/bin:/bin:/usr/sbin:/sbin'

interface TerminalSession {
  id: string
  controller: AbortController
  pty?: ReturnType<typeof startPty>
  attached: boolean
  nextSequence: number
  awaitingAck?: number
  pending: string
  exit?: Extract<TerminalEvent, { kind: 'exit' }>
}

async function configuredShell(): Promise<string> {
  let account: string | null = null
  try { account = userInfo().shell } catch { /* The account may be missing in a container. */ }
  for (const path of [account, process.env.SHELL, process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash', '/bin/sh']) {
    if (path && isAbsolute(path) && await access(path, constants.X_OK).then(() => true, () => false)) return path
  }
  throw new Error('Ion could not find an executable local shell.')
}

function shellEnvironment(shell: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, SHELL: shell, TERM_PROGRAM: 'Ion' }
  // A relative startup path must never resolve against an opened workspace.
  for (const key of ['HOME', 'ZDOTDIR', 'XDG_CONFIG_HOME', 'HISTFILE', 'INPUTRC']) {
    const value = environment[key]
    if (value !== undefined && !isAbsolute(value)) delete environment[key]
  }
  const configDirs = environment.XDG_CONFIG_DIRS?.split(delimiter).filter(isAbsolute).join(delimiter)
  if (configDirs) environment.XDG_CONFIG_DIRS = configDirs
  else delete environment.XDG_CONFIG_DIRS
  if (!environment.HOME) {
    let home = homedir()
    try { home = userInfo().homedir } catch { /* Fall back when no account entry exists. */ }
    environment.HOME = isAbsolute(home) ? home : '/'
  }
  environment.PATH = (environment.PATH ?? '').split(delimiter).filter(isAbsolute).join(delimiter) || systemPath
  for (const key of ['ENV', 'BASH_ENV', 'PWD', 'OLDPWD', 'ELECTRON_RUN_AS_NODE', 'ION_DEV_URL']) delete environment[key]
  return environment
}

async function windowsShell(cwd: string) {
  const cmd = join(windowsSystemDirectory, 'cmd.exe')
  const paths = await workspaceSafeWindowsToolPaths(cwd)
  const environment = {
    ...windowsEnvironment(paths, tmpdir()), ComSpec: cmd, PATHEXT: '.COM;.EXE;.BAT;.CMD', TERM_PROGRAM: 'Ion',
    ProgramFiles: process.env.ProgramFiles,
    'ProgramFiles(x86)': process.env['ProgramFiles(x86)'],
    ProgramW6432: process.env.ProgramW6432,
    ProgramData: process.env.ProgramData,
    SystemDrive: process.env.SystemDrive,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    USERNAME: process.env.USERNAME,
  }
  // cmd's AutoRun registry entries can run arbitrary scripts in the current folder.
  return { executable: cmd, args: ['/D'], environment }
}

function dimension(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 2 || value > 512) {
    throw new Error('Invalid terminal dimensions.')
  }
  return value
}

export class TerminalService {
  private readonly sessions = new Map<string, TerminalSession>()
  private disposed = false

  constructor(private readonly helper: string, private readonly publish: (event: TerminalEvent) => void) {}

  async create(cwd: string, columns: number, rows: number): Promise<TerminalSessionInfo> {
    dimension(columns)
    dimension(rows)
    if (process.platform !== 'darwin' && process.platform !== 'linux' && process.platform !== 'win32') {
      throw new Error('The integrated shell is unavailable on this operating system.')
    }
    if (this.disposed) throw new Error('The terminal is closing.')
    if (this.sessions.size >= maxTerminalSessions) {
      throw new Error('Close a terminal before starting another. Ion supports up to ' + maxTerminalSessions + ' sessions.')
    }
    const id = randomUUID()
    const session: TerminalSession = { id, controller: new AbortController(), attached: false, nextSequence: 1, pending: '' }
    this.sessions.set(id, session)
    try {
      const launch = process.platform === 'win32' ? await windowsShell(cwd) : await configuredShell().then((shell) => ({
        executable: shell, args: ['-l'], environment: shellEnvironment(shell),
      }))
      if (session.controller.signal.aborted) throw new Error('The terminal is closing.')
      await new Promise<void>((ready, fail) => {
        const pty = startPty({
          helper: this.helper, ...launch, cwd,
          shell: true, columns, rows, signal: session.controller.signal,
          ready,
          onOutput: (text) => {
            if (session.controller.signal.aborted) return
            session.pty?.pauseOutput()
            session.pending += text
            this.pump(session)
          },
        })
        session.pty = pty
        void pty.result.then((result) => {
          fail(new Error(result.detail ?? 'Unable to open the terminal shell.'))
          if (session.controller.signal.aborted) return
          const detail = result.detail ?? result.signal ?? (result.outputComplete ? undefined : 'Some terminal output could not be read.')
          session.exit = { id, kind: 'exit', code: result.exitCode, detail }
          this.pump(session)
        })
      })
      if (session.controller.signal.aborted) throw new Error('The terminal is closing.')
      return { id, title: basename(launch.executable) }
    } catch (error) {
      await this.close(id)
      throw error
    }
  }

  attach(id: unknown): void {
    const session = this.session(id)
    if (!session || session.attached) return
    session.attached = true
    this.pump(session)
  }

  ack(id: unknown, sequence: unknown): void {
    const session = this.session(id)
    if (typeof sequence !== 'number' || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw new Error('Invalid terminal output acknowledgement.')
    }
    if (session?.awaitingAck !== sequence) return
    session.awaitingAck = undefined
    this.pump(session)
  }

  async input(id: unknown, data: unknown): Promise<void> {
    if (typeof data !== 'string' || data.length > maxInputBytes || Buffer.byteLength(data) > maxInputBytes) {
      throw new Error('Send at most 16 KiB per terminal input chunk.')
    }
    if (!data) return
    const session = this.session(id)
    if (!session?.pty || session.exit || session.controller.signal.aborted) throw new Error('The terminal session has closed.')
    await session.pty.writeInput(data)
  }

  resize(id: unknown, columns: unknown, rows: unknown): void {
    const width = dimension(columns)
    const height = dimension(rows)
    this.session(id)?.pty?.resize(width, height)
  }

  async close(id: unknown): Promise<void> {
    const session = this.session(id)
    if (!session) return
    session.controller.abort()
    session.pending = ''
    try { await session.pty?.result }
    finally { this.sessions.delete(session.id) }
  }

  async closeAll(): Promise<void> {
    this.disposed = true
    const results = await Promise.allSettled(Array.from(this.sessions.keys(), (id) => this.close(id)))
    if (results.some((result) => result.status === 'rejected')) {
      throw new Error('One or more terminal sessions could not be verified as fully stopped.')
    }
  }

  private session(id: unknown): TerminalSession | undefined {
    if (typeof id !== 'string' || !sessionId.test(id)) throw new Error('Invalid terminal session ID.')
    return this.sessions.get(id)
  }

  private pump(session: TerminalSession): void {
    if (!session.attached || session.awaitingAck !== undefined || session.controller.signal.aborted) return
    try {
      if (session.pending) {
        const text = session.pending
        session.pending = ''
        const sequence = session.nextSequence++
        session.awaitingAck = sequence
        this.publish({ id: session.id, kind: 'data', text, sequence })
      } else if (session.exit) {
        this.sessions.delete(session.id)
        this.publish(session.exit)
      } else {
        session.pty?.resumeOutput()
      }
    } catch {
      // The owning window can close between writing a chunk and delivering it.
      void this.close(session.id)
    }
  }
}
