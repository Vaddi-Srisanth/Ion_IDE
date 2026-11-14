import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, launch, stubDialogs, withScratch } from './desktop-harness.mjs'
import { observeInspectorShutdown } from './inspector-shutdown-observer.mjs'
import { knownShutdownLiveness, observeUpdateShutdown } from './update-preferences-support.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  screenshots: { type: 'boolean' },
  'shutdown-cycles': { type: 'string', default: '0' },
} })
const shutdownCycles = Number(values['shutdown-cycles'])
assert.ok(Number.isSafeInteger(shutdownCycles) && shutdownCycles >= 0 && shutdownCycles <= 20)
const shutdownReport = resolve('performance-results/onboarding-shutdown.json')
const shutdownReceipts = []
async function saveShutdown(receipt) {
  shutdownReceipts.push(receipt)
  if (shutdownReceipts.length > 64) shutdownReceipts.shift()
  await mkdir(dirname(shutdownReport), { recursive: true })
  await writeFile(shutdownReport, JSON.stringify({ diagnostic: true, receipts: shutdownReceipts }, null, 2) + '\n')
}
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use the production build directory for the Electron startup fixtures.')
const entry = target.path.endsWith('.cjs') ? target.path : join(target.path, 'main', 'index.cjs')
const screenshots = values.screenshots ? 'performance-results/master-onboarding/test-screenshots' : null
if (screenshots) await mkdir(screenshots, { recursive: true })
const intro = (page) => page.getByTestId('onboarding-intro')
const onboarding = (page) => page.getByTestId('onboarding')
const skipIntro = (page) => page.getByTestId('onboarding-skip-intro')
const skipSetup = (page) => page.getByTestId('onboarding-skip-setup')
const workspace = (page) => page.getByTestId('workspace')

async function capture(page, name) {
  if (screenshots) await page.screenshot({ path: join(screenshots, `${name}.png`) })
}

async function withProfile(scratch, name, check, options = {}) {
  const { build = target, ...startup } = options
  const session = await launch(build, join(scratch, name), { firstRun: true, ...startup })
  let inspector, dispose, failure
  try {
    inspector = session.inspectorShutdownObserver ?? observeInspectorShutdown(session)
    dispose = observeUpdateShutdown(session, diagnostic => saveShutdown({ name, failure: diagnostic, inspector: inspector.snapshot() }))
    await session.page.context().setOffline(true)
    await check(session)
    assert.deepEqual(session.requests, [], 'Onboarding works without remote requests.')
    assert.deepEqual(session.errors, [], 'Onboarding produced no uncaught renderer errors.')
  } catch (error) {
    failure = error
  } finally {
    try {
      inspector?.setClosing()
      await close(session)
      assert.equal(session.appProcess.exitCode, 0, 'The owned desktop launcher exited normally.')
      assert.equal(session.appProcess.signalCode, null)
      const native = knownShutdownLiveness(session)
      if (process.platform === 'win32') {
        assert.deepEqual(native.alive, [], 'The owned Windows launcher and actual Electron process exited.')
      }
      await saveShutdown({ name, inspector: inspector?.snapshot(), exitCode: session.appProcess.exitCode, native })
    } catch (error) {
      await saveShutdown({ name, inspector: inspector?.snapshot(), error: String(error), detail: error.desktopShutdown })
      failure = failure ? new AggregateError([failure, error], `Onboarding ${name} and shutdown failed.`) : error
    } finally {
      dispose?.()
      inspector?.dispose()
    }
  }
  if (failure) throw failure
}

function playbackAssets(page) {
  return page.evaluate(() => {
    // Chromium omits timing entries for some app:// requests. Vite also records
    // the dynamically preloaded module and stylesheet as links in the head.
    const timed = performance.getEntriesByType('resource').map(({ name }) => name)
    const preloaded = [...document.querySelectorAll('link[href]')].map(({ href }) => href)
    return [...new Set([...timed, ...preloaded])].filter((name) => /\/CinematicIntro[-.]/i.test(name))
  })
}

