import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const fixtures = {
  a: {
    category: 'argument-count',
    broken: 'net_weight(gross)',
    reference: 'net_weight(gross, container)',
    cases: [['17 5', '12'], ['15 15', '0'], ['0 0', '0'], ['80 7', '73']],
  },
  b: {
    category: 'invalid-dereference',
    broken: 'corrected_reading(reading, *offset)',
    reference: 'corrected_reading(reading, offset)',
    cases: [['10 -3', '7'], ['-8 5', '-3'], ['0 0', '0'], ['12 4', '16']],
  },
  'a-transfer': {
    category: 'argument-count',
    broken: 'total_points(tasks, points_each, 0)',
    reference: 'total_points(tasks, points_each)',
    cases: [['4 7', '28'], ['0 15', '0'], ['9 1', '9'], ['2 11', '22']],
  },
  'b-transfer': {
    category: 'invalid-dereference',
    broken: '**stock + change',
    reference: '*stock + change',
    cases: [['30 -4', '26'], ['0 3', '3'], ['12 -12', '0'], ['7 0', '7']],
  },
}

const compiler = '/usr/bin/clang'
const compileFlags = ['-x', 'c', '-std=c17', '-Wall', '-Wextra', '-fdiagnostics-color=never']
const environment = { ...process.env, LC_ALL: 'C', LANG: 'C' }
const directory = await mkdtemp(join(tmpdir(), 'ion-study-fixture-'))
const source = join(directory, 'submission.c')
const binary = join(directory, 'submission')

function invoke(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: directory, env: environment, encoding: 'utf8', maxBuffer: 64 * 1024, timeout: 10_000, ...options,
  })
  if (result.error) throw result.error
  return result
}

function compile() {
  return invoke(compiler, [...compileFlags, source, '-o', binary])
}

function grade(cases) {
  const { status, stderr } = compile()
  if (status !== 0) {
    console.error(stderr.trim())
    return { compiled: false, passed: 0, total: cases.length }
  }
  let passed = 0
  for (const [input, expected] of cases) {
    try {
      const result = invoke(binary, [], { input: input + '\n', timeout: 2_000 })
      if (result.status === 0 && result.stdout === expected + '\n') passed++
    } catch {
      // A case that hangs or exceeds the output cap fails.
    }
  }
  return { compiled: true, passed, total: cases.length }
}

try {
  const args = process.argv.slice(2)
  if (args.length) {
    const [flag, form, path] = args
    assert.ok(args.length === 3 && flag === '--grade' && Object.hasOwn(fixtures, form) && path,
      'Usage: node docs/study/verify.mjs [--grade <a|b|a-transfer|b-transfer> <submission.c>]')
    await writeFile(source, await readFile(path))
    const result = grade(fixtures[form].cases)
    console.log(JSON.stringify(result))
    process.exitCode = result.passed === result.total ? 0 : 1
  } else {
    const bundle = await build({
      entryPoints: [fileURLToPath(new URL('../../src/main/learning/diagnostics.ts', import.meta.url))],
      platform: 'node', format: 'esm', bundle: true, write: false,
    })
    const { diagnose } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'))
    console.log(invoke(compiler, ['--version']).stdout.split('\n')[0])
    for (const [form, { category, broken, reference, cases }] of Object.entries(fixtures)) {
      const starter = await readFile(new URL(`fixtures/${form}.c`, import.meta.url), 'utf8')
      await writeFile(source, starter)
      const { status, stderr } = compile()
      assert.ok(status > 0, `${form} starter must fail to compile`)
      const actual = diagnose({
        status: 'compile-error', compiler, compileOutput: stderr, programOutput: '', outputComplete: true,
      }, 'c', source).filter((diagnostic) => diagnostic.severity === 'error')
      assert.deepEqual(actual.map((diagnostic) => [diagnostic.category, diagnostic.confidence]), [[category, 'high']])
      assert.ok(starter.includes(broken), `${form} reference edit must match the starter`)
      await writeFile(source, starter.replace(broken, reference))
      assert.deepEqual(grade(cases), { compiled: true, passed: cases.length, total: cases.length })
      console.log(`PASS ${form} · ${category} · ${cases.length} reference cases`)
    }
  }
} finally {
  await rm(directory, { recursive: true, force: true })
}
