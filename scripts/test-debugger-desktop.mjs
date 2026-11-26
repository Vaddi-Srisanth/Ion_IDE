import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifact, atPath, close, createProject, eventually, launch, openFolder, openFromExplorer,
  resourceSnapshot, stubDialogs, withScratch } from './desktop-harness.mjs'

// This test uses the production renderer, preload and main-process path with a
// disposable profile/workspace. Only the native consent dialog is stubbed.
process.env.ION_SHOW_TEST_WINDOWS = '0'
const target = await artifact('dist')

async function command(page, label) {
  await page.getByTestId('command-palette').click()
  const input = page.getByTestId('command-palette-input')
  await input.fill(label)
  await page.getByRole('option', { name: new RegExp(label, 'i') }).first().click()
}

await withScratch('debugger-desktop', async scratch => {
  const project = await createProject(join(scratch, 'workspace'), { fileCount: 0 })
  const source = join(project.directory, 'debug.c')
  await writeFile(source, [
    '#include <stdio.h>',
    'int main(void) {',
    '  int answer = 21;',
    '  answer *= 2;',
    '  printf("%d\\n", answer);',
    '  return answer == 42 ? 0 : 1;',
    '}',
    '',
  ].join('\n'))
  const profile = join(scratch, 'profile')
  await mkdir(profile)
  const session = await launch(target, profile)
  try {
    const { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, allowDebug: true })
    await openFolder(page, project)
    await openFromExplorer(page, source, 'answer *= 2')
    const before = await resourceSnapshot(session, { details: true })

    await command(page, 'Go to Line')
    await page.getByTestId('goto-line-input').fill('4')
    await page.getByTestId('goto-line-input').press('Enter')
    await page.locator('.monaco-editor').click()
    await page.keyboard.press('F9')
    await page.getByTestId('toggle-debug').click()
    await page.getByTestId('debug-start').click()
    await page.locator('[data-testid="debug-panel"][data-phase="paused"]').waitFor({ timeout: 25_000 })
    assert.ok(await page.getByTestId('debug-frame').count(), 'Production debugger exposed no paused stack frame.')
    assert.equal((await page.locator('.debug-breakpoint-dot').count()) > 0, true, 'Production breakpoint was not retained.')

    await page.getByRole('button', { name: 'Continue' }).click()
    await page.locator('[data-testid="debug-panel"][data-phase="finished"]').waitFor({ timeout: 20_000 })
    await eventually(async () => await page.evaluate(() => window.ion.debug.status()) === null,
      'Production debugger session did not release its main-process owner.', 10_000)
    const after = await resourceSnapshot(session, { details: true })
    assert.ok(after.childRssMiB <= before.childRssMiB + 1,
      `Debugger left child-process RSS behind (${before.childRssMiB} -> ${after.childRssMiB} MiB).`)
    assert.deepEqual(session.errors, [])
    assert.deepEqual(session.requests, [])
    console.log('PASS production Electron debugger breakpoint, stack, continue and owned cleanup')
  } finally {
    await close(session)
  }
})
