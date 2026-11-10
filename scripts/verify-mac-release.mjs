import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { lstat, mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { chromium } from 'playwright-core'
import { atPath, editorShows, eventually, requireVisibleDesktop, withScratch } from './desktop-harness.mjs'
import { macDocumentInfo } from './macos-document-types.mjs'
import { pdfFixture } from './viewer-fixtures.mjs'

requireVisibleDesktop()
const release = JSON.parse(await readFile('package.json', 'utf8'))
const image = resolve(process.argv[2] ?? `release/Ion-IDE-${release.version}-mac-${process.arch}.dmg`)
const command = (binary, args) => execFileSync(binary, args, { encoding: 'utf8' }).trim()

async function bytes(path) {
  const stat = await lstat(path)
  if (!stat.isDirectory()) return stat.isFile() ? stat.size : 0
  const sizes = await Promise.all((await readdir(path)).map((name) => bytes(join(path, name))))
  return sizes.reduce((total, size) => total + size, 0)
}

async function verifyTerminal(helper) {
  command('/usr/bin/codesign', ['--verify', '--strict', helper])
  assert.equal(command('/usr/bin/lipo', [helper, '-archs']), process.arch === 'x64' ? 'x86_64' : process.arch)
  const child = spawn(helper, ['80', '24', '/bin/sh', '-c',
    'test -t 0 && test -t 1 && test -t 2 || exit 1; printf "ready> "; IFS= read -r value; printf "\\nsealed:%s\\n" "$value"'],
  { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  let sent = false
  child.stderr.resume()
  child.stdin.on('error', () => {})
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    output += chunk
    if (!sent && output.includes('ready>')) {
      sent = true
      const value = Buffer.from('hello\n')
      const frame = Buffer.alloc(value.length + 3)
      frame[0] = 0x44
      frame.writeUInt16BE(value.length, 1)
      value.copy(frame, 3)
      child.stdin.write(frame)
    }
  })
  let timer
  try {
    const [exit] = await Promise.race([once(child, 'close'), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Packaged PTY timed out.')), 5000)
    })])
    assert.equal(exit, 0)
    assert.match(output, /sealed:hello/)
  } finally {
    clearTimeout(timer)
    child.stdin.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
}

async function waitForCheckpoint(page, text) {
  const deadline = performance.now() + 8000
  do {
    const matches = await page.evaluate(async (expected) => {
      const drafts = await window.ion.recovery.list()
      if (expected === null) return drafts.length === 0
      return drafts.length === 1 && await window.ion.recovery.read(drafts[0].id) === expected
    }, text)
    if (matches) return
    await sleep(100)
  } while (performance.now() < deadline)
  assert.fail(text === null ? 'Discarded draft remained in the journal.' : 'Unsaved draft was not checkpointed.')
}

