import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { artifact, close, editorShows, launch, withScratch } from './desktop-harness.mjs'

const run = promisify(execFile)
export const windowsInputFilename = 'verify-input.js'
export const windowsInputSource = `
const prompt = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
console.log('ION-WINDOWS-INPUT');
prompt.once('line', (line) => { console.log('ION-WINDOWS-ANSWER:' + line); prompt.close(); });
`

function approveNativeRun(pid) {
  // Exercise the real Windows trust dialog. Only invoke a button in this test's app process.
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    Add-Type -AssemblyName UIAutomationClient
    $root = [Windows.Automation.AutomationElement]::RootElement
    $owner = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, [int]${pid})
    $name = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty, 'Run Program')
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      foreach ($window in $root.FindAll([Windows.Automation.TreeScope]::Children, $owner)) {
        $button = $window.FindFirst([Windows.Automation.TreeScope]::Descendants, $name)
        if ($button -and $button.Current.IsEnabled) {
          $button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
          exit 0
        }
      }
      Start-Sleep -Milliseconds 150
    }
    throw 'The app did not show a Run Program trust button.'
  `], { windowsHide: true, timeout: 15_000 })
}

async function terminalShows(page, marker) {
  try {
    return await page.waitForFunction((expected) => {
      const rows = document.querySelectorAll('[data-testid="run-console-terminal"] .xterm-rows > div')
      return [...rows].map((row) => row.textContent).join('').includes(expected)
    }, marker, { polling: 100, timeout: 15_000 })
  } catch (error) {
    const observed = await page.evaluate(() => {
      const console = document.querySelector('[data-testid="output"]')
      return {
        phase: console?.getAttribute('data-phase'),
        status: console?.getAttribute('data-status'),
        visible: console?.textContent?.slice(-1200),
        events: window.ionWindowsSmokeEvents,
      }
    }).catch(() => null)
    throw new Error(`Run Console did not show ${marker}. Observed: ${JSON.stringify(observed)}`, { cause: error })
  }
}

export async function verifyWindowsConsole(page, pid) {
  await page.getByTestId('explorer-entry').filter({ hasText: windowsInputFilename }).click()
  await (await editorShows(page, 'ION-WINDOWS-INPUT')).dispose()
  await page.evaluate(() => {
    const events = window.ionWindowsSmokeEvents = []
    window.ion.runConsole.onUpdate(({ update }) => {
      if (events.length >= 12) return
      events.push(update.kind === 'data' ? { ...update, text: update.text.slice(0, 512) } : update)
    })
  })
  await Promise.all([approveNativeRun(pid), page.getByTestId('run').click()])
  await (await terminalShows(page, 'ION-WINDOWS-INPUT')).dispose()
  await page.getByTestId('run-console-input').focus()
  await page.keyboard.insertText('hello')
  await page.keyboard.press('Enter')
  await (await terminalShows(page, 'ION-WINDOWS-ANSWER:hello')).dispose()
  await page.locator('[data-testid="output"][data-status="success"]').waitFor()
  await page.getByTestId('run-console-clear').click()
  await page.waitForFunction(() => !document.querySelector('[data-testid="run-console-terminal"] .xterm-rows')
    ?.textContent?.includes('ION-WINDOWS-INPUT'))
  await page.getByTestId('run-console-rerun').click()
  await (await terminalShows(page, 'ION-WINDOWS-INPUT')).dispose()
  await page.getByTestId('run-console-stop').click()
  await page.locator('[data-testid="output"][data-status="cancelled"]').waitFor()
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
      await session.app.context().setOffline(true)
      await session.page.locator('.recent-entry').filter({ hasText: 'Console test workspace' }).click()
      await verifyWindowsConsole(session.page, session.pid)
    } finally {
      await close(session)
    }
  })
}
