import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { artifact, close, editorShows, launch, stubDialogs, withScratch } from './desktop-harness.mjs'

const run = promisify(execFile)
export const windowsInputFilename = 'verify-input.cjs'
export const windowsInputSource = `
const prompt = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
console.log('ION-WINDOWS-INPUT');
prompt.once('line', (line) => {
  process.stdout.write('ION-WINDOWS-ANSWER:' + line + '\\n', () => {
    prompt.close();
    process.stdin.destroy();
  });
});
`

function approveNativeRun(pid) {
  // Electron uses a Windows task dialog. Find the real enabled button in this app's process,
  // then activate its actual control ID without depending on an accessibility pattern.
  const script = `
    $ErrorActionPreference = 'Stop'
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class IonTaskDialog {
  private delegate bool WindowCallback(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr parameter);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] private static extern int GetDlgCtrlID(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr length,
    StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern bool PostMessage(IntPtr window, uint message, IntPtr controlId, IntPtr parameter);

  private const uint GetText = 0x000d;
  private const uint AbortIfHung = 0x0002;
  private const uint ClickTaskDialogButton = 0x0400 + 102;

  public static bool Click(uint process, string label) {
    bool posted = false;
    EnumWindows((window, unused) => {
      uint owner;
      GetWindowThreadProcessId(window, out owner);
      if (owner != process || !IsWindowVisible(window)) return true;
      EnumChildWindows(window, (child, ignored) => {
        if (!IsWindowVisible(child) || !IsWindowEnabled(child)) return true;
        var type = new StringBuilder(32);
        GetClassName(child, type, type.Capacity);
        if (!String.Equals(type.ToString(), "Button", StringComparison.OrdinalIgnoreCase)) return true;
        var text = new StringBuilder(256);
        UIntPtr length;
        if (SendMessageTimeout(child, GetText, (UIntPtr)(uint)text.Capacity, text, AbortIfHung, 250, out length) == IntPtr.Zero
            || text.ToString() != label) return true;
        int controlId = GetDlgCtrlID(child);
        posted = controlId > 0 && PostMessage(window, ClickTaskDialogButton, (IntPtr)controlId, IntPtr.Zero);
        return !posted;
      }, IntPtr.Zero);
      return !posted;
    }, IntPtr.Zero);
    return posted;
  }
}
'@
    for ($attempt = 0; $attempt -lt 60; $attempt++) {
      if ([IonTaskDialog]::Click(${pid}, 'Run Program')) { exit 0 }
      Start-Sleep -Milliseconds 150
    }
    throw 'The app did not show a Run Program trust button.'
  `
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true, timeout: 15_000 })
}

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
  try {
    const start = page.getByTestId('run').click()
    if (pid) await Promise.all([approveNativeRun(pid), start])
    else await start
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
