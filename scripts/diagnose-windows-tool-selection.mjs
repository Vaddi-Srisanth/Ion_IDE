import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { build } from 'esbuild'

assert.equal(process.platform, 'win32', 'Run compiler selection diagnostics on Windows.')
const scratch = await mkdtemp(join(await realpath(tmpdir()), 'ion-compiler-selection-'))
const bundle = join(scratch, 'selection.cjs')
try {
  await build({
    stdin: { contents: `export { findWindowsCompiler } from './src/main/runner.ts';
      export { windowsToolPaths, workspaceSafeWindowsToolPaths } from './src/main/windows-process.ts';`, resolveDir: process.cwd() },
    outfile: bundle, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent',
  })
  const tools = createRequire(import.meta.url)(bundle)
  const raw = tools.windowsToolPaths()
  const safe = await tools.workspaceSafeWindowsToolPaths(scratch)
  const candidates = []
  for (const directory of safe) for (const name of ['clang++.exe', 'g++.exe']) {
    const path = join(directory, name)
    const canonical = await realpath(path).catch(() => null)
    candidates.push({ directory, name, canonical, relation: canonical ? relative(scratch, canonical) : null,
      file: canonical ? await stat(canonical).then(value => value.isFile(), () => false) : false })
  }
  const selected = await tools.findWindowsCompiler(safe, scratch, true)
  console.log(JSON.stringify({ pathEntries: (process.env.PATH ?? '').split(';'), raw, safe, candidates, selected }, null, 2))
  const expectedDirectory = await realpath(process.env.ION_EXPECT_WINDOWS_GXX_DIRECTORY ?? 'C:\\mingw64\\bin')
  assert.ok(selected, 'Ion did not select an installed C++ compiler.')
  assert.equal(dirname(selected).toLowerCase(), expectedDirectory.toLowerCase(),
    `Ion selected ${selected}; expected the explicitly pinned MinGW-w64 directory.`)
  assert.equal(basename(selected).toLowerCase(), 'g++.exe')
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 3 })
}
