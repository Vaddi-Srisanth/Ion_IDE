import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

// Delay preflight independently from execution so Stop and failed saves can be exercised deterministically.
const fixture = `
  import { createRoot } from 'react-dom/client'
  import { PracticePane } from './src/renderer/practice/PracticePane'
  const submissions = Array.from({length:12}, (_, i) => ({verdict:'wrong-answer', judgedAt:i+1, passed:0,total:4,runtimeMs:i,current:false}))
  const original = {id:'supported', title:'Minutes', language:'python', topic:'Basics', difficulty:'Easy', notes:'', sourceUrl:'',
    statement:'Convert minutes.', completion:'In progress', revision:1, canSubmit:true, samples:[],
    attempts:[{id:'first', label:'First', submissions}, {id:'second', label:'Second'}]}
  const custom = {...original, id:'custom', title:'Custom', canSubmit:undefined}
  window.calls = []
  window.searches = []
  window.finishSearch = []
  window.progressReads = []
  window.progressStops = 0
  const bridge = {
    progress:() => new Promise((resolve, reject) => window.progressReads.push({resolve,reject})),
    cancelProgress:async () => {window.progressStops++},
    browse:filters => new Promise(resolve => {
      window.searches.push(filters)
      window.finishSearch.push(title => resolve([{id:title,title,topic:'Basics',difficulty:'Easy'}]))
    }),
    list:async () => ({problems:[original,custom],unavailable:0}),
    get:async id => id==='supported' ? original : custom,
    openAttempt:async (id,attempt) => ({path:attempt+'.py'}),
    submit:(id,attempt) => new Promise((resolve,reject) => {
      window.calls.push(['submit',id,attempt])
      window.cancel = () => reject(Error('Local submission stopped.'))
      window.finish = () => resolve({...original,attempts:[original.attempts[0], {...original.attempts[1],
        submissions:[{verdict:'accepted',judgedAt:100,passed:4,total:4,runtimeMs:8,current:true}]}]})
    }),
    cancelSamples:async () => { window.calls.push(['stop']); window.cancel() }
  }
  const root = createRoot(document.querySelector('#root'))
  root.render(<PracticePane bridge={bridge} initialProblem="supported"
    onPrepareRun={path=>new Promise(resolve=>{window.calls.push(['save',path]);window.save=resolve})}
    onOpenEntry={()=>{}} onClose={()=>root.unmount()}/>)
`
const bundle = await build({ stdin: { contents: fixture, loader: 'tsx', resolveDir: resolve('.') },
  bundle: true, jsx: 'automatic', write: false, outdir: 'out', format: 'iife', logLevel: 'silent' })
