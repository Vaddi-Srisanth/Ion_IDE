import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { outputFiles } = await build({
  bundle: true, write: false, platform: 'node', format: 'esm',
  stdin: {
    contents: `
      export { planningCases, scorePlan } from './test/fixtures/project-plans.ts'
      export { validateProject } from './src/main/projects/spec.ts'
      export { requestProject } from './src/main/projects/provider.ts'
    `,
    resolveDir: root,
  },
})
const { planningCases, scorePlan, validateProject, requestProject } = await import(
  'data:text/javascript;base64,' + Buffer.from(outputFiles[0].contents).toString('base64')
)

const reviewed = planningCases.map(item => {
  const spec = validateProject(item.reviewed)
  return { case: item.id, valid: true, ...scorePlan(item, spec) }
})
console.log('Reviewed offline reference plans. Rubric checks are targeted heuristics, and these plans are human-authored fixtures.')
console.table(reviewed)
if (!reviewed.every(item => Object.entries(item).filter(([key]) => key !== 'case').every(([, value]) => value))) {
  process.exitCode = 1
}

if (!process.argv.includes('--online')) {
  console.log('Live prompt comparison skipped. Use --online and the dedicated ION_PLAN_EVAL_* environment variables to send only the four synthetic goals.')
} else {
  const endpoint = process.env.ION_PLAN_EVAL_ENDPOINT
  const model = process.env.ION_PLAN_EVAL_MODEL
  const apiKey = process.env.ION_PLAN_EVAL_API_KEY
  if (!endpoint || !model || !apiKey) throw new Error('Set ION_PLAN_EVAL_ENDPOINT, ION_PLAN_EVAL_MODEL and ION_PLAN_EVAL_API_KEY.')
  const price = (name) => {
    if (!process.env[name]) return null
    const value = Number(process.env[name])
    if (!Number.isFinite(value) || value < 0) throw new Error('Invalid optional per-million-token price.')
    return value
  }
  const inputPrice = price('ION_PLAN_EVAL_INPUT_USD_PER_MILLION')
  const outputPrice = price('ION_PLAN_EVAL_OUTPUT_USD_PER_MILLION')
  const results = []
  for (const [index, item] of planningCases.entries()) {
    const variants = index % 2 === 0 ? ['baseline', 'constrained'] : ['constrained', 'baseline']
    for (const variant of variants) {
      const start = performance.now()
      try {
        const { spec, tokens, inputTokens, outputTokens } = await requestProject(
          { endpoint, model, apiKey }, item.goal, new AbortController().signal, variant,
        )
        const estimatedUSD = [inputPrice, outputPrice, inputTokens, outputTokens].every(value => value !== null)
          ? (inputPrice * inputTokens + outputPrice * outputTokens) / 1_000_000 : null
        results.push({ variant, case: item.id, valid: true, ...scorePlan(item, spec),
          milliseconds: Math.round(performance.now() - start), tokens, estimatedUSD })
      } catch {
        results.push({ variant, case: item.id, valid: false, milliseconds: Math.round(performance.now() - start) })
      }
    }
  }
  console.table(results)
  console.log('Dollar estimates require caller-supplied rates and omit cached-token pricing and provider-specific adjustments.')
  for (const variant of ['baseline', 'constrained']) {
    const tested = results.filter(item => item.variant === variant)
    const valid = tested.filter(item => item.valid)
    console.log(JSON.stringify({
      variant,
      attempts: tested.length,
      validRate: valid.length / tested.length,
      feasibleRate: tested.filter(item => item.feasible).length / tested.length,
      explicitPrerequisitesRate: tested.filter(item => item.explicitPrerequisites).length / tested.length,
      verifiableRate: tested.filter(item => item.verifiable).length / tested.length,
      simpleRate: tested.filter(item => item.simple).length / tested.length,
      averageMs: tested.reduce((total, item) => total + item.milliseconds, 0) / tested.length,
      averageTokens: valid.length && valid.every(item => item.tokens !== null)
        ? valid.reduce((total, item) => total + item.tokens, 0) / valid.length : null,
      estimatedUSD: valid.length && valid.every(item => item.estimatedUSD !== null)
        ? valid.reduce((total, item) => total + item.estimatedUSD, 0) : null,
    }))
  }
}
