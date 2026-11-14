import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { runPracticeBatch } from '../src/main/practice/execute-samples'
import { defaultRunLimits } from '../src/main/runner'

const examples = [
  ['answer.cpp', `#include <iostream>
int main() {
  int number;
  if (!(std::cin >> number)) return 2;
  std::cerr << "trace\\n";
  std::cout << number * 2 << '\\n';
}`],
  ['Main.java', `import java.util.Scanner;
public class Main {
  public static void main(String[] args) {
    int number = new Scanner(System.in).nextInt();
    System.err.println("trace");
    System.out.println(number * 2);
  }
}`],
  ['answer.py', `import sys
print("trace", file=sys.stderr)
print(int(input()) * 2)
`],
  ['answer.js', `const fs = require('node:fs')
console.error('trace')
console.log(Number(fs.readFileSync(0, 'utf8')) * 2)
`],
] as const

test('practice runs standalone local toolchains and keeps stderr out of answers', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'ion practice exercise '))
  t.after(() => rm(folder, { recursive: true, force: true }))
  await mkdir(join(folder, 'unrelated-project'))
  await writeFile(join(folder, 'unrelated-project', 'pom.xml'), 'Not a valid Maven project')
  for (const [name, source] of examples) {
    await t.test(name, async (context) => {
      const path = join(folder, 'unrelated-project', name)
      await writeFile(path, 'The runner must use the approved source snapshot.')
      const results = await runPracticeBatch(path, source, ['6\n', '17\n'], async () => true, new AbortController().signal)
      if (results[0].status === 'missing-toolchain') {
        assert.match(results[0].message, /local|install/i)
        return context.skip(results[0].message)
      }
      assert.deepEqual(results.map(({ status }) => status), ['success', 'success'], results.map((result) =>
        [result.message, result.compileOutput, result.programStderr].join('\n')).join('\n'))
      assert.deepEqual(results.map(({ programStdout }) => programStdout?.replaceAll('\r\n', '\n')), ['12\n', '34\n'])
      assert.deepEqual(results.map(({ programStderr }) => programStderr?.replaceAll('\r\n', '\n')), ['trace\n', 'trace\n'])
      assert.equal(typeof results[0].compileMs, /cpp|java/.test(name) ? 'number' : 'undefined')
      assert.equal(results[1].compileMs, undefined)
    })
  }
})

test('sample cases use fresh staged code and stop when the source changes', async (t) => {
  const source = `const fs = require('node:fs')
const input = fs.readFileSync(0, 'utf8').trim()
fs.writeFileSync(__filename, 'throw new Error("stale case source")')
fs.writeFileSync('marker', 'used', { flag: 'wx' })
console.log(input)
`
  let checks = 0
  const results = await runPracticeBatch('/answers/answer.js', source, ['first\n', 'second\n', 'third\n'],
    async () => ++checks <= 4, new AbortController().signal)
  if (results[0].status === 'missing-toolchain') return t.skip(results[0].message)
  assert.deepEqual(results.map(({ status }) => status), ['success', 'success', 'rejected'])
  assert.deepEqual(results.slice(0, 2).map(({ programStdout }) => programStdout), ['first\n', 'second\n'])
})

test('practice terminates a batch that exceeds its combined output budget', async (t) => {
  const results = await runPracticeBatch('/answers/answer.js',
    `process.stdout.write('x'.repeat(${defaultRunLimits.outputBytes + 1024}))`, ['', ''],
    async () => true, new AbortController().signal)
  if (results[0].status === 'missing-toolchain') return t.skip(results[0].message)
  assert.deepEqual(results.map(({ status }) => status), ['output-limit'])
  assert.equal(results[0].programStdout?.length, defaultRunLimits.outputBytes)
})

test('stopping a live practice sample reaps the process and clears its scratch files', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'ion practice cancel '))
  const marker = join(folder, 'started.json')
  const stop = new AbortController()
  const job = runPracticeBatch('/answers/answer.js', `
const fs = require('node:fs')
fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ pid: process.pid, cwd: process.cwd() }))
setInterval(() => {}, 1000)
`, [''], async () => true, stop.signal)
  t.after(async () => {
    stop.abort()
    await job
    await rm(folder, { recursive: true, force: true })
  })
  type LiveSample = { pid: number; cwd: string }
  let live: LiveSample | undefined
  const started = performance.now()
  while (!live && performance.now() - started < 3_000) {
    const progress = await Promise.race([
      job.then((results) => ({ results })),
      delay(20).then(() => ({ text: readFile(marker, 'utf8').catch(() => '') })),
    ])
    if ('results' in progress) {
      const [result] = progress.results
      if (result.status === 'missing-toolchain') return t.skip(result.message)
      assert.fail(result.message)
    }
    const text = await progress.text
    if (text) live = JSON.parse(text) as LiveSample
  }
  assert.ok(live, 'sample process started')
  stop.abort()
  assert.deepEqual((await job).map(({ status }) => status), ['cancelled'])
  assert.throws(() => process.kill(live.pid, 0), { code: 'ESRCH' })
  await assert.rejects(access(live.cwd), { code: 'ENOENT' })
})
