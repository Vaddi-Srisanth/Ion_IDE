import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { artifact, atPath, close, createProject, editorShows, launch, stubDialogs, withScratch } from './desktop-harness.mjs'

const target = await artifact('dist')
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const rendered = async (page, text) => { await (await editorShows(page, text)).dispose() }
const editorText = (page) => page.locator('.monaco-editor .view-lines').innerText()
const activeTab = (page) => page.getByTestId('tab').locator('.tab-name[aria-current="true"]')

await withScratch('starter-code', async (scratch) => {
  const profile = join(scratch, 'profile')
  const project = await createProject(join(scratch, 'project'), { fileCount: 0 })
  const renamedJava = join(project.directory, 'Exercise.java')
  const javascript = join(project.directory, 'app.js')
  const empty = join(project.directory, 'empty.c')
  const named = join(project.directory, 'Named.java')
  const blankCpp = join(project.directory, 'blank.cpp')
  await mkdir(profile)
  await Promise.all([
    writeFile(empty, ''),
    writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { autoSave: false }, recents: [] })),
  ])
  const session = await launch(target, profile)
  let step = 'open a C starter from Welcome'
  try {
    const { app, page } = session
    await page.context().setOffline(true)
    await stubDialogs(app, { folder: project.directory, save: renamedJava, allowRun: true })

    await page.getByTestId('new-file').click()
    await rendered(page, '#include <stdio.h>')
    await rendered(page, 'int main(void)')
    await page.getByText('Ln 4, Col 5', { exact: true }).waitFor()
    assert.match(await activeTab(page).innerText(), /Untitled-\d+\.c/)
    const c = await editorText(page)
    await page.getByTestId('insert-starter').click()
    await page.getByRole('alert').filter({ hasText: 'empty source file' }).waitFor()
    assert.equal(await editorText(page), c)

    step = 'create and run a renamed Java starter'
    await page.getByTestId('new-starter').click()
    await page.getByTestId('starter-java').click()
    await rendered(page, 'public static void main(String[] args)')
    assert.match(await activeTab(page).innerText(), /Main\.java/)
    await page.getByTestId('save-file').click()
    await atPath(page, 'tab', renamedJava).waitFor()
    assert.match(await readFile(renamedJava, 'utf8'), /^class Main \{/)
    await page.getByTestId('run').click()
    await page.locator('[data-testid="output"][data-status="success"]').waitFor({ timeout: 20_000 })
    console.log('PASS quick C starter, editing cursor, no overwrite, and Java starter runs after Save As')

    step = 'insert and undo in an existing empty file'
    await page.getByTestId('open-folder').click()
    await atPath(page, 'explorer-entry', empty).click()
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="editor"] .monaco-editor .view-line')))
    assert.equal((await editorText(page)).trim(), '')
    await page.getByTestId('insert-starter').click()
    await rendered(page, '#include <stdio.h>')
    await page.keyboard.press(`${modifier}+z`)
    await page.waitForFunction(() => !document.querySelector('.monaco-editor .view-lines')?.textContent?.trim())
    assert.equal(await readFile(empty, 'utf8'), '')

    async function create(name, useStarter) {
      await page.getByTestId('create-file').click()
      await page.getByTestId('entry-name').fill(name)
      const checkbox = page.getByTestId('create-with-starter')
      await checkbox.waitFor()
      if (!useStarter) await checkbox.uncheck()
      await page.getByTestId('entry-submit').click()
      await atPath(page, 'tab', join(project.directory, name)).waitFor()
    }
    await create('Named.java', true)
    await rendered(page, 'public class Named')
    assert.match(await readFile(named, 'utf8'), /^public class Named \{/)
    await create('blank.cpp', false)
    assert.equal(await readFile(blankCpp, 'utf8'), '')
    console.log('PASS an existing empty file changes only on request and undoes in one step, and named creation can include or skip starters')

    step = 'open a blank file and use the selected Learn language'
    await page.getByTestId('new-starter').click()
    await page.getByTestId('starter-blank').click()
    assert.match(await activeTab(page).innerText(), /Untitled\.txt/)
    await page.waitForFunction(() => Boolean(document.querySelector('[data-testid="editor"] .monaco-editor .view-line')))
    assert.equal((await editorText(page)).trim(), '')

    await page.evaluate(async () => {
      await window.ion.learningPacks.install('python')
      await window.ion.learningPacks.install('javascript')
      await window.ion.learningPacks.select('python')
    })
    await page.getByRole('button', { name: 'Welcome', exact: true }).click()
    await page.getByTestId('workspace-learn').click()
    await page.waitForFunction(() => document.querySelector('[data-testid="learning-language"]')?.value === 'python')
    await page.getByTestId('new-file').click()
    await rendered(page, 'def main():')
    assert.match(await activeTab(page).innerText(), /main\.py/)

    step = 'select JavaScript while a C tab is open and create a JavaScript file'
    const cTab = page.getByRole('button', { name: /^Untitled-\d+\.c$/ })
    await cTab.click()
    const language = page.getByTestId('learning-language')
    await language.selectOption('javascript')
    await page.waitForFunction(() => {
      const select = document.querySelector('[data-testid="learning-language"]')
      return select?.value === 'javascript' && !select.disabled
    })
    assert.match(await activeTab(page).innerText(), /Untitled-\d+\.c/)
    await rendered(page, '#include <stdio.h>')
    await page.locator('.tab-strip').getByRole('button', { name: 'New file', exact: true }).click()
    await rendered(page, 'function main() {')
    assert.equal(await activeTab(page).innerText(), 'main.js')
    await stubDialogs(app, { folder: project.directory, save: javascript })
    await page.getByTestId('save-file').click()
    await atPath(page, 'tab', javascript).waitFor()
    assert.match(await readFile(javascript, 'utf8'), /^function main\(\) \{/)
    assert.deepEqual(session.requests, [])
    assert.deepEqual(session.errors, [])
    console.log('PASS blank files and new starters in the selected Learn language work offline, and JavaScript saves alongside the original C tab')
  } catch (error) {
    console.error('Starter test failed while trying to ' + step + '.')
    throw error
  } finally {
    const page = session.page
    if (await page.locator('dialog[open]').count()) await page.keyboard.press('Escape').catch(() => {})
    const discard = page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: 'Discard', exact: true })
    await Promise.all([close(session), discard.click({ timeout: 3000 }).catch(() => {})])
  }
})
