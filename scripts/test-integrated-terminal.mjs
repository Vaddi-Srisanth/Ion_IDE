import assert from 'node:assert/strict'
import { access, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  artifact, close, createProject, eventually, launch, mkdir, openFolder, openFromExplorer,
  resourceSnapshot, runProgram, sleep, stubDialogs, withScratch,
} from './desktop-harness.mjs'
import { terminalShortcut } from './integrated-terminal-harness.mjs'

if (process.platform !== 'darwin') {
  console.log('SKIP the integrated zsh terminal desktop test requires macOS.')
  process.exit(0)
}

const { values } = parseArgs({ options: {
  target: { type: 'string', default: 'dist' }, screenshots: { type: 'string' },
} })
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use production build files for native dialog stubbing.')
if (values.screenshots) await mkdir(values.screenshots, { recursive: true })

const pane = (page) => page.getByTestId('terminal-pane')
const input = (page) => pane(page).locator('.xterm:visible .xterm-helper-textarea')
const rows = (page) => pane(page).locator('.xterm:visible .xterm-rows > div')
const sessionSelector = (page) => page.getByTestId('terminal-session')
const click = (page, id) => page.getByTestId(id).click()
const toggle = (app) => terminalShortcut(app, 'J', ['meta', 'shift'])
const focus = (app) => terminalShortcut(app, 'J', ['meta', 'alt'])
const prompt = 'ION-SHELL>'
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'"

async function transcript(page) {
  return (await rows(page).allTextContents()).map((line) => line.replaceAll('\u00a0', ' ')).join('\n')
}

async function output(page, expected) {
  const match = typeof expected === 'string'
    ? { text: expected } : { source: expected.source, flags: expected.flags }
  const handle = await page.waitForFunction(({ text, source, flags }) => {
    const terminals = document.querySelectorAll('[data-testid="terminal-pane"] .xterm')
    const active = [...terminals].find((terminal) => terminal.getBoundingClientRect().height > 0)
    if (!active) return false
    const lines = [...active.querySelectorAll('.xterm-rows > div')]
      .map((row) => row.textContent?.replaceAll('\u00a0', ' ').trimEnd() ?? '')
    const matcher = text === undefined ? new RegExp(source, flags) : null
    // Match rendered output at the start of a line to ignore echoed commands.
    return lines.find((line) => matcher ? matcher.test(line) : line === text) || false
  }, match, { timeout: 12_000 })
  try { return await handle.jsonValue() } finally { await handle.dispose() }
}

async function command(page, text) {
  await input(page).focus()
  await page.keyboard.insertText(text)
  await page.keyboard.press('Enter')
}

async function shellReady(page) {
  await input(page).waitFor({ state: 'attached' })
  await output(page, prompt)
}

const pids = async (session) => (await resourceSnapshot(session, { details: true }))
  .members.filter(({ kind }) => kind === 'child').map(({ pid }) => pid)

function isAlive(pid) {
  try { process.kill(pid, 0); return true } catch (error) {
    if (error.code === 'ESRCH') return false
    throw error
  }
}

async function reaped(pids) {
  await eventually(() => pids.every((pid) => !isAlive(pid)), 'Terminal left processes running: ' + pids.join(', '))
}

async function resize(page) {
  const splitter = page.getByRole('separator', { name: /^Resize (Console|Panel|Bottom Panel)$/i })
  await splitter.focus()
  const height = await pane(page).evaluate((element) => element.getBoundingClientRect().height)
  const rowCount = await rows(page).count()
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowUp')
  await eventually(async () => await pane(page).evaluate((element) => element.getBoundingClientRect().height) > height,
    'Keyboard resize did not increase the bottom panel height.')
  await eventually(async () => await rows(page).count() > rowCount, 'xterm did not fit the resized panel.')
}

