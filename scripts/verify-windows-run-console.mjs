import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifact, close, editorShows, launch, stubDialogs, withScratch } from './desktop-harness.mjs'

const windowsInputFilename = 'verify-input.cjs'
const windowsInputSource = `
const prompt = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
console.log('ION-WINDOWS-INPUT');
prompt.once('line', (line) => {
  process.stdout.write('ION-WINDOWS-ANSWER:' + line + '\\n', () => {
    prompt.close();
    process.stdin.destroy();
  });
});
`

async function consoleDiagnostics(page) {
  return page.evaluate(() => {
    const output = document.querySelector('[data-testid="output"]')
    return {
      phase: output?.getAttribute('data-phase'),
      status: output?.getAttribute('data-status'),
      message: output?.querySelector('.run-console-footer')?.textContent?.slice(0, 200),
      transcript: output?.querySelector('.xterm-rows')?.textContent?.slice(-1200),
      events: window.ionWindowsSmokeEvents,
    }
  }).catch(() => null)
}

async function terminalShows(page, marker) {
  const handle = await page.waitForFunction((expected) => {
    const rows = document.querySelectorAll('[data-testid="run-console-terminal"] .xterm-rows > div')
    return [...rows].map((row) => row.textContent).join('').includes(expected)
  }, marker, { polling: 100, timeout: 15_000 })
    .catch((error) => { throw new Error(`Run Console did not show ${marker}.`, { cause: error }) })
  await handle.dispose()
}

async function verifyWindowsConsole(page) {
  await page.getByTestId('explorer-entry').filter({ hasText: windowsInputFilename }).click()
  await (await editorShows(page, 'ION-WINDOWS-INPUT')).dispose()
  await page.evaluate(() => {
    const events = window.ionWindowsSmokeEvents = []
    window.ion.runConsole.onUpdate(({ update }) => {
      if (events.length >= 12) return
      events.push(update.kind === 'data' ? { ...update, text: update.text.slice(0, 512) } : update)
    })
  })
  try {
    await page.getByTestId('run').click()
    await terminalShows(page, 'ION-WINDOWS-INPUT')
    await page.getByTestId('run-console-input').focus()
    await page.keyboard.insertText('hello')
    await page.keyboard.press('Enter')
    await terminalShows(page, 'ION-WINDOWS-ANSWER:hello')
    await page.locator('[data-testid="output"][data-status="success"]').waitFor()
    await page.getByTestId('run-console-clear').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid="run-console-terminal"] .xterm-rows')
      ?.textContent?.includes('ION-WINDOWS-INPUT'))
    await page.getByTestId('run-console-rerun').click()
    await terminalShows(page, 'ION-WINDOWS-INPUT')
    await page.getByTestId('run-console-stop').click()
    await page.locator('[data-testid="output"][data-status="cancelled"]').waitFor()
  } catch (error) {
    throw new Error(`Windows Run Console verification failed. Observed: ${JSON.stringify(await consoleDiagnostics(page))}`, { cause: error })
  }
  console.log('PASS interactive JavaScript accepts input and Stop cancels a waiting program.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.platform, 'win32', 'Run this test on Windows.')
  await withScratch('windows-console', async (scratch) => {
    const project = join(scratch, 'Console test workspace')
    const profile = join(scratch, 'profile')
    await Promise.all([mkdir(project), mkdir(profile)])
    await Promise.all([
      writeFile(join(project, windowsInputFilename), windowsInputSource),
      writeFile(join(profile, 'preferences.json'), JSON.stringify({
        version: 1,
        settings: { openFullScreen: false },
        recents: [{ path: project, name: 'Console test workspace', kind: 'folder', lastOpened: 1 }],
      })),
    ])
    const session = await launch(await artifact('dist'), profile)
    try {
      await stubDialogs(session.app, { allowRun: true })
      await session.app.context().setOffline(true)
      await session.page.locator('.recent-entry').filter({ hasText: 'Console test workspace' }).click()
      await verifyWindowsConsole(session.page)
    } finally {
      await close(session)
    }
  })
}
