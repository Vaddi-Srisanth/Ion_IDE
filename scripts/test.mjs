import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { buildFileMutations } from './build-file-mutations.mjs'
import { buildWindowsConsoleProbe, buildWindowsPty } from './windows/build-pty.mjs'
import { pipeFixtureSources } from './windows/pipe-fixture-source.mjs'

const directory = await mkdtemp(join(tmpdir(), 'ion-tests-'))
try {
  const requested = new Set(process.argv.slice(2).map((name) => name + '.test.ts'))
  const files = (await readdir('test')).filter((name) => name.endsWith('.test.ts')
    && (!requested.size || requested.has(name)))
  if ([...requested].some((name) => !files.includes(name))) throw new Error('Unknown unit test filename.')
  if (!files.length) throw new Error('No unit tests found')
  const native = join(directory, process.platform === 'win32' ? 'ion-file-ops.exe' : 'ion-file-ops')
  const processHelper = process.platform === 'win32' ? join(directory, 'ion-pty.exe') : undefined
  let baselineHelper, detachedControlHelper, consoleProbe
  if (processHelper) await buildWindowsPty(processHelper, process.arch)
  if (processHelper && files.includes('windows-process-job.test.ts')) {
    const source = await readFile('src/main/run-console/pty-windows.cpp', 'utf8')
    const controls = pipeFixtureSources(source)
    const control = join(directory, 'baseline-pipe.cpp'), detachedControl = join(directory, 'detached-control-pipe.cpp')
    await writeFile(control, controls.baseline)
    await writeFile(detachedControl, controls.detached)
    baselineHelper = join(directory, 'baseline-ion-pty.exe')
    detachedControlHelper = join(directory, 'detached-control-ion-pty.exe')
    consoleProbe = join(directory, 'console-probe.exe')
    await buildWindowsPty(baselineHelper, process.arch, control)
    await buildWindowsPty(detachedControlHelper, process.arch, detachedControl)
    await buildWindowsConsoleProbe(consoleProbe)
  }
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
    stdio: 'inherit', env: { ...process.env, ION_FILE_MUTATIONS_TEST_HELPER: native, ION_WINDOWS_PROCESS_TEST_HELPER: processHelper,
      ION_WINDOWS_PROCESS_BASELINE_TEST_HELPER: baselineHelper, ION_WINDOWS_PROCESS_DETACHED_CONTROL_HELPER: detachedControlHelper,
      ION_WINDOWS_CONSOLE_PROBE: consoleProbe },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  await rm(directory, { recursive: true, force: true })
}
