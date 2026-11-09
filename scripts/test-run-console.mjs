import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, createProject, editorShows, eventually, launch, mkdir, openFolder, openFromExplorer,
  resourceSnapshot, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' },
  screenshots: { type: 'string' },
} })
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use production build files for native dialog stubbing.')
if (values.screenshots) await mkdir(values.screenshots, { recursive: true })

const output = '[data-testid="output"]'
const terminalRows = '[data-testid="run-console-terminal"] .xterm-rows > div'
const terminal = (page) => page.getByTestId('run-console-input')
const timeout = 20_000

function terminalText(page, marker) {
  return page.waitForFunction(({ selector, marker }) => {
    const lines = [...document.querySelectorAll(selector)].map((row) => row.textContent?.replaceAll('\u00a0', ' '))
    // xterm splits a long diagnostic across separate DOM rows at the right edge.
    return lines.join('\n').includes(marker) || lines.join('').includes(marker)
  }, { selector: terminalRows, marker }, { timeout })
}

async function finished(page, status, marker) {
  await page.locator(`${output}[data-status="${status}"]`).waitFor({ timeout })
  if (marker) await terminalText(page, marker)
  if (status === 'success') assert.match(await page.getByTestId('run-console-duration').textContent(), /Exit 0 · \d+ ms/)
}

async function run(page, path, sourceMarker, outputMarker) {
  await openFromExplorer(page, path, sourceMarker)
  await page.getByTestId('run').click()
  await finished(page, 'success', outputMarker)
}

async function input(page, line) {
  await page.keyboard.insertText(line)
  await page.keyboard.press('Enter')
}

async function replaceSource(page, source, marker) {
  await page.locator('.monaco-editor .view-lines').click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.insertText(source)
  await editorShows(page, marker)
}

async function runPreferences(page, saveBeforeRun) {
  await page.getByTestId('settings').click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('checkbox', { name: /^Autosave/ }).uncheck()
  await dialog.getByRole('checkbox', { name: /Save before Run/i }).setChecked(saveBeforeRun)
  await dialog.getByRole('checkbox', { name: /Keep previous run output/i }).check()
  await dialog.getByRole('button', { name: 'Done' }).click()
  await eventually(() => page.evaluate(async (save) => {
    const { settings } = await window.ion.getPreferences()
    return !settings.autoSave && settings.saveBeforeRun === save && settings.keepRunOutput
  }, saveBeforeRun), 'Run Console preferences were not written.')
}

async function interact(page, path, sourceMarker, questions, expected) {
  await openFromExplorer(page, path, sourceMarker)
  await page.getByTestId('run').click()
  await page.locator(`${output}[data-phase="running"]`).waitFor({ timeout })
  await terminal(page).waitFor({ state: 'attached', timeout })
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'run-console-input',
    undefined, { timeout })
  for (const [prompt, line] of questions) {
    await terminalText(page, prompt)
    await input(page, line)
  }
  await finished(page, 'success', expected)
}

async function rerun(page, marker) {
  await page.getByTestId('run-console-clear').click()
  await page.waitForFunction(({ selector, marker }) => [...document.querySelectorAll(selector)]
    .every((row) => !row.textContent?.includes(marker)), { selector: terminalRows, marker })
  await page.getByTestId('run-console-rerun').click()
  await finished(page, 'success', marker)
}

async function stopRunning(page, pidMarker, rerun = false) {
  const previous = await page.evaluate(() => globalThis.ionRunTestEvents.at(-1)?.id)
  await page.getByTestId(rerun ? 'run-console-rerun' : 'run').click()
  await page.locator(`${output}[data-phase="running"]`).waitFor({ timeout })
  // The previous run can still be visible for one frame after the phase changes.
  // Read the new run's PID from its own streamed events before checking xterm.
  const observed = await page.waitForFunction(({ previous, pidMarker }) => {
    const events = globalThis.ionRunTestEvents
    const current = events.findLast(({ update }) => update.kind === 'phase' && update.phase === 'preparing')
    if (!current || current.id === previous) return false
    const text = events.filter(({ id, update }) => id === current.id && update.kind === 'data' && update.stream === 'terminal')
      .map(({ update }) => update.text).join('')
    return Number(new RegExp(pidMarker + '(\\d+)').exec(text)?.[1]) || false
  }, { previous, pidMarker }, { timeout })
  const pid = await observed.jsonValue()
  await observed.dispose()
  assert.ok(Number.isInteger(pid) && pid > 1, `Expected a PID after ${pidMarker}`)
  await terminalText(page, `${pidMarker}${pid}`)
  await page.getByTestId('run-console-stop').click()
  await finished(page, 'cancelled', `${pidMarker}${pid}`)
  await waitForProcessExit(pid)
}