await withScratch('release-check', async (scratch) => {
  const volume = join(scratch, 'mount')
  const profile = join(scratch, 'profile')
  const project = join(scratch, 'Packaged study files')
  const csv = join(project, 'study.csv')
  const pdf = join(project, 'notes.pdf')
  const notebook = join(project, 'study.ipynb')
  const markdown = join(project, 'study.md')
  await Promise.all([mkdir(volume), mkdir(profile), mkdir(project)])
  await Promise.all([
    writeFile(csv, 'chapter,title\n1,"Local documents"\n'),
    writeFile(pdf, pdfFixture(1)),
    writeFile(notebook, JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {},
      cells: [{ cell_type: 'markdown', id: 'study', metadata: {}, source: '# Local study notebook' }] })),
    writeFile(markdown, '# Local Markdown preview\n\nAn **offline** study note.\n'),
    writeFile(join(profile, 'preferences.json'), JSON.stringify({
      version: 1, settings: {},
      recents: [{ path: project, name: 'Packaged study files', kind: 'folder', lastOpened: 1 }],
    })),
  ])
  let attached = false
  let child
  let browser
  async function start(binary) {
    const portFile = join(profile, 'DevToolsActivePort')
    await rm(portFile, { force: true })
    child = spawn(binary, [`--user-data-dir=${profile}`, '--remote-debugging-port=0'], { stdio: 'ignore' })
    let launchError
    child.once('error', (error) => { launchError = error })
    let port
    for (let attempt = 0; attempt < 100; attempt++) {
      port = await readFile(portFile, 'utf8').then((text) => text.split('\n')[0], () => null)
      if (port || launchError || child.exitCode !== null || child.signalCode !== null) break
      await sleep(50)
    }
    if (launchError) throw launchError
    assert.ok(port, 'packaged browser started')
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 })
    const context = browser.contexts()[0]
    const page = context.pages()[0] ?? await context.waitForEvent('page', { timeout: 8000 })
    page.setDefaultTimeout(8000)
    await page.getByTestId('welcome').waitFor()
    await context.setOffline(true)
    assert.equal(page.url(), 'app://workbench/index.html')
    return page
  }
  try {
    command('/usr/bin/hdiutil', ['attach', '-quiet', '-nobrowse', '-readonly', '-mountpoint', volume, image])
    attached = true
    assert.equal(await readlink(join(volume, 'Applications')), '/Applications')
    const copy = join(scratch, 'Ion IDE.app')
    command('/usr/bin/ditto', ['--norsrc', '--noextattr', join(volume, 'Ion IDE.app'), copy])
    command('/usr/bin/codesign', ['--verify', '--deep', '--strict', copy])
    for (const [key, value] of Object.entries(macDocumentInfo)) {
      const plist = join(copy, 'Contents/Info.plist')
      assert.deepEqual(JSON.parse(command('/usr/bin/plutil', ['-extract', key, 'json', '-o', '-', plist])), value)
    }
    const binary = join(copy, 'Contents/MacOS/Ion IDE')
    assert.equal(command('/usr/bin/lipo', [binary, '-archs']), process.arch === 'x64' ? 'x86_64' : process.arch)
    await verifyTerminal(join(copy, 'Contents/Resources/ion-pty'))
    command('/usr/bin/codesign', ['--verify', '--strict', join(copy, 'Contents/Resources/ion-rg')])
    const page = await start(binary)
    await page.locator('.app-shell[data-theme-id="dark"]').waitFor()
    assert.equal(await page.getByTestId('onboarding').count(), 0, 'The existing profile opens directly to Welcome.')
    assert.equal(await page.evaluate(async () => (await window.ion.themes.list()).length), 5)
    await page.getByTestId('command-palette').click()
    const commands = page.getByTestId('command-palette-input')
    await commands.fill('Preferences')
    await commands.press('Enter')
    await page.getByRole('dialog', { name: 'Preferences' }).waitFor()
    await page.getByText(`Ion ${release.version}`, { exact: true }).waitFor()
    assert.equal(await page.getByRole('checkbox', { name: /Check for updates on launch/ }).isChecked(), false)
    const reducedMotion = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)
    await page.getByTestId('onboarding-replay').click()
    if (reducedMotion) await page.getByRole('button', { name: 'Back to Ion' }).click()
    else {
      await page.getByTestId('onboarding-intro').waitFor()
      await page.getByTestId('onboarding-skip-intro').click()
    }
    await page.getByTestId('onboarding').waitFor({ state: 'detached' })
    console.log('PASS packaged offline introduction replays and dismisses.')
    await page.getByTestId('settings').click()
    await page.getByTestId('theme-light').click()
    await page.locator('.app-shell[data-theme-id="light"]').waitFor()
    await page.getByRole('button', { name: 'Done', exact: true }).click()
    const checks = await page.evaluate(async () => {
      await window.ion.updateSettings({ resourceProfile: 'full' })
      await window.ion.setOptionalPanel('projects')
      const provider = await window.ion.projects.provider()
      await window.ion.setOptionalPanel(null)
      await window.ion.updateSettings({ resourceProfile: 'minimal' })
      const [concept, practice] = await Promise.all([
        window.ion.learning.getConcept('statements'), window.ion.practice.list(),
      ])
      return [concept.title, provider.hasKey, practice.problems.length]
    })
    assert.deepEqual(checks, ['Statements and semicolons', false, 0])
    await page.getByTestId('workspace-learn').click()
    await page.getByTestId('learning-pane').waitFor()
    await page.getByTestId('learning-open-marketplace').click()
    await page.locator('[data-testid="marketplace-install"][data-pack="python"]').click()
    await page.locator('[data-testid="marketplace-use"][data-pack="python"]').click()
    await page.getByTestId('learning-topic').first().click()
    await page.getByTestId('learning-pack-lesson').waitFor()
    await page.getByRole('button', { name: 'Welcome', exact: true }).click()
    await page.getByTestId('workspace-practice').click()
    await page.getByTestId('practice-language').selectOption('python')
    await page.getByTestId('practice-difficulty').selectOption('Easy')
    await page.getByTestId('practice-challenge').first().getByTestId('practice-start').click()
    await page.getByTestId('practice-run-samples').waitFor()
    const starter = await editorShows(page, 'Write your solution here.')
    await starter.dispose()
    await page.getByTestId('close-tab').click()
    await page.getByRole('button', { name: 'Welcome', exact: true }).click()
    await page.locator('.recent-entry').filter({ hasText: 'Packaged study files' }).click()
    await page.getByRole('button', { name: 'Search in Files', exact: true }).click()
    await page.getByTestId('workspace-search-input').fill('Local Markdown preview')
    await page.getByRole('button', { name: /study\.md, line 1/ }).click()
    await (await editorShows(page, '# Local Markdown preview')).dispose()
    await atPath(page, 'explorer-entry', csv).click()
    await page.getByTestId('table-grid').getByText('Local documents', { exact: true }).waitFor()
    await atPath(page, 'close-tab', csv).click()
    await atPath(page, 'explorer-entry', pdf).click()
    await page.locator('[data-rendered="true"] [data-testid="pdf-page-canvas"]').waitFor()
    await atPath(page, 'close-tab', pdf).click()
    await atPath(page, 'explorer-entry', notebook).click()
    const notebookView = page.getByTestId('notebook-view')
    await notebookView.getByRole('heading', { name: 'Local study notebook' }).waitFor()
    await atPath(page, 'close-tab', notebook).click()
    await notebookView.waitFor({ state: 'detached' })
    await atPath(page, 'explorer-entry', markdown).click()
    await page.getByTestId('markdown-preview-toggle').click()
    const markdownView = page.getByTestId('markdown-preview')
    await markdownView.getByRole('heading', { name: 'Local Markdown preview' }).waitFor()
    await page.getByTestId('markdown-preview-toggle').click()
    await markdownView.waitFor({ state: 'hidden' })
    await atPath(page, 'close-tab', markdown).click()
    await markdownView.waitFor({ state: 'detached' })
    await page.getByRole('button', { name: 'Welcome', exact: true }).click()
    await page.getByTestId('new-file').click()
    const cStarter = await editorShows(page, '#include <stdio.h>')
    await cStarter.dispose()
    await page.locator('.monaco-editor .view-line').first().click({ position: { x: 8, y: 7 } })
    await page.keyboard.press('Meta+a')
    const draft = 'int main(void) { return 0; } /* packaged recovery */'
    await page.keyboard.insertText(draft)
    await editorShows(page, draft)
    await waitForCheckpoint(page, draft)
    await eventually(async () => {
      const snapshot = await readFile(join(profile, 'editor-session.json'), 'utf8').then(JSON.parse, () => null)
      return snapshot?.tabs.some(({ draftId }) => Boolean(draftId))
    }, 'The active draft must be referenced by the session.')

    const exited = once(child, 'exit')
    assert.equal(child.kill('SIGKILL'), true, 'terminated the disposable app copy')
    assert.deepEqual(await exited, [null, 'SIGKILL'])
    await Promise.race([browser.close().catch(() => {}), sleep(2500, undefined, { ref: false })])
    browser = undefined

    const restored = await start(binary)
    await restored.getByTestId('resume-session').click()
    await editorShows(restored, draft)
    await restored.getByTestId('close-tab').click()
    await restored.getByRole('button', { name: 'Discard', exact: true }).click()
    await restored.getByTestId('tab').waitFor({ state: 'detached' })
    await waitForCheckpoint(restored, null)
    console.log('PASS mounted installer, ad-hoc signature, bundled PTY and search, offline workspaces, previews, themes and crash session recovery')
    console.log(JSON.stringify({ appBytes: await bytes(copy), installerBytes: (await lstat(image)).size }))
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit')
      child.kill('SIGTERM')
      await Promise.race([exited, sleep(2500, undefined, { ref: false })])
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await exited
      }
    }
    if (browser) await Promise.race([browser.close().catch(() => {}), sleep(2500, undefined, { ref: false })])
    if (attached) command('/usr/bin/hdiutil', ['detach', volume, '-quiet'])
  }
})
