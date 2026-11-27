import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const fixture = `
  import { useState } from 'react'
  import { createRoot } from 'react-dom/client'
  import { ExplanationDialog } from './src/renderer/explanations/ExplanationDialog'
  const provider = { endpoint:'https://example.invalid/v1', model:'fixture', hasKey:true }
  const calls = window.calls = { provider:0, reviews:[], sent:[], retired:[] }
  let token
  const bridge = {
    provider:async () => { calls.provider++; return provider },
    review:async request => {
      calls.reviews.push(request)
      token = 'review-' + calls.reviews.length
      return { token, provider, question:request.question, purpose:request.purpose, action:request.action,
        stream:request.stream, bodyBytes:100, expiresAt:Date.now()+60_000,
        sources:request.code ? [{id:'code-1',label:request.code.label,origin:'editor-buffer',revision:'buffer-v1',startLine:1,endLine:3,text:request.code.text}] : [],
        exclusions:[] }
    },
    send:async value => {
      if (!token || token !== value) throw Error('Unexpected send token')
      calls.sent.push(token)
      token = undefined
      return new Promise(resolve => {window.finish = () => resolve({
        token:'validated-answer', summary:'Complete fixture answer', sections:[],questions:[],edit:null,recommendations:[]
      })})
    },
    cancel:async () => { if (token) calls.retired.push(token); token = undefined }
  }
  function App() {
    const [purpose, setPurpose] = useState()
    return <><button onClick={() => setPurpose('tutor')}>Tutor</button>
      <button onClick={() => setPurpose('project-lens')}>Project Lens</button>
      {purpose && <ExplanationDialog initialRequest={{purpose,action:purpose==='tutor'?'hint':'understand', question:'Explain this.',
        ...(purpose==='tutor' ? {code:{label:'main.py',text:'for item in items:\\n    print(item)\\n',version:1}} : {})}}
        bridge={bridge} onClose={() => setPurpose(undefined)} onOpenCitation={() => {}}/>}</>
  }
  createRoot(document.querySelector('#root')).render(<App/>)
`
const bundle = await build({ stdin: { contents: fixture, loader:'tsx', resolveDir:resolve('.') },
  bundle:true, jsx:'automatic', write:false, outdir:'out', format:'iife', logLevel:'silent' })
const browser = await chromium.launch({ channel:'chrome', headless:true })
try {
  const page = await browser.newPage()
  const errors = [], network = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()) })
  await page.context().setOffline(true)
  await page.setContent('<div id="root"></div>')
  for (const file of bundle.outputFiles) {
    if (file.path.endsWith('.css')) await page.addStyleTag({ content:file.text })
    else if (file.path.endsWith('.js')) await page.addScriptTag({ content:file.text })
  }
  assert.equal(await page.evaluate(() => window.calls.provider), 0)
  for (const [index, name] of ['Tutor','Project Lens'].entries()) {
    await page.getByRole('button', { name, exact:true }).click()
    const dialog = page.getByRole('dialog')
    const option = dialog.getByRole('checkbox', { name:'Stream provider response' })
    const review = dialog.getByRole('button', { name:'Review request' })
    const preview = dialog.getByRole('region', { name:'Exact request review' })
    const send = dialog.getByRole('button', { name:'Send reviewed request' })
    assert.equal(await option.isChecked(), false)
    await review.click()
    await preview.getByText('Single response', { exact:true }).waitFor()
    assert.equal(await page.evaluate(() => 'stream' in window.calls.reviews.at(-1)), false)
    await option.check()
    await preview.waitFor({ state:'detached' })
    await review.click()
    await preview.getByText('Streaming', { exact:true }).waitFor()
    await option.uncheck()
    await preview.waitFor({ state:'detached' })
    await option.check()
    await review.click()
    await preview.getByText('Streaming', { exact:true }).waitFor()
    const calls = await page.evaluate(() => window.calls)
    assert.deepEqual(calls.retired.slice(-2), ['review-' + (index*3+1), 'review-' + (index*3+2)])
    assert.equal(calls.reviews.at(-1).stream, true)
    assert.equal(calls.sent.length, index)
    await send.click()
    await page.waitForFunction(count => window.calls.sent.length === count, index+1)
    assert.equal(await option.isDisabled(), true)
    assert.equal(await page.getByTestId('explanation-answer').count(), 0)
    await page.evaluate(() => window.finish())
    await dialog.getByText('Complete fixture answer').waitFor()
    assert.equal(await option.isChecked(), false, 'A consumed review carried streaming into another request.')
    assert.equal(await page.evaluate(() => window.calls.sent.at(-1)), 'review-' + (index*3+3))
    await dialog.getByRole('button', { name:'Close dialog' }).click()
    await dialog.waitFor({ state:'detached' })
  }
  await page.getByRole('button', { name:'Tutor', exact:true }).click()
  const tutor = page.getByRole('dialog')
  const action = tutor.getByRole('combobox', { name:'Action' })
  const review = tutor.getByRole('button', { name:'Review request' })
  await action.selectOption('complexity')
  assert.equal(await review.isDisabled(), true, 'Complexity cannot be reviewed until code is explicitly selected.')
  await tutor.getByRole('checkbox', { name:'Current unsaved code: main.py (off by default)' }).check()
  await review.click()
  const preview = tutor.getByRole('region', { name:'Exact request review' })
  await preview.getByText('main.py · editor-buffer · lines 1–3').waitFor()
  const selected = await page.evaluate(() => window.calls.reviews.at(-1))
  assert.equal(selected.action, 'complexity')
  assert.deepEqual(selected.code, { label:'main.py', text:'for item in items:\n    print(item)\n', version:1 })
  assert.equal(selected.lesson, undefined)
  assert.equal(selected.project, undefined)
  await tutor.getByRole('button', { name:'Close dialog' }).click()
  await tutor.waitFor({ state:'detached' })
  assert.deepEqual(errors, [])
  assert.deepEqual(network, [])
  console.log('PASS Tutor and Project Lens review flow, explicit streaming and selected-code complexity consent')
} finally {
  await browser.close()
}