async function waitForProcessExit(pid) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { process.kill(pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return
      throw error
    }
    await sleep(50)
  }
  assert.fail(`Process ${pid} survived Stop.`)
}

await withScratch('run-console', async (scratch) => {
  const project = await createProject(join(scratch, 'project λ with spaces'), { fileCount: 0 })
  const path = (name) => join(project.directory, name)
  const sources = {
    'HelloWorld.java': `class HelloWorld {
  public static void main(String[] args) { System.out.println("ION-JAVA-HELLO"); }
}`,
    'ReadLine.java': `import java.util.Scanner;
public class ReadLine {
  public static void main(String[] args) {
    System.out.println("JAVA-INPUT-PID:" + ProcessHandle.current().pid());
    System.out.print("JAVA-INPUT> "); System.out.flush();
    String value = new Scanner(System.in).nextLine();
    System.out.println("ION-JAVA-SCANNER:" + value.toUpperCase());
  }
}`,
    'src/ion/study/PackageRunner.java': `package ion.study;
public class PackageRunner {
  public static void main(String[] args) { System.out.println(Helper.message()); }
}`,
    'src/ion/study/Helper.java': `package ion.study;
class Helper { static String message() { return "ION-JAVA-PACKAGE-HELPER"; } }`,
    'ChangeMe.java': `class ChangeMe {
  public static void main(String[] args) { System.out.println("ION-JAVA-PREVIOUS-CLASS"); }
}`,
    'Broken.java': 'class Broken { public static void main(String[] args) { int BROKEN_JAVA = ; } }',
    'hello world.c': `#include <stdio.h>
int main(void) { puts("ION-C-SIMPLE"); }`,
    'broken source.c': 'int main(void) { return BROKEN_C; }',
    'scan integer.c': `#include <stdio.h>
#include <unistd.h>
int main(void) {
  int n;
  printf("C-INPUT-PID:%ld\\n", (long)getpid());
  printf("C-INPUT> "); fflush(stdout);
  if (scanf("%d", &n) != 1) return 2;
  printf("ION-C-SCANF:%d\\n", n + 1);
  return 0;
}`,
    'hello world.cpp': `#include <iostream>
int main() { std::cout << "ION-CPP-SIMPLE\\n"; }`,
    'broken source.cpp': 'int main() { return BROKEN_CPP; }',
    'cin integer.cpp': `#include <iostream>
#include <unistd.h>
int main() {
  int n;
  std::cout << "CPP-INPUT-PID:" << getpid() << "\\n";
  std::cout << "CPP-INPUT> " << std::flush;
  if (!(std::cin >> n)) return 2;
  std::cout << "ION-CPP-CIN:" << n * 2 << "\\n";
}`,
    'hello world.python': 'print("ION-PYTHON-SIMPLE")',
    'raise error.py': 'raise RuntimeError("ION-PYTHON-ERROR")',
    'two lines.py': `import os
import sys
assert sys.stdin.isatty() and sys.stdout.isatty()
print(f"PYTHON-INPUT-PID:{os.getpid()}")
first = input("FIRST> ")
second = input("SECOND> ")
print(f"ION-PYTHON-MULTILINE:{first}/{second}")`,
    'streams.js': `if (!process.stdout.isTTY || !process.stderr.isTTY) process.exit(7);
process.stdout.write('\\x1b[32mION-JS-OUT\\x1b[0m\\n');
process.stderr.write('ION-JS-ERR\\n');`,
    'read line.js': `const rl = require('node:readline').createInterface({ input: process.stdin, output: process.stdout });
console.log('JS-INPUT-PID:' + process.pid);
rl.question('JS-INPUT> ', (answer) => {
  console.log('ION-JS-READLINE:' + answer.toUpperCase());
  rl.close();
});`,
    'throw error.js': 'Error.stackTraceLimit = 0;\nthrow new Error("ION-JS-ERROR");',
    'saved version.js': 'console.log("ION-DISK-V1");',
    'alternate screen.js': `process.stdout.write('ION-NORMAL-SCREEN\\n\\x1b[?1049hION-ALTERNATE-SCREEN\\n');
setInterval(() => {}, 1000);`,
    'loop.c': `#include <stdio.h>
#include <unistd.h>
int main(void) {
  printf("ION-LOOP-PID:%ld\\n", (long)getpid()); fflush(stdout);
  for (;;) {}
}`,
    'index.html': `<!doctype html><title>Ion preview fixture</title>
<link rel="stylesheet" href="./preview.css">
<div id="preview-output"></div>
<script type="module" src="./preview.mjs"></script>`,
    'preview.mjs': 'document.querySelector("#preview-output").textContent = "ION-WEB-MODULE";',
    'preview.css': '#preview-output { color: rgb(9, 101, 125); }',
    'workspace race.js': 'console.log("ION-WORKSPACE-RACE-LAUNCHED");',
  }
  await Promise.all(Object.entries(sources).map(async ([name, text]) => {
    await mkdir(dirname(path(name)), { recursive: true })
    await writeFile(path(name), text)
  }))

  const session = await launch(target, join(scratch, 'profile'))
  let stderr = ''
  session.app.process().stderr?.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192) })
  try {
    const { app, page } = session
    await app.context().setOffline(true)
    await page.evaluate(() => {
      const events = globalThis.ionRunTestEvents = []
      window.ion.runConsole.onUpdate(({ id, update }) => {
        events.push({ id, update: update.kind === 'data' ? { ...update, text: update.text.slice(0, 300) } : update })
        if (events.length > 24) events.shift()
      })
    })
    await stubDialogs(app, { folder: project.directory, allowRun: true })
    await openFolder(page, project)
    assert.deepEqual((await resourceSnapshot(session)).processes.filter((kind) => kind === 'child'), [],
      'No native terminal helper runs before a program starts')

    const matrix = [
      {
        language: 'C', simple: ['hello world.c', 'puts(', 'ION-C-SIMPLE'],
        input: ['scan integer.c', 'scanf', [['C-INPUT>', '41']], 'ION-C-SCANF:42'], pid: 'C-INPUT-PID:',
        failure: ['broken source.c', 'BROKEN_C', 'compile-error', 'error:'],
      },
      {
        language: 'C++', simple: ['hello world.cpp', 'std::cout', 'ION-CPP-SIMPLE'],
        input: ['cin integer.cpp', 'std::cin', [['CPP-INPUT>', '21']], 'ION-CPP-CIN:42'], pid: 'CPP-INPUT-PID:',
        failure: ['broken source.cpp', 'BROKEN_CPP', 'compile-error', 'error:'],
      },
      {
        language: 'Java', simple: ['HelloWorld.java', 'HelloWorld', 'ION-JAVA-HELLO'],
        input: ['ReadLine.java', 'new Scanner', [['JAVA-INPUT>', 'study lab']], 'ION-JAVA-SCANNER:STUDY LAB'], pid: 'JAVA-INPUT-PID:',
        failure: ['Broken.java', 'BROKEN_JAVA', 'compile-error', 'error:'],
      },
      {
        language: 'Python', simple: ['hello world.python', 'print(', 'ION-PYTHON-SIMPLE'],
        input: ['two lines.py', 'input(', [['FIRST>', 'alpha'], ['SECOND>', 'beta']], 'ION-PYTHON-MULTILINE:alpha/beta'], pid: 'PYTHON-INPUT-PID:',
        failure: ['raise error.py', 'raise RuntimeError', 'runtime-error', 'RuntimeError: ION-PYTHON-ERROR'],
      },
      {
        language: 'JavaScript', simple: ['streams.js', 'process.stderr.write', 'ION-JS-OUT'],
        input: ['read line.js', 'rl.question', [['JS-INPUT>', 'lab']], 'ION-JS-READLINE:LAB'], pid: 'JS-INPUT-PID:',
        failure: ['throw error.js', 'throw new Error', 'runtime-error', 'Error: ION-JS-ERROR'],
      },
    ]
    for (const { language, simple, input: interactive, failure, pid } of matrix) {
      await run(page, path(simple[0]), simple[1], simple[2])
      await rerun(page, simple[2])
      await rerun(page, simple[2])
      if (language === 'JavaScript') await terminalText(page, 'ION-JS-ERR')

      const [inputFile, inputSource, prompts, answer] = interactive
      await interact(page, path(inputFile), inputSource, prompts, answer)
      if (language === 'Java' && values.screenshots) await page.screenshot({ path: join(values.screenshots, 'run-console.png') })
      await stopRunning(page, pid, true)

      const [failureFile, failureSource, status, diagnostic] = failure
      await openFromExplorer(page, path(failureFile), failureSource)
      await page.getByTestId('run').click()
      await finished(page, status, diagnostic)
      assert.deepEqual((await resourceSnapshot(session)).processes.filter((kind) => kind === 'child'), [],
        `${language} left a compiler, program, or PTY helper running.`)
      console.log(`PASS ${language} output, Rerun twice, interactive input, Stop and reaping, errors, and a Unicode folder path with spaces`)
    }

    for (const folder of ['src', 'src/ion', 'src/ion/study']) await atPath(page, 'explorer-entry', path(folder)).click()
    await run(page, path('src/ion/study/PackageRunner.java'), 'Helper.message', 'ION-JAVA-PACKAGE-HELPER')
    console.log('PASS Java packages and targeted multi-file compilation')

    await run(page, path('ChangeMe.java'), 'ChangeMe', 'ION-JAVA-PREVIOUS-CLASS')
    await replaceSource(page, 'class ChangeMe { public static void main(String[] args) { int BROKEN_FRESH = } }', 'BROKEN_FRESH')
    await page.getByTestId('run').click()
    await finished(page, 'compile-error', 'error:')
    assert.doesNotMatch(await page.getByTestId('output').textContent(), /ION-JAVA-PREVIOUS-CLASS/)
    assert.match(await readFile(path('ChangeMe.java'), 'utf8'), /BROKEN_FRESH/)
    console.log('PASS Save Before Run and Java compiler errors prevent executing previously compiled code')

    await openFromExplorer(page, project.loop, 'for (;;)')
    await stopRunning(page, 'ION-LOOP-PID:')

    await openFromExplorer(page, path('alternate screen.js'), 'ION-ALTERNATE-SCREEN')
    await page.getByTestId('run').click()
    await page.locator(`${output}[data-phase="running"]`).waitFor({ timeout })
    await terminalText(page, 'ION-ALTERNATE-SCREEN')
    await page.getByTestId('run-console-stop').click()
    await finished(page, 'cancelled', 'ION-NORMAL-SCREEN')
    assert.doesNotMatch(await page.getByTestId('run-console-terminal').innerText(), /ION-ALTERNATE-SCREEN/)
    assert.deepEqual((await resourceSnapshot(session)).processes.filter((kind) => kind === 'child'), [],
      'No program, compiler or PTY helper remains after repeated runs and Stop')
    console.log('PASS Stop on an infinite loop, alternate-screen restore, and process cleanup')

    await runPreferences(page, false)
    const version = path('saved version.js')
    await run(page, version, 'ION-DISK-V1', 'ION-DISK-V1')
    await replaceSource(page, 'console.log("ION-EDITOR-V2");', 'ION-EDITOR-V2')
    await page.getByTestId('run').click()
    await terminalText(page, 'Running the last saved version.')
    await finished(page, 'success', 'ION-DISK-V1')
    assert.match(await readFile(version, 'utf8'), /ION-DISK-V1/)
    assert.doesNotMatch(await page.getByTestId('run-console-terminal').innerText(), /ION-EDITOR-V2/)
    await runPreferences(page, true)
    await page.getByTestId('run').click()
    await finished(page, 'success', 'ION-EDITOR-V2')
    await terminalText(page, 'ION-DISK-V1')
    assert.match(await readFile(version, 'utf8'), /ION-EDITOR-V2/)
    console.log('PASS Save before Run off and on, and retained prior output in the same terminal')

    await writeFile(version, 'console.log("ION-EXTERNAL-V3");')
    await page.getByTestId('run').click()
    await finished(page, 'rejected', 'The source changed on disk. Reload it before running.')
    await page.getByRole('button', { name: 'Reload', exact: true }).waitFor()
    assert.doesNotMatch(await page.getByTestId('run-console-terminal').innerText(), /ION-EXTERNAL-V3/)
    await runPreferences(page, false)
    await page.getByTestId('run').click()
    await finished(page, 'success', 'ION-EXTERNAL-V3')
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Reload', exact: true }).click()
    await editorShows(page, 'ION-EXTERNAL-V3')
    console.log('PASS Save Before Run checks the editor revision, switching it off runs the disk version, and Reload updates the editor')

    await openFromExplorer(page, path('preview.css'), 'rgb(9, 101, 125)')
    const [preview] = await Promise.all([app.waitForEvent('window'), page.getByTestId('preview-web').click()])
    await preview.waitForURL('ion-preview://site/index.html')
    const rendered = preview.getByText('ION-WEB-MODULE', { exact: true })
    await rendered.waitFor()
    assert.equal(await rendered.evaluate((element) => getComputedStyle(element).color), 'rgb(9, 101, 125)')
    assert.equal(await preview.evaluate(() => typeof window.ion), 'undefined')
    assert.equal(await preview.evaluate(() => typeof window.require), 'undefined')
    if (values.screenshots) await preview.screenshot({ path: join(values.screenshots, 'web-preview.png') })
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows().find((window) => window.webContents.getURL().startsWith('ion-preview:'))?.close()
    })
    console.log('PASS separate offline web preview resolves HTML, CSS, and JavaScript modules without workbench privileges')

    await openFromExplorer(page, path('workspace race.js'), 'ION-WORKSPACE-RACE-LAUNCHED')
    const replacement = await createProject(join(scratch, 'different workspace'), { fileCount: 0 })
    await stubDialogs(app, { folder: replacement.directory, allowRun: true })
    await app.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox
      let approvalRequested
      globalThis.ionApprovalRequested = new Promise((resolve) => { approvalRequested = resolve })
      dialog.showMessageBox = (owner, options) => {
        if (!options.message.startsWith('Trust workspace race.js')) return original(owner, options)
        dialog.showMessageBox = original
        return new Promise((resolve) => {
          globalThis.ionCompleteApproval = () => resolve({ response: 1, checkboxChecked: false })
          approvalRequested()
        })
      }
    })
    await page.getByTestId('run').click()
    try {
      await app.evaluate(async () => {
        let timer
        try {
          await Promise.race([globalThis.ionApprovalRequested, new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Expected a pending Run approval.')), 5000)
          })])
        } finally { clearTimeout(timer) }
      })
      await page.locator('.titlebar').getByTestId('open-folder').click()
      await atPath(page, 'explorer-entry', replacement.program).waitFor()
    } finally {
      await app.evaluate(() => {
        globalThis.ionCompleteApproval?.()
        delete globalThis.ionCompleteApproval
        delete globalThis.ionApprovalRequested
      })
    }
    await finished(page, 'rejected', 'The source or workspace changed before the run.')
    assert.doesNotMatch(await page.getByTestId('run-console-terminal').innerText(), /ION-WORKSPACE-RACE-LAUNCHED/)
    console.log('PASS changing folders during approval invalidates the original Run plan')

    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
  } catch (error) {
    const child = session.app.process()
    if (stderr || session.errors.length || child.exitCode !== null || child.signalCode !== null) {
      console.error('Run Console diagnostic', { stderr, errors: session.errors, exitCode: child.exitCode, signal: child.signalCode })
    }
    if (!session.page.isClosed()) console.error('Visible console:', await session.page.locator('.run-console').innerText({ timeout: 500 })
      .then((text) => text.slice(-2500)).catch(() => ''))
    if (!session.page.isClosed()) console.error('Recent console events:', JSON.stringify(await session.page
      .evaluate(() => globalThis.ionRunTestEvents).catch(() => null)))
    throw error
  } finally {
    await close(session)
  }
})
