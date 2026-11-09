import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { RunResult } from '../src/shared/contracts'
import { judgeTest, unavailableTest } from '../src/main/projects/evidence'
import { ProviderVault, requestProject } from '../src/main/projects/provider'
import { ProjectRepository } from '../src/main/projects/repository'
import { validateProject } from '../src/main/projects/spec'
import { planningCases, scorePlan } from './fixtures/project-plans'

const plan = planningCases[0].reviewed
const testArtifact = plan.tests[0]
const revision = 'source-revision'
const goodRun: RunResult = {
  status: 'success', compiler: '/usr/bin/clang', compileOutput: '', programOutput: '5\n', programStdout: '5\n',
  programStderr: '', exitCode: 0, durationMs: 84, message: 'Program exited successfully.',
}

test('validates the reviewed project corpus and rejects malformed or ambiguous schema fields', () => {
  for (const item of planningCases) {
    const validated = validateProject(item.reviewed)
    assert.deepEqual(validated, item.reviewed)
    assert.ok(Object.values(scorePlan(item, validated)).every(Boolean), item.id)
  }
  const invalid = [
    { ...plan, version: 2 },
    { ...plan, shellCommand: 'run-me' },
    { ...plan, files: [{ ...plan.files[0], path: '../escape.c' }] },
    { ...plan, tests: [{ ...testArtifact, source: 'C:\\project\\main.c' }] },
    { ...plan, tests: [{ ...testArtifact, expectedOutput: '', match: 'contains' }] },
    { ...plan, tests: [{ ...testArtifact, milestoneId: 'unknown' }] },
    { ...plan, milestones: [{ ...plan.milestones[0], dependsOn: ['sum'] }, plan.milestones[1]] },
    { ...plan, milestones: [{ ...plan.milestones[0], status: 'test-verified' }] },
  ]
  for (const spec of invalid) assert.throws(() => validateProject(spec))
})

test('project writes preserve scoped records and invalidate modified test approvals and evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-projects-test-'))
  try {
    const projects = new ProjectRepository(directory)
    assert.equal(await projects.read('/alpha'), null)
    const created = await projects.save('/alpha', plan, null)
    await assert.rejects(projects.evidence('/alpha', judgeTest(testArtifact, goodRun, revision), created.revision), /approve/)
    const approved = await projects.approve('/alpha', testArtifact, created.revision)
    const evidenced = await projects.evidence('/alpha', judgeTest(testArtifact, goodRun, revision), approved.revision)
    assert.equal((await new ProjectRepository(directory).read('/alpha'))?.evidence[0].outcome, 'test-verified')
    assert.equal(await projects.read('/other'), null)
    const acceptanceChanged = await projects.save('/alpha', { ...plan, milestones: plan.milestones.map(milestone =>
      milestone.id === testArtifact.milestoneId ? { ...milestone, acceptance: ['New criterion.'] } : milestone) }, evidenced.revision)
    assert.deepEqual(acceptanceChanged.approved, [testArtifact.id])
    assert.deepEqual(acceptanceChanged.evidence, [])
    const modified = { ...plan, tests: [{ ...testArtifact, expectedOutput: '7\n' }, plan.tests[1]] }
    await assert.rejects(projects.save('/alpha', modified, approved.revision), /changed/)
    const changed = await projects.save('/alpha', modified, acceptanceChanged.revision)
    assert.deepEqual(changed.approved, [])
    assert.deepEqual(changed.evidence, [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('verification distinguishes behavior failure, environmental issues, and incomplete execution', () => {
  const stderr = judgeTest(testArtifact, { ...goodRun, programOutput: '5\nwarning\n', programStderr: 'warning\n' }, revision)
  assert.equal(stderr.outcome, 'test-verified')
  assert.equal(judgeTest(testArtifact, { ...goodRun, programStdout: 'unexpected\n' }, revision).outcome, 'test-failed')
  assert.equal(judgeTest(testArtifact, { ...goodRun, status: 'runtime-error', exitCode: 1 }, revision).kind, 'behavior')
  assert.equal(judgeTest(testArtifact, { ...goodRun, status: 'missing-toolchain', exitCode: null }, revision).kind, 'environment')
  const timeout = judgeTest(testArtifact, { ...goodRun, status: 'timeout' }, revision)
  assert.equal(timeout.kind, 'interrupted')
  assert.equal(timeout.outcome, 'unable-to-verify')
  const partial = judgeTest(testArtifact, { ...goodRun, outputComplete: false }, revision)
  assert.equal(partial.outcome, 'unable-to-verify')
  assert.equal(partial.kind, 'interrupted')
  assert.equal(judgeTest(testArtifact, { ...goodRun, status: 'compile-error' }, revision).kind, 'configuration')
  assert.equal(unavailableTest(testArtifact, 'Missing source.').outcome, 'unable-to-verify')
})

test('provider enforces key isolation, HTTPS and endpoint-specific encrypted storage', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ion-planner-test-'))
  const key = 'synthetic-unit-key-not-a-real-credential'
  try {
    const file = join(directory, 'provider.json')
    const vault = new ProviderVault(file, {
      available: async () => true,
      encrypt: async () => Buffer.from('fake-ciphertext-for-this-test'),
      decrypt: async () => key,
    })
    await assert.rejects(vault.update({ endpoint: 'http://example.invalid/v1', model: 'model', apiKey: key }), /HTTPS/)
    const settings = await vault.update({ endpoint: 'https://example.invalid/v1', model: 'model', apiKey: key })
    assert.equal(settings.hasKey, true)
    assert.equal('apiKey' in settings, false)
    assert.equal((await readFile(file, 'utf8')).includes(key), false)
    assert.equal((await vault.unlock(settings)).apiKey, key)
    const changed = await vault.update({ endpoint: 'https://other.invalid/v1', model: 'model' })
    assert.equal(changed.hasKey, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('planning sends only the approved text and rejects malformed, incomplete, or key-echoed replies', async () => {
  const key = 'synthetic-unit-key-not-a-real-credential'
  const options = { endpoint: 'https://example.invalid/v1', model: 'fake-model', apiKey: key }
  const reply = (content: string, finish_reason = 'stop') => new Response(JSON.stringify({
    choices: [{ finish_reason, message: { content } }], usage: { total_tokens: 90, prompt_tokens: 50, completion_tokens: 40 },
  }))
  const response = await requestProject(options, plan.description, new AbortController().signal, 'constrained', async (url, init) => {
    assert.equal(url, 'https://example.invalid/v1/chat/completions')
    assert.equal(init?.redirect, 'error')
    const body = JSON.parse(String(init.body))
    assert.equal(body.store, false)
    assert.deepEqual(body.messages.filter((message: { role: string }) => message.role === 'user'),
      [{ role: 'user', content: plan.description }])
    assert.equal(body.response_format.json_schema.strict, true)
    assert.equal(JSON.stringify(body).includes(key), false)
    return reply(JSON.stringify(plan))
  })
  assert.deepEqual(response, { spec: plan, tokens: 90, inputTokens: 50, outputTokens: 40 })
  for (const invalid of [reply('{}'), reply(JSON.stringify(plan), 'length'), reply(JSON.stringify({ ...plan, title: key }))]) {
    await assert.rejects(
      requestProject(options, plan.description, new AbortController().signal, 'constrained', async () => invalid),
      /invalid plan/,
    )
  }
})