const browser = await chromium.launch({ channel: 'chrome', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 300, height: 640 } })
  const errors = []
  page.on('pageerror', reason => errors.push(reason.message))
  await page.context().setOffline(true)
  await page.setContent('<div id="root"></div>')
  for (const file of bundle.outputFiles) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content: file.text })
    else if (file.path.endsWith('.js')) await page.addScriptTag({ content: file.text })
  }
  const submit = page.getByRole('button', { name: 'Local Submit', exact: true })
  const stop = page.getByTestId('practice-stop')
  const history = page.getByRole('region', { name: 'Local submission history' })
  const attempt = page.getByTestId('practice-attempt')
  await submit.waitFor()
  await attempt.selectOption('first')
  assert.equal(await history.getByRole('listitem').count(), 10)
  assert.match(await history.getByRole('listitem').first().innerText(), /11 ms/)
  assert.match(await history.getByRole('listitem').last().innerText(), /2 ms/)
  await attempt.selectOption('second')
  assert.equal(await history.count(), 0)
  assert.deepEqual(await page.evaluate(() => window.calls), [])

  await submit.click()
  await page.waitForFunction(() => window.calls.length === 1)
  await page.evaluate(() => window.save(false))
  await page.getByRole('alert').filter({ hasText: 'Save your edits' }).waitFor()
  await submit.click()
  await page.waitForFunction(() => window.calls.length === 2)
  await stop.click()
  await page.evaluate(() => window.save(false))
  await page.getByRole('status').filter({ hasText: 'Stopped before running' }).waitFor()
  assert.equal(await page.getByRole('alert').count(), 0)
  assert.deepEqual(await page.evaluate(() => window.calls), [['save','second.py'], ['save','second.py']])

  await submit.click()
  await page.waitForFunction(() => window.calls.length === 3)
  await page.evaluate(() => window.save(true))
  await page.waitForFunction(() => window.calls.length === 4)
  await stop.click()
  await page.getByRole('alert').filter({ hasText: 'Local submission stopped.' }).waitFor()
  assert.equal(await history.count(), 0)
  await submit.click()
  await page.waitForFunction(() => window.calls.length === 6)
  await page.evaluate(() => window.save(true))
  await page.waitForFunction(() => window.calls.length === 7)
  await page.evaluate(() => window.finish())
  await history.getByText('Accepted').waitFor()
  assert.deepEqual(await page.evaluate(() => window.calls.slice(2)), [
    ['save','second.py'], ['submit','supported','second'], ['stop'], ['save','second.py'], ['submit','supported','second'],
  ])
  await page.getByTestId('practice-problem').selectOption('custom')
  await page.getByRole('heading', { name: 'Custom', exact: true }).waitFor()
  assert.equal(await submit.count(), 0)
  assert.equal(await history.count(), 0)
  await page.getByTestId('practice-browse-tab').click()
  const search = page.getByRole('searchbox', { name: 'Search by title or topic' })
  await search.fill(' EarLIer ')
  assert.deepEqual(await page.evaluate(() => window.searches), [])
  await search.press('Enter')
  await page.waitForFunction(() => window.searches.length === 1)
  assert.equal(await page.evaluate(() => window.searches[0].search), 'EarLIer')
  await page.getByRole('button', { name: 'Clear search' }).click()
  await page.evaluate(() => window.finishSearch[0]('Reply after clear'))
  assert.equal(await page.getByTestId('practice-challenge').count(), 0)
  await search.fill('basics')
  await search.press('Enter')
  await page.waitForFunction(() => window.searches.length === 2)
  await page.getByTestId('practice-difficulty').selectOption('Easy')
  await page.waitForFunction(() => window.searches.length === 3)
  await page.evaluate(() => { window.finishSearch[2]('Latest match'); window.finishSearch[1]('Obsolete match') })
  await page.getByRole('heading', { name: 'Latest match' }).waitFor()
  assert.equal(await page.getByText('Obsolete match').count(), 0)
  await page.getByRole('button', { name: 'Clear search' }).click()
  await page.getByTestId('practice-topic').selectOption('Basics')
  await page.waitForFunction(() => window.searches.length === 4)
  assert.deepEqual(await page.evaluate(() => window.searches.map(({search, topic, difficulty}) => [search,topic,difficulty])), [
    ['EarLIer',undefined,undefined], ['basics',undefined,undefined], ['basics',undefined,'Easy'], [undefined,'Basics','Easy'],
  ])
  await page.evaluate(() => window.finishSearch[3]('Topic and difficulty match'))
  await page.getByRole('heading', { name: 'Topic and difficulty match' }).waitFor()
  const progressTab = page.getByRole('button', { name: 'Progress', exact: true })
  const progress = page.getByRole('region', { name: 'Catalog progress' })
  assert.equal(await page.evaluate(() => window.progressReads.length), 0)
  await progressTab.click()
  await page.waitForFunction(() => window.progressReads.length === 1)
  await page.getByTestId('practice-saved-tab').click()
  await page.waitForFunction(() => window.progressStops === 1)
  await progressTab.click()
  await page.waitForFunction(() => window.progressReads.length === 2)
  const populated = { catalogSize:8,opened:2,submitted:1,accepted:1,unavailable:1,challenges:[
    {id:'a',title:'Imported solution',state:'accepted',importedOnly:true},
    {id:'b',title:'Opened locally',state:'opened',importedOnly:false},
  ] }
  await page.evaluate(result => {
    window.progressReads[1].resolve(result)
    window.progressReads[0].reject(Error('Stale failure'))
  }, populated)
  const imported = progress.getByRole('listitem').filter({ hasText: 'Imported solution' })
  await imported.getByText('Imported history').waitFor()
  await imported.getByText('Accepted').waitFor()
  await progress.getByText(/Counts may be incomplete/).waitFor()
  assert.equal(await progress.getByRole('alert').count(), 0)
  await progress.getByRole('button', { name: 'Refresh' }).click()
  await page.waitForFunction(() => window.progressReads.length === 3)
  await page.evaluate(() => window.progressReads[2].reject(Error('Profile is unavailable')))
  await progress.getByRole('alert').filter({ hasText: 'Profile is unavailable' }).waitFor()
  await progress.getByRole('button', { name: 'Try again' }).click()
  await page.waitForFunction(() => window.progressReads.length === 4)
  await page.evaluate(() => window.progressReads[3].resolve({
    catalogSize:8, opened:0, submitted:0, accepted:0, unavailable:0, challenges:[],
  }))
  await progress.getByText('Open a catalog challenge to start tracking progress.').waitFor()
  assert.equal(await page.evaluate(() => window.progressStops), 1)
  await progress.getByRole('button', { name: 'Refresh' }).click()
  await page.waitForFunction(() => window.progressReads.length === 5)
  await page.getByRole('button', { name: 'Hide Practice' }).click()
  await page.waitForFunction(() => window.progressStops === 2)
  await page.evaluate(() => window.progressReads[4].resolve({}))
  assert.equal(await progress.count(), 0)
  console.log('PASS progress loads only on request, distinguishes imported history and ignores replies after navigation or teardown')
  assert.deepEqual(errors, [])
  console.log('PASS catalog search waits for Enter, accepts text alone, preserves filters and ignores superseded responses')
  console.log('PASS Practice Submit honors saved-source preflight, Stop, problem capability, and the selected attempt’s ten newest verdicts')
} finally {
  await browser.close()
}
