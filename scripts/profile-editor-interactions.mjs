import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { arch, cpus, release, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { gzip } from 'node:zlib'
import { median } from './benchmark-resource-metrics.mjs'
import {
  artifact, atPath, close, createProject, desktopWindowsVisible, editorShows, launch, openFolder, openFromExplorer,
  resourceSnapshot, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'
import { windowsProcessTree } from './windows/process-tree.mjs'

const { values } = parseArgs({ options: {
  baseline: { type: 'string' }, candidate: { type: 'string', default: 'dist' },
  samples: { type: 'string', default: '12' }, 'profile-samples': { type: 'string', default: '3' },
  mode: { type: 'string', default: 'both' },
  out: { type: 'string', default: 'performance-results/editor-interactions' }, help: { type: 'boolean' },
} })
if (values.help) {
  console.log('node scripts/profile-editor-interactions.mjs --baseline path/to/dist [--candidate dist] [--samples 12] [--profile-samples 3] [--mode both|timing|diagnostic] [--out path]')
  process.exit(0)
}
assert.ok(values.baseline, 'Pass the preserved production build with --baseline.')
assert.match(values.mode, /^(both|timing|diagnostic)$/)
function boundedCount(value, limit) {
  const result = Number(value)
  assert.ok(Number.isInteger(result) && result > 0 && result <= limit)
  return result
}
const samples = boundedCount(values.samples, 60)
const profileSamples = boundedCount(values['profile-samples'], 10)
const output = resolve(values.out)
const mac = process.platform === 'darwin'
const modifier = mac ? 'Meta' : 'Control'
const undo = modifier + '+z'
const redo = mac ? 'Meta+Shift+z' : 'Control+y'
const editorRoot = '[data-testid="editor"] .monaco-editor'
const editMarker = 'ION_INTERACTION_EDIT'
const tabMarker = 'ION_INTERACTION_TAB'
const openMarker = 'ION_INTERACTION_OPEN'
const inlineNeedle = 'ION_PROFILE_FIND'
const replaceNeedle = 'ION_PROFILE_REPLACED'
const searchNeedle = 'ION_PROFILE_WORKSPACE'
const zip = promisify(gzip)

function summary(values) {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b)
  const percentile = (fraction) => ordered[Math.ceil(ordered.length * fraction) - 1] ?? null
  return { count: ordered.length, median: median(ordered), p95: percentile(.95), p99: percentile(.99), max: ordered.at(-1) ?? null }
}

async function installObserver(page) {
  await page.evaluate(({ editorRoot, editMarker }) => {
    let sequence = 0
    const lineRoot = `${editorRoot} .view-lines`
    const contains = (needle) => Array.from(document.querySelectorAll(`${lineRoot} .view-line`))
      .some((line) => line.textContent?.includes(needle))
    window.ionProfile = {
      arm(spec) {
        const started = []
        const measured = []
        let frame
        let timer
        let awaitingFrame = false
        let end
        let fail
        this.done = new Promise((resolve, reject) => { end = resolve; fail = reject })
        void this.done.catch(() => {})
        const marker = (id, phase) => { if (spec.trace) performance.mark(`ion:${spec.name}:${id}:${phase}`) }
        const viewport = () => document.querySelector(`${editorRoot} .lines-content`)?.style.top
        function cleanup() {
          clearTimeout(timer)
          cancelAnimationFrame(frame)
          document.removeEventListener(spec.event, onEvent, true)
        }
        function ready(sample) {
          const condition = spec.condition
          if (condition === 'line') return contains(spec.needle) === !spec.absent && (!spec.also || contains(spec.also))
          if (condition === 'gone') return !document.querySelector(spec.result) && contains(spec.needle)
          if (condition === 'element') return Boolean(document.querySelector(spec.result))
          if (condition === 'count') return document.querySelector(spec.result)?.textContent?.includes(spec.needle)
          if (condition === 'scroll') return viewport() !== sample.scroll
          if (condition === 'burst') {
            const line = document.querySelector(`${lineRoot} .view-line`)?.textContent
            if (!line?.includes(editMarker)) return false
            const suffix = line.slice(line.indexOf(editMarker) + editMarker.length)
            const letters = suffix.length
            return spec.removing ? letters <= sample.expected : letters >= sample.expected
          }
          return false
        }
        function observe() {
          awaitingFrame = false
          const now = performance.now()
          for (const sample of started) {
            if (sample.readyAt === undefined && ready(sample)) {
              sample.readyAt = now
              marker(sample.id, 'ready')
            } else if (sample.readyAt !== undefined && sample.frameAt === undefined) {
              sample.frameAt = now
              marker(sample.id, 'frame')
              measured.push({ id: sample.id, queueMs: sample.queueMs, readyMs: sample.readyAt - sample.time,
                frameMs: now - sample.time, repeat: sample.repeat })
            }
          }
          if (measured.length === spec.count) {
            cleanup()
            end(measured)
          } else if (started.some((sample) => sample.frameAt === undefined)) schedule()
        }
        function schedule() {
          if (awaitingFrame) return
          awaitingFrame = true
          frame = requestAnimationFrame(observe)
        }
        function onEvent(event) {
          if (started.length >= spec.count || (spec.key && event.key?.toLowerCase() !== spec.key)
            || (spec.selector && (!(event.target instanceof Element) || !event.target.closest(spec.selector)))) return
          const id = ++sequence
          const time = performance.now()
          marker(id, 'start')
          started.push({ id, time, scroll: spec.condition === 'scroll' ? viewport() : undefined,
            queueMs: Math.max(0, time - event.timeStamp), repeat: event.repeat ?? false,
            expected: spec.removing ? spec.count - started.length - 1 : started.length + 1 })
          schedule()
        }
        document.addEventListener(spec.event, onEvent, true)
        timer = setTimeout(() => {
          cleanup()
          fail(new Error(`${spec.name} observed ${started.length} of ${spec.count} inputs and ${measured.length} view updates.`))
        }, 4500)
      },
    }
  }, { editorRoot, editMarker })
}

async function runActions({ page, app }, fixture, count, cdp) {
  const operations = {}
  const editor = page.locator(editorRoot)
  const active = page.locator(`${editorRoot} .view-lines .view-line`).first()
  const keyboard = (key, condition = 'line', extra = {}) => ({ event: 'keydown', key, selector: editorRoot, condition, ...extra })
  const line = (needle, absent = false) => ({ needle, absent })
  const mark = 'Z_IonUndoProfile'
  const editorReady = async (text) => (await editorShows(page, text)).dispose()
  async function focusFirstLine() {
    await editor.click({ position: { x: 100, y: 28 } })
    await page.keyboard.press(mac ? 'Meta+ArrowUp' : 'Control+Home')
    await active.filter({ hasText: editMarker }).waitFor()
    await active.click()
    await page.keyboard.press(mac ? 'Meta+ArrowRight' : 'End')
  }
  async function resetSource() {
    const tab = atPath(page, 'tab', fixture.program)
    const discard = page.getByRole('button', { name: 'Discard', exact: true })
    await atPath(page, 'close-tab', fixture.program).click()
    await Promise.race([discard.waitFor(), tab.waitFor({ state: 'detached' })])
    if (await discard.isVisible()) await discard.click()
    await tab.waitFor({ state: 'detached' })
    await openFromExplorer(page, fixture.program, editMarker)
    await focusFirstLine()
  }
  const tabButton = (path) => atPath(page, 'tab', path).locator('.tab-name')
  const findDialog = page.getByTestId('editor').getByRole('dialog', { name: 'Find / Replace' })
  const findInput = findDialog.getByPlaceholder('Find', { exact: true })
  const findCount = `${editorRoot} .find-widget .matchesCount`
  async function openFind() {
    await focusFirstLine()
    await page.keyboard.press(modifier + '+f')
    await findInput.waitFor()
    await findInput.fill('')
    await editor.locator('.find-widget .matchesCount').filter({ hasText: /1200/ }).waitFor({ state: 'hidden' })
  }
  async function insertPaste(text) {
    await page.evaluate((contents) => {
      const transfer = new DataTransfer()
      transfer.setData('text/plain', contents)
      document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }))
    }, text)
  }
  async function record(name, detail, repetitions, step) {
    const observed = []
    const before = cdp && await cdp.send('Runtime.getHeapUsage')
    for (let iteration = 0; iteration < repetitions; iteration++) {
      try {
        await step(async (spec, action) => {
          await page.evaluate((payload) => window.ionProfile.arm(payload), { name, trace: Boolean(cdp), count: 1, ...spec })
          await action()
          observed.push(...await page.evaluate(() => window.ionProfile.done))
        }, iteration)
      } catch (error) { throw new Error(`Profiling ${name}, repetition ${iteration + 1} failed.`, { cause: error }) }
    }
    const after = cdp && await cdp.send('Runtime.getHeapUsage')
    operations[name] = { detail, samples: observed, readyMs: summary(observed.map((sample) => sample.readyMs)),
      frameMs: summary(observed.map((sample) => sample.frameMs)), ...(before && { heapBefore: before, heapAfter: after }) }
  }

  await openFromExplorer(page, fixture.tab, tabMarker)
  await openFromExplorer(page, fixture.program, editMarker)
  await installObserver(page)
  await focusFirstLine()
  const burst = count * 4
  await record('typing', 'Continuous lower-case input in a C comment. 12 ms requested key cadence.', 1, async (measure) => {
    await measure(keyboard('z', 'burst', { count: burst }), () => page.keyboard.type('z'.repeat(burst), { delay: 12 }))
  })
  await record('backspace-repeat', 'Repeated Backspace keydown events at a requested 12 ms cadence.', 1, async (measure) => {
    await measure(keyboard('backspace', 'burst', { count: burst, removing: true }), async () => {
      for (let index = 0; index < burst; index++) {
        await page.keyboard.down('Backspace')
        if (index !== burst - 1) await sleep(12)
      }
      await page.keyboard.up('Backspace')
    })
  })
  assert.ok(operations['backspace-repeat'].samples.filter(({ repeat }) => repeat).length >= burst - 1)
  await resetSource()

  for (const size of [100, 5000]) {
    const needle = `ION_PROFILE_PASTE_END_${size}`
    const pasted = Array.from({ length: size }, (_, index) => index === size - 1 ? '// ' + needle : `// pasted line ${index + 1}`).join('\n')
    await record(`paste-${size}`, `Paste ${size} text lines through Monaco’s DOM clipboard handler.`, count, async (measure) => {
      await focusFirstLine()
      await measure({ event: 'paste', condition: 'line', selector: editorRoot, ...line(needle) }, () => insertPaste(pasted))
      await resetSource()
    })
  }

  await record('undo', 'Undo one inserted text operation.', count, async (measure) => {
    await focusFirstLine()
    await page.keyboard.insertText(mark)
    await editorReady(mark)
    await measure(keyboard('z', 'line', { ...line(mark, true), also: editMarker }), () => page.keyboard.press(undo))
  })
  await resetSource()
  await record('redo', 'Redo the reverted operation and observe the restored line.', count, async (measure) => {
    await focusFirstLine()
    await page.keyboard.insertText(mark)
    await editorReady(mark)
    await page.keyboard.press(undo)
    await focusFirstLine()
    assert.ok(!(await active.textContent()).includes(mark), 'Redo starts with the edit undone.')
    await measure(keyboard(mac ? 'z' : 'y', 'line', line(mark)), () => page.keyboard.press(redo))
    await page.keyboard.press(undo)
    await focusFirstLine()
  })
  await record('select-all', 'Select the full C model and observe the editor’s selection decoration.', count, async (measure) => {
    await focusFirstLine()
    await measure(keyboard('a', 'element', { result: `${editorRoot} .selected-text` }), () => page.keyboard.press(modifier + '+a'))
    await page.keyboard.press('ArrowLeft')
  })
  await record('tab-switch', 'Switch between two opened source tabs using the tab strip.', count, async (measure, index) => {
    const target = index % 2 === 0 ? fixture.tab : fixture.program
    const needle = index % 2 === 0 ? tabMarker : editMarker
    await measure({ event: 'pointerdown', condition: 'line', selector: '[data-testid="tab"]', ...line(needle) },
      () => tabButton(target).click())
  })
  await tabButton(fixture.program).click()
  await focusFirstLine()
  const opener = atPath(page, 'explorer-entry', fixture.opened)
  const closer = atPath(page, 'close-tab', fixture.opened)
  await record('file-open', 'Open and close the same previously unopened source path through Explorer. OS caches retained after the first open.',
    count, async (measure) => {
      await measure({ event: 'pointerdown', condition: 'line', selector: '[data-testid="explorer-entry"]', ...line(openMarker) }, () => opener.click())
      await closer.click()
      await editorReady(editMarker)
    })
  await record('tab-close', 'Close a clean active source tab and restore the prior editor view.', count, async (measure) => {
    await opener.click()
    await editorReady(openMarker)
    await measure({ event: 'pointerdown', condition: 'gone', selector: '[data-testid="close-tab"]',
      result: `[data-testid="tab"][data-path=${JSON.stringify(fixture.opened)}]`, ...line(editMarker) }, () => closer.click())
  })

  await record('inline-find', 'Run Monaco Find for a token that occurs 1,200 times.', count, async (measure) => {
    await openFind()
    await measure({ event: 'input', condition: 'count', selector: `${editorRoot} .find-widget`, result: findCount, needle: '1200' },
      () => findInput.fill(inlineNeedle))
    await page.keyboard.press('Escape')
  })
  await record('replace-all', 'Replace all 1,200 token occurrences, then undo outside the sample.', count, async (measure) => {
    await openFind()
    await findInput.fill(inlineNeedle)
    await editor.locator('.find-widget .matchesCount').filter({ hasText: /1200/ }).waitFor()
    const toggle = findDialog.getByRole('button', { name: 'Toggle Replace' })
    const replacement = findDialog.getByPlaceholder('Replace', { exact: true })
    if (!await replacement.isVisible()) await toggle.click()
    await replacement.fill(replaceNeedle)
    await measure({ event: 'pointerdown', condition: 'line', selector: `${editorRoot} .find-widget`, ...line(replaceNeedle) },
      () => findDialog.getByRole('button', { name: /Replace All/ }).click())
    await page.keyboard.press('Escape')
    await focusFirstLine()
    await page.keyboard.press(undo)
    await editorReady(inlineNeedle)
  })

  await record('workspace-search', 'Search the saved 1,000-file fixture for a unique token. Includes Ion’s debounce and child process work.',
    count, async (measure) => {
      await page.getByRole('button', { name: 'Search in Files', exact: true }).click()
      const input = page.getByTestId('workspace-search-input')
      await input.waitFor()
      await measure({ event: 'input', condition: 'element', selector: '[data-testid="workspace-search-input"]',
        result: '[data-testid="workspace-search-file"]' }, () => input.fill(searchNeedle))
      await input.press('Escape')
    })

  await focusFirstLine()
  const box = await editor.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + box.width * .55, box.y + box.height * .5)
  await record('wheel-scroll', 'Wheel event to changed editor viewport offset plus the next animation callback.', count, async (measure, index) => {
    await measure({ event: 'wheel', condition: 'scroll', selector: editorRoot }, () => page.mouse.wheel(0, index % 2 ? -480 : 480))
  })
  assert.deepEqual(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((window) => window.isVisible())),
    [desktopWindowsVisible()])
  return operations
}

