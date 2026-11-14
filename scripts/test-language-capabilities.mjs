import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, launch, openFolder, openFromExplorer, stubDialogs, withScratch } from './desktop-harness.mjs'
import { installCloseConfirmationProbe, observeUpdateShutdown } from './update-preferences-support.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
const samples = [
  ['c', 'C', 'example.c', 'int main(void) { return 42; }'],
  ['cpp', 'C++', 'upper.C', 'constexpr auto value = "example";'],
  ['java', 'Java', 'Example.java', 'class Example { String value = "example"; }'],
  ['python', 'Python', 'example.py', 'def example(): return "example"'],
  ['javascript', 'JavaScript', 'example.js', 'const example = "example";'],
  ['typescript', 'TypeScript', 'example.ts', 'const example: string = "example";'],
  ['html', 'HTML', 'example.html', '<p title="example">Plain text</p>'],
  ['css', 'CSS', 'example.css', '.example { color: red; width: 42px; }'],
  ['sql', 'SQL', 'example.sql', "SELECT 'example', 42 FROM examples;"],
  ['go', 'Go', 'example.go', 'const example string = "example"'],
  ['rust', 'Rust', 'example.rs', 'let example: &str = "example";'],
  ['csharp', 'C#', 'Example.cs', 'string example = "example";'],
  ['kotlin', 'Kotlin', 'example.kt', 'val example: String = "example"'],
  ['swift', 'Swift', 'example.swift', 'let example: String = "example"'],
  ['php', 'PHP', 'example.php', '<?php echo "example"; ?>'],
  ['ruby', 'Ruby', 'example.rb', 'def example; "example"; end'],
  ['dart', 'Dart', 'example.dart', 'final example = "example";'],
  ['bash', 'Bash / Shell', 'example.sh', 'if true; then echo "example"; fi'],
  ['markdown', 'Markdown', 'example.md', '# Example\n\nPlain text with `code`.'],
  ['json', 'JSON', 'example.json', '{"example": "text", "flag": true}'],
  ['yaml', 'YAML', 'example.yaml', 'example: "text" # comment'],
  ['perl', 'Perl', 'example.pl', 'my $example = "example";'],
  ['xml', 'XML', 'example.xml', '<example id="text">Plain text</example>'],
]

await withScratch('language-capabilities', async (scratch) => {
  const project = await createProject(join(scratch, 'language examples'), { fileCount: 0 })
  await Promise.all(samples.map(([, , name, content]) => writeFile(join(project.directory, name), content + '\n')))
  assert.equal(target.args.length, 1, 'The language diagnostic needs an unpackaged production entry.')
  const entry = join(scratch, 'language-close-probe.cjs')
  await writeFile(entry, `(${installCloseConfirmationProbe.toString()})(require('electron').ipcMain,globalThis,()=>performance.now());require(${JSON.stringify(target.args[0])});`)
  const session = await launch({ ...target, args: [entry] }, join(scratch, 'profile'))
  const { app, page } = session
  const dialog = page.getByRole('dialog', { name: 'Language Support' })
  let primaryError
  const dispose = observeUpdateShutdown(session, async diagnostic => {
    await mkdir('performance-results', { recursive: true })
    await writeFile('performance-results/language-capabilities-failure.json', JSON.stringify({
      ...diagnostic, commit: process.env.GITHUB_SHA ?? null,
      primary: primaryError ? { name: primaryError.name, message: String(primaryError.message).slice(0, 2000) } : null,
    }, null, 2) + '\n')
  })
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    for (const [, label, name, content] of samples) {
      const path = join(project.directory, name)
      await openFromExplorer(page, path, content.split('\n')[0])
      await page.locator('.document-status').getByText(label, { exact: true }).waitFor()
      try {
        const tokens = await page.waitForFunction(() => {
          const spans = document.querySelectorAll('.monaco-editor .view-line span[class*="mtk"]');
          return new Set(Array.from(spans, (span) => getComputedStyle(span).color)).size > 1;
        })
        await tokens.dispose()
      } catch (error) {
        throw new Error(`${label} did not render distinct syntax colors for ${name}.`, { cause: error })
      }
      await atPath(page, 'close-tab', path).click()
    }
    await page.getByTestId('command-palette').click()
    await page.getByTestId('command-palette-input').fill('Language Support')
    await page.getByRole('option', { name: /^Language Support/ }).click()
    await dialog.waitFor()
    const selector = dialog.getByLabel('Language')
    assert.deepEqual(await selector.locator('option').evaluateAll((items) => items.map((item) => [item.value, item.text])),
      samples.map(([id, label]) => [id, label]))
    const detail = (label) => dialog.locator('.setting').filter({ has: page.getByText(label, { exact: true }) }).locator('dd')
    await selector.selectOption('cpp')
    assert.match(await detail('Run Console').textContent(), /\.C$/)
    assert.doesNotMatch(await detail('Run Console').textContent(), /\.hpp/)
    await selector.selectOption('java')
    assert.equal(await detail('Basic suggestions').textContent(), 'Keywords and snippets')
    assert.match(await detail('Semantic tools').textContent(), /JDK 17\+/)
    await selector.selectOption('typescript')
    assert.equal(await detail('Run Console').textContent(), 'Unavailable')
    assert.equal(await detail('Semantic tools').textContent(), 'Unavailable')
    await selector.selectOption('json')
    assert.match(await detail('Format Document').textContent(), /\.json$/)
    assert.doesNotMatch(await detail('Format Document').textContent(), /\.ipynb/)
    await dialog.getByRole('button', { name: 'Done' }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    console.log(`PASS rendered syntax and capability labels for ${samples.length} languages offline`)
  } catch (error) {
    primaryError = error
    await session.onShutdownFailure({ error: 'Language capability fixture failed before close.' })
      .catch(reason => console.error('Language failure receipt unavailable:', String(reason.message).slice(0, 1000)))
    throw error
  } finally {
    let cleanupError
    try {
      if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Close dialog' }).click({ timeout: 1000 })
      await dialog.waitFor({ state: 'detached' })
    } catch (error) {
      cleanupError = error
      await session.onShutdownFailure({ error: 'Language dialog dismissal failed.', message: String(error.message).slice(0, 2000) })
        .catch(reason => console.error('Language dismissal receipt unavailable:', String(reason.message).slice(0, 1000)))
    }
    try { await close(session) } catch (error) { cleanupError ??= error }
    finally { dispose() }
    if (cleanupError) {
      if (primaryError) {
        primaryError.cleanupError = String(cleanupError.message).slice(0, 1000)
        console.error('Language fixture cleanup also failed:', primaryError.cleanupError)
      } else throw cleanupError
    }
  }
})
