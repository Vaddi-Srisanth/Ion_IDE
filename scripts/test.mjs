import { spawnSync } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { buildFileMutations } from './build-file-mutations.mjs'
import { buildWindowsPty } from './windows/build-pty.mjs'

const directory = await mkdtemp(join(tmpdir(), 'ion-tests-'))
try {
  const requested = new Set(process.argv.slice(2).map((name) => name + '.test.ts'))
  const files = (await readdir('test')).filter((name) => name.endsWith('.test.ts')
    && (!requested.size || requested.has(name)))
  if ([...requested].some((name) => !files.includes(name))) throw new Error('Unknown unit test filename.')
  if (!files.length) throw new Error('No unit tests found')
  const native = join(directory, process.platform === 'win32' ? 'ion-file-ops.exe' : 'ion-file-ops')
  const processHelper = process.platform === 'win32' ? join(directory, 'ion-pty.exe') : undefined
  if (processHelper) await buildWindowsPty(processHelper, process.arch)
  if (files.some((name) => /^(backend|editor-session|file-mutation-races|file-metadata|workspace-files-windows)\.test\.ts$/.test(name))) {
    await buildFileMutations(native)
  }
  await build({
    entryPoints: files.map((file) => join('test', file)),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outdir: directory,
    outExtension: { '.js': '.cjs' },
    sourcemap: 'inline',
    external: ['electron'],
  })
  // Several fixture files start cold JVMs/compilers/build tools. Concurrent
  // files on the hosted Windows VM exhausted their individual tool deadlines;
  // serialize them without changing the application's execution limits.
  const result = spawnSync(process.execPath, ['--enable-source-maps', '--test',
    ...(process.platform === 'win32' ? ['--test-concurrency=1'] : []),
    ...files.map((file) => join(directory, file.replace(/\.ts$/, '.cjs')))], {
    stdio: 'inherit', env: { ...process.env, ION_FILE_MUTATIONS_TEST_HELPER: native, ION_WINDOWS_PROCESS_TEST_HELPER: processHelper },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  await rm(directory, { recursive: true, force: true })
}