async function readTrace(cdp, stream) {
  const chunks = []
  try {
    for (;;) {
      const result = await cdp.send('IO.read', { handle: stream, size: 1024 * 1024 })
      chunks.push(Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8'))
      if (result.eof) return Buffer.concat(chunks)
    }
  } finally { await cdp.send('IO.close', { handle: stream }) }
}

const metricNames = ['RunTask', 'EventDispatch', 'FunctionCall', 'UpdateLayoutTree', 'Layout', 'Paint', 'FireAnimationFrame', 'TimerFire']

function traceEvidence(rawTrace, profile, operations) {
  const events = JSON.parse(rawTrace).traceEvents
  const intervals = new Map()
  const nativePhaseNames = ['keydown', 'input', 'render', 'inputlatency']
  const nativeStarts = new Map()
  const nativeMeasures = []
  for (const event of events) {
    if (event.name?.startsWith('ion:')) {
      const [, operation, id, phase] = event.name.split(':')
      const key = `${operation}:${id}`
      const time = intervals.get(key) ?? { pid: event.pid, tid: event.tid }
      time[phase] = event.ts
      intervals.set(key, time)
    } else if (event.cat === 'blink.user_timing' && nativePhaseNames.includes(event.name) && event.id2?.local) {
      const key = `${event.pid}:${event.tid}:${event.name}:${event.id2.local}`
      if (event.ph === 'b') nativeStarts.set(key, event)
      if (event.ph === 'e') {
        const start = nativeStarts.get(key)
        if (start) nativeMeasures.push({ name: start.name, pid: start.pid, tid: start.tid, start: start.ts, end: event.ts })
        nativeStarts.delete(key)
      }
    }
  }
  const relevant = events.filter((event) => event.ph === 'X' && metricNames.includes(event.name))
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map(profile.nodes.flatMap((node) => (node.children ?? []).map((child) => [child, node.id])))
  let timestamp = profile.startTime
  const cpu = (profile.samples ?? []).map((id, index) => {
    timestamp += profile.timeDeltas?.[index] ?? 0
    return { id, timestamp, us: profile.timeDeltas?.[index] ?? 0 }
  })
  const stack = (id) => {
    const frames = []
    while (id && frames.length < 12) {
      const item = nodes.get(id)?.callFrame
      if (item) frames.push({ name: item.functionName || '(anonymous)', url: item.url, line: item.lineNumber + 1, column: item.columnNumber + 1 })
      id = parents.get(id)
    }
    return frames
  }
  for (const [operation, result] of Object.entries(operations)) {
    const windows = result.samples.map(({ id }) => intervals.get(`${operation}:${id}`))
    assert.ok(windows.every((item) => Number.isFinite(item?.start) && Number.isFinite(item?.frame)), `Missing trace marks for ${operation}`)
    const measurements = windows.map(({ start, ready, frame, pid, tid }) => {
      const entries = relevant.filter((event) => event.pid === pid && event.tid === tid && event.ts < frame && event.ts + event.dur > start)
      const durations = Object.fromEntries(metricNames.map((name) => [name, entries.filter((event) => event.name === name)
        .reduce((sum, event) => sum + Math.min(frame, event.ts + event.dur) - Math.max(start, event.ts), 0) / 1000]))
      const tasks = entries.filter((event) => event.name === 'RunTask').map((event) => event.dur / 1000)
      const calls = entries.filter((event) => event.name === 'FunctionCall' && event.args?.data?.url)
        .sort((a, b) => b.dur - a.dur).slice(0, 4).map((event) => ({ ...event.args.data, durationMs: event.dur / 1000 }))
      return { durationMs: (frame - start) / 1000, readyMs: (ready - start) / 1000, durations, calls,
        maxIntersectingTaskMs: Math.max(0, ...tasks), tasksAbove50Ms: tasks.filter((task) => task > 50).length }
    })
    const hot = new Map()
    for (const sample of cpu) {
      const node = nodes.get(sample.id)?.callFrame
      if (!node?.url || !windows.some(({ start, frame }) => sample.timestamp >= start && sample.timestamp <= frame)) continue
      const total = hot.get(sample.id) ?? { samples: 0, approximateMs: 0 }
      total.samples++
      total.approximateMs += sample.us / 1000
      hot.set(sample.id, total)
    }
    result.trace = { measurements, topJs: [...hot].sort((a, b) => b[1].samples - a[1].samples).slice(0, 5)
      .map(([id, counts]) => ({ ...counts, stack: stack(id) })) }
    if (operation === 'typing') {
      const phases = nativeMeasures.filter(({ name, start, pid, tid }) => name === 'inputlatency'
        && windows.some((window) => window.pid === pid && window.tid === tid && start >= window.start && start - window.start < 2_000))
      const durations = nativePhaseNames.map((name) => [name, summary(nativeMeasures.filter((event) => event.name === name
        && phases.some(({ start, end, pid, tid }) => event.pid === pid && event.tid === tid && event.start >= start && event.end <= end))
        .map(({ start, end }) => (end - start) / 1000))])
      result.trace.monacoInputMs = Object.fromEntries(durations)
    }
  }
  return { eventCount: events.length, rendererCpuSamples: cpu.length, traceMarkerCount: intervals.size,
    sampledCpuClockOverlapsActionWindows: Object.values(operations).some((entry) => entry.trace.topJs.length) }
}

async function runTrial(target, label, mode, fixture, scratch) {
  const profilePath = join(scratch, `${label}-${mode}`)
  await mkdir(profilePath)
  await writeFile(join(profilePath, 'preferences.json'), JSON.stringify({ version: 1,
    settings: { theme: 'dark', autoSave: false, openFullScreen: false, resourceProfile: 'minimal' } }))
  const session = await launch(target, profilePath)
  let cdp
  let success = false
  try {
    const { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: fixture.directory })
    await openFolder(page, fixture)
    const window = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio }))
    let trace
    if (mode === 'diagnostic') {
      cdp = await page.context().newCDPSession(page)
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.setSamplingInterval', { interval: 1000 })
      await cdp.send('Tracing.start', { transferMode: 'ReturnAsStream', traceConfig: { includedCategories: [
        'toplevel', 'devtools.timeline', 'blink.user_timing', 'v8', 'disabled-by-default-devtools.timeline',
      ] } })
      await cdp.send('Profiler.start')
    }
    const processTree = () => process.platform === 'win32' ? windowsProcessTree(session) : resourceSnapshot(session, { details: true })
    const before = await processTree()
    const operations = await runActions(session, fixture, mode === 'diagnostic' ? profileSamples : samples, cdp)
    if (cdp) {
      const finished = new Promise((done) => cdp.once('Tracing.tracingComplete', done))
      await cdp.send('Tracing.end')
      const [{ stream }, { profile }] = await Promise.all([finished, cdp.send('Profiler.stop')])
      assert.ok(stream, 'Chromium did not return a trace stream.')
      const traceBytes = await readTrace(cdp, stream)
      trace = traceEvidence(traceBytes, profile, operations)
      await Promise.all([
        zip(traceBytes).then((bytes) => writeFile(join(output, `${label}.trace.json.gz`), bytes)),
        writeFile(join(output, `${label}.cpuprofile`), JSON.stringify(profile)),
      ])
    }
    const after = await processTree()
    await sleep(1000)
    const settled = await processTree()
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    success = true
    return { window, operations, trace, startupMs: session.startupMs, processTree: { before, after, settled } }
  } finally {
    await cdp?.detach().catch(() => undefined)
    if (success) {
      const path = atPath(session.page, 'tab', fixture.program)
      const discard = session.page.getByRole('button', { name: 'Discard', exact: true })
      await atPath(session.page, 'close-tab', fixture.program).click()
      await Promise.race([discard.waitFor(), path.waitFor({ state: 'detached' })])
      if (await discard.isVisible()) await discard.click()
      await path.waitFor({ state: 'detached' })
    } else {
      await session.app.evaluate(({ BrowserWindow }) => {
        for (const window of BrowserWindow.getAllWindows()) window.destroy()
      }).catch(() => undefined)
    }
    await close(session)
  }
}

