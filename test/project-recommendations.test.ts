import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { ExplanationReply, ReviewedSource } from '../src/shared/explanations'
import type { ProjectRecord, ProjectSpec } from '../src/shared/projects'
import { mergeProjectRecommendations } from '../src/shared/project-recommendations'
import { newProject, validateProject } from '../src/main/projects/spec'
import { ProjectRepository } from '../src/main/projects/repository'
import { WorkspaceFiles } from '../src/main/files'
import { ProjectLensSession } from '../src/main/project-lens/session'
import { prepareContext } from '../src/main/explanations/context'

type Recommendation = ExplanationReply['recommendations'][number]
const recommendation = (more: Partial<Recommendation> = {}): Recommendation => ({ id: 'inspect', title: 'Inspect behavior',
  description: 'Describe what the reviewed code does.', acceptance: ['Explain a representative input manually.'],
  dependsOn: [], citations: [{ sourceId: 'source-1', startLine: 2, endLine: 3 }], ...more })
const sources: Pick<ReviewedSource, 'id' | 'label' | 'startLine' | 'endLine'>[] = [
  { id: 'source-1', label: 'src/main.py', startLine: 1, endLine: 8 },
]
const invalid = /recommendation|Recommendation|citation|Milestone|Project plans|Draft text/

function existing(): ProjectSpec {
  const spec = newProject('Existing project', 'Preserve this plan and all its work.')
  spec.milestones[0].id = 'lens-1'
  spec.milestones[0].status = 'manually-completed'
  spec.milestones.push({ id: 'lens-2', title: 'Work in progress', description: 'Keep its description.', acceptance: ['Original requirement.'],
    status: 'in-progress', dependsOn: ['lens-1'] })
  spec.tests = [{ id: 'existing-test', milestoneId: 'lens-1', title: 'Existing approved behavior definition', source: 'main.c',
    stdin: 'input', expectedOutput: 'original', match: 'exact', exitCode: 0 }]
  return validateProject(spec)
}

test('draft merge preserves existing identities, statuses, test definitions and record evidence without mutation', () => {
  const record: ProjectRecord = { spec: existing(), revision: 'saved-revision', approved: ['existing-test'], automatic: ['existing-test'],
    evidence: [{ testId: 'existing-test', outcome: 'test-verified', kind: 'behavior', message: 'Actual existing evidence.', captured: 'original',
      compilerOutput: '', exitCode: 0, durationMs: 3, checkedAt: 123, stale: false }] }
  const before = structuredClone(record), next = recommendation()
  const merged = mergeProjectRecommendations(record.spec, [next], ['inspect'], sources)
  assert.deepEqual(record, before)
  assert.deepEqual(merged.spec.milestones.slice(0, 2), record.spec.milestones)
  assert.deepEqual(merged.spec.tests, record.spec.tests)
  assert.equal(merged.idMap.inspect, 'lens-3')
  assert.equal(merged.spec.milestones[2].status, 'not-started')
  assert.match(merged.spec.milestones[2].description, /Reviewed context \(not verification\):\nsrc\/main.py: lines 2–3/)
  assert.deepEqual(validateProject(merged.spec), merged.spec)
  merged.spec.tests[0].expectedOutput = 'edited only in draft'
  assert.equal(record.spec.tests[0].expectedOutput, 'original')
  assert.deepEqual(record.evidence, before.evidence)
})

test('new IDs are unique and dependency edges map only to explicitly selected recommendation drafts', () => {
  const first = recommendation({ id: 'lens-1' }), second = recommendation({ id: 'follow', dependsOn: ['lens-1'] })
  const merged = mergeProjectRecommendations(existing(), [first, second], ['follow', 'lens-1'], sources)
  assert.equal(merged.idMap.follow, 'lens-3')
  assert.equal(merged.idMap['lens-1'], 'lens-4')
  assert.deepEqual(merged.spec.milestones[2].dependsOn, ['lens-4'])
  assert.deepEqual(merged.spec.milestones[3].dependsOn, [])
  assert.deepEqual(validateProject(merged.spec), merged.spec)
  assert.throws(() => mergeProjectRecommendations(existing(), [first, second], ['follow'], sources), /Select every prerequisite/)
  assert.throws(() => mergeProjectRecommendations(existing(), [first], ['missing'], sources), invalid)
  assert.throws(() => mergeProjectRecommendations(existing(), [first], ['lens-1', 'lens-1'], sources), invalid)
  assert.throws(() => mergeProjectRecommendations(existing(), [first, first], ['lens-1'], sources), invalid)
})

test('cycles, missing dependencies, stale citation ranges and invented evidence fail before producing a plan', () => {
  for (const recommendations of [[recommendation({ dependsOn: ['inspect'] })],
    [recommendation({ dependsOn: ['missing'] })], [recommendation({ dependsOn: ['second'] }), recommendation({ id: 'second', dependsOn: ['inspect'] })]]) {
    assert.throws(() => mergeProjectRecommendations(existing(), recommendations, recommendations.map(item => item.id), sources), invalid)
  }
  for (const citations of [[{ sourceId: 'invented', startLine: 1, endLine: 1 }],
    [{ sourceId: 'source-1', startLine: 0, endLine: 1 }], [{ sourceId: 'source-1', startLine: 1, endLine: 9 }]]) {
    assert.throws(() => mergeProjectRecommendations(existing(), [recommendation({ citations })], ['inspect'], sources), invalid)
  }
  const corrupt = existing(); corrupt.milestones[1].dependsOn = ['unknown']
  assert.throws(() => mergeProjectRecommendations(corrupt, [recommendation()], ['inspect'], sources), invalid)
})