await withScratch('integrated-terminal', async (scratch) => {
  const project = await createProject(join(scratch, 'project λ with spaces'), { fileCount: 1 })
  const zsh = join(scratch, 'zsh')
  await mkdir(zsh)
  await mkdir(join(project.directory, 'subfolder'))
  await writeFile(join(zsh, '.zshrc'), [
    `PROMPT="${prompt} "`, 'RPROMPT=""', 'unsetopt BEEP BANG_HIST',
    'export PYTHON_BASIC_REPL=1 GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null npm_config_offline=true npm_config_update_notifier=false',
    '',
  ].join('\n'))
  await writeFile(join(project.directory, '.zshrc'), 'touch .ion-untrusted-ran\n')
  await writeFile(join(project.directory, '.envrc'), 'touch .ion-untrusted-ran\n')
  await writeFile(join(project.directory, 'package.json'), JSON.stringify({
    name: 'ion-terminal-smoke', version: '1.0.0', private: true,
    scripts: { smoke: 'node -e "console.log(\'ION-NPM-RUN-OK\')"' },
  }))
  process.env.ZDOTDIR = zsh
  const session = await launch(target, join(scratch, 'profile'))
  const { app, page } = session
  try {
    await page.context().setOffline(true)
    await stubDialogs(app, { file: project.program, folder: project.directory, allowRun: true })
    assert.deepEqual(await pids(session), [], 'Welcome launched a shell before the user opened Terminal.')
    await page.getByTestId('welcome').getByTestId('open-file').click()
    await page.getByTestId('workspace').waitFor()
    assert.deepEqual(await pids(session), [], 'Opening an editor launched a shell before the user opened Terminal.')
    await toggle(app)
    await shellReady(page)
    await command(page, 'print -r -- "ION-HOME:$PWD"; print -r -- "ION-ZSH:$ZSH_VERSION"; [[ -t 0 && -t 1 ]] && print ION-PTY-OK')
    const homePath = await realpath(homedir())
    await output(page, 'ION-HOME:' + homePath)
    await output(page, /^ION-ZSH:\d+\.\d+/)
    await output(page, 'ION-PTY-OK')
    await click(page, 'terminal-close')
    await eventually(async () => (await pids(session)).length === 0, 'Home shell did not exit.')
    await click(page, 'terminal-hide')

    await page.locator('.titlebar').getByTestId('open-folder').click()
    await openFromExplorer(page, project.program, 'ION-DESKTOP-RUN-OK')
    await focus(app)
    await click(page, 'terminal-new')
    await shellReady(page)
    await eventually(() => input(page).evaluate((element) => element === document.activeElement), 'New Terminal did not receive input focus.')
    await command(page, `[[ "$PWD" == ${quote(project.directory)} ]] && print -r -- 'ION-'WORKSPACE-OK`)
    await output(page, 'ION-WORKSPACE-OK')
    await assert.rejects(access(join(project.directory, '.ion-untrusted-ran')), { code: 'ENOENT' })
    await command(page, 'cd subfolder && ls -a && print -r -- "ION-CD:${PWD:t}"')
    await output(page, 'ION-CD:subfolder')
    await command(page, 'cd .. && git init -q && print -r -- "ION-GIT:$(git rev-parse --is-inside-work-tree)" && ls program.c')
    await output(page, 'ION-GIT:true')
    await output(page, 'program.c')
    await command(page, 'print -r -- "ION-NPM:$(npm --version)" && cc program.c -o ./compiled && ./compiled')
    await output(page, /^ION-NPM:\d+\.\d+\.\d+/)
    await output(page, 'ION-DESKTOP-RUN-OK')
    await command(page, 'npm run --silent smoke')
    await output(page, 'ION-NPM-RUN-OK')
    console.log('PASS no startup shell, zsh PTY in home/workspace, cd, ls, Git, npm and a real C compile and run')

    await command(page, 'python3 -m venv --without-pip .ion-test-venv && source .ion-test-venv/bin/activate && print -r -- "ION-VENV:${VIRTUAL_ENV:t}"')
    await output(page, 'ION-VENV:.ion-test-venv')
    await command(page, 'python -q')
    await output(page, /^>>> ?$/)
    await command(page, 'print("ION-" + "PYTHON-" + str(7 * 6))')
    await output(page, 'ION-PYTHON-42')
    await command(page, 'exit()')
    await command(page, 'python -c \'print("ION-ANSWER:" + input("ION-INPUT> "))\'')
    await output(page, 'ION-INPUT>')
    await command(page, 'typing into a real shell')
    await output(page, 'ION-ANSWER:typing into a real shell')
    await command(page, 'deactivate')
    await command(page, '(( ION_HISTORY += 1 )); print "ION-HISTORY:$ION_HISTORY"')
    await output(page, 'ION-HISTORY:1')
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Enter')
    await output(page, 'ION-HISTORY:2')
    await command(page, String.raw`printf '\033[31m%s\033[0m\n' 'ION-'ANSI-RED`)
    await output(page, 'ION-ANSI-RED')
    const red = pane(page).locator('.xterm:visible .xterm-fg-1').filter({ hasText: 'ION-ANSI-RED' }).first()
    const bounds = await red.boundingBox()
    assert.ok(bounds?.width, 'ANSI SGR red did not apply to the rendered text.')
    // Intercept the write in this Electron process so the user's pasteboard is untouched.
    await app.evaluate(({ clipboard }) => {
      clipboard.writeText = (value) => { globalThis.ionTerminalCopied = value }
    })
    const rowY = bounds.y + bounds.height / 2
    await page.mouse.move(bounds.x, rowY)
    await page.mouse.down()
    await page.mouse.move(bounds.x + bounds.width, rowY)
    await page.mouse.up()
    await input(page).evaluate((element) => {
      element.focus()
      element.dispatchEvent(new KeyboardEvent('keydown', { key: 'c', code: 'KeyC', metaKey: true, bubbles: true, cancelable: true }))
    })
    await eventually(() => app.evaluate(() => globalThis.ionTerminalCopied?.trim() === 'ION-ANSI-RED'),
      'The terminal did not copy the selected text.')
    await input(page).evaluate((element) => {
      const data = new DataTransfer()
      data.setData('text/plain', "print -r -- 'ION-'PASTE-OK")
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await page.keyboard.press('Enter')
    await output(page, 'ION-PASTE-OK')
    console.log('PASS Python virtual environment and REPL, prompts, input, history, ANSI color, selection, copy and paste')

    await command(page, 'stty size | sed "s/^/ION-SIZE-A:/"')
    const previous = await output(page, /^ION-SIZE-A:\d+ \d+$/)
    await resize(page)
    await command(page, 'stty size | sed "s/^/ION-SIZE-B:/"')
    const next = await output(page, /^ION-SIZE-B:\d+ \d+$/)
    assert.ok(Number(next.match(/:(\d+)/)[1]) > Number(previous.match(/:(\d+)/)[1]), 'The PTY row count did not increase.')

    await command(page, String.raw`sh -c 'printf "ION-INTERRUPT:%s\n" "$$"; exec sleep 120'`)
    const interruptPid = Number((await output(page, /^ION-INTERRUPT:\d+$/)).split(':')[1])
    assert.ok(isAlive(interruptPid))
    await terminalShortcut(app, 'C', ['control'])
    await reaped([interruptPid])
    await command(page, 'print -r -- "ION-INTERRUPTED:$?"')
    await output(page, 'ION-INTERRUPTED:130')
    console.log('PASS PTY resize reaches stty and Ctrl+C interrupts the foreground job without closing zsh')

    const first = await sessionSelector(page).inputValue()
    await click(page, 'terminal-new')
    await sessionSelector(page).locator('option').nth(1).waitFor({ state: 'attached' })
    await shellReady(page)
    const second = await sessionSelector(page).inputValue()
    assert.notEqual(first, second)
    await command(page, `[[ "$PWD" == ${quote(project.directory)} ]] && print -r -- 'ION-'SECOND-OK`)
    await output(page, 'ION-SECOND-OK')
    await sessionSelector(page).selectOption(first)
    assert.doesNotMatch(await transcript(page), /ION-SECOND-OK/)
    // Fill multiple native output chunks while the xterm surface is detached.
    await command(page, `sleep 0.3; python3 -c 'for i in range(2600): print(f"hidden {i:04d} " + "x" * 90)'; print -r -- 'ION-'HIDDEN-DONE`)
    const beforeHide = await pids(session)
    await click(page, 'terminal-hide')
    await pane(page).waitFor({ state: 'hidden' })
    await sleep(1150)
    await focus(app)
    await output(page, 'ION-HIDDEN-DONE')
    assert.ok((await pids(session)).filter((pid) => beforeHide.includes(pid)).length >= 4, 'Hiding the panel restarted the shells.')
    await command(page, "sleep 1; print -r -- 'ION-'RUN-SWITCH-DONE")
    await runProgram(page)
    await click(page, 'bottom-terminal-tab')
    await output(page, 'ION-RUN-SWITCH-DONE')
    await terminalShortcut(app, 'F', ['meta'])
    await page.getByTestId('terminal-search-input').fill('ION-RUN-SWITCH-DONE')
    await page.getByTestId('terminal-search-input').press('Enter')
    await page.getByTestId('terminal-search-status').getByText('Match', { exact: true }).waitFor()
    await page.getByTestId('terminal-search-input').press('Escape')
    await page.getByTestId('terminal-search-input').waitFor({ state: 'hidden' })
    if (values.screenshots) await page.screenshot({ path: join(values.screenshots, 'integrated-terminal.png') })
    await click(page, 'terminal-clear')
    await eventually(async () => !(await transcript(page)).includes('ION-RUN-SWITCH-DONE'), 'Clear retained previous output.')
    console.log('PASS multiple sessions, hidden high-volume output, Run Console independence, terminal search and Clear')

    await sessionSelector(page).selectOption(second)
    await command(page, String.raw`sleep 120 & printf 'ION-BG:%s\n' $!`)
    const backgroundPid = Number((await output(page, /^ION-BG:\d+$/)).split(':')[1])
    await command(page, String.raw`sh -c 'trap "" TERM HUP; printf "ION-FG:%s\n" "$$"; while :; do sleep 120; done'`)
    const foregroundPid = Number((await output(page, /^ION-FG:\d+$/)).split(':')[1])
    assert.ok(isAlive(backgroundPid) && isAlive(foregroundPid))
    const terminalProcesses = await pids(session)
    await click(page, 'terminal-close')
    await reaped([backgroundPid, foregroundPid])
    assert.equal(await sessionSelector(page).inputValue(), first)
    const survivors = await pids(session)
    assert.equal(survivors.length, 2, 'Only the first shell and its helper should remain.')
    await reaped(terminalProcesses.filter((pid) => !survivors.includes(pid)))
    await click(page, 'terminal-close')
    await reaped(survivors)
    for (let cycle = 0; cycle < 8; cycle++) {
      await click(page, 'terminal-new')
      await shellReady(page)
      const started = await pids(session)
      assert.equal(started.length, 2, 'Each session owns one shell and one helper.')
      await click(page, 'terminal-close')
      await reaped(started)
    }
    assert.deepEqual(await pids(session), [])
    console.log('PASS closing a session reaps foreground and background jobs; eight create/close cycles left no children')

    await click(page, 'terminal-new')
    await shellReady(page)
    await command(page, String.raw`sleep 120 & printf 'ION-QUIT:%s\n' $!`)
    const quitPid = Number((await output(page, /^ION-QUIT:\d+$/)).split(':')[1])
    assert.ok(isAlive(quitPid))
    const final = await pids(session)
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    await close(session)
    await reaped(final)
    console.log('PASS quitting Ion closes terminal processes and sessions stayed offline')
  } catch (error) {
    console.error(error)
    if (!page.isClosed()) console.error('Terminal transcript:', await transcript(page).catch(() => ''))
    if (!page.isClosed()) console.error('Panel:', await pane(page).innerText({ timeout: 300 }).catch(() => ''))
    throw error
  } finally {
    await close(session)
  }
})
