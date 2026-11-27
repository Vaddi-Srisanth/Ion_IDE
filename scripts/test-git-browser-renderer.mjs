import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Delayed responses exercise renderer lifecycles that a real local Git command rarely hits.
const fixture = `
  import { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import Panel from './src/renderer/source-control/SourceControlPanel'
  window.browseCalls = []
  window.conflictCalls = []
  window.githubCalls = []
  window.finish = []
  window.previews = []
  window.finishPreview = []
  window.tagCalls = []
  function bridge(root) {
    const tags = []
    return {
      status: async () => ({ kind:'repository', root, branch:'main',
        entries:[{path:'merge.txt',absolutePath:root+'/merge.txt',worktree:'U',index:'U',unmerged:true}] }),
      browse: () => new Promise(resolve => {
        window.browseCalls.push(root)
        window.finish.push((subject, remotes=[{name:'origin', repository:'team/demo'}, {name:'mirror',repository:null}], stash={oid:'c'.repeat(40)}) =>
          resolve({ commits:[{oid:'a'.repeat(40),subject,author:'Test',time:0}], branches:[{name:'topic',oid:'b'.repeat(40)}], tags, remotes, stash, truncated:false }))
      }),
      previewComparison: request => new Promise(resolve => { window.previews.push([root,request]); window.finishPreview.push(resolve) }),
      createTag: async request => { window.tagCalls.push([root,request]); tags.push({name:request.name,oid:request.from}) },
      conflict: async ({path}) => {
        window.conflictCalls.push([root,path])
        return { path, absolutePath:root+'/'+path, base:'before', ours:'left', theirs:'right' }
      },
      github: async repository => {
        window.githubCalls.push(['load',root,repository])
        return {repository:'Team/Demo', login:'octo', pullRequests:[],
          issues:[{number:7,title:'Reviewed issue',url:'https://github.com/Team/Demo/issues/7'}]}
      },
      openGitHubPage: async url => { window.githubCalls.push(['open',root,url]) },
      cloneGitHub: async repository => { window.githubCalls.push(['clone',root,repository]); return null },
      closeGitHub: async () => { window.githubCalls.push(['close',root]) },
    }
  }
  const first = bridge('first'), second = bridge('second')
  function App() {
    const [root, setRoot] = useState('first'), [open, setOpen] = useState(true)
    return <>
      <button onClick={() => setRoot(current => current==='first'?'second':'first')}>Switch workspace</button>
      <button onClick={() => setOpen(true)}>Open panel</button>
      {open && <Panel key={root} bridge={root==='first'?first:second} onClose={()=>setOpen(false)}
        onDiff={()=>{throw Error('Conflict requested a two-way diff')}} onEntries={()=>{}} isDirty={()=>false}/>}
    </>
  }
  createRoot(document.querySelector('#root')).render(<App/>)
`
const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: resolve('.') }, bundle: true,
  write: false, outdir: 'out', format: 'iife', jsx: 'automatic', logLevel: 'silent' })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 240, height: 640 } })
  const errors = []
  const network = []
  await page.context().setOffline(true)
  page.on('request', req => { if (/^https?:/.test(req.url())) network.push(req.url()) })
  page.on('pageerror', reason => errors.push(reason.message))
  await page.setContent('<div id="root"></div>')
  for (const file of bundle.outputFiles) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text })
    else if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text })
  }
  const toggle = page.getByTestId('git-browse')
  await toggle.waitFor()
  assert.deepEqual(await page.evaluate(() => window.browseCalls), [])
  assert.deepEqual(await page.evaluate(() => window.conflictCalls), [])
  await toggle.focus()
  await page.keyboard.press('Enter')
  await toggle.click()
  await page.evaluate(() => window.finish[0]('collapsed result'))
  await page.waitForFunction(() => !document.querySelector('[data-testid="git-browse"]').disabled)
  assert.equal(await page.getByText('collapsed result').count(), 0)
  await toggle.click()
  await page.getByRole('button', { name: 'Switch workspace' }).click()
  await page.waitForFunction(() => document.querySelector('[data-testid="git-browse"]')?.getAttribute('aria-expanded') === 'false')
  await toggle.click()
  await page.evaluate(() => { window.finish[2]('current result'); window.finish[1]('old root result') })
  await page.getByText('current result').waitFor()
  assert.equal(await page.getByText('old root result').count(), 0)
  const view = page.getByRole('combobox', { name: 'Repository view' })
  await view.selectOption('remotes')
  const remotes = page.getByRole('list', { name: 'Remotes' })
  await remotes.getByRole('listitem').filter({ hasText: 'origin' }).getByText('team/demo', { exact: true }).waitFor()
  assert.equal(await remotes.getByRole('listitem').filter({ hasText: 'mirror' }).innerText(), 'mirror')
  assert.equal(await remotes.getByRole('link').count(), 0)
  assert.deepEqual(await page.evaluate(() => window.browseCalls), ['first', 'first', 'second'])
  await page.getByRole('button', { name: 'Refresh repository browser' }).click()
  await page.getByRole('button', { name: 'Close Source Control' }).click()
  await page.evaluate(() => window.finish[3]('closed result'))
  await page.getByRole('button', { name: 'Open panel' }).click()
  await toggle.waitFor()
  assert.equal(await page.getByText('closed result').count(), 0)
  await toggle.click()
  await page.evaluate(() => window.finish[4]('empty remotes', []))
  await view.selectOption('remotes')
  await page.getByText('No remotes.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Review conflict for merge.txt' }).click()
  const modal = page.getByRole('dialog', { name: 'Review merge conflict' })
  await modal.getByText('left', { exact: true }).waitFor()
  await modal.getByRole('combobox').selectOption('theirs')
  await modal.getByText('right', { exact: true }).waitFor()
  await modal.getByRole('button', { name: 'Done' }).click()
  await modal.waitFor({ state: 'detached' })
  assert.deepEqual(await page.evaluate(() => window.conflictCalls), [['second', 'merge.txt']])
  const hosted = page.getByRole('region', { name: 'GitHub', exact: true })
  await hosted.getByRole('button', { name: 'GitHub', exact: true }).click()
  await hosted.getByLabel('GitHub repository').fill('team/demo')
  assert.deepEqual(await page.evaluate(() => window.githubCalls), [])
  await hosted.getByRole('button', { name: 'Load from GitHub' }).click()
  await hosted.getByRole('button', { name: '#7 Reviewed issue' }).click()
  const reviewed = [['load', 'second', 'team/demo'], ['open', 'second', 'https://github.com/Team/Demo/issues/7']]
  assert.deepEqual(await page.evaluate(() => window.githubCalls), reviewed)
  await hosted.getByRole('button', { name: 'Clone public repository…' }).click()
  assert.deepEqual(await page.evaluate(() => window.githubCalls), [...reviewed, ['clone', 'second', 'Team/Demo']])
  assert.equal(await hosted.getByText(/Cloned to/).count(), 0)
  assert.equal(await page.getByTestId('git-branch').innerText(), 'main')

  const head = 'a'.repeat(40), tip = 'b'.repeat(40), stash = 'c'.repeat(40), base = 'd'.repeat(40)
  const compare = page.getByRole('button', { name: 'Compare topic with HEAD' })
  const stashButton = page.getByRole('button', { name: 'Preview latest stash' })
  const region = page.getByRole('region', { name: 'Comparison preview' })
  const finishPreview = result => page.evaluate(data => window.finishPreview.at(-1)(data), result)
  const branchResult = { from:head, to:tip, relation:'ahead', changes:[{path:'src/a.ts',status:'M'}], truncated:false, includesUntrackedParent:false }
  await view.selectOption('stash')
  await stashButton.waitFor()
  await view.selectOption('branches')
  assert.deepEqual(await page.evaluate(() => window.previews), [])
  await compare.click()
  assert.deepEqual(await page.evaluate(() => window.previews), [['second', {kind:'branch',name:'topic',from:head,to:tip}]])
  await finishPreview(branchResult)
  await region.getByText('This branch is ahead of HEAD.').waitFor()
  await region.getByRole('listitem').filter({ hasText: 'src/a.ts' }).getByText('Modified').waitFor()
  await page.getByRole('button', { name: 'Refresh repository browser' }).click()
  await page.evaluate(() => window.finish.at(-1)('refreshed'))
  await compare.waitFor()
  assert.equal(await region.count(), 0)
  await view.selectOption('stash')
  await stashButton.click()
  assert.deepEqual(await page.evaluate(() => window.previews.at(-1)), ['second', {kind:'stash',name:'refs/stash',from:head,to:stash}])
  const paths = Array.from({length:200}, (_, i) => ({path:'file-'+i, status:'A'}))
  await finishPreview({from:base, to:stash, relation:'stash', changes:paths, truncated:true, includesUntrackedParent:true})
  await region.getByText(base.slice(0, 10), {exact:true}).waitFor()
  assert.equal(await region.getByRole('listitem').count(), 200)
  await region.getByText(/Some changed files are omitted/).waitFor()
  await region.getByText('This stash also contains untracked files outside this preview.').waitFor()
  await region.getByRole('button', {name:'Close preview'}).click()
  await stashButton.click()
  await toggle.click()
  await finishPreview(branchResult)
  await toggle.click()
  await page.evaluate(() => window.finish.at(-1)('no stash', [], null))
  await page.getByText('No stash saved.').waitFor()
  assert.equal(await region.count(), 0)
  await view.selectOption('branches')
  await compare.click()
  await page.getByRole('button', { name:'Switch workspace' }).click()
  await toggle.waitFor()
  await finishPreview(branchResult)
  await toggle.click()
  await page.evaluate(() => window.finish.at(-1)('new root'))
  await view.selectOption('branches')
  await compare.waitFor()
  assert.equal(await region.count(), 0)
  await view.selectOption('tags')
  await page.getByRole('button', {name:'Create lightweight tag…'}).click()
  await page.getByLabel('Tag name').fill('v2.1')
  assert.deepEqual(await page.evaluate(() => window.tagCalls), [])
  await page.getByRole('button', {name:'Create lightweight tag',exact:true}).click()
  await page.getByText('Loading repository…').waitFor()
  await page.evaluate(() => window.finish.at(-1)('tag created'))
  await page.getByRole('list', {name:'Tags'}).getByText('v2.1').waitFor()
  assert.equal(await page.getByLabel('Tag name').count(), 0)
  assert.equal(await view.inputValue(), 'tags')
  assert.equal(await page.getByTestId('git-branch').innerText(), 'main')
  assert.deepEqual(await page.evaluate(() => window.tagCalls), [['first',{name:'v2.1',from:head}]])
  assert.deepEqual(network, [])
  assert.deepEqual(errors, [])
  console.log('PASS repository browse lifecycle, remotes, conflict review, GitHub lookup/link/clone cancellation, branch and stash previews, lightweight tags')
} finally {
  await browser.close()
}
