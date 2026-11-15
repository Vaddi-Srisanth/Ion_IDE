import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { setTimeout as sleep } from 'node:timers/promises'
import { createDesktopStartupObserver, desktopStartupObserverFor, rendererStartupSnapshot } from './desktop-startup-observer.mjs'

function browser() {
  const document = new EventTarget()
  document.fonts = { status: 'loaded' }
  const navigation = [{ startTime: 0, domInteractive: 13, loadEventEnd: 21 }]
  const resources = [
    { name: 'app://workbench/assets/MonacoSurface-hash.js', startTime: 30, duration: 9, initiatorType: 'script' },
    { name: 'https://secret.example/private?token=do-not-keep', startTime: 31, duration: 8, initiatorType: 'fetch' },
    { name: 'app://workbench/private/notes.js?secret=hidden', startTime: 32, duration: 7, initiatorType: 'script' },
  ]
  let ticks = 100
  const context = createContext({ document, URL, performance: { now: () => ++ticks,
    getEntriesByType: name => name === 'navigation' ? navigation : name === 'resource' ? resources
      : [{ name: 'first-contentful-paint', startTime: 18, duration: 0 }] } })
  const page = { async evaluate(fn, input) {
    context.input = input
    return structuredClone(runInContext('(' + fn.toString() + ')(input)', context))
  } }
  return { page, document, resources, context }
}

test('controller stages use one monotonic origin; real asynchronous completion is observed without polling', async () => {
  const observer = createDesktopStartupObserver()
  observer.mark('launch-requested')
  await sleep(8)
  observer.mark('electron-launch-resolved')
  observer.mark('first-window-resolved')
  observer.mark('start-locator-wait-requested')
  const boundary = performance.now()
  observer.mark('start-locator-observed', boundary)
  const rows = observer.report.phases
  assert.equal(rows[0].ms, 0)
  assert.ok(rows[1].ms > 0)
  assert.ok(rows.every((row, index) => !index || row.ms >= rows[index - 1].ms))
  assert.deepEqual(rows.map(row => row.name), ['launch-requested', 'electron-launch-resolved', 'first-window-resolved',
    'start-locator-wait-requested', 'start-locator-observed'])
  assert.match(observer.report.interpretation, /independent origin/)
  await observer.dispose()
})

test('file timing records preserve supplied aggregate boundary, retain failures and enforce bounds', async () => {
  let time = 100
  const observer = createDesktopStartupObserver({ now: () => time })
  observer.mark('launch-requested', 100)
  const open = observer.beginFile(140)
  open.mark('click-resolved', 150)
  open.mark('tab-observed', 160)
  open.mark('text-observed', 180)
  open.finish('complete', 40)
  assert.deepEqual(observer.report.fileOpens[0], { sequence: 1, startedMs: 40, phases: [
    { name: 'click-requested', ms: 0 }, { name: 'click-resolved', ms: 10 },
    { name: 'tab-observed', ms: 20 }, { name: 'text-observed', ms: 40 }], status: 'complete', durationMs: 40 })
  observer.beginFile(200).finish('failed', 8000)
  assert.equal(observer.report.fileOpens[1].status, 'failed')
  assert.equal(observer.report.fileOpens[1].durationMs, 8000)
  for (let i = 0; i < 100; i++) { time++; observer.mark('bounded'); observer.beginFile(time) }
  assert.equal(observer.report.phases.length, 64)
  assert.equal(observer.report.fileOpens.length, 32)
  assert.equal(observer.report.truncated, true)
  await observer.dispose()
  const count = observer.report.phases.length
  observer.mark('ignored')
  assert.equal(observer.beginFile(), null)
  assert.equal(observer.report.phases.length, count)
})

test('real DOM event subscription is bounded, sanitized and removed by the idempotent disposer', async () => {
  const { page, document, resources } = browser()
  const observer = createDesktopStartupObserver({ now: () => 1 })
  observer.mark('launch-requested')
  await observer.attach(page)
  assert.equal(desktopStartupObserverFor(page), observer)
  let explored = false
  document.closest = () => explored
  document.dispatchEvent(new Event('click'))
  explored = true
  for (let i = 0; i < 100; i++) document.dispatchEvent(new Event('click'))
  for (let i = 0; i < 100; i++) resources.push({ name: 'file:///Users/private/secret.txt', duration: 1 })
  await observer.readRenderer()
  const report = observer.report.renderer
  assert.equal(report.clicks.length, 32)
  assert.equal(report.clicks[0].ms, 101)
  assert.equal(report.clicksTruncated, true)
  assert.equal(report.resources.length, 64)
  assert.equal(report.resourcesTruncated, true)
  assert.equal(report.resources[0].route, 'MonacoSurface-hash.js')
  assert.equal(report.resources[1].route, 'other')
  assert.equal(report.resources[2].route, 'local-resource')
  assert.equal(report.navigation[0].domInteractive, 13)
  assert.equal(report.fontStatus, 'loaded')
  assert.doesNotMatch(JSON.stringify(report), /secret|private|Users|token=|https:/)
  await observer.dispose()
  await observer.dispose()
  assert.equal(desktopStartupObserverFor(page), undefined)
  const clicks = report.clicks.length
  document.dispatchEvent(new Event('click'))
  await observer.readRenderer()
  assert.equal(observer.report.renderer.clicks.length, clicks)
  assert.equal(observer.report.disposed, true)
})

test('unavailable renderer diagnostics are explicitly recorded without swallowing application errors or retaining exception text', async () => {
  const observer = createDesktopStartupObserver()
  const page = { async evaluate() { throw new Error('/private/path?secret=credential') } }
  await observer.attach(page)
  for (let i = 0; i < 10; i++) await observer.readRenderer()
  await observer.dispose()
  assert.equal(observer.report.errors.length, 8)
  assert.equal(observer.report.truncated, true)
  assert.equal(observer.report.renderer, null)
  assert.doesNotMatch(JSON.stringify(observer.report), /private|credential/)
  assert.equal(desktopStartupObserverFor(page), undefined)
})

test('snapshot-only read installs no listeners or window state', () => {
  const { context, document } = browser()
  let installed = 0
  const original = document.addEventListener
  document.addEventListener = function (...args) { installed++; return original.apply(this, args) }
  context.input = { key: '__test' }
  runInContext('(' + rendererStartupSnapshot.toString() + ')(input)', context)
  assert.equal(installed, 0)
  assert.equal(context.__test, undefined)
})

test('a stalled inspection transport cannot indefinitely block diagnostic attach, snapshot or disposal', async () => {
  const observer = createDesktopStartupObserver({ diagnosticTimeoutMs: 10 })
  const page = { evaluate() { return new Promise(() => {}) } }
  const began = performance.now()
  await observer.attach(page)
  await observer.readRenderer()
  await observer.dispose()
  assert.ok(performance.now() - began >= 20, 'Actual diagnostic deadlines elapsed.')
  assert.deepEqual(observer.report.errors.map(row => row.status), ['timeout', 'timeout', 'timeout'])
  assert.deepEqual(observer.report.errors.map(row => row.stage), ['renderer-attach', 'renderer-snapshot', 'renderer-dispose'])
  assert.equal(desktopStartupObserverFor(page), undefined)
  assert.equal(observer.report.disposed, true)
  assert.throws(() => createDesktopStartupObserver({ diagnosticTimeoutMs: 0 }), /deadline/)
})
