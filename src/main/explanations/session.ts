import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import type { ExplanationCitation, ExplanationInput, ExplanationOpenResult, ExplanationReply, ExplanationReview } from '../../shared/explanations'
import { buildExplanationPayload, sendExplanationPayload, type ProviderVault, type PreparedExplanation } from '../projects/provider'

const lifetimeMs = 5 * 60_000
const messages = {
  busy: 'An explanation operation is still finishing. Wait for it to finish or cancel it.',
  inactive: 'The explanation session is no longer active.',
  cancelled: 'The explanation operation was cancelled.',
  expired: 'This explanation review or reply is unavailable or expired. Review the context again.',
  review: 'Could not prepare this explanation. No context was sent.',
  send: 'The explanation could not be completed. Review the context again.',
  citation: 'This citation is unavailable or its source changed. Review the context again.',
} as const
class SessionError extends Error {}
function fail(kind: keyof typeof messages): never { throw new SessionError(messages[kind]) }

export interface ExplanationContext {
  input: ExplanationInput
  stream?: boolean
  exclusions: string[]
  validate(): Promise<void>
  openCitation(citation: ExplanationCitation): Promise<ExplanationOpenResult>
}
export interface ExplanationSessionOptions {
  vault(): Promise<ProviderVault>
  context(request: unknown, signal: AbortSignal): Promise<ExplanationContext>
  approve(review: ExplanationReview, signal: AbortSignal): Promise<boolean>
  isCurrent(): boolean
  request?: typeof fetch
  /** Monotonic test seam; production uses performance.now, without a timer. */
  now?(): number
}
type SourceLease = Pick<ExplanationContext, 'validate' | 'openCitation'>
interface Operation { controller: AbortController; generation: number; done: Promise<void>; finish(): void }
interface Review {
  review: ExplanationReview
  prepared: PreparedExplanation
  fingerprint: string
  vault: ProviderVault
  context: SourceLease
  expires: number
}
interface Reply { reply: ExplanationReply; context: SourceLease; expires: number }

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

/** Main-owned, consent-gated capability. Constructing it performs no I/O. */
export class ExplanationSession {
  private generation = 0
  private pending?: Operation
  private reviewed?: Review
  private replied?: Reply
  private readonly now: () => number

  constructor(private readonly options: ExplanationSessionOptions) {
    this.now = options.now ?? (() => performance.now())
  }

  cancel(): void {
    ++this.generation
    this.reviewed = undefined
    this.replied = undefined
    this.pending?.controller.abort()
    // Keep ownership until the pending finally block unwinds. An operation
    // which ignores cancellation must not overlap a replacement request.
  }

  close(): void { this.cancel() }

  /** Shutdown waits for pending resource owners to finish their finally blocks. */
  async drain(): Promise<void> { await this.pending?.done }

  private expire(): void {
    const now = this.now()
    if (this.reviewed && now >= this.reviewed.expires) this.reviewed = undefined
    if (this.replied && now >= this.replied.expires) this.replied = undefined
  }

  private owner(): boolean {
    try { return this.options.isCurrent() } catch { return false }
  }

  private begin(): Operation {
    if (this.pending) fail('busy')
    this.expire()
    if (!this.owner()) { this.cancel(); fail('inactive') }
    let finish!: () => void
    const done = new Promise<void>(resolve => { finish = resolve })
    const operation = { controller: new AbortController(), generation: this.generation, done, finish }
    this.pending = operation
    return operation
  }

  private check(operation: Operation, expires?: number): void {
    if (this.pending !== operation || operation.generation !== this.generation || operation.controller.signal.aborted) fail('cancelled')
    if (!this.owner()) { this.cancel(); fail('inactive') }
    if (expires !== undefined && this.now() >= expires) { this.cancel(); fail('expired') }
  }

  private finish(operation: Operation): void {
    if (this.pending === operation) this.pending = undefined
    operation.finish()
  }

