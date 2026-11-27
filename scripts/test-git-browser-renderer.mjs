import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Delayed responses exercise renderer lifecycles that a real local Git command rarely hits.
const fixture = `
  import { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import Panel from './src/renderer/source-control/SourceControlPanel'
  window.ion = {platform:'darwin'}
  window.blameCalls = []
  window.cancelBlames = []
  window.finishBlame = []
  window.browseCalls = []
  window.conflictCalls = []
  window.githubCalls = []
  window.switchCalls = []
  window.fetchCalls = []
  window.finishPullRequest = []
  window.finish = []
  window.previews = []
  window.finishPreview = []
  window.tagCalls = []
  function bridge(root) {
    const tags = []
    const state = { branch: 'main' }
    const directory = '/repositories/' + root
    return {
      status: async () => ({ kind:'repository', root:directory, branch:state.branch,
        entries:[{path:'merge.txt',absolutePath:directory+'/merge.txt',worktree:'U',index:'U',unmerged:true},
          {path:'changed.ts',absolutePath:directory+'/changed.ts',worktree:'M',index:'',unmerged:false},
          {path:'new.ts',absolutePath:directory+'/new.ts',worktree:'?',index:'',unmerged:false}] }),
      blame: ({path}) => new Promise((resolve,reject) => {
        window.blameCalls.push([root,path])
        window.finishBlame.push({resolve,reject})
      }),
      cancelBlame: async path => { window.cancelBlames.push([root,path]) },
      browse: () => new Promise(resolve => {
        window.browseCalls.push(root)
        window.finish.push((subject, remotes=[{name:'origin', repository:'team/demo'}, {name:'mirror',repository:null}], stash={oid:'c'.repeat(40)}) =>
          resolve({ commits:[{oid:'a'.repeat(40),subject,author:'Test',time:0}], branches:[{name:'topic',oid:'b'.repeat(40)}],
            cachedRemoteBranches:[{name:'origin/topic',oid:'e'.repeat(40)}], tags, remotes, stash, truncated:false }))
      }),
      previewComparison: request => new Promise(resolve => { window.previews.push([root,request]); window.finishPreview.push(resolve) }),
      createTag: async request => { window.tagCalls.push([root,request]); tags.push({name:request.name,oid:request.from}) },
      switchBranch: async request => { window.switchCalls.push([root,request]); state.branch=request.target; return true },
      fetchPublic: async request => { window.fetchCalls.push([root,request]); return {oid:'f'.repeat(40),changed:true} },
      conflict: async ({path}) => {
        window.conflictCalls.push([root,path])
        return { path, absolutePath:root+'/'+path, base:'before', ours:'left', theirs:'right' }
      },
      github: async repository => {
        window.githubCalls.push(['load',root,repository])
        return {repository:'Team/Demo', login:'octo', pullRequests:[{number:9, title:'Read the changes', url:'https://github.com/Team/Demo/pull/9'}],
          issues:[{number:7,title:'Reviewed issue',url:'https://github.com/Team/Demo/issues/7'}]}
      },
      githubPullRequest: request => new Promise(resolve => {
        window.githubCalls.push(['pull',root,request])
        window.finishPullRequest.push(() => resolve({number:9, title:'Read the changes', url:'https://github.com/Team/Demo/pull/9',
          state:'open', draft:true, author:'author', base:'main', head:'author:fix', body:'<em>Inert description</em>', bodyTruncated:true}))
      }),
      openGitHubPage: async url => { window.githubCalls.push(['open',root,url]) },
      cloneGitHub: async repository => { window.githubCalls.push(['clone',root,repository]); return null },
      closeGitHub: async () => { window.githubCalls.push(['close',root]) },
    }
  }
  const first = bridge('first'), second = bridge('second')
  function App() {
    const [root, setRoot] = useState('first'), [open, setOpen] = useState(true)
    const [file, setFile] = useState('/repositories/first/src/clean.ts'), [dirty, setDirty] = useState(false)
    window.setHistoryFile = setFile
    window.setHistoryDirty = setDirty
    window.setFixtureRoot = setRoot
    return <>
      <button onClick={() => setRoot(current => current==='first'?'second':'first')}>Switch workspace</button>
      <button onClick={() => setOpen(true)}>Open panel</button>
      {open && <Panel key={root} bridge={root==='first'?first:second} activePath={file} onClose={()=>setOpen(false)}
        onDiff={()=>{throw Error('Conflict requested a two-way diff')}} onEntries={()=>{}} isDirty={path=>dirty && path===file}/>}
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
  const lineHistory = page.getByRole('button', {name:'Line history',exact:true})
  const history = page.getByRole('dialog', {name:'Line history'})
  assert.deepEqual(await page.evaluate(() => window.blameCalls), [])
  await lineHistory.click()
  assert.deepEqual(await page.evaluate(() => window.blameCalls), [['first','src/clean.ts']])
  const report = {path:'src/clean.ts', head:'e'.repeat(40), truncated:true,
    ranges:Array.from({length:45}, (_, i) => ({start:1+i*2,count:2,oid:'a'.repeat(40),author:'Ada',time:1710000000,subject:'Revision '+i}))}
  await page.evaluate(result => window.finishBlame[0].resolve(result), report)
  await history.getByText('Lines 1–2', {exact:true}).waitFor()
  assert.equal(await history.getByRole('listitem').count(), 40)
  await history.getByRole('button', {name:'Show more ranges'}).click()
  await history.getByText('Lines 89–90', {exact:true}).waitFor()
  await history.getByText('Some committed history is outside the preview limits.').waitFor()
  assert.equal(await history.locator('time').first().getAttribute('datetime'), '2024-03-09T16:00:00.000Z')
  await history.getByRole('button', {name:'Done'}).click()
  assert.deepEqual(await page.evaluate(() => window.cancelBlames), [])
  await page.evaluate(() => window.setHistoryFile('/repositories/first/changed.ts'))
  await lineHistory.click()
  await history.getByText(/Local changes can shift the lines/).waitFor()
  await page.evaluate(() => window.setHistoryDirty(true))
  await history.getByText(/Unsaved edits can place these lines elsewhere/).waitFor()
  await page.keyboard.press('Escape')
  await history.waitFor({state:'detached'})
  assert.deepEqual(await page.evaluate(() => window.cancelBlames), [['first','changed.ts']])
  await lineHistory.click()
  await page.evaluate(result => {
    window.finishBlame[2].resolve({...result, path:'changed.ts', ranges:[{...result.ranges[0],subject:'Reopened result'}]})
    window.finishBlame[1].resolve(result)
  }, report)
  await history.getByText('Reopened result').waitFor()
  assert.equal(await history.getByRole('alert').count(), 0)
  await history.getByRole('button', {name:'Done'}).click()
  await lineHistory.click()
  await page.evaluate(() => window.setHistoryFile('/repositories/first/new.ts'))
  await history.waitFor({state:'detached'})
  assert.equal(await lineHistory.count(), 0, 'Known untracked file')
  await page.evaluate(result => window.finishBlame[3].resolve(result), report)
  await page.evaluate(() => window.setHistoryFile('/repositories/first-neighbor/src/clean.ts'))
  assert.equal(await lineHistory.count(), 0, 'Sibling repository with the same prefix')
  await page.evaluate(() => window.setHistoryFile('/repositories/first/src/clean.ts'))
  await lineHistory.click()
  await page.evaluate(() => window.finishBlame[4].reject(new Error('The file changed during blame.')))
  await history.getByRole('alert').getByText('The file changed during blame.').waitFor()
  await history.getByRole('button', {name:'Done'}).click()
  await lineHistory.click()
  await page.evaluate(() => window.setFixtureRoot('second'))
  await history.waitFor({state:'detached'})
  await page.evaluate(result => window.finishBlame[5].resolve(result), report)
  await page.evaluate(() => { window.setFixtureRoot('first'); window.setHistoryDirty(false) })
  await lineHistory.waitFor()
  assert.equal(await history.count(), 0)
  assert.deepEqual(await page.evaluate(() => window.cancelBlames), [['first','changed.ts'],['first','changed.ts'],['first','src/clean.ts']])
  console.log('PASS on-demand committed line history, changed coordinates, paging, cancellation and stale responses')
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
  await hosted.getByRole('button', { name: 'Clone public repository…' }).click()
  const anonymous = ['clone', 'second', 'team/demo']
  assert.deepEqual(await page.evaluate(() => window.githubCalls), [anonymous])
  await hosted.getByRole('button', { name: 'Load from GitHub' }).click()
  const pull = hosted.getByRole('button', { name: '#9 Read the changes' })
  await pull.waitFor()
  assert.deepEqual(await page.evaluate(() => window.githubCalls), [anonymous, ['load', 'second', 'team/demo']])
  await pull.click()
  await hosted.getByText('Loading pull request…').waitFor()
  await page.evaluate(() => window.finishPullRequest.at(-1)())
  const pullDetail = hosted.getByRole('region', { name: 'Pull request details' })
  await pullDetail.getByText('Draft by author').waitFor()
  await pullDetail.getByText('author:fix').waitFor()
  await pullDetail.getByText('<em>Inert description</em>').waitFor()
  assert.equal(await pullDetail.locator('em').count(), 0)
  assert.equal(await pullDetail.getByRole('heading').evaluate(node => node === document.activeElement), true)
  await pullDetail.getByRole('button', { name: 'Open pull request on GitHub' }).click()
  await pullDetail.getByRole('button', { name: 'Hide details' }).click()
  await pullDetail.waitFor({ state: 'detached' })
  assert.equal(await pull.evaluate(node => node === document.activeElement), true)
  await hosted.getByRole('button', { name: '#7 Reviewed issue' }).click()
  const reviewed = [anonymous, ['load', 'second', 'team/demo'], ['pull', 'second', {repository:'Team/Demo', number:9}],
    ['open', 'second', 'https://github.com/Team/Demo/pull/9'], ['open', 'second', 'https://github.com/Team/Demo/issues/7']]
  assert.deepEqual(await page.evaluate(() => window.githubCalls), reviewed)
  await hosted.getByRole('button', { name: 'Clone public repository…' }).click()
  assert.deepEqual(await page.evaluate(() => window.githubCalls), [...reviewed, ['clone', 'second', 'Team/Demo']])
  assert.equal(await hosted.getByText(/Cloned to/).count(), 0)
  assert.equal(await page.getByTestId('git-branch').innerText(), 'main')
  await pull.click()
  await hosted.getByText('Loading pull request…').waitFor()
  await hosted.getByRole('button', { name: 'GitHub', exact: true }).click()
  await page.evaluate(() => window.finishPullRequest.at(-1)())
  await hosted.getByRole('button', { name: 'GitHub', exact: true }).click()
  assert.equal(await pullDetail.count(), 0)
  assert.deepEqual((await page.evaluate(() => window.githubCalls)).at(-1), ['close', 'second'])

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
  await view.selectOption('cachedRemoteBranches')
  const cached = page.getByRole('list', { name: 'Cached remote branches' })
  await cached.getByText('origin/topic', { exact: true }).waitFor()
  await page.getByText(/Git refs stored on this computer and run offline/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'New branch…' }).count(), 0)
  assert.equal(await page.evaluate(() => window.previews.length), 1)
  await cached.getByRole('button', { name: 'Compare origin/topic with HEAD' }).click()
  assert.deepEqual(await page.evaluate(() => window.previews.at(-1)), ['second',
    { kind: 'cached-remote-branch', name: 'origin/topic', from: head, to: 'e'.repeat(40) }])
  await finishPreview({ ...branchResult, to: 'e'.repeat(40) })
  await region.getByText('This branch is ahead of HEAD.').waitFor()
  await region.getByText(/Git refs stored on this computer and run offline/).waitFor()
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
  await view.selectOption('branches')
  await compare.click()
  await finishPreview({...branchResult,relation:'same',changes:[]})
  const switchButton = region.getByRole('button', {name:'Review switch…'})
  const switchBrowseCount = await page.evaluate(() => window.finish.length)
  await switchButton.click()
  assert.deepEqual(await page.evaluate(() => window.switchCalls), [['first',{current:'main',target:'topic',from:head,to:tip}]])
  await page.waitForFunction(count => window.finish.length > count, switchBrowseCount)
  await page.evaluate(() => window.finish.at(-1)('switched repository'))
  await page.getByText('Switched to topic.').waitFor()
  assert.equal(await page.getByTestId('git-branch').innerText(), 'topic')
  await view.selectOption('cachedRemoteBranches')
  await page.getByRole('button', {name:'Compare origin/topic with HEAD'}).click()
  await finishPreview({...branchResult,to:'e'.repeat(40),changes:[]})
  const fetchButton = region.getByRole('button', {name:'Review fetch…'})
  const fetchBrowseCount = await page.evaluate(() => window.finish.length)
  await fetchButton.click()
  assert.deepEqual(await page.evaluate(() => window.fetchCalls), [['first',{
    repository:'team/demo',remote:'origin',branch:'topic',previous:'e'.repeat(40)}]])
  await page.waitForFunction(count => window.finish.length > count, fetchBrowseCount)
  await page.evaluate(() => window.finish.at(-1)('fetched repository'))
  await page.getByText('origin/topic advanced to ffffffffff.').waitFor()
  assert.deepEqual(network, [])
  assert.deepEqual(errors, [])
  console.log('PASS repository browsing, reviewed switch and fetch requests, conflict and GitHub details, previews, tags and cancellation')
} finally {
  await browser.close()
}
