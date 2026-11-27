import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const fixture = `
  import { createRoot } from 'react-dom/client'
  import { PracticePane } from './src/renderer/practice/PracticePane'
  window.calls=[]
  const bridge=new Proxy({}, {get(_,name){return async()=>{window.calls.push(name);if(name==='list')return{problems:[],unavailable:0};throw Error('Unexpected bridge call '+name)}}})
  const root=createRoot(document.querySelector('#root'))
  root.render(<PracticePane bridge={bridge} onPrepareRun={async()=>false} onOpenEntry={()=>{}} onClose={()=>root.unmount()}/>)
`
const result = await build({ stdin:{contents:fixture,loader:'tsx',resolveDir:resolve('.')},bundle:true,jsx:'automatic',write:false,
  splitting:true,metafile:true,outdir:'out',entryNames:'practice',format:'esm',logLevel:'silent' })
const entry=Object.entries(result.metafile.outputs).find(([,info])=>info.entryPoint?.endsWith('/MergeSortWalkthrough.tsx'))
assert.ok(entry,'Merge sort should compile into a separate renderer chunk.')
const chunk=basename(entry[0]), files=new Map(result.outputFiles.map(file=>[basename(file.path),file.text]))
files.set('shell.css',await readFile('src/renderer/styles.css','utf8'))
const browser=await chromium.launch({channel:'chrome',headless:true})
try {
  const page=await browser.newPage({viewport:{width:250,height:620}}), origin='http://ion-practice-merge.test'
  const requested=[], unexpected=[], errors=[]
  page.on('pageerror',error=>errors.push(error.message));await page.context().setOffline(true)
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),name=url.pathname.slice(1)
    if(url.origin===origin){requested.push(name);if(!name)return route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/practice.css"><div id="root" class="app-shell"></div><script type="module" src="/practice.js"></script>'})
      if(files.has(name))return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body:files.get(name)})}
    if(name!=='favicon.ico')unexpected.push(url.href);await route.abort()
  })
  await page.goto(origin)
  const entryButton=page.getByRole('button',{name:'Walk through merge sort'})
  await entryButton.waitFor();assert.equal(requested.includes(chunk),false);assert.deepEqual(await page.evaluate(()=>window.calls),['list'])
  await entryButton.press('Enter')
  const lesson=page.getByRole('region',{name:'Merge sort'}), status=lesson.getByRole('status')
  await lesson.getByRole('heading',{name:'Merge sort',exact:true}).waitFor();assert.equal(requested.filter(name=>name===chunk).length,1)
  assert.match(await status.innerText(),/Split \[8, 3, 5, 1\] into \[8, 3\] and \[5, 1\]/)
  const next=lesson.getByRole('button',{name:'Next step'}), previous=lesson.getByRole('button',{name:'Previous step'}), reset=lesson.getByRole('button',{name:'Reset walkthrough'})
  assert.equal(await previous.isDisabled(),true)
  await next.click();assert.match(await status.innerText(),/Split \[8, 3\] into \[8\] and \[3\]/)
  await next.click();assert.match(await status.innerText(),/\[8\] is already sorted/)
  await next.click();assert.match(await status.innerText(),/\[3\] is already sorted/)
  await next.click();assert.match(await status.innerText(),/Merge sorted runs \[8\] and \[3\].*\[3, 8\]/)
  for(let i=0;i<5;i++)await next.click()
  assert.match(await status.innerText(),/Merge sorted runs \[3, 8\] and \[1, 5\].*\[1, 3, 5, 8\]/)
  await status.getByText('Array sorted').waitFor();assert.equal(await next.isDisabled(),true)
  const complexity=lesson.getByRole('region',{name:'Complexity analysis'})
  await complexity.getByText(/O\(n log n\) in best, average and worst cases/).waitFor()
  await complexity.getByText(/O\(n\) for merge buffers, plus O\(log n\) recursive stack frames/).waitFor()
  const scroll=page.locator('.practice-scroll');assert.equal(await scroll.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
  await reset.click();assert.match(await status.innerText(),/Split \[8, 3, 5, 1\]/)
  await page.getByRole('button',{name:'Back to Browse'}).press('Enter')
  await page.waitForFunction(()=>document.activeElement?.textContent?.includes('Walk through merge sort'))
  assert.deepEqual(await page.evaluate(()=>window.calls),['list']);assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[])
  console.log('PASS offline merge-sort recursion and merge order, bounds, lazy loading, narrow layout and keyboard return')
} finally { await browser.close() }
