import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { artifact, close, eventually, launch, withScratch } from './desktop-harness.mjs'

const { values } = parseArgs({ options: { target: { type: 'string', default: 'dist' } } })
const target = await artifact(values.target)
assert.ok(!target.path.endsWith('.app'), 'Use the production build directory for the isolated recovery publication latch.')

await withScratch('recovery-drain', async (scratch) => {
  const profile = join(scratch, 'profile')
  const wrapper = join(scratch, 'recovery-wrapper.cjs')
  const id = randomUUID()
  const published = join(profile, 'recovery', id + '.draft')
  await mkdir(profile)
  await writeFile(join(profile, 'preferences.json'), JSON.stringify({ version: 1,
    settings: { resourceProfile: 'minimal' }, recents: [] }))
  // Delay only an explicitly requested recovery rename. Reads/writes/fsync,
  // renderer crashes, main shutdown, recovery IPC and the next launch stay real.
  await writeFile(wrapper, `const fs = require('node:fs/promises'); const rename = fs.rename;
    const latch = globalThis.ionRecoveryDrainTest = { enabled: false, held: false, release: undefined };
    fs.rename = async (from, to) => {
      if (latch.enabled && String(from).includes('.ion-recovery-')) {
        latch.held = true;
        await new Promise(resolve => { latch.release = resolve });
      }
      return rename(from, to);
    };
    require(${JSON.stringify(resolve(target.args[0]))});`)
  let session = await launch({ ...target, path: wrapper, args: [wrapper] }, profile)
  try {
    await session.page.context().setOffline(true)
    await session.page.evaluate(async (id) => window.ion.recovery.write({ id, name: 'pending.txt', text: 'previous acknowledged revision' }), id)
    assert.ok((await readFile(published, 'utf8')).includes('previous acknowledged revision'))
    const [restarted] = await Promise.all([
      session.app.waitForEvent('window', { timeout: 15000 }),
      session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()),
    ])
    await restarted.getByTestId('welcome').waitFor()
    await restarted.context().setOffline(true)
    await session.app.evaluate(() => { globalThis.ionRecoveryDrainTest.enabled = true })
    await restarted.evaluate((id) => {
      void window.ion.recovery.write({ id, name: 'pending.txt', text: 'latest queued revision' }).catch(() => {})
    }, id)
    await eventually(() => session.app.evaluate(() => globalThis.ionRecoveryDrainTest.held), 'Recovery rename was not held.')
    const proc = session.appProcess
    const exited = once(proc, 'exit')
    await session.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer()).catch(() => {})
    await delay(200)
    assert.equal(proc.exitCode, null, 'Main must not exit while an accepted checkpoint is unpublished.')
    assert.equal(proc.signalCode, null)
    await session.app.evaluate(() => globalThis.ionRecoveryDrainTest.release())
    await Promise.race([exited, delay(8000, undefined, { ref: false }).then(() => { throw new Error('Recovery-drained app did not exit.') })])
    assert.ok((await readFile(published, 'utf8')).includes('latest queued revision'))
    assert.deepEqual(await readdir(join(profile, 'recovery')), [id + '.draft'])
    assert.deepEqual(session.requests, [], 'Recovery remains offline.')
    console.log('PASS repeated renderer crashes drain a queued checkpoint before normal main-process exit')
    session = await launch(target, profile)
    await session.page.context().setOffline(true)
    assert.equal(await session.page.evaluate((id) => window.ion.recovery.read(id), id), 'latest queued revision')
    await session.page.getByTestId('recover-edits').waitFor()
    assert.deepEqual(session.requests, [])
    console.log('PASS next real launch exposes the latest checkpoint through recovery IPC and UI')
  } finally {
    await session.app.evaluate(() => globalThis.ionRecoveryDrainTest?.release?.()).catch(() => {})
    await close(session)
  }
})
