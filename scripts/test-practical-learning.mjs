import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, close, editorShows, eventually, launch, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, out: { type: 'string', default: 'performance-results/practical-learning.json' },
  'require-toolchains': { type: 'boolean', default: false },
} })
const target = await artifact(values.target)
const output = resolve(values.out)
await mkdir(dirname(output), { recursive: true })
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const report = { complete: false, platform: process.platform, arch: process.arch, lanes: [], unavailable: [] }
const persist = () => writeFile(output, JSON.stringify(report, null, 2) + '\n')
await persist()

const solutions = {
  c: {
    marker: 'total += value;',
    source: '#include <stdio.h>\nint main(void) {\n    int upper;\n    if (scanf("%d", &upper) != 1) return 1;\n    int total = 0;\n    for (int value = 1; value <= upper; value++) {\n        if (value % 3 == 0) total += value;\n    }\n    printf("%d\\n", total);\n    return 0;\n}\n',
    unavailable: /^A local C compiler is required\./,
  },
  python: {
    marker: 'range(upper, 0, -1)',
    source: 'upper = int(input())\nfor value in range(upper, 0, -1):\n    if value % 3 == 0:\n        print(value)\n',
    unavailable: /^A local Python 3 interpreter is required\./,
  },
  java: {
    marker: 'Math.max(largest, input.nextInt())',
    source: 'import java.util.Scanner;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner input = new Scanner(System.in);\n        int count = input.nextInt();\n        int largest = input.nextInt();\n        for (int i = 1; i < count; i++) {\n            largest = Math.max(largest, input.nextInt());\n        }\n        System.out.println(largest);\n    }\n}\n',
    unavailable: /^A local Java JDK is required\./,
  },
}

async function activePath(page) {
  return page.locator('[data-testid="tab"] .tab-name[aria-current="true"]')
    .evaluate(node => node.closest('[data-path]').dataset.path)
}

async function replaceSource(page, source, marker) {
  await page.getByTestId('editor').locator('.monaco-editor .view-line').first().click({ position: { x: 12, y: 7 } })
  await page.keyboard.press(modifier + '+a')
  // CDP insertText is an IME-style insertion, not a user paste; its multiline
  // Undo grouping differs in stock Monaco. Exercise the existing paste command
  // as the previously verified Undo control does, without touching OS clipboard.
  await page.evaluate(async text => {
    const url = performance.getEntriesByType('resource').map(entry => entry.name).find(name => /\/editor\.api-[^/]+\.js$/.test(name))
    if (!url) throw new Error('The already-loaded Monaco module is unavailable.')
    const { editor } = await import(url)
    const instance = editor.getEditors().find(item => item.getDomNode()?.closest('[data-testid="editor"]'))
    if (!instance) throw new Error('The existing active source editor is unavailable.')
    instance.focus()
    instance.trigger('clipboard', 'paste', { text, pasteOnNewLine: false, multicursorText: null })
  }, source)
  await (await editorShows(page, marker)).dispose()
}

