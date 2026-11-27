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
const entry = Object.entries(bundle.metafile.outputs).find(([, info]) => info.entryPoint?.endsWith('/BreadthFirstSearchWalkthrough.tsx'))
assert.ok(entry, 'Breadth-first search should compile into a separate renderer chunk.')
const chunk = basename(entry[0])
const files = new Map(bundle.outputFiles.map(file => [basename(file.path), file.text]))
files.set('shell.css', await readFile('src/renderer/styles.css', 'utf8'))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 250, height: 620 } })
  const origin = 'http://ion-practice-bfs.test', requested = [], unexpected = [], errors = []
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
  const entryButton = page.getByRole('button', { name: 'Walk through breadth-first search' })
  await entryButton.waitFor()
  assert.equal(requested.includes(chunk), false)
  assert.deepEqual(await page.evaluate(() => window.practiceCalls), ['list'])
  await entryButton.press('Enter')
  const walkthrough = page.getByRole('region', { name: 'Breadth-first search' })
  await walkthrough.getByRole('heading', { name: 'Breadth-first search' }).waitFor()
  await walkthrough.getByRole('list', { name: 'Directed graph adjacency list' }).waitFor()
  const states = walkthrough.getByRole('list', { name: 'Node states' })
  const traversal = walkthrough.getByRole('region', { name: 'Traversal state' })
  const status = walkthrough.getByRole('status')
  const next = walkthrough.getByRole('button', { name: 'Next step' })
  const previous = walkthrough.getByRole('button', { name: 'Previous step' })
  const reset = walkthrough.getByRole('button', { name: 'Reset traversal' })
  assert.equal(requested.filter(name => name === chunk).length, 1)
  assert.equal(await traversal.locator('dd').nth(0).innerText(), 'A')
  assert.equal(await traversal.locator('dd').nth(1).innerText(), 'B, C')
  assert.equal(await traversal.locator('dd').nth(2).innerText(), 'A, B, C')
  assert.equal(await states.getByRole('listitem', { name: 'B, queued' }).count(), 1)
  await next.click()
  assert.equal(await traversal.locator('dd').nth(0).innerText(), 'B')
  assert.equal(await traversal.locator('dd').nth(1).innerText(), 'C, D, E')
  await next.click()
  assert.equal(await traversal.locator('dd').nth(0).innerText(), 'C')
  assert.equal(await traversal.locator('dd').nth(1).innerText(), 'D, E, F')
  await next.click(); await next.click()
  await status.getByText(/F was already marked/).waitFor()
  assert.equal((await traversal.locator('dd').nth(2).innerText()).match(/F/g)?.length, 1)
  await next.click()
  await status.getByText('Traversal complete').waitFor()
  assert.equal(await traversal.locator('dd').nth(1).innerText(), 'Empty')
  assert.equal(await next.isDisabled(), true)
  const complexity = walkthrough.getByRole('region', { name: 'Complexity analysis' })
  await complexity.getByText('O(V + E): each reachable node and outgoing edge is examined at most once.').waitFor()
  await complexity.getByText('O(V) for the queue and discovered set.').waitFor()
  assert.equal(await previous.isDisabled(), false)
  await reset.click()
  assert.equal(await traversal.locator('dd').nth(0).innerText(), 'A')
  const start = walkthrough.getByRole('combobox', { name: 'Start node' })
  await start.selectOption('C')
  assert.equal(await traversal.locator('dd').nth(0).innerText(), 'C')
  assert.equal(await traversal.locator('dd').nth(1).innerText(), 'F')
  const scroll = page.locator('.practice-scroll')
  assert.equal(await scroll.evaluate(element => element.scrollWidth <= element.clientWidth), true)
  const back = page.getByRole('button', { name: 'Back to Browse' })
  await back.press('Enter')
  await entryButton.waitFor()
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('Walk through breadth-first search'))
  assert.deepEqual(await page.evaluate(() => window.practiceCalls), ['list'])
  assert.deepEqual(unexpected, [])
  assert.deepEqual(errors, [])
  console.log('PASS offline BFS walkthrough queue order, duplicate discovery, complexity, lazy load and keyboard return')
} finally { await browser.close() }