await mkdir(output, { recursive: true })
await withScratch('editor-interactions', async (scratch) => {
  const fixture = await createProject(join(scratch, 'workspace'), { medium: true, fileCount: 0 })
  fixture.tab = join(fixture.directory, 'tab-sample.c')
  fixture.opened = join(fixture.directory, 'open-sample.c')
  await Promise.all([
    writeFile(fixture.program, '// ' + editMarker + '\n' + Array.from({ length: 1200 }, (_, index) =>
      `static const unsigned value_${index} = ${index}u; // ${inlineNeedle}\n`).join('')),
    writeFile(fixture.tab, `// ${tabMarker}\nint tab_example(void) { return 7; }\n`),
    writeFile(fixture.opened, `// ${openMarker}\nint open_example(void) { return 9; }\n`),
    writeFile(join(fixture.directory, 'workspace-search.txt'), `${searchNeedle}\n`),
  ])
  const targets = await Promise.all([['baseline', values.baseline], ['candidate', values.candidate]].map(async ([label, path]) => {
    const target = await artifact(path)
    assert.ok(!target.path.endsWith('.app'), 'Use unpackaged production builds with the Electron harness.')
    return { label, target, mainSha256: createHash('sha256').update(await readFile(target.args[0])).digest('hex') }
  }))
  const report = {
    environment: { platform: process.platform, arch: arch(), osRelease: release(), cpu: cpus()[0]?.model, ramBytes: totalmem(),
      visible: desktopWindowsVisible(), profile: 'minimal', offline: true },
    method: 'DOM event capture to first animation callback observing the expected view or UI state, then the following callback. Hidden runs do not measure physical key-to-photon latency. Timing trials arm an event listener and start view verification on input. Trace and V8 profiles are captured in a separate diagnostic trial. Memory is sampled, not an allocation peak. Percentiles use nearest rank except the median. An individual operation may have a small sample count, so tail values are descriptive.',
    samples, profileSamples, targets: Object.fromEntries(targets.map(({ label, target, mainSha256 }) => [label, { path: target.path, mainSha256 }])),
  }
  for (const mode of values.mode === 'both' ? ['timing', 'diagnostic'] : [values.mode]) {
    for (const { label, target } of targets) {
      const result = await runTrial(target, label, mode, fixture, scratch)
      report.targets[label][mode] = result
      console.log(`${label} ${mode}`, Object.fromEntries(Object.entries(result.operations).map(([name, item]) => [name, item.frameMs])))
      await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2) + '\n')
    }
  }
  console.log(output)
})
