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
const entry=Object.entries(result.metafile.outputs).find(([,info])=>info.entryPoint?.endsWith('/TreeTraversalWalkthrough.tsx'))
assert.ok(entry,'Tree traversal should compile into a separate renderer chunk.')
const chunk=basename(entry[0]), files=new Map(result.outputFiles.map(file=>[basename(file.path),file.text]))
files.set('shell.css',await readFile('src/renderer/styles.css','utf8'))
const browser=await chromium.launch({channel:'chrome',headless:true})
try {
  const page=await browser.newPage({viewport:{width:250,height:620}}), origin='http://ion-practice-tree.test'
  const requested=[], unexpected=[], errors=[]
  page.on('pageerror',error=>errors.push(error.message));await page.context().setOffline(true)
  await page.route('**/*',async route=>{
    const url=new URL(route.request().url()),name=url.pathname.slice(1)
    if(url.origin===origin){requested.push(name);if(!name)return route.fulfill({contentType:'text/html',body:'<link rel="stylesheet" href="/shell.css"><link rel="stylesheet" href="/practice.css"><div id="root" class="app-shell"></div><script type="module" src="/practice.js"></script>'})
      if(files.has(name))return route.fulfill({contentType:name.endsWith('.css')?'text/css':'text/javascript',body:files.get(name)})}
    if(name!=='favicon.ico')unexpected.push(url.href);await route.abort()
  })
  await page.goto(origin)
  const entryButton=page.getByRole('button',{name:'Walk through binary-tree traversals'})
  await entryButton.waitFor();assert.equal(requested.includes(chunk),false);assert.deepEqual(await page.evaluate(()=>window.calls),['list'])
  await entryButton.press('Enter')
  const lesson=page.getByRole('region',{name:'Binary tree traversals'}), state=lesson.getByRole('region',{name:'Traversal state'})
  await lesson.getByRole('heading',{name:'Binary tree traversals',exact:true}).waitFor()
  assert.equal(requested.filter(name=>name===chunk).length,1)
  await lesson.getByRole('region',{name:'Binary tree structure'}).getByText('F',{exact:true}).waitFor()
  const current=()=>state.locator('dl > div:nth-child(2) dd').innerText()
  const next=lesson.getByRole('button',{name:'Next step'})
  const order=lesson.getByRole('combobox',{name:'Traversal order'})
  for(const [name,sequence] of [
    ['preorder',['A','B','D','E','C','F']],
    ['inorder',['D','B','E','A','C','F']],
    ['postorder',['D','E','B','F','C','A']],
    ['levelorder',['A','B','C','D','E','F']],
  ]){
    await order.selectOption(name)
    const actual=[]
    for(let i=0;i<6;i++){actual.push(await current());if(i<5)await next.click()}
    assert.deepEqual(actual,sequence,`${name} traversal order`)
    assert.equal(await next.isDisabled(),true)
    await lesson.getByText(/O\(n\): each node is visited once/).waitFor()
  }
  await lesson.getByRole('button',{name:'Reset traversal'}).click()
  await lesson.getByText('Step 1 of 6').waitFor()
  const scroll=page.locator('.practice-scroll');assert.equal(await scroll.evaluate(el=>el.scrollWidth<=el.clientWidth),true)
  await page.getByRole('button',{name:'Back to Browse'}).press('Enter')
  await page.waitForFunction(()=>document.activeElement?.textContent?.includes('Walk through binary-tree traversals'))
  assert.deepEqual(await page.evaluate(()=>window.calls),['list'])
  assert.deepEqual(unexpected,[]);assert.deepEqual(errors,[])
  console.log('PASS offline preorder/inorder/postorder/level-order traces, complexity, lazy loading, narrow layout and keyboard return')
} finally { await browser.close() }
