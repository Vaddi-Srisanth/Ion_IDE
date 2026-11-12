import assert from 'node:assert/strict'
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { artifact, atPath, close, editorShows, eventually, launch, openFromExplorer, withScratch } from './desktop-harness.mjs'

// Only native dialog decisions are stubbed. The renderer, IPC, filesystem,
// persisted trust store, compiler, PTY program execution and application restart
// are real. The standard harness prevents all test windows from showing/focusing.
process.env.ION_SHOW_TEST_WINDOWS = '0'
const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' }, help: { type: 'boolean' } } })
if (values.help) {
  console.log('node scripts/test-run-trust.mjs [--target dist]\nUses hidden disposable Electron profiles/workspaces and an installed C compiler. Stubs native consent dialogs only; compiles and runs actual C programs.')
  process.exit(0)
}
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use production build files for hidden native dialog regression tests.')
const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
const expectedCheckbox = 'Trust this folder for future single-file Runs'
const source = revision => `#include <stdio.h>\n/* ION-RUN-TRUST-REVISION-${revision} */\nint main(void) {\n  FILE *file = fopen("ion-executed.log", "ab");\n  if (!file) return 2;\n  if (fputc('x', file) == EOF || fclose(file) != 0) return 3;\n  puts("ION-RUN-TRUST-EXECUTED");\n  return 0;\n}\n`
const trustFile = profile => join(profile, 'run-trust.json')
async function readTrust(profile) {
  try { return JSON.parse(await readFile(trustFile(profile), 'utf8')) }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, roots: [] }; throw error }
}
async function writes(directory) {
  try { return (await readFile(join(directory, 'ion-executed.log'), 'utf8')).length }
  catch (error) { if (error.code === 'ENOENT') return 0; throw error }
}
async function installDialogs(session, folder) {
  await session.app.evaluate(({ dialog }, directory) => {
    globalThis.ionRunTrustRegression = { folder: directory, answers: [], prompts: [], unexpected: [] }
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.ionRunTrustRegression.folder] })
    dialog.showSaveDialog = async () => ({ canceled: true })
    dialog.showMessageBox = async (_window, options) => {
      const state = globalThis.ionRunTrustRegression
      if (!(options?.buttons ?? []).includes('Run Program')) {
        state.unexpected.push({ message: options?.message, buttons: options?.buttons })
        return { response: options?.cancelId ?? 0, checkboxChecked: false }
      }
      state.prompts.push({ message: options.message, buttons: options.buttons, checkboxLabel: options.checkboxLabel,
        checkboxChecked: options.checkboxChecked, detail: options.detail })
      // Unexpected prompts fail closed. Tests explicitly queue consent only
      // where a new user approval is expected.
      return state.answers.shift() ?? { response: 0, checkboxChecked: false }
    }
  }, folder)
  await session.page.context().setOffline(true)
  await session.page.evaluate(() => {
    window.ionRunTrustEvents = []
    window.ionRunTrustUnsubscribe = window.ion.runConsole.onUpdate(event => {
      window.ionRunTrustEvents.push(event)
      if (window.ionRunTrustEvents.length > 200) window.ionRunTrustEvents.shift()
    })
  })
}
const prompts = session => session.app.evaluate(() => globalThis.ionRunTrustRegression.prompts)
async function answer(session, response, checkboxChecked) {
  await session.app.evaluate((_electron, choice) => { globalThis.ionRunTrustRegression.answers = [choice] }, { response, checkboxChecked })
}
async function openWorkspace(session, directory, program, { welcome = false } = {}) {
  await session.app.evaluate((_electron, folder) => { globalThis.ionRunTrustRegression.folder = folder }, directory)
  const surface = welcome ? session.page.getByTestId('welcome') : session.page.locator('.titlebar')
  await surface.getByTestId('open-folder').click()
  await session.page.getByTestId('workspace').waitFor()
  await atPath(session.page, 'explorer-entry', program).waitFor()
  await openFromExplorer(session.page, program, 'ION-RUN-TRUST-REVISION-')
}
async function run(session, directory, status, expectedWrites, expectedPrompts) {
  const before = await session.page.evaluate(() => window.ionRunTrustEvents.findLast(event => event.update.kind === 'phase' && event.update.phase === 'preparing')?.id)
  await session.page.getByTestId('run').click()
  await session.page.waitForFunction(previous => {
    const latest = window.ionRunTrustEvents.findLast(event => event.update.kind === 'phase' && event.update.phase === 'preparing')
    return latest && latest.id !== previous
  }, before)
  await session.page.locator(`[data-testid="output"][data-status="${status}"]`).waitFor({ timeout: 20000 })
  await session.page.getByTestId('run').waitFor({ timeout: 20000 })
  await eventually(async () => await writes(directory) === expectedWrites,
    `Expected ${expectedWrites} real program execution(s) in the active workspace, got ${await writes(directory)}.`, 10000)
  assert.equal((await prompts(session)).length, expectedPrompts)
  if (status === 'success') {
    assert.match(await session.page.getByTestId('run-console-duration').textContent(), /Exit 0 · \d+ ms/)
    await session.page.waitForFunction(() => window.ionRunTrustEvents.filter(event => event.update.kind === 'data')
      .map(event => event.update.text).join('').includes('ION-RUN-TRUST-EXECUTED'))
  }
}
async function assertStoredRoot(profile, directory) {
  const stored = await readTrust(profile)
  const canonical = await realpath(directory)
  const stats = await lstat(canonical, { bigint: true })
  assert.equal(stored.version, 1)
  assert.deepEqual(stored.roots, [{ path: canonical, dev: String(stats.dev), ino: String(stats.ino) }])
}
async function hidden(session) {
  assert.equal(await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
    .some(window => window.isVisible() || window.isFocused())), false, 'Regression test must stay hidden.')
  assert.deepEqual(await session.app.evaluate(() => globalThis.ionRunTrustRegression.unexpected), [])
}
async function quit(session) {
  await session.page.evaluate(() => window.ionRunTrustUnsubscribe?.()).catch(() => {})
  const closing = close(session)
  const discard = session.page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: /discard/i })
  await Promise.race([closing, discard.click({ timeout: 1500 }).catch(() => closing)])
  await closing
}

