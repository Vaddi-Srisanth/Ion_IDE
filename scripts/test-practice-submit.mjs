import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, close, editorShows, eventually, launch, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const notes = 'Check the quotient and the remaining minutes.'
const correct = 'print(*divmod(int(input()), 60))\n'
const runTimeout = 90_000

async function replaceSource(page, code) {
  await page.getByTestId('editor').locator('.monaco-editor .view-line').first().click({ position: { x: 12, y: 7 } })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.insertText(code)
  await (await editorShows(page, code.split('\n')[0])).dispose()
}

async function openPractice(page) {
  await page.context().setOffline(true)
  await page.getByTestId('workspace-practice').click()
  await page.getByTestId('practice-language').waitFor()
}

async function savedProblem(page, id) {
  return page.evaluate(problemId => window.ion.practice.get(problemId), id)
}

function checkPrivateShape(row) {
  assert.deepEqual(Object.keys(row).sort(), ['judgedAt', 'verdict', 'passed', 'total', 'runtimeMs', 'current'].sort())
  assert.ok(row.judgedAt > 0 && row.runtimeMs >= 0)
}

await withScratch('practice-local-submit', async scratch => {
  const profile = join(scratch, 'profile')
  const first = await launch(target, profile)
  let id, path, visibleReport, savedHistory
  try {
    const { app, page } = first
    await stubDialogs(app, { allowRun: true })
    await openPractice(page)
    const challenge = page.locator('[data-testid="practice-challenge"][data-challenge="minutes-to-clock"]')
    const search = page.getByRole('searchbox', { name: 'Search by title or topic' })
    assert.equal(await page.getByTestId('practice-challenge').count(), 0)
    await search.fill('MINUTES TO CLOCK')
    await search.press('Enter')
    await challenge.waitFor()
    assert.equal(await challenge.getByTestId('practice-start').count(), 0)
    await search.fill('bAsIcS')
    await search.press('Enter')
    await page.getByRole('heading', { name: 'Matches for “bAsIcS”' }).waitFor()
    await challenge.waitFor()
    await page.getByRole('button', { name: 'Clear search' }).click()
    await challenge.waitFor({ state: 'detached' })
    assert.equal(await search.inputValue(), '')
    await page.getByTestId('practice-language').selectOption('python')
    await page.getByTestId('practice-difficulty').selectOption('Easy')
    await challenge.getByTestId('practice-start').click()
    const submit = page.getByRole('button', { name: 'Local Submit', exact: true })
    await submit.waitFor()
    await (await editorShows(page, 'Write your solution here.')).dispose()
    id = await page.getByTestId('practice-problem').inputValue()
    path = await page.locator('[data-testid="tab"] .tab-name[aria-current="true"]').evaluate(node => node.closest('[data-path]').dataset.path)
    await page.getByTestId('practice-edit').click()
    await page.getByTestId('practice-notes').fill(notes)
    await page.getByLabel('Manual completion status').selectOption('In progress')
    await page.getByTestId('practice-save').click()
    await page.getByTestId('practice-saved-notes').filter({ hasText: notes }).waitFor()
    const { samples } = await savedProblem(page, id)
    const answers = Object.fromEntries(samples.map(sample => [sample.input.trim(), sample.expectedOutput.trim()]))
    const hardcoded = 'answers = ' + JSON.stringify(answers) + '\nprint(answers.get(input().strip(), "unknown"))\n'
    await replaceSource(page, hardcoded)
    await page.getByTestId('practice-run-samples').click()
    const samplePasses = page.getByTestId('practice-results').getByText(samples.length + ' of ' + samples.length + ' passed', { exact: true })
    await samplePasses.waitFor({ timeout: runTimeout })
    assert.equal(await readFile(path, 'utf8'), hardcoded)
    visibleReport = (await savedProblem(page, id)).attempts[0].lastRun
    await submit.click()
    const history = page.getByRole('region', { name: 'Local submission history' })
    const wrong = history.getByRole('listitem').filter({ hasText: 'Wrong answer' })
    await wrong.getByText('Matched the saved file at last check.').waitFor({ timeout: runTimeout })
    const firstAttempt = (await savedProblem(page, id)).attempts[0]
    const [miss] = firstAttempt.submissions
    checkPrivateShape(miss)
    assert.ok(miss.passed < miss.total)
    assert.deepEqual(firstAttempt.lastRun, visibleReport)
    assert.equal(await history.locator('pre,details').count(), 0)
    console.log('PASS a solution hardcoded to visible examples passes samples and fails the offline judge')

    // This scratch marker proves the user presses Stop after the approved interpreter starts.
    const marker = join(scratch, 'interpreter-started')
    const waiting = 'import time\nopen(' + JSON.stringify(marker) + ', "w").close()\ntime.sleep(30)\n'
    await replaceSource(page, waiting)
    await submit.click()
    await eventually(() => access(marker).then(() => true, () => false), 'Submitted Python never started.', runTimeout)
    await page.getByTestId('practice-stop').click()
    await page.getByTestId('practice-pane').getByRole('alert').filter({ hasText: /stopped|cancelled|aborted/i }).waitFor({ timeout: runTimeout })
    const afterStop = (await savedProblem(page, id)).attempts[0]
    assert.deepEqual(afterStop.submissions, [{ ...miss, current: false }])
    assert.equal(afterStop.lastRun.testedAt, visibleReport.testedAt)
    console.log('PASS stopping the running Python process preserves submission and sample history')

    await replaceSource(page, correct)
    await submit.click()
    const accepted = history.getByRole('listitem').filter({ hasText: 'Accepted' })
    await accepted.getByText('Matched the saved file at last check.').waitFor({ timeout: runTimeout })
    await wrong.getByText(/Historical result/).waitFor()
    assert.equal(await readFile(path, 'utf8'), correct)
    const completed = await savedProblem(page, id)
    assert.equal(completed.completion, 'In progress')
    assert.equal(completed.notes, notes)
    assert.deepEqual(completed.attempts[0].lastRun, { ...visibleReport, current: false })
    savedHistory = completed.attempts[0].submissions
    assert.equal(savedHistory.length, 2)
    savedHistory.forEach(checkPrivateShape)
    const hit = savedHistory.find(row => row.verdict === 'accepted')
    assert.ok(hit && hit.passed === hit.total && hit.current)
    assert.deepEqual(first.requests, [])
    assert.deepEqual(first.errors, [])
    console.log('PASS a saved divmod solution is accepted while manual completion and public sample results are preserved')
  } finally {
    await close(first)
  }

  const reopened = await launch(target, profile)
  try {
    const { page } = reopened
    await openPractice(page)
    await page.getByTestId('practice-saved-tab').click()
    await page.getByTestId('practice-problem').selectOption(id)
    const history = page.getByRole('region', { name: 'Local submission history' })
    await history.getByRole('button', { name: 'Refresh history' }).click()
    await history.getByText('Accepted', { exact: true }).waitFor()
    await history.getByText('Wrong answer', { exact: true }).waitFor()
    await page.getByTestId('practice-results').getByText('Saved source or samples changed since this run.').waitFor()
    await page.getByTestId('practice-saved-notes').filter({ hasText: notes }).waitFor()
    await page.getByText(/Manual status · In progress/).waitFor()
    const restored = await savedProblem(page, id)
    assert.deepEqual(restored.attempts[0].submissions, savedHistory)
    assert.deepEqual(restored.attempts[0].lastRun, { ...visibleReport, current: false })
    await page.getByTestId('practice-open-attempt').click()
    await (await editorShows(page, correct.trim())).dispose()
    assert.equal(await readFile(path, 'utf8'), correct)
    assert.deepEqual(reopened.requests, [])
    assert.deepEqual(reopened.errors, [])
    console.log('PASS both verdicts, the previous sample run, source, notes and manual status survive offline relaunch')
  } finally {
    await close(reopened)
  }
})
