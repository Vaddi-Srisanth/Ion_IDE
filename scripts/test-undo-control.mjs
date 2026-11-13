import assert from 'node:assert/strict'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'
import electron from 'electron'
import { artifact, atPath, close, editorShows, launch, openFolder, openFromExplorer, sleep, stubDialogs, withScratch } from './desktop-harness.mjs'

const result = { complete: false, platform: process.platform, cases: [],
  method: 'Hidden stock Monaco and production Ion; insertText, sequential typing, existing Monaco paste command (no OS clipboard access); refocus every Undo. No production undo instrumentation.' }
const original = '#include <stdio.h>\nint main(void) { return 0; }\n'
const insertion = ' /* ION_AUDIT_UNDO */'
const key = process.platform === 'darwin' ? 'Meta' : 'Control'
const end = process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End'
const editorModuleName = (await readdir(resolve(process.env.ION_UNDO_TARGET ?? 'dist', 'renderer/assets'))).find(name => /^editor\.api-.*\.js$/.test(name))
async function insert(page, method) {
  if (method === 'insertText') await page.keyboard.insertText(insertion)
  else if (method === 'typing') await page.keyboard.type(insertion)
  else await page.evaluate(async ({ text, moduleName }) => {
    const url = new URL('assets/' + moduleName, location.href).href
    const instance = globalThis.control ?? (await import(url)).editor.getEditors().find(item => item.getDomNode()?.closest('[data-testid="editor"]'))
    if (!instance) throw new Error('The existing editor is unavailable')
    instance.trigger('clipboard', 'paste', { text, pasteOnNewLine: false, multicursorText: null })
  }, { text: insertion, moduleName: editorModuleName })
}
const out = resolve(process.env.ION_UNDO_REPORT ?? 'remediation/undo-control.json')
try {
  await withScratch('undo-control', async scratch => {
    const stockEntry = join(scratch, 'stock.js')
    const modulePath = path => JSON.stringify(resolve(path).replaceAll('\\', '/'))
    await writeFile(stockEntry, `import {editor} from ${modulePath('node_modules/monaco-editor/esm/vs/editor/editor.api.js')};
      import ${modulePath('node_modules/monaco-editor/esm/vs/languages/definitions/cpp/register.js')};
      globalThis.control=editor.create(document.querySelector('#editor'),{value:${JSON.stringify(original)},language:'c',automaticLayout:true,minimap:{enabled:false},fontSize:13});`)
    await build({ entryPoints: [stockEntry], outfile: join(scratch, 'stock-bundle.js'), bundle: true, format: 'iife',
      loader: { '.ttf': 'file' }, logLevel: 'silent' })
    await writeFile(join(scratch, 'stock.html'), '<link rel="stylesheet" href="stock-bundle.css"><div id="editor" style="height:700px"></div><button id="save">Save</button><script src="stock-bundle.js"></script>')
    await writeFile(join(scratch, 'stock-main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>{const w=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}});w.loadFile(${JSON.stringify(join(scratch, 'stock.html'))});});app.on('window-all-closed',()=>app.quit());`)
    // Windows treats a present, empty ELECTRON_RUN_AS_NODE as enabled. Match
    // the real desktop harness by omitting it, rather than setting it empty.
    const stockEnvironment = { ...process.env }
    delete stockEnvironment.ELECTRON_RUN_AS_NODE
    const stock = await _electron.launch({ executablePath: electron, args: [join(scratch, 'stock-main.cjs')], env: stockEnvironment })
    try {
      const page = await stock.firstWindow()
      await page.waitForFunction(() => !!globalThis.control)
      for (const method of ['insertText', 'typing', 'paste']) {
        await page.evaluate(value => { globalThis.control.setValue(value); globalThis.control.setPosition({lineNumber:1,column:999}); globalThis.control.focus() }, original)
        await insert(page, method)
        await page.locator('#save').click()
        const before = await page.evaluate(() => globalThis.control.getValue())
        const states = []
        for (let i = 0; i < 5; i++) {
          await page.evaluate(() => globalThis.control.focus())
          await page.keyboard.press(key + '+z'); await sleep(50)
          states.push(await page.evaluate(() => globalThis.control.getValue()))
          if (states.at(-1) === original) break
        }
        assert.equal(states.at(-1), original, `Stock ${method} must recover original through focused Undo`)
        if (method === 'paste') assert.equal(states.length, 1, 'A clipboard paste is one Undo operation')
        result.cases.push({ app: 'stock Monaco', method, before, focusedUndoStates: states })
      }
    } finally { await stock.close() }
    const project = { directory: join(scratch, 'project'), program: join(scratch, 'project', 'undo.c') }
    const path = join(project.directory, 'undo.c')
    const other = join(project.directory, 'other.txt')
    await mkdir(project.directory)
    await writeFile(path, original); await writeFile(other, 'Other tab')
    const profile = join(scratch, 'profile'); await mkdir(profile)
    await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1, settings: { autoSave: false, resourceProfile: 'minimal', openFullScreen: false } }))
    const session = await launch(await artifact(process.env.ION_UNDO_TARGET ?? 'dist'), profile)
    try {
      const { page, app } = session
      await page.context().setOffline(true)
      await stubDialogs(app, { folder: project.directory })
      await openFolder(page, project)
      await openFromExplorer(page, path, '#include')
      const line = () => page.getByTestId('editor').locator('.view-line').first()
      async function save() {
        await page.getByTestId('save-file').click()
        await atPath(page, 'tab', path).locator('.tab-dirty').waitFor({ state: 'detached' })
        return readFile(path, 'utf8')
      }
      for (const method of ['insertText', 'typing', 'paste']) for (const swap of [false, true]) {
        await line().click(); await page.keyboard.press(end)
        await insert(page, method)
        await (await editorShows(page, 'ION_AUDIT_UNDO')).dispose()
        const before = await save()
        if (swap) {
          await openFromExplorer(page, other, 'Other tab')
          await atPath(page, 'tab', path).locator('.tab-name').click()
          await (await editorShows(page, 'ION_AUDIT_UNDO')).dispose()
        }
        const states = []
        for (let i = 0; i < 5; i++) {
          await line().click(); await page.keyboard.press(key + '+z'); await sleep(50)
          states.push(await save())
          if (states.at(-1) === original) break
        }
        assert.equal(states.at(-1), original, `Ion ${method}, swap=${swap}: focused Undo must restore exact bytes`)
        assert.deepEqual(states, result.cases.find(item => item.app === 'stock Monaco' && item.method === method).focusedUndoStates,
          'Ion Undo grouping must match the stock editor with identical input')
        result.cases.push({ app: 'Ion production', method, swap, before, focusedUndoStates: states })
      }
      assert.deepEqual(session.errors, []); assert.deepEqual(session.requests, [])
    } finally { await close(session) }
  })
  result.complete = true
} catch (error) { result.error = String(error.stack ?? error); process.exitCode = 1 }
finally { await mkdir(resolve('remediation'), { recursive: true }); await writeFile(out, JSON.stringify(result, null, 2) + '\n') }
console.log(JSON.stringify({ complete: result.complete, cases: result.cases.length, error: result.error, report: out }))
