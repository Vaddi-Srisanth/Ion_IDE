// Development-only microbenchmark. Never loaded by Ion or used on user files.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { build, stop } from 'esbuild'

const { values } = parseArgs({ options: {
  baseline: { type: 'string', default: 'df089aabfc8b5f3f5e19eb1d3372fc12131c7703' },
  out: { type: 'string', default: 'performance-results/diagnostic-normalization-profile.json' },
} })
assert.match(values.baseline, /^[a-f0-9]{40}$/)
const file = 'src/main/learning/diagnostics.ts'
const before = execFileSync('git', ['--no-pager', '--no-replace-objects', 'show', values.baseline + ':' + file],
  { encoding: 'utf8', maxBuffer: 256 * 1024 })
const directory = await mkdtemp(join(tmpdir(), 'ion-diagnostic-profile-'))
const require = createRequire(resolve('package.json'))
const loaded = []
async function classifier(contents) {
  const out = await build({ stdin: { contents, resolveDir: resolve('src/main/learning'), sourcefile: 'diagnostics.ts', loader: 'ts' },
    bundle: true, platform: 'node', format: 'cjs', write: false })
  // Use ordinary Node modules, not VM globals whose cross-context property
  // lookup changes hot-loop cost. Only reviewed application code is loaded.
  const compiled = join(directory, 'classifier-' + loaded.length + '.cjs')
  await writeFile(compiled, out.outputFiles[0].text, { flag: 'wx', mode: 0o600 })
  loaded.push(compiled)
  return require(compiled).diagnose
}
try {
  const versions = { before: await classifier(before), after: await classifier(await readFile(file, 'utf8')) }
  const path = 'C:\\Fixture\\undefined name.py'
  const trace = `Traceback (most recent call last):\r\n  File "${path}", line 1, in <module>\r\n    print(undefined_study_value)\r\nNameError: name 'undefined_study_value' is not defined`
  const cases = { plain: trace,
    conpty: '\x1b[?9001h\x1b[?1004h\x1b[?25l\x1b[2J\x1b[m\x1b[H\r\n\x1b]0;python.exe\x07' + trace + '\x1b[7;1H\x1b[?9001l\x1b[?1004l\n',
    nearLimit: 'x'.repeat(63000) + '\r\n' + trace, overLimit: 'x'.repeat(70000) + trace }
  const report = { kind: 'Node-only-classifier-function-microbenchmark', baseline: values.baseline,
    environment: { platform: process.platform, arch: process.arch, node: process.version },
    iterationsPerSample: 100, pairedSamples: 6,
    limitations: ['Not Ion startup, idle RAM, macOS footprint, native Windows correctness or display latency.',
      'One Node process with ordinary compiled modules; allocator/GC affect small timings.',
      'RSS is sampled at batch endpoints, not peak or retained memory.',
      'Malformed, ambiguous and over-limit output intentionally abstains.'], cases: {} }
  for (const [name, text] of Object.entries(cases)) {
    const result = { status: 'runtime-error', compiler: 'C:\\Fixture\\python.exe', compileOutput: '', programOutput: text,
      exitCode: 1, durationMs: 1, message: 'Program failed (exit code 1).', outputComplete: true }
    const samples = []
    for (let pair = 0; pair < 6; pair++) for (const label of pair % 2 ? ['after', 'before'] : ['before', 'after']) {
      const fn = versions[label]
      for (let warm = 0; warm < 5; warm++) fn(result, 'python', path)
      const cpu = process.cpuUsage(), rss = process.memoryUsage().rss, began = performance.now()
      let category
      for (let repeat = 0; repeat < 100; repeat++) category = fn(result, 'python', path)[0].category
      const elapsed = performance.now() - began, used = process.cpuUsage(cpu)
      samples.push({ pair: pair + 1, label, elapsedMs: elapsed, perCallMs: elapsed / 100,
        cpuMs: (used.user + used.system) / 1000, rssBeforeBytes: rss, rssAfterBytes: process.memoryUsage().rss, category })
    }
    report.cases[name] = { bytes: Buffer.byteLength(text), samples }
    const median = list => { list.sort((a, b) => a - b); return (list[2] + list[3]) / 2 }
    console.log(name, Object.fromEntries(['before', 'after'].map(label => [label,
      { medianMsPerCall: median(samples.filter(row => row.label === label).map(row => row.perCallMs)),
        category: samples.find(row => row.label === label).category }])))
  }
  const output = resolve(values.out)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify(report, null, 2) + '\n')
} finally {
  for (const path of loaded) delete require.cache[path]
  stop()
  await rm(directory, { recursive: true, force: true })
}
