import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const fixture = `
  import { createRoot } from 'react-dom/client'
  import { PracticePane } from './src/renderer/practice/PracticePane'
  window.practiceCalls = []
  const bridge = new Proxy({}, { get(_, name) { return async () => {
    window.practiceCalls.push(name)
    if (name === 'list') return {problems:[], unavailable:0}
    throw Error('Unexpected practice call: '+name)
  } } })
  const root = createRoot(document.querySelector('#root'))
  root.render(<PracticePane bridge={bridge} onPrepareRun={async () => false} onOpenEntry={() => {}}
    onClose={() => root.unmount()} />)
`
const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: resolve('.') },
  bundle: true, jsx: 'automatic', write: false, splitting: true, metafile: true,
  outdir: 'out', entryNames: 'practice', format: 'esm', logLevel: 'silent' })
const entry = Object.entries(bundle.metafile.outputs).find(([, info]) => info.entryPoint?.endsWith('/DijkstraWalkthrough.tsx'))
assert.ok(entry, 'Dijkstra should compile into a separate renderer chunk.')
const chunk = basename(entry[0])
const files = new Map(bundle.outputFiles.map(file => [basename(file.path), file.text]))
files.set('shell.css', await readFile('src/renderer/styles.css', 'utf8'))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 250, height: 620 } })
  const origin = 'http://ion-practice-dijkstra.test', requested = [], unexpected = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.context().setOffline(true)
  await page.route('**/*', async route => {
    const url = new URL(route.request().url()), name = url.pathname.slice(1)
    if (url.origin === origin) {
      requested.push(name)
      if (!name) return route.fulfill({ contentType: 'text/html', body: `<link rel="stylesheet" href="/shell.css">
        <link rel="stylesheet" href="/practice.css"><div id="root" class="app-shell"></div>
        <script type="module" src="/practice.js"></script>` })
      if (files.has(name)) return route.fulfill({ contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: files.get(name) })
    }
    if (name !== 'favicon.ico') unexpected.push(url.href)
    await route.abort()
  })
  await page.goto(origin)
  const entryButton = page.getByRole('button', { name: 'Walk through Dijkstra’s algorithm' })
  await entryButton.waitFor()
  assert.equal(requested.includes(chunk), false)
  assert.deepEqual(await page.evaluate(() => window.practiceCalls), ['list'])
  await entryButton.press('Enter')
  const walkthrough = page.getByRole('region', { name: 'Dijkstra’s shortest-path algorithm' })
  await walkthrough.getByRole('heading', { name: 'Dijkstra’s shortest-path algorithm' }).waitFor()
  await walkthrough.getByRole('list', { name: 'Weighted directed graph adjacency list' }).waitFor()
  const distances = walkthrough.getByRole('list', { name: 'Shortest-path distances' })
  const state = walkthrough.getByRole('region', { name: 'Shortest-path state' })
  const status = walkthrough.getByRole('status')
  const next = walkthrough.getByRole('button', { name: 'Next step' })
  const previous = walkthrough.getByRole('button', { name: 'Previous step' })
  const reset = walkthrough.getByRole('button', { name: 'Reset traversal' })
  assert.equal(requested.filter(name => name === chunk).length, 1)
  assert.equal(await state.locator('dd').nth(0).innerText(), 'A · 0')
  assert.equal(await state.locator('dd').nth(1).innerText(), 'B: 4, C: 1')
  assert.equal(await distances.getByRole('listitem', { name: 'B: distance 4, unsettled' }).count(), 1)
  await next.click()
  assert.equal(await state.locator('dd').nth(0).innerText(), 'C · 1')
  assert.equal(await distances.getByRole('listitem', { name: 'B: distance 3, unsettled' }).count(), 1)
  assert.equal(await state.locator('dd').nth(1).innerText(), 'B: 3, D: 6')
  await next.click()
  assert.equal(await state.locator('dd').nth(0).innerText(), 'B · 3')
  assert.equal(await state.locator('dd').nth(1).innerText(), 'D: 4, E: 10')
  await next.click()
  assert.equal(await state.locator('dd').nth(0).innerText(), 'D · 4')
  assert.equal(await state.locator('dd').nth(1).innerText(), 'E: 7')
  await next.click()
  await status.getByText('Shortest paths complete').waitFor()
  assert.equal(await state.locator('dd').nth(1).innerText(), 'Empty')
  assert.equal(await state.locator('dd').nth(2).innerText(), 'A, C, B, D, E')
  for (const [node, distance] of [['A', '0'], ['B', '3'], ['C', '1'], ['D', '4']]) {
    assert.equal(await distances.getByRole('listitem', { name: `${node}: distance ${distance}, settled` }).count(), 1)
  }
  assert.equal(await distances.getByRole('listitem', { name: 'E: distance 7, current' }).count(), 1)
  assert.equal(await next.isDisabled(), true)
  const complexity = walkthrough.getByRole('region', { name: 'Complexity analysis' })
  await complexity.getByText(/O\(V² \+ E\)/).waitFor()
  await complexity.getByText('O(V) for distances, predecessors and settled nodes; the graph input is excluded.').waitFor()
  assert.equal(await previous.isDisabled(), false)
  await reset.click()
  await walkthrough.getByRole('combobox', { name: 'Start node' }).selectOption('C')
  assert.equal(await state.locator('dd').nth(0).innerText(), 'C · 0')
  assert.equal(await distances.getByRole('listitem', { name: 'A: distance ∞, unreachable so far' }).count(), 1)
  await next.click()
  assert.equal(await state.locator('dd').nth(0).innerText(), 'B · 2')
  assert.equal(await state.locator('dd').nth(1).innerText(), 'D: 3, E: 9')
  await walkthrough.getByRole('combobox', { name: 'Start node' }).selectOption('E')
  await status.getByText('Shortest paths complete').waitFor()
  assert.equal(await state.locator('dd').nth(0).innerText(), 'E · 0')
  assert.equal(await distances.getByRole('listitem', { name: 'A: distance ∞, unreachable so far' }).count(), 1)
  assert.equal(await next.isDisabled(), true)
  const scroll = page.locator('.practice-scroll')
  assert.equal(await scroll.evaluate(element => element.scrollWidth <= element.clientWidth), true)
  const back = page.getByRole('button', { name: 'Back to Browse' })
  await back.press('Enter')
  await entryButton.waitFor()
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('Walk through Dijkstra’s algorithm'))
  assert.deepEqual(await page.evaluate(() => window.practiceCalls), ['list'])
  assert.deepEqual(unexpected, [])
  assert.deepEqual(errors, [])
  console.log('PASS offline Dijkstra walkthrough relaxations, unreachable nodes, bounds, lazy load and keyboard return')
} finally { await browser.close() }
