import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, launch, openFolder,
  stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)

await withScratch('workspace-search', async (scratch) => {
  const project = await createProject(join(scratch, 'Search workspace'), { medium: true })
  const profile = join(scratch, 'profile')
  const nested = join(project.directory, 'nested folder')
  const source = join(nested, 'Result 😀.c')
  const notes = join(project.directory, 'Course notes.md')
  await Promise.all([mkdir(profile), mkdir(nested)])
  await Promise.all([
    writeFile(source, '// title\n\n// α😀 needle.search*\n// needle.search* again\n'),
    writeFile(notes, '# Notes\n\nneedle.search*\n'),
    writeFile(join(nested, 'ignored.txt'), 'needle.search*\n'),
    writeFile(join(nested, '.gitignore'), 'ignored.txt\n'),
  ])
  const session = await launch(target, profile)
  try {
    const { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory })
    await openFolder(page, project)
    const openSearch = page.getByRole('button', { name: 'Search in Files', exact: true })
    const input = page.getByTestId('workspace-search-input')
    const samples = []
    const dialogSamples = []
    for (let iteration = 0; iteration < 5; iteration++) {
      const opened = performance.now()
      await openSearch.click()
      await input.waitFor()
      dialogSamples.push(performance.now() - opened)
      const started = performance.now()
      await input.fill('needle.search*')
      await page.getByText('3 matching lines in 2 files.', { exact: true }).waitFor()
      samples.push(performance.now() - started)
      assert.equal(await page.getByTestId('workspace-search-file').count(), 2)
      assert.equal(await atPath(page, 'workspace-search-file', source).getByRole('button').count(), 2)
      if (iteration !== 4) await input.press('Escape')
    }
    await atPath(page, 'workspace-search-file', source).getByRole('button', { name: /line 3/ }).click()
    await atPath(page, 'tab', source).waitFor()
    await editorShows(page, 'needle.search*')
    await page.getByText('Ln 3, Col 8', { exact: true }).waitFor()
    await openSearch.click()
    await input.fill('unfinished search')
    const cancelStarted = performance.now()
    await page.getByRole('button', { name: 'Cancel search' }).click()
    await page.getByText('Search cancelled.', { exact: true }).waitFor()
    const cancelResponseMs = performance.now() - cancelStarted
    await input.fill('needle.search*')
    await page.getByText('3 matching lines in 2 files.', { exact: true }).waitFor()
    await atPath(page, 'workspace-search-file', notes).getByRole('button', { name: /line 3/ }).click()
    await atPath(page, 'tab', notes).waitFor()
    await editorShows(page, 'needle.search*')
    await page.getByTestId('markdown-preview-toggle').click()
    await page.getByRole('button', { name: 'Show Markdown source', exact: true }).waitFor()
    await openSearch.click()
    await input.fill('needle.search*')
    await page.getByText('3 matching lines in 2 files.', { exact: true }).waitFor()
    await atPath(page, 'workspace-search-file', notes).getByRole('button', { name: /line 3/ }).click()
    await page.getByRole('button', { name: 'Show Markdown preview', exact: true }).waitFor()
    await page.getByText('Ln 3, Col 1', { exact: true }).waitFor()
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    console.log('PASS offline grouped workspace search, ignore rules, cancellation and source navigation')
    const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]
    console.log(JSON.stringify({ searchableFiles: 1016, matchedFiles: 2, matchingLines: 3,
      searchInputToResultsMs: samples, medianMs: median, dialogReadyMs: dialogSamples, debounceMs: 160, cancelResponseMs }))
  } finally {
    await close(session)
  }
})
