import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { MissingToolchainError, prepareRun, type CommandPlan } from '../src/main/run-console/plans'
import { InteractiveRunner } from '../src/main/run-console/engine'
import { runLanguage } from '../src/shared/run-console'

const execute = promisify(execFile)
const signal = new AbortController().signal

async function scratch(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ion plans '))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return directory
}

function invoke(command: CommandPlan, cwd: string) {
  return execute(command.executable, command.args, {
    cwd: command.cwd ?? cwd, env: command.environment, timeout: 20_000, maxBuffer: 256 * 1024,
  })
}

test('detects runnable extensions without routing browser documents to Node', () => {
  assert.equal(runLanguage('example.c'), 'c')
  assert.equal(runLanguage('example.C'), 'cpp')
  assert.equal(runLanguage('example.cc'), 'cpp')
  assert.equal(runLanguage('example.java'), 'java')
  assert.equal(runLanguage('example.py'), 'python')
  assert.equal(runLanguage('example.python'), 'python')
  assert.equal(runLanguage('example.mjs'), 'javascript')
  assert.equal(runLanguage('index.html'), undefined)
})

test('reports missing runtimes with actionable installation instructions', { skip: process.platform === 'win32' }, async (t) => {
  const directory = await scratch(t)
  // The planner excludes executables under the workspace. A root workspace
  // exercises the missing-runtime path without changing installed tools or PATH.
  for (const [name, hint] of [['example.py', 'Install Python 3'], ['example.js', 'Install Node.js']]) {
    const path = join(directory, name)
    await writeFile(path, '')
    await assert.rejects(prepareRun({ path, root: '/', scratch: directory, signal }),
      (error) => error instanceof MissingToolchainError && error.message.includes(hint))
  }
})

test('compiles and runs C and C++ with local tools and paths containing spaces', async (t) => {
  const root = await scratch(t)
  for (const [language, name, source] of [
    ['c', 'hello from C.c', '#include <stdio.h>\nint main(void) { puts("hello"); return 0; }'],
    ['cpp', 'hello from CPP.cpp', '#include <iostream>\nint main() { std::cout << "hello\\n"; }'],
  ]) {
    await t.test(language, async (context) => {
      const path = join(root, name)
      const build = join(root, language + ' build')
      await Promise.all([writeFile(path, source), mkdir(build)])
      const plan = await prepareRun({ path, root, scratch: build, signal }).catch((error: unknown) => {
        if (error instanceof MissingToolchainError) return null
        throw error
      })
      if (!plan?.compile) return context.skip('A local compiler is needed')
      assert.equal(basename(plan.run.executable), process.platform === 'win32' ? 'program.exe' : 'program')
      await invoke(plan.compile, root)
      assert.match((await invoke(plan.run, root)).stdout, /^hello\r?\n$/)
    })
  }
})

test('Java compiles a packaged entry point and its required sources with a local JAR', async (t) => {
  const directory = await scratch(t)
  const root = join(directory, 'my project')
  const packageDirectory = join(root, 'src', 'lesson', 'demo')
  const path = join(packageDirectory, 'Entry.java')
  const toolDiscovery = join(directory, 'discovery')
  const build = join(directory, 'isolated classes')
  await Promise.all([mkdir(packageDirectory, { recursive: true }), mkdir(toolDiscovery), mkdir(build)])
  await writeFile(path, `/* package decoy; public static void main(String[] fake) {} */
package lesson /* comment */ . demo;
import external.Value;
class Entry {}
class Actual {
    public static void main(String... args) {
        System.out.println(Helper.text() + " " + Value.number());
    }
}
`)
  await writeFile(join(packageDirectory, 'Helper.java'),
    'package lesson.demo; class Helper { static String text() { return "Hello"; } }\n')
  // A neighboring broken file should never be handed to the compiler.
  await writeFile(join(packageDirectory, 'Unused.java'), 'intentionally invalid source\n')
  const initial = await prepareRun({ path, root, scratch: toolDiscovery, signal }).catch((error: unknown) => {
    if (error instanceof MissingToolchainError) return null
    throw error
  })
  if (!initial?.compile) return t.skip('A local JDK is needed')
  const jarDirectory = join(root, 'lib')
  const jarClasses = join(directory, 'jar classes')
  const jarSource = join(directory, 'Value.java')
  await Promise.all([mkdir(jarDirectory), mkdir(jarClasses)])
  await writeFile(jarSource, 'package external; public class Value { public static int number() { return 42; } }\n')
  await invoke({ ...initial.compile, args: ['-d', jarClasses, jarSource] }, root)
  await invoke({
    ...initial.compile, executable: join(dirname(initial.compile.executable), process.platform === 'win32' ? 'jar.exe' : 'jar'),
    args: ['cf', join(jarDirectory, 'local dependency.jar'), '-C', jarClasses, '.'],
  }, root)
  const plan = await prepareRun({ path, root, scratch: build, signal })
  assert.equal(plan.cwd, root)
  assert.equal(plan.compile?.args.at(-1), path)
  assert.ok(plan.compile?.args.includes('-proc:none'))
  await invoke(plan.compile!, root)
  const program = await plan.resolveRun!()
  assert.equal(program.args.at(-1), 'lesson.demo.Actual')
  assert.match((await invoke(program, root)).stdout, /^Hello 42\r?\n$/)
  assert.equal(basename(plan.toolchain), process.platform === 'win32' ? 'javac.exe' : 'javac')
})

test('invalid Java is compiled before the runner needs an entry-point decision', async (t) => {
  const directory = await scratch(t)
  const path = join(directory, 'Broken.java')
  const oldBuild = join(directory, 'previous run')
  const newBuild = join(directory, 'current run')
  await Promise.all([mkdir(oldBuild), mkdir(newBuild)])
  await writeFile(path, 'public class Broken { public static void main(String[] args) {} }\n')
  const previous = await prepareRun({ path, root: null, scratch: oldBuild, signal }).catch((error: unknown) => {
    if (error instanceof MissingToolchainError) return null
    throw error
  })
  if (!previous?.compile) return t.skip('A local JDK is needed')
  await invoke(previous.compile, directory)
  const staleProgram = await previous.resolveRun!()
  assert.ok((await stat(join(oldBuild, 'classes', 'Broken.class'))).isFile())

  await writeFile(path, 'public class Broken { public static void main(String[] args) { wrong } }\n')
  const plan = await prepareRun({ path, root: null, scratch: newBuild, signal })
  let attemptedLaunch = false
  const runner = new InteractiveRunner(join(directory, 'unavailable pty helper'))
  const result = await runner.run({
    ...plan,
    resolveRun: async () => {
      attemptedLaunch = true
      return staleProgram
    },
  }, () => {}, signal)
  assert.equal(result.status, 'compile-error')
  assert.match(result.compileOutput, /Broken\.java:1: error:/)
  assert.equal(attemptedLaunch, false)
  assert.equal(result.programOutput, '')
  await assert.rejects(plan.resolveRun!(), /No launchable main method/)
})
