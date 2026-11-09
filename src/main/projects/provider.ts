import type { ProjectSpec, ProviderSettings } from '../../shared/projects'
import { boundedText, validateProject } from './spec'
import { readJson, writeJson } from './storage'

const settingsLimit = 32 * 1024
const responseLimit = 160 * 1024
const defaultEndpoint = 'https://api.openai.com/v1'
const apiKeyPattern = /^[A-Za-z0-9._~+\/=-]{8,4096}$/

interface StoredProvider {
  endpoint: string
  model: string
  cipher: string | null
}

interface CredentialStore {
  available(): Promise<boolean>
  encrypt(value: string): Promise<Buffer>
  decrypt(value: Buffer): Promise<string>
}

interface ProviderOptions {
  endpoint: string
  model: string
  apiKey: string
}

type JSONSchema = Record<string, unknown>
const text = { type: 'string' }
const array = (items: JSONSchema) => ({ type: 'array', items })
const object = (properties: Record<string, JSONSchema>) => ({
  type: 'object', properties, required: Object.keys(properties), additionalProperties: false,
})
const schema = object({
  version: { type: 'integer', enum: [1] }, title: text, description: text, goal: text,
  technologies: array(text),
  files: array(object({ path: text, purpose: text, required: { type: 'boolean' } })),
  milestones: array(object({
    id: text, title: text, description: text, dependsOn: array(text), acceptance: array(text),
    status: { type: 'string', enum: ['not-started'] },
  })),
  environment: array(text),
  tests: array(object({
    id: text, milestoneId: text, title: text, source: text, stdin: text, expectedOutput: text,
    match: { type: 'string', enum: ['exact', 'contains'] }, exitCode: { type: 'integer' },
  })),
})

const baselinePrompt = 'Draft a concise, achievable project plan for a student. Return a version 1 specification. Include only observable single-file C console tests when supported. Write planning text only. Never write application source, shell commands, executable scripts, or tool calls.'
const constrainedPrompt = [
  baselinePrompt,
  'Choose the simplest feasible stack, distinguish required files from optional suggestions, and state environmental dependencies or an explicit unresolved assumption.',
  'For each milestone include measurable acceptance criteria and list prerequisite milestone IDs. Use lowercase kebab-case identifiers. New milestones always have not-started status.',
  'For C console behavior, use a relative .c path, literal stdin and literal expected stdout, an exact or contains match, and an exit code from 0 to 255. Prefer representative normal and boundary cases. Use no test when an interface or environment is missing. Tests may run only after independent human review.',
  'For browser pages, distinguish browser download, user-granted file access, and server-side writes. A static page cannot silently write arbitrary disk files. Describe a feasible mechanism or the clarification needed. Leave tests empty for browser, network, and multi-file build verification.',
].join(' ')

function endpointURL(input: unknown): string {
  const value = boundedText(input, 500, 'Provider HTTPS endpoint').trim()
  let url: URL
  try { url = new URL(value) } catch { throw new Error('Enter an absolute HTTPS provider endpoint.') }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !url.hostname || url.port && url.port !== '443') {
    throw new Error('Provider endpoints require HTTPS on the standard port, without credentials, query, or fragment.')
  }
  return url.href.replace(/\/+$/, '')
}

function modelId(input: unknown): string {
  const model = boundedText(input, 120, 'Model ID', true).trim()
  if (!/^[A-Za-z0-9._:/-]*$/.test(model)) throw new Error('Enter a valid model ID.')
  return model
}

function projectProvider(value: StoredProvider): ProviderSettings {
  return { endpoint: value.endpoint, model: value.model, hasKey: value.cipher !== null }
}

