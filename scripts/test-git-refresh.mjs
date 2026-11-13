import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'
import { _electron } from 'playwright-core'
import electron from 'electron'
import { withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { source: { type: 'string', default: '.' }, out: { type: 'string' } } })
const result = { complete: false, source: resolve(values.source), platform: process.platform }
try {
  await withScratch('git-refresh-gate', async scratch => {
    const entry = join(scratch, 'entry.tsx')
    await writeFile(entry, `import React,{useState} from 'react';import{createRoot}from'react-dom/client';
      import Panel from ${JSON.stringify(join(result.source, 'src/renderer/source-control/SourceControlPanel.tsx'))};
      let count=0,release;const status=()=>Promise.resolve({kind:'repository',branch:'main',entries:[{path:count++?'new.txt':'old.txt',absolutePath:'/fixture/old.txt',index:'',worktree:'M'}]});
      const bridge={status,diff:()=>new Promise(resolve=>{release=()=>resolve({})})};
      function App(){const[revision,setRevision]=useState(0);return <><button id="save" onClick={()=>setRevision(r=>r+1)}>Save source</button>
      <button id="release" onClick={()=>release()}>Complete operation</button><Panel bridge={bridge} revision={revision} onClose={()=>{}} onEntries={()=>{}} onDiff={()=>{}} isDirty={()=>false}/></>};
      createRoot(document.querySelector('#root')).render(<App/>);`)
    await build({ entryPoints: [entry], outfile: join(scratch, 'bundle.js'), bundle: true, format: 'iife', jsx: 'automatic',
      nodePaths: [resolve('node_modules')], logLevel: 'silent' })
    await writeFile(join(scratch, 'index.html'), '<link rel="stylesheet" href="bundle.css"><div id="root"></div><script src="bundle.js"></script>')
    await writeFile(join(scratch, 'main.cjs'), `const{app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}).loadFile(${JSON.stringify(join(scratch, 'index.html'))}));app.on('window-all-closed',()=>app.quit());`)
    const app = await _electron.launch({ executablePath: electron, args: [join(scratch, 'main.cjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '' } })
    try {
      const page = await app.firstWindow()
      await page.getByTestId('git-open-diff').filter({ hasText: 'old.txt' }).click()
      await page.locator('#save').click()
      await page.waitForTimeout(550) // Past the real debounce while diff is pending.
      await page.locator('#release').click()
      await page.getByTestId('git-open-diff').filter({ hasText: 'new.txt' }).waitFor({ timeout: 2000 })
      assert.equal(await page.getByTestId('git-open-diff').count(), 1)
      result.complete = true
    } finally { await app.close() }
  })
} catch (error) { result.error = String(error.stack ?? error); process.exitCode = 1 }
if (values.out) { await mkdir(resolve(values.out, '..'), { recursive: true }); await writeFile(values.out, JSON.stringify(result, null, 2) + '\n') }
console.log(JSON.stringify(result))