await withScratch('run-trust', async scratch => {
  const directory = join(scratch, 'trusted-workspace')
  const nested = join(directory, 'nested-workspace')
  const different = join(scratch, 'different-workspace')
  const profile = join(scratch, 'private-profile')
  await Promise.all([mkdir(nested, { recursive: true }), mkdir(different), mkdir(profile)])
  const program = join(directory, 'program.c'), nestedProgram = join(nested, 'nested.c'), otherProgram = join(different, 'other.c')
  await Promise.all([writeFile(program, source(1)), writeFile(nestedProgram, source(1)), writeFile(otherProgram, source(1)),
    writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
      settings: { autoSave: false, saveBeforeRun: true, openFullScreen: false, checkUpdatesOnLaunch: false, resourceProfile: 'minimal' }, recents: [] }))])
  let session = await launch(target, profile)
  try {
    await installDialogs(session, directory)
    await openWorkspace(session, directory, program, { welcome: true })
    await answer(session, 0, true)
    await run(session, directory, 'rejected', 0, 1)
    assert.deepEqual((await readTrust(profile)).roots, [], 'Cancel with a checked box must never persist trust.')
    assert.equal((await prompts(session))[0].checkboxLabel, expectedCheckbox)
    assert.equal((await prompts(session))[0].checkboxChecked, false)
    console.log('PASS Cancel plus checked trust does not execute code or grant persistent folder approval.')

    await answer(session, 1, true)
    await run(session, directory, 'success', 1, 2)
    await assertStoredRoot(profile, directory)
    console.log('PASS one explicit checked approval persists the canonical folder identity and compiles/runs real C.')

    await session.page.getByTestId('editor').locator('.view-line').first().click({ position: { x: 6, y: 8 } })
    await session.page.keyboard.press(mod + '+a')
    await session.page.evaluate(text => {
      const clipboardData = new DataTransfer()
      clipboardData.setData('text/plain', text)
      document.activeElement.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }, source(2))
    await (await editorShows(session.page, 'ION-RUN-TRUST-REVISION-2')).dispose()
    await session.page.getByTestId('save-file').click()
    await eventually(async () => await readFile(program, 'utf8') === source(2), 'Actual editor edits did not save to the C source.')
    await run(session, directory, 'success', 2, 2)
    await assertStoredRoot(profile, directory)
    console.log('PASS saved source revisions in an approved folder execute without another consent prompt.')

    await openWorkspace(session, nested, nestedProgram)
    await answer(session, 0, true)
    await run(session, nested, 'rejected', 0, 3)
    await assertStoredRoot(profile, directory)
    await openWorkspace(session, different, otherProgram)
    await answer(session, 0, false)
    await run(session, different, 'rejected', 0, 4)
    await assertStoredRoot(profile, directory)
    console.log('PASS nested and unrelated workspace roots do not inherit folder approval.')

    await hidden(session)
    await quit(session)
    session = undefined
    await assertStoredRoot(profile, directory)
    session = await launch(target, profile)
    await installDialogs(session, directory)
    await openWorkspace(session, directory, program, { welcome: true })
    await run(session, directory, 'success', 3, 0)
    await assertStoredRoot(profile, directory)
    console.log('PASS a fresh Electron process reopens the same real profile/folder and runs without prompting.')

    await session.page.getByTestId('settings').click()
    const preferences = session.page.getByRole('dialog', { name: 'Preferences' })
    await preferences.getByRole('button', { name: 'Forget Trusted Run Folders', exact: true }).click()
    await preferences.getByRole('status').filter({ hasText: 'Remembered Run approvals cleared.' }).waitFor()
    await preferences.getByRole('button', { name: 'Done', exact: true }).click()
    assert.deepEqual((await readTrust(profile)).roots, [])
    await answer(session, 0, true)
    await run(session, directory, 'rejected', 3, 1)
    assert.deepEqual((await readTrust(profile)).roots, [], 'Revocation and subsequent Cancel must stay revoked.')
    assert.equal((await prompts(session))[0].checkboxLabel, expectedCheckbox)
    await hidden(session)
    console.log('PASS Preferences revocation clears disk and in-memory approval; the next Run asks again.')
  } finally { if (session) await quit(session) }
})
