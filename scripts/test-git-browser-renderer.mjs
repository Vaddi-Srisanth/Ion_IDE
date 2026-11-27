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
  function bridge(root) {
    return {
      status: async () => ({ kind:'repository', root, branch:'main',
        entries:[{path:'merge.txt',absolutePath:root+'/merge.txt',worktree:'U',index:'U',unmerged:true}] }),
      browse: () => new Promise(resolve => {
        window.browseCalls.push(root)
        window.finish.push((subject, remotes=[{name:'origin', repository:'team/demo'}, {name:'mirror',repository:null}]) =>
          resolve({ commits:[{oid:'a'.repeat(40),subject,author:'Test',time:0}], branches:[], tags:[], remotes, truncated:false }))
      }),
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
      <button onClick={() => setRoot('second')}>Switch workspace</button>
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
  assert.deepEqual(network, [])
  assert.deepEqual(errors, [])
  console.log('PASS repository browse lifecycle, remotes, conflict review, explicit GitHub lookup, reviewed link and clone cancellation')
} finally {
  await browser.close()
}
