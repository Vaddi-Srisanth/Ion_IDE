import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

// Match the separate CJS production entry points, rather than importing both
// functions from one test bundle and accidentally hiding duplicated state.
test('trusted Windows helper bootstrap reaches independently bundled optional modules', async () => {
  const scratch = await mkdtemp(join(tmpdir(), 'ion-helper-bundles-'))
  try {
    const source = resolve('src/main/windows-process.ts')
    const { build } = createRequire(resolve('package.json'))('esbuild') as typeof import('esbuild')
    const main = join(scratch, 'main.ts'), optional = join(scratch, 'optional.ts')
    await writeFile(main, `export { configureWindowsProcessHelper } from ${JSON.stringify(source)};`)
    await writeFile(optional, `export { windowsPipeCommand } from ${JSON.stringify(source)};`)
    await build({ entryPoints: [main, optional], bundle: true, platform: 'node', format: 'cjs',
      outdir: join(scratch, 'out'), outExtension: { '.js': '.cjs' }, logLevel: 'silent' })
    const script = `const assert=require('node:assert/strict'),path=require('node:path');
      Object.defineProperty(process.versions,'electron',{value:'test-owned-context'});
      process.env.ION_WINDOWS_PROCESS_TEST_HELPER=path.resolve('workspace-untrusted-helper');
      const bootstrap=require(${JSON.stringify(join(scratch, 'out/main.cjs'))});
      const optional=require(${JSON.stringify(join(scratch, 'out/optional.cjs'))});
      assert.throws(()=>optional.windowsPipeCommand(process.execPath,[]),/helper is unavailable/);
      assert.throws(()=>bootstrap.configureWindowsProcessHelper('relative-helper'),/Invalid/);
      const trusted=path.resolve('installed-owned-helper');
      bootstrap.configureWindowsProcessHelper(trusted);
      assert.deepEqual(optional.windowsPipeCommand(process.execPath,['literal & argument']),
        {executable:trusted,args:['--pipe',String(process.pid),process.execPath,'literal & argument']});
      console.log('PASS shared trusted bootstrap; workspace environment ignored');`
    const { stdout } = await promisify(execFile)(process.execPath, ['-e', script], {
      timeout: 10000, maxBuffer: 64 * 1024, windowsHide: true,
    })
    assert.match(stdout, /PASS shared trusted bootstrap/)
  } finally { await rm(scratch, { recursive: true, force: true }) }
})
