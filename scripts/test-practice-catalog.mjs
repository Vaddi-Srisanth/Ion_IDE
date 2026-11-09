import assert from 'node:assert/strict'
import { mkdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, close, editorShows, launch, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, screenshots: { type: 'string' },
} })
const target = await artifact(values.target)
const screenshots = values.screenshots ? resolve(values.screenshots) : null
if (screenshots) await mkdir(screenshots, { recursive: true })
const capture = (page, name) => screenshots ? page.screenshot({ path: join(screenshots, name + '.png') }) : Promise.resolve()
const sources = {
  python: 'import sys\nm = int(sys.stdin.read())\nprint(m // 60, m % 60)\n',
  javascript: "const m = Number(require('node:fs').readFileSync(0, 'utf8'));\nconsole.log(Math.floor(m / 60), m % 60);\n",
  c: '#include <stdio.h>\nint main(void) {\n  long long m;\n  if (scanf("%lld", &m) != 1) return 1;\n  printf("%lld %lld\\n", m / 60, m % 60);\n  return 0;\n}\n',
  cpp: '#include <iostream>\nint main() {\n  long long m;\n  if (!(std::cin >> m)) return 1;\n  std::cout << m / 60 << " " << m % 60 << "\\n";\n}\n',
  java: 'import java.util.Scanner;\npublic class Main {\n  public static void main(String[] args) {\n    long m = new Scanner(System.in).nextLong();\n    System.out.println((m / 60) + " " + (m % 60));\n  }\n}\n',
}
const extensions = { python: 'py', javascript: 'js', c: 'c', cpp: 'cpp', java: 'java' }
const challenge = (page) => page.locator('[data-testid="practice-challenge"][data-challenge="minutes-to-clock"]')
const readLibrary = (page) => page.evaluate(() => window.ion.practice.list())
const replaceSource = async (page, content) => {
  const editor = page.getByTestId('editor').locator('.monaco-editor .view-line').first()
  await editor.click({ position: { x: 12, y: 7 } })
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
  await page.keyboard.insertText(content)
  await (await editorShows(page, content.split('\n')[0])).dispose()
}
async function openPractice(page) {
  await page.context().setOffline(true)
  await page.getByTestId('workspace-practice').click()
  await page.getByTestId('practice-language').waitFor()
}
async function filters(page, language, topic = 'Basics') {
  await page.getByTestId('practice-language').selectOption(language)
  await page.getByTestId('practice-topic').selectOption(topic)
  await page.getByTestId('practice-difficulty').selectOption('Easy')
  await challenge(page).waitFor()
}

await withScratch('practice-catalog', async (scratch) => {
  const profile = join(scratch, 'profile')
  const first = await launch(target, profile)
  let pythonId
  let pythonPath
  try {
    const { app, page } = first
    await stubDialogs(app, { allowRun: true })
    await openPractice(page)
    assert.equal(await page.getByTestId('practice-form').count(), 0)
    assert.equal(await page.getByTestId('practice-language').inputValue(), '')
    await filters(page, '')
    await challenge(page).getByTestId('practice-view-problem').click()
    const preview = page.getByTestId('practice-challenge-preview')
    await preview.getByText('Minutes to Clock', { exact: true }).waitFor()
    assert.match(await preview.getByTestId('practice-problem-statement').textContent(), /Constraints/i)
    await preview.getByTestId('practice-sample-definitions').waitFor()
    assert.deepEqual((await readLibrary(page)).problems, [])
    await capture(page, 'browse-topic-only')
    console.log('PASS fresh Practice shows filters and a complete challenge preview without a language or manual fields')

    for (const [language, source] of Object.entries(sources)) {
      if (language === 'python') {
        await page.getByTestId('practice-language').selectOption(language)
        await preview.getByTestId('practice-start').click()
      } else {
        await page.getByTestId('practice-browse-tab').click()
        await filters(page, language)
        await challenge(page).getByTestId('practice-start').click()
      }
      await page.getByTestId('practice-run-samples').waitFor()
      await (await editorShows(page, 'Write your solution here.')).dispose()
      const activePath = await page.locator('[data-testid="tab"] .tab-name[aria-current="true"]')
        .evaluate((node) => node.closest('[data-path]').dataset.path)
      assert.ok(activePath.endsWith('.' + extensions[language]))
      if (language === 'java') assert.ok(activePath.endsWith('/Main.java'))
      const list = await readLibrary(page)
      const item = list.problems.find((row) => row.title === 'Minutes to Clock' && row.language === language)
      assert.ok(item)
      const problem = await page.evaluate((id) => window.ion.practice.get(id), item.id)
      assert.equal(problem.attempts.length, 1)
      assert.ok(problem.samples.length >= 3)
      if (language === 'python') {
        pythonId = item.id
        pythonPath = activePath
        await page.getByTestId('practice-run-samples').click()
        await page.getByTestId('practice-results').getByText(`0 of ${problem.samples.length} passed`, { exact: true }).waitFor()
      }
      await replaceSource(page, source)
      await page.getByTestId('practice-run-samples').click()
      await page.getByTestId('practice-results').getByText(`${problem.samples.length} of ${problem.samples.length} passed`, { exact: true }).waitFor()
      const withoutIndent = (code) => code.replace(/^[ \t]+/gm, '').trim()
      assert.equal(withoutIndent(await readFile(activePath, 'utf8')), withoutIndent(source))
      if (language === 'python') await capture(page, 'sample-results')
      console.log(`PASS ${language} starter opens, saves and executes ${problem.samples.length} supplied test cases`)
    }

    await page.getByTestId('practice-browse-tab').click()
    await filters(page, 'python')
    await challenge(page).getByTestId('practice-start').click()
    await page.getByTestId('practice-results').waitFor()
    await (await editorShows(page, 'import sys')).dispose()
    assert.equal(await readFile(pythonPath, 'utf8'), sources.python)
    assert.equal((await readLibrary(page)).problems.length, Object.keys(sources).length)
    assert.deepEqual(first.requests, [])
    assert.deepEqual(first.errors, [])
    console.log('PASS starting the same challenge resumes its saved attempt without duplicates or overwriting code')
  } finally {
    await close(first)
  }

  const reopened = await launch(target, profile)
  try {
    const { page } = reopened
    await openPractice(page)
    await page.getByTestId('practice-saved-tab').click()
    await page.getByTestId('practice-problem').selectOption(pythonId)
    await page.getByTestId('practice-results').getByText(/([1-9]) of \1 passed/).waitFor()
    await page.getByTestId('practice-open-attempt').click()
    await (await editorShows(page, 'import sys')).dispose()
    assert.deepEqual(reopened.requests, [])
    assert.deepEqual(reopened.errors, [])
    console.log('PASS challenges, code and recorded results survive an offline relaunch')
  } finally {
    await close(reopened)
  }
})