  async review(request: unknown): Promise<ExplanationReview> {
    const operation = this.begin()
    this.reviewed = undefined
    this.replied = undefined
    try {
      const context = await this.options.context(request, operation.controller.signal)
      this.check(operation)
      await context.validate()
      this.check(operation)
      const vault = await this.options.vault()
      this.check(operation)
      const { settings, fingerprint } = await vault.reviewedIdentity()
      this.check(operation)
      if (!settings.hasKey || !settings.model) fail('review')
      const prepared = buildExplanationPayload(settings, context.input, context.stream)
      if (!Array.isArray(context.exclusions) || context.exclusions.length > 32
        || context.exclusions.some(item => typeof item !== 'string' || !item.trim() || item.length > 256 || /[\x00-\x1f\x7f]/.test(item))) fail('review')
      const review = freeze<ExplanationReview>({ token: randomUUID(), provider: { ...settings }, bodyBytes: prepared.bodyBytes,
        ...(prepared.stream ? { stream: true } : {}),
        expiresAt: Date.now() + lifetimeMs, sources: prepared.sources.map(source => ({ ...source })),
        exclusions: [...context.exclusions], question: prepared.question, purpose: prepared.purpose, action: prepared.action })
      this.check(operation)
      this.reviewed = { review, prepared, fingerprint, vault,
        context: { validate: () => context.validate(), openCitation: citation => context.openCitation(citation) },
        expires: this.now() + lifetimeMs }
      return review
    } catch (error) {
      if (error instanceof SessionError) throw error
      if (operation.controller.signal.aborted || operation.generation !== this.generation) fail('cancelled')
      fail('review')
    } finally { this.finish(operation) }
  }

  async send(token: unknown): Promise<ExplanationReply | null> {
    if (this.pending) fail('busy')
    this.expire()
    const selected = this.reviewed
    if (!selected || typeof token !== 'string' || token !== selected.review.token) fail('expired')
    const operation = this.begin()
    // A valid Send consumes its token even if consent is declined or validation fails.
    this.reviewed = undefined
    this.replied = undefined
    try {
      this.check(operation, selected.expires)
      await selected.context.validate()
      this.check(operation, selected.expires)
      const approved = await this.options.approve(selected.review, operation.controller.signal)
      this.check(operation, selected.expires)
      if (!approved) return null
      await selected.context.validate()
      this.check(operation, selected.expires)
      const provider = await selected.vault.unlock(selected.review.provider, selected.fingerprint)
      this.check(operation, selected.expires)
      await selected.context.validate()
      this.check(operation, selected.expires)
      const identity = await selected.vault.reviewedIdentity()
      this.check(operation, selected.expires)
      if (identity.fingerprint !== selected.fingerprint) fail('send')
      const content = await sendExplanationPayload(provider, selected.prepared, operation.controller.signal, this.options.request)
      this.check(operation, selected.expires)
      await selected.context.validate()
      this.check(operation, selected.expires)
      const finalIdentity = await selected.vault.reviewedIdentity()
      this.check(operation, selected.expires)
      if (finalIdentity.fingerprint !== selected.fingerprint) fail('send')
      const reply = freeze<ExplanationReply>({ ...content, token: randomUUID() })
      this.replied = { reply, context: selected.context, expires: this.now() + lifetimeMs }
      return reply
    } catch (error) {
      if (error instanceof SessionError) throw error
      if (operation.controller.signal.aborted || operation.generation !== this.generation) fail('cancelled')
      fail('send')
    } finally { this.finish(operation) }
  }

  async openCitation(token: unknown, sourceId: unknown, range: unknown): Promise<ExplanationOpenResult> {
    if (this.pending) fail('busy')
    this.expire()
    const selected = this.replied
    if (!selected || typeof token !== 'string' || token !== selected.reply.token) fail('expired')
    if (!range || typeof range !== 'object' || Array.isArray(range) || typeof sourceId !== 'string'
      || Object.keys(range).length !== 2 || !Object.hasOwn(range, 'startLine') || !Object.hasOwn(range, 'endLine')) fail('citation')
    const { startLine, endLine } = range as Record<string, unknown>
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine)) fail('citation')
    const citation = [...selected.reply.sections.flatMap(section => section.citations),
      ...selected.reply.recommendations.flatMap(item => item.citations)]
      .find(item => item.sourceId === sourceId && item.startLine === startLine && item.endLine === endLine)
    if (!citation) fail('citation')
    const operation = this.begin()
    try {
      this.check(operation, selected.expires)
      await selected.context.validate()
      this.check(operation, selected.expires)
      const result = await selected.context.openCitation({ ...citation })
      this.check(operation, selected.expires)
      await selected.context.validate()
      this.check(operation, selected.expires)
      return result
    } catch (error) {
      this.replied = undefined
      if (error instanceof SessionError) throw error
      if (operation.controller.signal.aborted || operation.generation !== this.generation) fail('cancelled')
      fail('citation')
    } finally { this.finish(operation) }
  }
}
