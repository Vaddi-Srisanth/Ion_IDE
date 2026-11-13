import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { artifact, close, launch, resourceSnapshot, withScratch } from './desktop-harness.mjs'
import { attachRendererDetails } from '../remediation/tools/renderer-details.mjs'

process.env.ION_SHOW_TEST_WINDOWS = '0'
assert.equal(process.platform, 'darwin', 'Native sampler control requires macOS; not a Windows pass.')
const report = { complete: false, method: 'Actual detached CDP session with a live disposable Electron page/main; proves error ambiguity and native-result retention, not the cause of the earlier unexplained disconnect.' }
try {
  await withScratch('detail-retention', async scratch => {
    const session = await launch(await artifact('dist'), join(scratch, 'profile'))
    try {
      const { app, page } = session
      const cdp = await page.context().newCDPSession(page)
      const before = await resourceSnapshot(session, { details: true })
      assert.ok(before.rssMiB > 0 && before.members.length > 0)
      await cdp.detach()
      let retained
      await assert.rejects(attachRendererDetails(before, cdp, page, async point => { retained = structuredClone(point) }), /closed|detached|collected/i)
      assert.ok(retained.nativeComplete)
      assert.equal(retained.detailsComplete, false)
      assert.equal(retained.rssMiB, before.rssMiB)
      assert.equal(retained.members.length, before.members.length)
      assert.equal(await page.evaluate(() => document.readyState), 'complete')
      assert.equal(await app.evaluate(() => process.pid), session.pid)
      report.nativeReadingRetained = true
      report.pageAndMainStillUsable = true
      report.retained = retained
    } finally { await close(session) }
  })
  report.complete = true
} catch (error) { report.error = String(error.stack ?? error); process.exitCode = 1 }
finally {
  const path = resolve('remediation/benchmark-detail-retention.json')
  await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify({ complete: report.complete, error: report.error }))
