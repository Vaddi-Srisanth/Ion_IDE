import type { LanguageToolState, LanguageToolStatus, ToolReply, ToolSnapshot } from '../../shared/language-tools'

export type LanguageServiceState = LanguageToolState

export interface ManagedLanguageService {
  readonly closed: boolean
  query(snapshot: ToolSnapshot, signal?: AbortSignal): Promise<ToolReply | null>
  stop(): Promise<void>
}

export interface LanguageServiceDescriptor {
  adapter: string
  language: string
  root: string | null
  path: string
}

export type LanguageServiceStatus = LanguageToolStatus

export type LanguageServiceFactory = (descriptor: LanguageServiceDescriptor, signal: AbortSignal) => Promise<ManagedLanguageService>

interface Session {
  descriptor: LanguageServiceDescriptor
  controller: AbortController
  service: Promise<ManagedLanguageService>
  generation: number
  state: LanguageServiceState
  detail?: string
  idle?: ReturnType<typeof setTimeout>
}

const idleMs = 15_000
const failureWindowMs = 60_000
const restartLimit = 2
const maxSessions = 4

/** Owns every optional language service. Construction itself performs no work. */
export class LanguageServiceManager {
  private readonly sessions = new Map<string, Session>()
  private readonly failureHistory = new Map<string, number[]>()
  private readonly history = new Map<string, LanguageServiceStatus>()
  private readonly requests = new Map<string, AbortController>()
  private generation = 0
  private drain = Promise.resolve()

  constructor(private readonly factory: LanguageServiceFactory, private readonly now = Date.now) {}

  statuses(): LanguageServiceStatus[] {
    const values = new Map(this.history)
    for (const [key, { descriptor, state, detail }] of this.sessions) values.set(key, { ...descriptor, state, detail })
    return [...values.values()]
  }

  async query(descriptor: LanguageServiceDescriptor, snapshot: ToolSnapshot): Promise<ToolReply | null> {
    const key = this.key(descriptor)
    let session = this.sessions.get(key)
    if (!session) {
      const failures = (this.failureHistory.get(key) ?? []).filter(time => this.now() - time < failureWindowMs)
      this.failureHistory.set(key, failures)
      if (failures.length >= restartLimit) throw new Error('Language service restart limit reached. Restart it manually after checking the installed tool.')
      await this.makeRoom()
      session = this.start(descriptor)
      this.sessions.set(key, session)
      this.record(key, session)
    }
    clearTimeout(session.idle)
    const generation = session.generation
    session.state = 'busy'
    this.record(key, session)
    const request = snapshot.requestId ? new AbortController() : undefined
    if (snapshot.requestId) {
      if (this.requests.has(snapshot.requestId)) throw new Error('Duplicate language service request.')
      this.requests.set(snapshot.requestId, request!)
    }
    try {
      const service = await session.service
      if (this.sessions.get(key) !== session || generation !== session.generation) return null
      session.state = 'busy'
      this.record(key, session)
      const work = service.query(snapshot, request?.signal)
      const reply = request ? await Promise.race([work, new Promise<null>(resolve => {
        request.signal.addEventListener('abort', () => resolve(null), { once: true })
      })]) : await work
      if (request?.signal.aborted) {
        session.state = 'ready'
        this.record(key, session)
        return null
      }
      if (this.sessions.get(key) !== session || generation !== session.generation || reply?.version !== snapshot.version) return null
      session.state = 'ready'
      this.record(key, session)
      return reply
    } catch (error) {
      if (this.sessions.get(key) !== session) return null
      session.state = 'error'
      session.detail = error instanceof Error ? error.message.slice(0, 300) : 'Language service failed.'
      this.record(key, session)
      const failures = (this.failureHistory.get(key) ?? []).filter(time => this.now() - time < failureWindowMs)
      failures.push(this.now())
      this.failureHistory.set(key, failures)
      if (await session.service.then(service => service.closed, () => true)) await this.stopSession(key, session)
      throw error
    } finally {
      if (snapshot.requestId && this.requests.get(snapshot.requestId) === request) this.requests.delete(snapshot.requestId)
    }
  }

  cancel(requestId: string) {
    this.requests.get(requestId)?.abort()
  }

  release(immediate: boolean, language?: string) {
    const targets = [...this.sessions.entries()].filter(([, session]) => !language || session.descriptor.language === language)
    if (immediate) return Promise.all(targets.map(([key, session]) => this.stopSession(key, session))).then(() => undefined)
    for (const [key, session] of targets) {
      clearTimeout(session.idle)
      session.idle = setTimeout(() => { void this.stopSession(key, session) }, idleMs)
      session.idle.unref()
    }
    return Promise.resolve()
  }

  async stopAll() {
    for (const request of this.requests.values()) request.abort()
    this.requests.clear()
    await Promise.all([...this.sessions.entries()].map(([key, session]) => this.stopSession(key, session)))
    await this.drain
  }

  private start(descriptor: LanguageServiceDescriptor): Session {
    const controller = new AbortController()
    const session: Session = {
      descriptor, controller, generation: ++this.generation, state: 'starting',
      service: Promise.resolve(null as never),
    }
    session.service = this.factory(descriptor, controller.signal).then(service => {
      if (controller.signal.aborted) {
        void service.stop()
        throw new Error('Language service start was cancelled.')
      }
      session.state = 'ready'
      this.record(this.key(descriptor), session)
      return service
    }, error => {
      session.state = 'error'
      session.detail = error instanceof Error ? error.message.slice(0, 300) : 'Language service could not start.'
      this.record(this.key(descriptor), session)
      throw error
    })
    return session
  }

  private async stopSession(key: string, session: Session) {
    if (this.sessions.get(key) !== session) return
    this.sessions.delete(key)
    clearTimeout(session.idle)
    session.state = 'stopped'
    if (this.history.get(key)?.state !== 'error') this.record(key, session)
    session.controller.abort()
    const stop = session.service.then(service => service.stop(), () => {})
    this.drain = Promise.all([this.drain, stop]).then(() => undefined)
    await stop
  }

  private async makeRoom() {
    if (this.sessions.size < maxSessions) return
    const candidate = [...this.sessions.entries()].find(([, session]) => session.state !== 'busy')
    if (!candidate) throw new Error('All language services are busy. Close or disable one before starting another.')
    await this.stopSession(candidate[0], candidate[1])
  }

  private key({ adapter, root, path }: LanguageServiceDescriptor) {
    return adapter + ':' + (root ?? path)
  }

  private record(key: string, session: Session) {
    this.history.delete(key)
    this.history.set(key, { ...session.descriptor, state: session.state, detail: session.detail })
    if (this.history.size > 32) this.history.delete(this.history.keys().next().value!)
  }
}