export class ProviderVault {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly path: string, private readonly credentials: CredentialStore) {}

  private async read(): Promise<StoredProvider> {
    const value = await readJson(this.path, settingsLimit)
    if (value === null) return { endpoint: defaultEndpoint, model: '', cipher: null }
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid provider settings.')
    const data = value as Record<string, unknown>
    if (data.version !== 1 || (data.cipher !== null && (typeof data.cipher !== 'string'
      || data.cipher.length > 28_000 || !/^[A-Za-z0-9+/=]+$/.test(data.cipher)))) {
      throw new Error('Invalid provider settings.')
    }
    return { endpoint: endpointURL(data.endpoint), model: modelId(data.model), cipher: data.cipher }
  }

  async get(): Promise<ProviderSettings> {
    return projectProvider(await this.read())
  }

  update(value: unknown): Promise<ProviderSettings> {
    const operation = this.queue.then(async () => {
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some(key => !['endpoint', 'model', 'apiKey', 'forgetKey'].includes(key))) {
        throw new Error('Invalid provider settings.')
      }
      const data = value as Record<string, unknown>
      const endpoint = endpointURL(data.endpoint)
      const model = modelId(data.model)
      if (data.forgetKey !== undefined && typeof data.forgetKey !== 'boolean') throw new Error('Invalid key setting.')
      const previous = await this.read()
      let cipher = data.forgetKey || endpoint !== previous.endpoint ? null : previous.cipher
      if (data.apiKey !== undefined) {
        if (data.forgetKey || typeof data.apiKey !== 'string' || !apiKeyPattern.test(data.apiKey)
          || endpoint.includes(data.apiKey) || model.includes(data.apiKey)) {
          throw new Error('Enter a valid API key separately from the endpoint and model.')
        }
        if (!await this.credentials.available()) throw new Error('An OS-backed credential store is unavailable.')
        cipher = (await this.credentials.encrypt(data.apiKey)).toString('base64')
      }
      const next = { endpoint, model, cipher }
      await writeJson(this.path, { version: 1, ...next }, settingsLimit)
      return projectProvider(next)
    })
    this.queue = operation.catch(() => undefined)
    return operation
  }

  async unlock(settings: ProviderSettings): Promise<ProviderOptions> {
    const stored = await this.read()
    if (!stored.cipher || !stored.model) throw new Error('Configure a provider, model, and API key before planning online.')
    if (stored.endpoint !== settings.endpoint || stored.model !== settings.model) {
      throw new Error('The provider changed. Review the online request again.')
    }
    if (!await this.credentials.available()) throw new Error('An OS-backed credential store is unavailable.')
    const apiKey = await this.credentials.decrypt(Buffer.from(stored.cipher, 'base64'))
    if (!apiKeyPattern.test(apiKey)) throw new Error('The saved API key cannot be used.')
    return { endpoint: stored.endpoint, model: stored.model, apiKey }
  }
}

async function boundedResponse(response: Response): Promise<string> {
  if (!response.body) throw new Error('The provider returned no planning response.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > responseLimit) throw new Error('The provider returned a planning response that exceeds its size limit.')
      chunks.push(decoder.decode(value, { stream: true }))
    }
    return chunks.join('') + decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

export type PromptVariant = 'baseline' | 'constrained'

export async function requestProject(
  options: ProviderOptions, input: unknown, signal: AbortSignal,
  prompt: PromptVariant = 'constrained', request: typeof fetch = fetch,
): Promise<{ spec: ProjectSpec; tokens: number | null; inputTokens: number | null; outputTokens: number | null }> {
  const goal = boundedText(input, 4000, 'Project description')
  const endpoint = endpointURL(options.endpoint)
  const model = modelId(options.model)
  if (!model || !apiKeyPattern.test(options.apiKey)) throw new Error('Configure a provider, model, and API key before planning online.')
  if (goal.includes(options.apiKey)) throw new Error('Remove the configured API key from the project description before sending it.')
  let response: Response
  try {
    response = await request(endpoint + '/chat/completions', {
      method: 'POST', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
      headers: { authorization: 'Bearer ' + options.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_completion_tokens: 5000, store: false,
        messages: [{ role: 'system', content: prompt === 'baseline' ? baselinePrompt : constrainedPrompt },
          { role: 'user', content: goal }],
        response_format: { type: 'json_schema', json_schema: { name: 'ion_project_spec_v1', strict: true, schema } },
      }),
    })
  } catch {
    throw new Error('The planning request could not reach the configured HTTPS provider, timed out, or was cancelled.')
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error('The planning provider returned HTTP ' + response.status + '. Check its configuration and model support.')
  }
  try {
    const body = JSON.parse(await boundedResponse(response)) as {
      choices?: { finish_reason?: unknown; message?: { content?: unknown; refusal?: unknown } }[]
      usage?: { total_tokens?: unknown; prompt_tokens?: unknown; completion_tokens?: unknown }
    }
    const choice = body?.choices?.[0]
    const content = choice?.message?.content
    if (choice?.finish_reason !== 'stop' || choice.message?.refusal || typeof content !== 'string') throw new Error('Incomplete response')
    const spec = validateProject(JSON.parse(content) as unknown)
    if (JSON.stringify(spec).includes(options.apiKey) || spec.milestones.some(item => item.status !== 'not-started')) throw new Error('Unsafe proposal')
    const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
    return { spec, tokens: count(body.usage?.total_tokens), inputTokens: count(body.usage?.prompt_tokens),
      outputTokens: count(body.usage?.completion_tokens) }
  } catch {
    throw new Error('The provider returned a refused, incomplete, or invalid plan. No project was changed.')
  }
}
