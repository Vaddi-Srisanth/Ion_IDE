import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { PreferenceStore } from '../src/main/preferences'

test('Windows preferences recover from a sharing lock and preserve the old file on a persistent lock', {
  skip: process.platform !== 'win32',
  timeout: 20_000,
}, async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-preferences-lock-'))
  const path = join(scratch, 'preferences.json')
  const old = JSON.stringify({ version: 1, settings: { checkUpdatesOnLaunch: false }, recents: [] })
  const lock = async () => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      "$ErrorActionPreference='Stop'",
      "$handle=[IO.File]::Open($env:ION_LOCK_PATH, 'Open', 'Read', 'ReadWrite')",
      "try { [Console]::WriteLine('locked'); $null=[Console]::ReadLine() } finally { $handle.Dispose() }",
    ].join('; ')], { env: { ...process.env, ION_LOCK_PATH: path }, windowsHide: true })
    const closed = once(child, 'close')
    // Observe an early spawn failure even if the readiness check rejects first.
    void closed.catch(() => undefined)
    const lines = createInterface({ input: child.stdout })
    try {
      const [line] = await Promise.race([
        once(lines, 'line'),
        closed.then(([code]) => { throw new Error('The Windows preference lock helper exited with code ' + code) }),
      ])
      assert.equal(line, 'locked')
    } catch (error) {
      child.kill()
      await closed.catch(() => undefined)
      throw error
    } finally {
      lines.close()
    }
    return async () => {
      child.stdin.end('\n')
      assert.equal((await closed)[0], 0)
    }
  }
  try {
    await writeFile(path, old)
    const store = new PreferenceStore(path)
    await store.get()
    const release = await lock()
    const pending = store.updateSettings({ checkUpdatesOnLaunch: true })
    const outcome = pending.then(() => null, (error: unknown) => error)
    try {
      await delay(160)
      assert.equal(await readFile(path, 'utf8'), old, 'the existing file stayed intact during replacement')
    } finally {
      await release()
    }
    assert.equal(await outcome, null, 'the write recovered after the native sharing lock was released')
    const saved = await readFile(path, 'utf8')
    assert.equal(JSON.parse(saved).settings.checkUpdatesOnLaunch, true)
    const releasePersistent = await lock()
    try {
      await assert.rejects(store.updateSettings({ checkUpdatesOnLaunch: false }), /EBUSY|EPERM|EACCES/)
      assert.equal((await store.get()).settings.checkUpdatesOnLaunch, true)
      assert.equal(await readFile(path, 'utf8'), saved)
      assert.deepEqual(await readdir(scratch), ['preferences.json'])
    } finally {
      await releasePersistent()
    }
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})