test('project limits reject overlong drafts without truncating requirements or silently overwriting work', () => {
  const initial = existing(), saved = structuredClone(initial)
  for (const next of [recommendation({ title: 'x'.repeat(121) }), recommendation({ description: 'x'.repeat(801) }),
    recommendation({ acceptance: ['x'.repeat(401)] }), recommendation({ acceptance: [] }),
    recommendation({ description: 'x'.repeat(790) }), recommendation({ title: 'bad\u0000title' })]) {
    assert.throws(() => mergeProjectRecommendations(initial, [next], ['inspect'], sources), invalid)
    assert.deepEqual(initial, saved)
  }
  const full = existing()
  for (let i = 2; i < 16; i++) full.milestones.push({ ...full.milestones[0], id: 'old-' + i, dependsOn: [] })
  assert.throws(() => mergeProjectRecommendations(full, [recommendation()], ['inspect'], sources), /up to 16 milestones/)
  const empty = mergeProjectRecommendations(initial, [recommendation()], [], sources)
  assert.deepEqual(empty.spec, initial)
  assert.notEqual(empty.spec, initial)
  assert.equal(Object.keys(empty.idMap).length, 0)
})

test('a new roadmap may begin with an empty draft only when reviewed selections produce a valid nonempty specification', () => {
  const draft = { ...newProject('New reviewed roadmap', 'Build only the explicitly reviewed work.'), milestones: [] }
  const before = structuredClone(draft)
  const { spec } = mergeProjectRecommendations(draft, [recommendation()], ['inspect'], sources)
  assert.equal(spec.milestones.length, 1)
  assert.equal(spec.milestones[0].status, 'not-started')
  assert.equal(spec.milestones[0].id, 'lens-1')
  assert.deepEqual(spec.tests, [])
  assert.deepEqual(validateProject(spec), spec)
  assert.deepEqual(draft, before)
  assert.throws(() => mergeProjectRecommendations(draft, [recommendation()], [], sources), /at least one recommendation/)
})

test('exact native E/F fixture merges real reviewed source IDs and persists its original tests/manual status through ProjectRepository', async t => {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-native-recommendation-contract-')))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const root = join(scratch, 'Project ü with spaces'), profile = join(scratch, 'profile')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src/evidence.py'), 'def fixture_value():\n    return 3\n')
  await writeFile(join(root, 'main.c'), 'int main(void) { return 0; }\n')
  await writeFile(join(root, 'package.json'), '{"name":"disposable-explanation-fixture","dependencies":{"react":"19"}}\n')
  const initialProject = validateProject({ version: 1, title: 'Existing verified local plan', description: 'Keep all existing local work.',
    goal: 'Preserve old milestones and tests while reviewing new drafts.', technologies: [], files: [], environment: [],
    milestones: [{ id: 'old-work', title: 'Existing manual progress', description: 'Original milestone.',
      acceptance: ['Original acceptance requirement.'], dependsOn: [], status: 'manually-completed' }],
    tests: [{ id: 'old-test', milestoneId: 'old-work', title: 'Existing test definition', source: 'main.c',
      stdin: '', expectedOutput: '', match: 'exact', exitCode: 0 }] })
  const repository = new ProjectRepository(profile)
  const initialRecord = await repository.save(root, initialProject, null)
  const scope = new WorkspaceFiles()
  await scope.grant(root, 'folder')
  const lens = new ProjectLensSession(() => scope)
  t.after(() => lens.close())
  const snapshot = await lens.analyze(root)
  const reference = snapshot.files.find(item => item.reference.path === 'src/evidence.py')!.reference
  const context = await prepareContext({ purpose: 'project-lens', action: 'understand',
    question: 'Explain only the evidence I explicitly selected.', project: { root, refs: [reference] } }, new AbortController().signal,
  { scope: () => scope, isCurrent: () => true, lens: async requested => lens.lease(requested),
    lesson: async () => { throw new Error('No lesson selected.') } })
  const source = context.input.sources.find(item => item.origin === 'saved-file')!
  assert.match(source.id, /^source-[a-f0-9-]{36}$/)
  const actualRecommendation: Recommendation = { id: 'inspect', title: 'User-reviewed improvement',
    description: 'Explain two cases after independent review.', acceptance: ['Explain two representative inputs.'], dependsOn: [],
    citations: [{ sourceId: source.id, startLine: source.startLine, endLine: source.startLine }] }
  const current = (await repository.read(root))!
  const { spec } = mergeProjectRecommendations(current.spec, [actualRecommendation], ['inspect'], context.input.sources)
  const merged = await repository.save(root, spec, current.revision)
  assert.deepEqual(merged.spec.milestones[0], initialRecord.spec.milestones[0])
  assert.deepEqual(merged.spec.tests, initialRecord.spec.tests)
  assert.deepEqual(merged.approved, initialRecord.approved)
  assert.deepEqual(merged.evidence, initialRecord.evidence)
  assert.equal(merged.spec.milestones[1].title, 'User-reviewed improvement')
  assert.equal(merged.spec.milestones[1].status, 'not-started')
  assert.match(merged.spec.milestones[1].description, /Reviewed context \(not verification\)/)
  assert.deepEqual(await new ProjectRepository(profile).read(root), merged)
  await assert.rejects(repository.save(root, spec, initialRecord.revision), /saved project changed/)
})
