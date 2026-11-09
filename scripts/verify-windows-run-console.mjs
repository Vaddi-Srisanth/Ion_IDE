import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifact, close, editorShows, eventually, launch, stubDialogs, withScratch } from './desktop-harness.mjs'

const windowsInputFilename = 'verify-input λ.cjs'
const pythonInputFilename = 'prompt λ.py'
const windowsInputSource = `
const prompt = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
console.log('ION-WINDOWS-INPUT');
console.log(process.stdin.isTTY ? 'ION-WINDOWS-TTY' : 'ION-WINDOWS-PIPE');
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

async function terminalShows(page, marker, surface = 'run-console-terminal', timeout = 15_000) {
  const handle = await page.waitForFunction(({ expected, target }) => {
    const rows = document.querySelectorAll('[data-testid="' + target + '"] .xterm-rows > div')
    return [...rows].map((row) => row.textContent).join('').includes(expected)
  }, { expected: marker, target: surface }, { polling: 100, timeout })
    .catch((error) => { throw new Error(`${surface} did not show ${marker}.`, { cause: error }) })
  await handle.dispose()
}

async function typeLine(input, text) {
  await input.pressSequentially(text)
  await input.press('Enter')
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
    await terminalShows(page, 'ION-WINDOWS-TTY')
    await typeLine(page.getByTestId('run-console-input'), 'hello')
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
  console.log('PASS JavaScript uses a real Windows console, accepts input, reruns, and stops a waiting program.')
}

const toolchainFixtures = {
  'native.c': '#include <stdio.h>\nint main(void) { puts("ION-C-OUTPUT"); return 0; }\n',
  'native.cpp': '#include <iostream>\nint main() { std::cout << "ION-CPP-OUTPUT" << std::endl; }\n',
  'invalid.c': '#error ION-C-DIAGNOSTIC\n',
  [pythonInputFilename]: 'print("ION-PYTHON-TTY" if __import__("sys").stdin.isatty() else "ION-PYTHON-PIPE")\nprint("ION-PYTHON-ANSWER:" + input())\n',
}
const javaFixtures = {
  'Main.java': 'package sample; public class Main { public static void main(String[] args) { System.out.println(Message.read()); } }',
  'Message.java': 'package sample; class Message { static String read() { return "ION-JAVA-MULTI-FILE"; } }',
}

async function verifyToolchains(page) {
  const choose = (name) => page.getByTestId('explorer-entry').getByText(name, { exact: true }).click()
  const status = (value) => page.locator('[data-testid="output"][data-status="' + value + '"]').waitFor()
  const run = () => page.getByTestId('run').click()

  try {
    await choose('native.c')
    await run()
    await terminalShows(page, 'ION-C-OUTPUT')
    await status('success')
    await choose('native.cpp')
    await run()
    await terminalShows(page, 'ION-CPP-OUTPUT')
    await status('success')
    await choose('invalid.c')
    await run()
    await terminalShows(page, 'ION-C-DIAGNOSTIC')
    await status('compile-error')
    console.log('PASS C and C++ compile and run, and real compiler diagnostics reach the console.')

    await choose('sample')
    await choose('Main.java')
    await run()
    await terminalShows(page, 'ION-JAVA-MULTI-FILE')
    await status('success')
    console.log('PASS Java compiles a package with multiple source files and runs its main class.')

    await choose(pythonInputFilename)
    await run()
    await terminalShows(page, 'ION-PYTHON-TTY')
    await typeLine(page.getByTestId('run-console-input'), 'from Ion')
    await terminalShows(page, 'ION-PYTHON-ANSWER:from Ion')
    await status('success')
    console.log('PASS Python uses ConPTY and accepts real interactive input.')
  } catch (error) {
    throw new Error(`Windows toolchain verification failed. Observed: ${JSON.stringify(await consoleDiagnostics(page))}`, { cause: error })
  }
}

async function verifyTerminal(app, page, workspaceName) {
  const pane = page.getByTestId('terminal-pane')
  const selector = pane.getByTestId('terminal-session')
  const type = (command) => typeLine(pane.getByTestId('terminal-input'), command)
  const ipc = await app.evaluateHandle(({ ipcMain }) => {
    const channel = 'ion:terminal-input'
    const ackChannel = 'ion:terminal-ack'
    const handlers = ipcMain._invokeHandlers
    const original = handlers?.get(channel)
    const originalAck = handlers?.get(ackChannel)
    const writes = []
    const acks = []
    if (!original || !originalAck) return { available: false, writes, acks, restore() {} }
    handlers.set(channel, (event, id, data) => {
      if (writes.length >= 32) writes.shift()
      writes.push(typeof data === 'string' ? data.slice(0, 256) : typeof data)
      return original(event, id, data)
    })
    handlers.set(ackChannel, (event, id, sequence) => {
      if (acks.length >= 12) acks.shift()
      acks.push(sequence)
      return originalAck(event, id, sequence)
    })
    return { available: true, writes, acks, restore() {
      handlers.set(channel, original)
      handlers.set(ackChannel, originalAck)
    } }
  })
  let keyboardWrites
  const diagnostics = await page.evaluateHandle(() => {
    const events = []
    const enter = []
    const onKey = (event) => {
      if (event.key !== 'Enter' || event.target?.getAttribute?.('data-testid') !== 'terminal-input') return
      queueMicrotask(() => enter.push({
        key: event.key, code: event.code, keyCode: event.keyCode, defaultPrevented: event.defaultPrevented,
        composing: event.isComposing, trusted: event.isTrusted, alt: event.altKey, ctrl: event.ctrlKey,
      }))
    }
    document.addEventListener('keydown', onKey, true)
    const unlisten = window.ion.terminal.onEvent((event) => {
      if (events.length >= 12) events.shift()
      events.push(event.kind === 'data' ? { ...event, text: event.text.slice(0, 512) } : event)
    })
    return { events, enter, unsubscribe() {
      document.removeEventListener('keydown', onKey, true)
      unlisten()
    } }
  })

  try {
    await page.getByTestId('bottom-terminal-tab').click()
    await selector.waitFor()
    assert.match(await selector.locator('option:checked').textContent(), /powershell\.exe/i)
    const first = await selector.inputValue()
    await (await page.waitForFunction(() => {
      const rows = document.querySelectorAll('[data-testid="terminal-pane"] .xterm-rows > div')
      return [...rows].some((row) => /^PS .+>/.test(row.textContent?.trim() ?? ''))
    }, undefined, { timeout: 15_000 })).dispose()
    async function expectCommand(command, marker) {
      await type(command)
      try {
        await terminalShows(page, marker, 'terminal-pane')
      } catch (error) {
        keyboardWrites = await ipc.evaluate(({ available, writes, acks }) => ({ available, writes, acks }))
        // Probe the same queued command with only a carriage return through the native bridge.
        // The original keyboard assertion still fails if the probe succeeds.
        const comparison = await page.evaluate((id) => window.ion.terminal.input(id, '\r'), first)
          .then(() => terminalShows(page, marker, 'terminal-pane', 2500))
          .then(() => 'Direct carriage return submitted the queued command.', (reason) => String(reason))
        throw new Error('The PowerShell command did not produce ' + marker + '. ' + comparison, { cause: error })
      }
    }
    await expectCommand("[Console]::WriteLine(('ION-'+'PS-OK'))", 'ION-PS-OK')
    await expectCommand("Write-Output ('ION-' + 'WORKSPACE:' + (Split-Path -Leaf $PWD.Path))", 'ION-WORKSPACE:' + workspaceName)
    await type("Write-Output ('ION-' + 'SHELL-PID:' + $PID)")
    const pidHandle = await page.waitForFunction(() => {
      const rows = document.querySelectorAll('[data-testid="terminal-pane"] .xterm-rows > div')
      return Number([...rows].map((row) => /^ION-SHELL-PID:(\d+)$/.exec(row.textContent?.trim())?.[1]).find(Boolean))
    })
    let pid
    try { pid = await pidHandle.jsonValue() } finally { await pidHandle.dispose() }
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'PowerShell did not report its process ID.')
    assert.doesNotThrow(() => process.kill(pid, 0))

    await pane.getByTestId('terminal-new').click()
    await eventually(async () => await selector.locator('option').count() === 2, 'Second terminal did not open.')
    const second = await selector.inputValue()
    assert.notEqual(first, second)
    await selector.selectOption(first)
    await pane.getByTestId('terminal-hide').click()
    await pane.waitFor({ state: 'hidden' })
    assert.doesNotThrow(() => process.kill(pid, 0))
    await page.getByRole('button', { name: 'Toggle Console' }).click()
    assert.equal(await selector.inputValue(), first)
    await terminalShows(page, 'ION-SHELL-PID:' + pid, 'terminal-pane')
    await pane.getByTestId('terminal-close').click()
    await eventually(() => {
      try { process.kill(pid, 0); return false } catch (error) {
        if (error.code !== 'ESRCH') throw error
        return true
      }
    }, 'Closing the terminal did not release the PowerShell process.')
    assert.equal(await selector.inputValue(), second)
    await pane.getByTestId('terminal-close').click()
  } catch (error) {
    const observed = await diagnostics.evaluate(({ events, enter }) => ({
      events, enter,
      focus: document.activeElement?.getAttribute('data-testid'),
      visible: [...document.querySelectorAll('[data-testid="terminal-pane"] .xterm-rows > div')]
        .map((row) => row.textContent).join('\n').slice(-1600),
    })).catch(() => null)
    const writes = keyboardWrites ?? await ipc.evaluate(({ available, writes, acks }) => ({ available, writes, acks })).catch(() => null)
    throw new Error(`Windows Terminal verification failed. ${error.message} Observed: ${JSON.stringify({ ...observed, ipc: writes })}`, { cause: error })
  } finally {
    await diagnostics.evaluate(({ unsubscribe }) => unsubscribe()).catch(() => {})
    await diagnostics.dispose()
    await ipc.evaluate(({ restore }) => restore()).catch(() => {})
    await ipc.dispose()
  }
  console.log('PASS PowerShell starts in the workspace, two sessions switch independently, and closing reaps the process.')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  assert.equal(process.platform, 'win32', 'Run this test on Windows.')
  await withScratch('windows-console', async (scratch) => {
    const workspaceName = 'Console test workspace'
    const project = join(scratch, workspaceName)
    const java = join(project, 'sample')
    const profile = join(scratch, 'profile')
    await Promise.all([mkdir(java, { recursive: true }), mkdir(profile)])
    await Promise.all([
      writeFile(join(project, windowsInputFilename), windowsInputSource),
      ...Object.entries(toolchainFixtures).map(([name, source]) => writeFile(join(project, name), source)),
      ...Object.entries(javaFixtures).map(([name, source]) => writeFile(join(java, name), source)),
      writeFile(join(profile, 'preferences.json'), JSON.stringify({
        version: 1,
        settings: { openFullScreen: false },
        recents: [{ path: project, name: workspaceName, kind: 'folder', lastOpened: 1 }],
      })),
    ])
    const session = await launch(await artifact('dist'), profile)
    try {
      await stubDialogs(session.app, { allowRun: true })
      await session.app.context().setOffline(true)
      await session.page.locator('.recent-entry').filter({ hasText: workspaceName }).click()
      await verifyWindowsConsole(session.page)
      await verifyToolchains(session.page)
      await verifyTerminal(session.app, session.page, workspaceName)
    } finally {
      await close(session)
    }
  })
}
