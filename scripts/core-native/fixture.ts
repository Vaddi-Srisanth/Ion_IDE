// Synthetic data only. Bundled by the acceptance driver; never shipped in Ion.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { PreferenceStore } from '../../src/main/preferences'
import { RecoveryStore } from '../../src/main/recovery'
import { LearningService } from '../../src/main/learning'
import { LearningPackStore } from '../../src/main/learning/catalog-store'
import { ThemeStore } from '../../src/main/themes'
import { PracticeStore } from '../../src/main/practice/store'
import { ProjectRepository } from '../../src/main/projects/repository'
import { RunTrustStore } from '../../src/main/run-trust'
import { unavailableTest } from '../../src/main/projects/evidence'
import { planningCases } from '../../test/fixtures/project-plans'

export async function seed(profile: string, workspace: string) {
  await mkdir(profile, { recursive: true }); await mkdir(workspace, { recursive: true })
  await writeFile(join(workspace, 'main.c'), '#include <stdio.h>\nint main(void) { return 0; }\n')
  const prefs = new PreferenceStore(join(profile, 'preferences.json'))
  await prefs.updateSettings({ fontSize: 19, autoSave: false, smartLanguages: ['java'] })
  await prefs.remember({ path: workspace, name: 'Synthetic coursework', kind: 'folder' })
  const recovery = new RecoveryStore(join(profile, 'recovery')), draft = randomUUID()
  await recovery.write({ id: draft, name: 'Offline notes.txt', text: 'ION_ARCHIVED_DRAFT', originalPath: join(workspace, 'notes.txt') })
  await new LearningService(join(profile, 'learning.json')).recordTopic('arrays', 'selected')
  const themes = new ThemeStore(profile, resolve('src/main/themes/palettes'))
  const theme = await themes.create(JSON.parse(await readFile(resolve('src/main/themes/palettes/dark.json'), 'utf8')))
  const catalog = join(profile, 'fixture-catalog'); await mkdir(catalog); await writeFile(join(catalog, 'index.json'), '[]')
  const packPath = join(profile, 'fixture-pack.json')
  await writeFile(packPath, JSON.stringify({ schema: 1, id: 'acceptance-notes', name: 'Acceptance study notes', version: 1,
    summary: 'Original synthetic offline material.', lessons: [{ id: 'branches', title: 'Acceptance branches', section: 'Syntax',
      explanation: 'ION_OFFLINE_LESSON', example: 'if (ready) start();', api: [{ name: 'if', description: 'Choose a branch.' }], practice: 'Write a condition.' }] }))
  const packs = new LearningPackStore(profile, catalog, '0.9.8'); await packs.importFile(packPath); await packs.select('acceptance-notes', false)
  const practice = new PracticeStore(join(profile, 'practice'))
  const problem = await practice.save({ title: 'Acceptance practice', statement: 'Print 2.', sourceUrl: '', difficulty: 'Easy', topic: 'Basics', completion: 'In progress',
    notes: 'ION_PERSONAL_NOTES', samples: [{ id: randomUUID(), label: 'Sample', input: '', expectedOutput: '2' }] })
  const created = await practice.createAttempt(problem.id, 'Edited offline attempt')
  await writeFile(await practice.openAttempt(problem.id, created.attempt.id), '/* ION_ATTEMPT_SOURCE */\nint main(void) { return 2; }\n')
  // Persisted synthetic historical evidence; this is not a claimed compiler execution.
  await practice.runSamples(problem.id, created.attempt.id, async () => [{ status: 'success', compiler: '/fixture/not-executed', compileOutput: '', programOutput: '2',
    programStdout: '2', programStderr: '', exitCode: 0, durationMs: 1, message: 'Synthetic historical evidence.' }])
  const repository = new ProjectRepository(join(profile, 'projects-v1')), plan = structuredClone(planningCases[0].reviewed)
  plan.milestones[0].status = 'in-progress'
  const record = await repository.save(workspace, plan, null), approved = await repository.approve(workspace, plan.tests[0], record.revision)
  await repository.evidence(workspace, unavailableTest(plan.tests[0], 'ION_HISTORICAL_TEST'), approved.revision)
  const trust = new RunTrustStore(join(profile, 'run-trust.json')); await trust.remember(await trust.snapshot(workspace))
  for (const name of ['planning-provider-v1.json', 'Login Data']) await writeFile(join(profile, name), 'SYNTHETIC_CREDENTIAL_DO_NOT_COPY')
  return { draft, theme: theme.id, problem: problem.id, attempt: created.attempt.id, plan: plan.title, source: await practice.openAttempt(problem.id, created.attempt.id) }
}
