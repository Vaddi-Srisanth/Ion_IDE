import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build } from 'esbuild'

const { values } = parseArgs({ options: { source: { type: 'string', default: '.' },
  'expect-vulnerable': { type: 'boolean' }, out: { type: 'string' } } })
const require = createRequire(import.meta.url)
const processes = require('node:child_process')
const spawn = processes.spawn
const scratch = await realpath(await mkdtemp(join(tmpdir(), 'ion-git-race-')))
const root = join(scratch, 'Source café')
const report = { complete: false, platform: process.platform, source: resolve(values.source),
  expectedVulnerable: Boolean(values['expect-vulnerable']) }
let service
try {
  await mkdir(root)
  await build({ entryPoints: [join(resolve(values.source), 'src/main/source-control/index.ts')],
    outfile: join(scratch, 'service.cjs'), bundle: true, platform: 'node', format: 'cjs' })
  const git = (...args) => processes.execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', ...args],
    { encoding: 'utf8', windowsHide: true })
  git('init', '-q', '-b', 'main')
  git('config', 'core.autocrlf', 'false')
  await writeFile(join(root, '.gitattributes'), '*.txt filter=late\n')
  await writeFile(join(root, 'data.txt'), 'preserve these bytes\r\n')
  const script = join(scratch, 'filter.cjs')
  await writeFile(script, 'require("node:fs").writeFileSync("filter-ran", "executed"); process.stdin.pipe(process.stdout)')
  const command = `"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`
  const { SourceControlService } = require(join(scratch, 'service.cjs'))
  service = new SourceControlService()
  await service.status(root)
  processes.spawn = (executable, args, options) => {
    if (options.cwd === root && args.includes('add')) {
      git('config', 'filter.late.clean', command)
      report.injectedAtRealLaunch = true
    }
    return spawn(executable, args, options)
  }
  await service.change(root, { path: 'data.txt', action: 'stage' })
  report.filterExecuted = existsSync(join(root, 'filter-ran'))
  report.indexPreserved = git('show', ':data.txt') === await readFile(join(root, 'data.txt'), 'utf8')
  assert.equal(report.injectedAtRealLaunch, true)
  assert.equal(report.filterExecuted, Boolean(values['expect-vulnerable']))
  assert.equal(report.indexPreserved, true)
  report.complete = true
  console.log(values['expect-vulnerable'] ? 'REPRODUCED the checkpoint filter execution race' : 'PASS the real late filter did not execute and staged bytes match')
} finally {
  processes.spawn = spawn
  service?.close()
  await service?.drain()
  await rm(scratch, { recursive: true, force: true })
  if (values.out) {
    await mkdir(dirname(resolve(values.out)), { recursive: true })
    await writeFile(values.out, JSON.stringify(report, null, 2) + '\n')
  }
}
