import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join, resolve } from 'node:path'

// Only run examples maintained in the bundled catalog. User-imported packs are data.
const root = resolve(import.meta.dirname, '..')
const catalog = join(root, 'src', 'main', 'learning', 'catalog')
const packs = new Set(readdirSync(catalog, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'index.json')
  .map(({ name }) => name.slice(0, -5)))
const ids = process.argv.slice(2)
for (const id of ids) assert.ok(packs.has(id), `Unknown bundled pack: ${id}`)
const cli = process.execPath
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const safeYaml = 'Psych.safe_load(STDIN.read, permitted_classes: [], permitted_symbols: [], aliases: false)'
const documentExtensions = new Set(['.json', '.xml', '.yaml', '.yml', '.html'])

function run(work, command, args, input) {
  const result = spawnSync(command, args, { cwd: work, input, encoding: 'utf8', timeout: 30_000,
    maxBuffer: 512 * 1024, env: { ...process.env, LC_ALL: 'C', PYTHONUTF8: '1' } })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout || result.signal}`)
  return result.stdout
}

function executeExample(work, file, lesson) {
  const { example } = lesson
  const extension = extname(file)
  if (lesson.exampleMode !== 'program' && !documentExtensions.has(extension)) {
    return { skip: 'requires the surrounding program or manual verification' }
  }
  switch (extension) {
    case '.c':
    case '.cpp': {
      const c = extension === '.c'
      const executable = join(work, process.platform === 'win32' ? 'example.exe' : 'example')
      run(work, c ? 'clang' : 'clang++', [c ? '-std=c17' : '-std=c++17', '-Wall', '-Wextra', '-Werror',
        '-pedantic', file, '-o', executable])
      return { output: run(work, executable, []) }
    }
    case '.java':
      run(work, 'javac', ['--release', '17', '-encoding', 'UTF-8', '-Xlint:all', '-Werror', file])
      return { output: run(work, 'java', ['-Duser.language=en', '-Duser.country=US', file.slice(0, -5)]) }
    case '.py':
      return { output: run(work, process.platform === 'win32' ? 'python' : 'python3', ['-I', file]) }
    case '.js':
    case '.mjs':
    case '.cjs':
      return { output: run(work, cli, [file]) }
    case '.ts':
    case '.mts':
      run(work, cli, [tsc, '--target', 'ES2022', '--module', 'nodenext', '--strict', '--skipLibCheck', file])
      return { output: run(work, cli, [file.slice(0, -extension.length) + (extension === '.mts' ? '.mjs' : '.js')]) }
    case '.sql': {
      const init = join(work, 'sqlite-init')
      writeFileSync(init, '')
      return { output: run(work, 'sqlite3', ['-init', init, '-batch', '-bail', '-noheader', '-separator', '|', ':memory:'], example) }
    }
    case '.json':
      JSON.parse(example)
      return { check: 'JSON parsed' }
    case '.xml':
      run(work, 'xmllint', ['--nonet', '--noout', '-'], example)
      return { check: 'XML parsed' }
    case '.yaml':
    case '.yml':
      run(work, 'ruby', ['-rpsych', '-e', safeYaml], example)
      return { check: 'YAML parsed using a data-only loader' }
    case '.html': {
      const scripts = [...example.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
      if (!scripts.length) return { skip: 'requires manual HTML verification' }
      for (const script of scripts) run(work, cli, ['--input-type=module', '--check'], script[1])
      return { check: 'inline JavaScript syntax checked; interaction requires a browser' }
    }
    default:
      return { skip: `no verifier for ${extension}` }
  }
}

let checked = 0
let skipped = 0
let failed = 0
for (const id of ids.length ? ids : packs) {
  const pack = JSON.parse(readFileSync(join(catalog, id + '.json'), 'utf8'))
  for (const lesson of pack.lessons) {
    const label = `${id}/${lesson.id}`
    const file = lesson.exampleFile
    if (!file || !/^[\w-]+\.[a-z0-9]{1,10}$/i.test(file)) {
      console.log(`SKIP ${label} (no supported example filename)`)
      skipped++
      continue
    }
    const work = mkdtempSync(join(tmpdir(), 'ion-learning-example-'))
    try {
      writeFileSync(join(work, file), lesson.example + '\n')
      const result = executeExample(work, file, lesson)
      if (result.skip) {
        console.log(`SKIP ${label} (${result.skip})`)
        skipped++
        continue
      }
      const expected = lesson.expectedOutput
      if ('output' in result && expected !== undefined) {
        assert.equal(result.output.replaceAll('\r\n', '\n').replace(/\n+$/, ''), expected.replace(/\n+$/, ''))
      }
      console.log(`PASS ${label} (${result.check ?? (expected === undefined ? 'executed' : 'matched output')})`)
      checked++
    } catch (error) {
      if (error.code === 'ENOENT' && error.path && !error.path.startsWith(work)) {
        console.log(`SKIP ${label} (${error.path} unavailable)`)
        skipped++
      } else {
        console.error(`FAIL ${label}: ${error.message}`)
        failed++
      }
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}
console.log(`${checked} checked, ${skipped} skipped, ${failed} failed`)
if (failed) process.exitCode = 1