async function expectNoPlaybackAssets(page) {
  assert.deepEqual(await playbackAssets(page), [], 'This launch must not request cinematic code or styles.')
}

async function expectReducedSetup(page) {
  assert.equal(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true)
  await skipSetup(page).waitFor()
  assert.equal(await intro(page).count(), 0)
  await expectNoPlaybackAssets(page)
}

async function replay(page) {
  await page.getByTestId('settings').click()
  await page.getByRole('dialog', { name: 'Preferences' }).getByTestId('onboarding-replay').click()
}

async function expectTerminalText(page, expected) {
  const result = await page.waitForFunction((marker) => {
    const rows = document.querySelectorAll('[data-testid="run-console-terminal"] .xterm-rows > div')
    return [...rows].map((row) => row.textContent?.replaceAll('\u00a0', ' ')).join('').includes(marker)
  }, expected, { timeout: 15_000 })
  await result.dispose()
}

await withScratch('onboarding', async (scratch) => {
  const project = await createProject(join(scratch, 'onboarding folder λ'), { fileCount: 1 })
  const reducedShim = join(scratch, 'reduced-motion.cjs')
  // Emulate the OS media preference before production App mounts. A renderer
  // command-line switch is not forwarded by Electron on all platforms.
  await writeFile(reducedShim, `const { app } = require('electron');
app.on('browser-window-created', (_event, window) => {
  const loadURL = window.loadURL.bind(window);
  window.loadURL = async (...args) => {
    await loadURL('about:blank');
    const debuggerSession = window.webContents.debugger;
    debuggerSession.attach();
    await debuggerSession.sendCommand('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
    });
    return loadURL(...args);
  };
});
require(${JSON.stringify(entry)});
`)
  const reducedTarget = await artifact(reducedShim)

  // Independent cold profiles, all required to pass. This is a diagnostic
  // stress workload, never a retry or a production performance sample.
  for (let cycle = 0; cycle < shutdownCycles; cycle++) {
    await withProfile(scratch, `shutdown-${cycle}`, async ({ app, page }) => {
      await intro(page).waitFor()
      await skipIntro(page).click()
      await intro(page).waitFor({ state: 'detached' })
      await skipSetup(page).click()
      await onboarding(page).waitFor({ state: 'detached' })
      await stubDialogs(app, { file: project.program })
      await page.getByTestId('welcome').getByTestId('open-file').click()
      await (await editorShows(page, 'ION-DESKTOP-RUN-OK')).dispose()
    })
  }

  await withProfile(scratch, 'skip', async ({ page }) => {
    await intro(page).waitFor()
    assert.ok((await playbackAssets(page)).length > 0, 'The cinematic module or stylesheet must be observable during playback.')
    await skipIntro(page).waitFor()
    await page.keyboard.press('Escape')
    await intro(page).waitFor({ state: 'detached' })
    await page.getByTestId('onboarding-start').waitFor()
    await skipSetup(page).click()
    await onboarding(page).waitFor({ state: 'detached' })
    assert.equal(await page.getByTestId('welcome').getByTestId('new-file').isVisible(), true)
  })
  await withProfile(scratch, 'skip', async ({ app, page }) => {
    assert.equal(await onboarding(page).count(), 0)
    await expectNoPlaybackAssets(page)
    await stubDialogs(app, { file: project.program })
    await page.getByTestId('welcome').getByTestId('open-file').click()
    await (await editorShows(page, 'ION-DESKTOP-RUN-OK')).dispose()
  })
  console.log('PASS first launch, Escape skips playback, and Skip Setup persists across relaunch without loading cinematic assets')

  const legacy = join(scratch, 'legacy')
  const preferences = join(legacy, 'preferences.json')
  const legacyPreferences = JSON.stringify({ version: 1, settings: { fontSize: 19 }, recents: [] })
  await mkdir(legacy)
  await writeFile(preferences, legacyPreferences)
  await withProfile(scratch, 'legacy', async ({ page }) => {
    const actualFontSize = await page.evaluate(async () => (await window.ion.getPreferences()).settings.fontSize)
    assert.equal(actualFontSize, 19)
    assert.equal(await onboarding(page).count(), 0)
    await expectNoPlaybackAssets(page)
    assert.equal(await readFile(preferences, 'utf8'), legacyPreferences, 'Upgrade leaves existing profile settings untouched.')
  })
  console.log('PASS an existing profile opens directly to Welcome with its old preferences and no cinematic assets')

  await withProfile(scratch, 'full-playback', async ({ app, page }) => {
    await intro(page).waitFor()
    const started = performance.now()
    if (screenshots) {
      for (const [offset, frame] of [[1300, 'sun'], [3090, 'blue'], [4750, 'atom'], [7180, 'logo']]) {
        await delay(Math.max(0, offset - (performance.now() - started)))
        await capture(page, frame)
      }
    }
    await page.getByTestId('onboarding-start').waitFor({ timeout: 12_000 })
    const seconds = (performance.now() - started) / 1000
    assert.ok(seconds >= 5.5 && seconds <= 10, `The natural intro duration was ${seconds.toFixed(2)} seconds.`)
    await intro(page).waitFor({ state: 'detached' })
    await capture(page, 'setup')
    await stubDialogs(app, { folder: project.directory })
    await page.getByTestId('onboarding-open-folder').click()
    await workspace(page).waitFor()
    await atPath(page, 'explorer-entry', project.program).waitFor()
    assert.equal(await onboarding(page).count(), 0)
    console.log(`PASS cinematic finishes automatically after ${seconds.toFixed(2)} seconds and Open Existing Folder opens the real workspace`)
  })

  const routes = [
    ['free', null],
    ['learn', 'learning-pane'],
    ['projects', 'projects-panel'],
    ['practice', 'practice-pane'],
  ]
  for (const [mode, panel] of routes) {
    await withProfile(scratch, `reduced-${mode}`, async ({ page }) => {
      await expectReducedSetup(page)
      if (mode === 'free') await capture(page, 'reduced-motion')
      await page.getByTestId(`onboarding-${mode}`).click()
      await page.locator(`[data-testid="workspace"][data-mode="${mode}"]`).waitFor()
      if (panel) await page.getByTestId(panel).waitFor()
      assert.equal(await onboarding(page).count(), 0)
      if (mode === 'free') assert.equal(await page.getByTestId('tab').count(), 0)
    }, { build: reducedTarget })
  }
  console.log('PASS reduced-motion first run loads no cinematic assets and all four workspace actions open their real workspaces')

  await withProfile(scratch, 'starter-and-replay', async ({ app, page }) => {
    await expectReducedSetup(page)
    const saved = join(project.directory, 'hello.c')
    await stubDialogs(app, { save: saved, allowRun: true })
    await page.getByTestId('onboarding-start').click()
    await page.getByRole('dialog', { name: 'New File from Starter' }).getByTestId('starter-c').click()
    await (await editorShows(page, '#include <stdio.h>')).dispose()
    // Inserted multiline text passes through Monaco's automatic indentation.
    const program = '#include <stdio.h>\nint main(void) { char input[64]; '
      + 'fputs("ION-FIRST-RUN> ", stdout); fflush(stdout); '
      + 'if (!fgets(input, sizeof input, stdin)) return 1; '
      + 'printf("ION-FIRST-ANSWER:%s", input); return 0; }\n'
    await page.locator('.monaco-editor .view-line').first().click()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a')
    await page.keyboard.insertText(program)
    await (await editorShows(page, 'ION-FIRST-RUN>')).dispose()
    await page.getByTestId('save-file').click()
    await atPath(page, 'tab', saved).waitFor()
    assert.equal(await readFile(saved, 'utf8'), program)

    await page.getByTestId('run').click()
    await expectTerminalText(page, 'ION-FIRST-RUN>')
    const input = page.getByTestId('run-console-input')
    await input.pressSequentially('hello')
    await input.press('Enter')
    await expectTerminalText(page, 'ION-FIRST-ANSWER:hello')
    await page.locator('[data-testid="output"][data-status="success"]').waitFor()
    console.log('PASS Get Started chooses an editable C starter, saves it, and runs with real interactive input')

    await replay(page)
    const backToIon = onboarding(page).getByRole('button', { name: 'Back to Ion' })
    await backToIon.waitFor()
    assert.equal(await intro(page).count(), 0)
    await expectNoPlaybackAssets(page)
    await capture(page, 'reduced-motion-replay')
    await backToIon.click()
    await onboarding(page).waitFor({ state: 'detached' })

    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await replay(page)
    await intro(page).waitFor()
    await skipIntro(page).click()
    await onboarding(page).waitFor({ state: 'detached' })

    await replay(page)
    await intro(page).waitFor()
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await intro(page).waitFor({ state: 'detached' })
    await backToIon.click()
    await onboarding(page).waitFor({ state: 'detached' })
    await atPath(page, 'tab', saved).waitFor()
    await (await editorShows(page, 'ION-FIRST-RUN>')).dispose()
    await expectTerminalText(page, 'ION-FIRST-ANSWER:hello')
    assert.equal(await readFile(saved, 'utf8'), program)
    console.log('PASS Preferences replay honors reduced motion, skips on click, and preserves editor and Run Console state')

    await page.emulateMedia({ reducedMotion: 'no-preference' })
    const canvasFailure = await page.evaluateHandle(() => {
      const original = HTMLCanvasElement.prototype.getContext
      let attempted = false
      HTMLCanvasElement.prototype.getContext = function (...args) {
        if (args[0] === '2d' && this.closest('[data-testid="onboarding-intro"]')) {
          attempted = true
          return null
        }
        return Reflect.apply(original, this, args)
      }
      return {
        attempted: () => attempted,
        restore: () => { HTMLCanvasElement.prototype.getContext = original },
      }
    })
    try {
      await replay(page)
      await (await page.waitForFunction((failure) => failure.attempted(), canvasFailure)).dispose()
      await onboarding(page).waitFor({ state: 'detached' })
      await atPath(page, 'tab', saved).waitFor()
      await (await editorShows(page, 'ION-FIRST-RUN>')).dispose()
      await expectTerminalText(page, 'ION-FIRST-ANSWER:hello')
      assert.equal(await readFile(saved, 'utf8'), program)
    } finally {
      await canvasFailure.evaluate((failure) => failure.restore()).catch(() => {})
      await canvasFailure.dispose()
    }
    console.log('PASS unavailable cinematic canvas falls back to the same editor tab and Run Console output')
  }, { build: reducedTarget })

  if (process.platform === 'darwin') {
    await withProfile(scratch, 'native-open-live', async ({ app, page }) => {
      await intro(page).waitFor()
      await app.evaluate(({ app }, path) => app.emit('open-file', { preventDefault() {} }, path), project.program)
      await onboarding(page).waitFor({ state: 'detached' })
      await atPath(page, 'tab', project.program).waitFor()
      await (await editorShows(page, 'ION-DESKTOP-RUN-OK')).dispose()
    })

    const shim = join(scratch, 'native-open-before-ready.cjs')
    // Emit through the trusted Electron app event before whenReady handlers run.
    await writeFile(shim, `const { app } = require('electron');
require(${JSON.stringify(entry)});
app.emit('open-file', { preventDefault() {} }, ${JSON.stringify(project.program)});
`)
    await withProfile(scratch, 'native-open-cold', async ({ page }) => {
      await atPath(page, 'tab', project.program).waitFor()
      await (await editorShows(page, 'ION-DESKTOP-RUN-OK')).dispose()
      assert.equal(await onboarding(page).count(), 0)
      await expectNoPlaybackAssets(page)
    }, { build: await artifact(shim), startAt: 'workspace' })
    console.log('PASS early and in-progress macOS app open-file events bypass onboarding and open the requested source')
  }
})
