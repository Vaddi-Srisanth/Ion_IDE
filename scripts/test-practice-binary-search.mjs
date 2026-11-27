import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const fixture = `
  import { createRoot } from 'react-dom/client'
  import { PracticePane } from './src/renderer/practice/PracticePane'
  window.practiceCalls = []
  const bridge = new Proxy({}, {
    get(_, name) {
      return async () => {
        window.practiceCalls.push(name)
        if (name === 'list') return {problems:[], unavailable:0}
        throw Error('Unexpected practice call: '+name)
      }
    }
  })
  const root = createRoot(document.querySelector('#root'))
  root.render(<PracticePane bridge={bridge} onPrepareRun={async () => false} onOpenEntry={() => {}}
    onClose={() => root.unmount()} />)
`
const bundle = await build({
  stdin: { contents: fixture, loader: 'tsx', resolveDir: resolve('.') },
  bundle: true, jsx: 'automatic', write: false, splitting: true, metafile: true,
  outdir: 'out', entryNames: 'practice', format: 'esm', logLevel: 'silent',
})
const entry = Object.entries(bundle.metafile.outputs).find(([, info]) =>
  info.entryPoint?.endsWith('/BinarySearchWalkthrough.tsx'))
assert.ok(entry, 'Binary search should compile into a separate renderer chunk.')
const lessonModule = basename(entry[0])
const files = new Map(bundle.outputFiles.map(file => [basename(file.path), file.text]))
files.set('shell.css', await readFile('src/renderer/styles.css', 'utf8'))
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 250, height: 600 } })
  const origin = 'http://ion-practice.test'
  const requested = [], unexpected = [], errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.context().setOffline(true)
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    const name = url.pathname.slice(1)
    if (url.origin === origin) {
      requested.push(name)
      if (!name) return route.fulfill({
        contentType: 'text/html',
        body: `<link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/practice.css">
          <div id="root" class="app-shell"></div><script type="module" src="/practice.js"></script>`,
      })
      if (files.has(name)) return route.fulfill({
        contentType: name.endsWith('.css') ? 'text/css' : 'text/javascript', body: files.get(name),
      })
    }
    if (name !== 'favicon.ico') unexpected.push(url.href)
    await route.abort()
  })
  await page.goto(origin)
  const entryButton = page.getByRole('button', { name: 'Walk through binary search' })
  await entryButton.waitFor()
  assert.equal(requested.includes(lessonModule), false)
  assert.deepEqual(await page.evaluate(() => window.practiceCalls), ['list'])
  await entryButton.press('Enter')
  const lesson = page.getByRole('region', { name: 'Binary search' })
  await lesson.getByRole('heading', { name: 'Binary search' }).waitFor()
  const complexity = lesson.getByRole('region', { name: 'Complexity analysis' })
  await complexity.getByText('O(log n) comparisons: each step halves the remaining range.').waitFor()
  await complexity.getByText('O(1) for this iterative version; this excludes the input list.').waitFor()
  await complexity.getByText('These are analytical bounds, not measured timings.').waitFor()
  assert.equal(requested.filter(name => name === lessonModule).length, 1)
  if (entry[1].cssBundle) {
    await page.addStyleTag({ url: origin + '/' + basename(entry[1].cssBundle) })
  }
  const back = page.getByRole('button', { name: 'Back to Browse' })
  assert.equal(await back.evaluate(button => button === document.activeElement), true)
  const range = lesson.locator('.practice-binary-range dd')
  const list = lesson.getByRole('list', { name: 'Sorted values' })
  const status = lesson.getByRole('status')
  const next = lesson.getByRole('button', { name: 'Next step' })
  const previous = lesson.getByRole('button', { name: 'Previous step' })
  const reset = lesson.getByRole('button', { name: 'Reset search' })
  assert.deepEqual(await range.allTextContents(), ['0', '3', '6'])
  assert.equal(await list.getByRole('listitem').count(), 7)
  await list.getByRole('listitem', { name: 'Index 3, value 19, Mid' }).waitFor()
  await status.getByText(/left of mid are too small/).waitFor()
  assert.equal(await previous.isDisabled(), true)
  assert.equal(await reset.isDisabled(), true)
  await next.click()
  await status.getByText(/right of mid are too large/).waitFor()
  assert.deepEqual(await range.allTextContents(), ['4', '5', '6'])
  assert.equal(await list.getByRole('listitem', { name: /eliminated/ }).count(), 4)
  await next.click()
  await status.getByText('Target found').waitFor()
  await status.getByText('27 matches the target. It is at index 4.').waitFor()
  assert.deepEqual(await range.allTextContents(), ['4', '4', '4'])
  assert.equal(await next.isDisabled(), true)
  await previous.click()
  await status.getByText(/right of mid are too large/).waitFor()
  await reset.click()
  assert.deepEqual(await range.allTextContents(), ['0', '3', '6'])
  const target = lesson.getByRole('combobox', { name: 'Target' })
  await next.click()
  await target.selectOption('20')
  assert.deepEqual(await range.allTextContents(), ['0', '3', '6'])
  for (let step = 0; step < 3; step++) await next.click()
  await status.getByText('Target absent').waitFor()
  await status.getByText(/search range is empty/).waitFor()
  assert.deepEqual(await range.allTextContents(), ['4', 'None', '3'])
  assert.equal(await list.getByRole('listitem', { name: /eliminated/ }).count(), 7)
  assert.equal(await next.isDisabled(), true)
  const scroll = page.locator('.practice-scroll')
  assert.equal(await scroll.evaluate(element => element.scrollWidth <= element.clientWidth), true)
  await reset.click()
  assert.equal(await target.inputValue(), '20')
  assert.deepEqual(await range.allTextContents(), ['0', '3', '6'])
  await back.press('Enter')
  await entryButton.waitFor()
  await page.waitForFunction(() => document.activeElement?.textContent?.includes('Walk through binary search'))
  assert.deepEqual(await page.evaluate(() => window.practiceCalls), ['list'])
  assert.deepEqual(unexpected, [])
  assert.deepEqual(errors, [])
  console.log('PASS the offline walkthrough loads on explicit entry and steps through found and absent targets, with bounded controls and keyboard focus.')
} finally {
  await browser.close()
}
