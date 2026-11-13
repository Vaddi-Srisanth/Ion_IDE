import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs, promisify } from 'node:util'
import { build } from 'esbuild'

const { values } = parseArgs({ options: { 'native-source': { type: 'string', default: 'src/main/native-file-mutations.c' }, out: { type: 'string' } } })
const nativeSource = resolve(values['native-source'])
const report = { complete: false, platform: process.platform, nativeSource,
  sourceSha256: createHash('sha256').update(await readFile(nativeSource)).digest('hex') }
const scratch = await mkdtemp(join(tmpdir(), 'ion-metadata-regression-'))
const run = promisify(execFile)
try {
  if (process.platform !== 'darwin') throw new Error('This metadata regression requires native macOS; not verified on this host.')
  const helper = join(scratch, 'ion-file-ops')
  await run('/usr/bin/xcrun', ['clang', '-std=c11', '-D_DARWIN_C_SOURCE', '-O2', '-Wall', '-Wextra', '-Werror', nativeSource, '-o', helper])
  const test = join(scratch, 'metadata.cjs')
  await build({ entryPoints: ['test/file-metadata.test.ts'], outfile: test, bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const result = await run(process.execPath, ['--test', test], { env: { ...process.env, ION_FILE_MUTATIONS_TEST_HELPER: helper }, timeout: 30000 })
  report.output = result.stdout; report.complete = true
} catch (error) { report.error = String(error.stderr ?? error.stack ?? error); report.output = error.stdout; process.exitCode = 1 }
finally {
  await rm(scratch, { recursive: true, force: true })
  if (values.out) { const path = resolve(values.out); await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(report, null, 2) + '\n') }
}
console.log(JSON.stringify(report))