try {
  await withScratch('practical-learning', async (scratch) => {
    const profile = join(scratch, 'profile')
    await mkdir(profile)
    // Explicit saves let the fixture distinguish unsaved editor content from
    // the saved revision to which real sample reports apply.
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
      settings: { autoSave: false, saveBeforeRun: true, openFullScreen: false }, recents: [] }))
    const session = await launch(target, profile)
    let primaryFailure
    try {
      const { app, page } = session
      await page.context().setOffline(true)
      await stubDialogs(app, { allowRun: true })
      await page.getByTestId('workspace-learn').click()
      const learn = page.getByTestId('learning-pane')
      assert.equal((await learn.locator('.learning-nav-item').first().textContent()).trim(), 'Topics')
      assert.equal((await page.evaluate(() => window.ion.learningPacks.getLibrary())).selected, null)

      for (const [language, solution] of Object.entries(solutions)) {
        const lane = { language, status: 'running', phase: 'select-language' }
        report.lanes.push(lane)
        await persist()
        await learn.getByTestId('learning-language').selectOption(language)
        await eventually(async () => await learn.getByTestId('learning-language').isEnabled()
          && (await page.evaluate(() => window.ion.learningPacks.getLibrary(false))).selected === language,
        language + ' selection did not settle.')
        const definition = await page.evaluate(id => window.ion.learningPacks.getLesson(id, 'flow'), language)
        assert.ok(definition.objective && definition.starter !== undefined && definition.hints.length > 1)
        const before = await page.evaluate(id => window.ion.learning.getLearningActivity(id, 'flow'), language)
        await learn.locator('[data-testid="learning-topic"][data-topic="flow"]').click()
        const lesson = learn.getByTestId('learning-pack-lesson')
        const practical = lesson.getByTestId('learning-practical-exercise')
        await practical.getByTestId('learning-objective').getByText(definition.objective, { exact: true }).waitFor()
        await practical.getByTestId('learning-follow-up').waitFor()
        for (const [index, hint] of definition.hints.entries()) {
          await practical.getByTestId('learning-reveal-hint').click()
          await practical.getByTestId('learning-hints').getByText(hint, { exact: true }).waitFor()
          await eventually(async () =>
            (await page.evaluate(id => window.ion.learning.getLearningActivity(id, 'flow'), language)).hintsRevealed === before.hintsRevealed + index + 1,
          language + ' hint event did not persist.')
        }
        assert.equal(await practical.getByTestId('learning-reveal-hint').isDisabled(), true)
        const activity = await page.evaluate(id => window.ion.learning.getLearningActivity(id, 'flow'), language)
        assert.ok(activity.opened > before.opened)
        assert.equal('mastered' in activity, false)
        lane.activity = activity

        lane.phase = 'open-exercise'
        await practical.getByTestId('learning-start-exercise').click()
        await eventually(() => practical.getByTestId('learning-run-samples').isEnabled(), language + ' exercise did not open.')
        await page.locator('[data-testid="workspace"][data-mode="learn"]').waitFor()
        assert.equal(await page.getByTestId('practice-pane').count(), 0, 'Opening a practical exercise must retain the lesson beside code.')
        const path = await activePath(page)
        assert.equal(await readFile(path, 'utf8'), definition.starter)
        const initial = await page.evaluate(id => window.ion.learning.getLearningTaskEvidence(id, 'flow'), language)
        assert.equal(initial.attemptCount, 1)
        assert.equal(initial.manualStatus, 'Not started')
        assert.equal(initial.samples, null)
        // The exercise button settles before Documents.open finishes its read
        // and Monaco model activation. Never type into the previous model.
        lane.phase = 'wait-starter-model'
        await persist()
        await (await editorShows(page, 'TODO:')).dispose()
        const editor = page.getByTestId('editor').locator('.monaco-editor')
        await editor.evaluate((element, id) => { element.dataset.practicalFixture = id }, language)
        lane.phase = 'replace-starter'
        await persist()
        await replaceSource(page, solution.source, solution.marker)
        lane.phase = 'undo-solution'
        await persist()
        await page.keyboard.press(modifier + '+z')
        await (await editorShows(page, 'TODO:')).dispose()
        assert.equal(await readFile(path, 'utf8'), definition.starter, 'Unsaved solution/Undo must not alter the source on disk.')
        lane.phase = 'redo-solution'
        await persist()
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y')
        await (await editorShows(page, solution.marker)).dispose()
        assert.equal(await editor.getAttribute('data-practical-fixture'), language)

        lane.phase = 'run-real-samples'
        await practical.getByTestId('learning-run-samples').click()
        // Derived from the existing compilation limit and per-case execution
        // limits, including Windows cleanup guards; this does not change them.
        const deadline = 15_000 + 4_000 + definition.exercise.samples.length * (5_000 + 4_000)
        await (await page.waitForFunction(() => {
          const root = document.querySelector('[data-testid="learning-practical-exercise"]')
          return Boolean(root?.querySelector('[data-testid="practice-results"], [role="alert"]'))
        }, undefined, { timeout: deadline })).dispose()
        const error = practical.getByRole('alert')
        if (await error.count()) assert.fail(await error.textContent())
        await eventually(() => practical.getByTestId('learning-run-samples').isEnabled(), 'Sample execution did not finish cleanup.')
        const evidence = await page.evaluate(id => window.ion.learning.getLearningTaskEvidence(id, 'flow'), language)
        const problem = await page.evaluate(id => window.ion.practice.get(id), evidence.problemId)
        const last = problem.attempts.at(-1).lastRun
        assert.ok(last && evidence.samples)
        lane.evidence = evidence
        lane.results = last.results
        assert.equal(evidence.manualStatus, 'Not started')
        assert.equal('mastered' in evidence, false)
        assert.equal(await readFile(path, 'utf8'), solution.source)
        const missing = last.results.find(result => result.status === 'unavailable' && solution.unavailable.test(result.message))
        if (missing) {
          assert.equal(evidence.samples.passed, 0)
          lane.status = 'unavailable'
          lane.reason = missing.message
          report.unavailable.push(language)
          console.log('UNAVAILABLE ' + language + ' execution: ' + missing.message)
          await persist()
          continue
        }
        assert.equal(evidence.samples.current, true)
        assert.equal(evidence.samples.total, definition.exercise.samples.length)
        assert.equal(evidence.samples.passed, definition.exercise.samples.length, JSON.stringify(last.results))
        assert.equal(evidence.samples.failed + evidence.samples.unavailable + evidence.samples.skipped, 0)
        await practical.getByTestId('practice-results').getByText(`${last.results.length} of ${last.results.length} passed`, { exact: true }).waitFor()

        lane.phase = 'saved-source-change'
        const marker = language === 'python' ? '# practical-source-changed' : '// practical-source-changed'
        await editor.locator('.view-line').first().click({ position: { x: 8, y: 7 } })
        await page.keyboard.press(modifier + '+End')
        await page.keyboard.insertText('\n' + marker + '\n')
        await page.keyboard.press(modifier + '+s')
        await eventually(async () => (await readFile(path, 'utf8')).includes(marker), 'The explicit save did not finish.')
        await practical.getByTestId('learning-refresh-evidence').click()
        await practical.getByTestId('learning-sample-evidence').getByText('Saved source or samples changed since that run.', { exact: false }).waitFor()
        const stale = await page.evaluate(id => window.ion.learning.getLearningTaskEvidence(id, 'flow'), language)
        assert.equal(stale.samples.current, false)
        assert.equal(stale.samples.testedAt, evidence.samples.testedAt)
        assert.equal(stale.manualStatus, 'Not started')
        const changedSource = await readFile(path, 'utf8')
        await practical.getByTestId('learning-start-exercise').click()
        await eventually(() => practical.getByTestId('learning-run-samples').isEnabled(), 'The existing exercise did not reopen.')
        assert.equal(await activePath(page), path)
        assert.equal(await readFile(path, 'utf8'), changedSource)
        assert.deepEqual(await page.evaluate(id => window.ion.learning.getLearningTaskEvidence(id, 'flow'), language), stale)
        assert.equal(await editor.getAttribute('data-practical-fixture'), language, 'Learning actions must preserve the existing editor instance.')
        lane.status = 'verified'
        lane.phase = 'complete'
        lane.staleEvidence = stale
        console.log('PASS ' + language + ': real saved sample execution, graduated hints, source/Undo preservation and honest stale evidence')
        await persist()
      }
      assert.deepEqual(session.requests, [], 'Practical learning made a network request.')
      assert.deepEqual(session.errors, [], 'Practical learning raised an uncaught renderer error.')
    } catch (error) {
      primaryFailure = error
      report.failure = String(error.message ?? error).slice(0, 1500)
      console.error('Practical-learning primary failure:', report.lanes.at(-1)?.phase, report.failure)
      await persist()
      throw error
    } finally {
      // Only this disposable test profile is involved. Honor normal editor
      // recovery instead of allowing its unsaved dialog to mask a prior error.
      const closing = close(session)
      const keep = session.page.getByRole('dialog', { name: 'Unsaved changes', exact: true })
        .getByRole('button', { name: 'Keep Drafts and Quit', exact: true })
      await Promise.race([closing.then(() => false, () => false),
        keep.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)])
        .then(async visible => { if (visible) await keep.click() })
      try { await closing }
      catch (error) {
        report.cleanupFailure = String(error.message ?? error).slice(0, 1500)
        await persist()
        if (primaryFailure) throw new AggregateError([primaryFailure, error], 'Practical learning and cleanup both failed.')
        throw error
      }
    }
  })
  report.complete = report.lanes.length === 3 && report.lanes.every(lane => lane.status === 'verified')
  await persist()
  if (values['require-toolchains']) assert.deepEqual(report.unavailable, [], 'Required local toolchains were unavailable; execution was not verified.')
} catch (error) {
  report.failure ??= String(error.message ?? error).slice(0, 1500)
  await persist()
  throw error
}
console.log(output)
