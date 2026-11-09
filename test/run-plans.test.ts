import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'
import { MissingToolchainError, prepareRun, type CommandPlan } from '../src/main/run-console/plans'
import { InteractiveRunner } from '../src/main/run-console/engine'
import { installedWindowsJavaBuild } from '../src/main/run-console/windows-java-build'
import { runLanguage } from '../src/shared/run-console'

const execute = promisify(execFile)
const signal = new AbortController().signal

async function scratch(t: { after(callback: () => Promise<void>): void }) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'ion plans '))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 3 }))
  return directory
}

function invoke(command: CommandPlan, cwd: string) {
  return execute(command.executable, command.args, {
    cwd: command.cwd ?? cwd, env: command.environment, timeout: command.timeoutMs ?? 20_000, maxBuffer: 256 * 1024,
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
  const root = join(directory, 'Café & project')
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

const mavenFixture = `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.ionide.test</groupId><artifactId>native-java</artifactId><version>1</version>
  <properties><maven.compiler.release>17</maven.compiler.release><project.build.sourceEncoding>UTF-8</project.build.sourceEncoding></properties>
  <dependencies><dependency>
    <groupId>org.apache.commons</groupId><artifactId>commons-lang3</artifactId><version>3.17.0</version>
  </dependency></dependencies>
  <build><plugins>
    <plugin><artifactId>maven-compiler-plugin</artifactId><version>3.13.0</version></plugin>
    <plugin><artifactId>maven-resources-plugin</artifactId><version>3.3.1</version></plugin>
    <plugin><artifactId>maven-dependency-plugin</artifactId><version>3.8.1</version></plugin>
  </plugins></build>
</project>`

const liveJavaBuilds = process.platform === 'win32' && process.env.ION_TEST_WINDOWS_JAVA_BUILDS === '1'
const verifyLaunchers = process.platform !== 'win32' && process.env.ION_TEST_JAVA_LAUNCHERS === '1'

test('installed Maven and Gradle JVM launchers compile a project and run its real entry point offline',
  { skip: !liveJavaBuilds && !verifyLaunchers }, async (t) => {
    const directory = await scratch(t)
    for (const build of ['maven', 'gradle'] as const) {
      await t.test(build, async () => {
        const root = join(directory, `Café & ${build} project`)
        const packageDirectory = join(root, 'src', 'main', 'java', 'demo')
        const path = join(packageDirectory, 'Entry.java')
        const buildScratch = join(directory, build + ' output')
        await Promise.all([mkdir(packageDirectory, { recursive: true }), mkdir(buildScratch)])
        await Promise.all([
          writeFile(path, `package demo;
class Entry {}
class Actual {
  public static void main(String[] args) {
    System.out.println("ION-JAVA-PROMPT");
    System.out.println(Helper.answer(new java.util.Scanner(System.in).nextLine()));
  }
}`),
          writeFile(join(packageDirectory, 'Helper.java'), `package demo;
class Helper {
  static String answer(String input) {
    return "ION-JAVA-RESULT:" + ${build === 'maven'
      ? 'org.apache.commons.lang3.StringUtils.reverse(input)' : 'new StringBuilder(input).reverse().toString()'};
  }
}`),
          ...(build === 'maven'
            ? [writeFile(join(root, 'pom.xml'), mavenFixture), writeFile(join(root, 'mvnw.cmd'), '@exit /b 91')]
            : [writeFile(join(root, 'build.gradle'), "plugins { id 'java' }\n"),
              writeFile(join(root, 'settings.gradle'), "rootProject.name = 'ion-native-java'\n"),
              writeFile(join(root, 'gradlew.bat'), '@exit /b 92')]),
        ])
        const plan = await prepareRun({ path, root, scratch: buildScratch, signal })
        assert.equal(plan.build, build)
        let command = plan.compile!
        if (verifyLaunchers) {
          // The same installed Java launchers can be exercised on POSIX without
          // pretending that a Windows process or path API was tested there.
          const launcher = await installedWindowsJavaBuild(build, root, root, [])
          assert.ok(launcher)
          command = { ...command, executable: plan.run.executable, args: [...launcher.args, ...command.args] }
        } else assert.equal(basename(command.executable), 'java.exe')
        assert.ok(command.args.includes('--offline'))
        if (build === 'gradle') assert.ok(command.args.includes('-Porg.gradle.java.installations.auto-download=false'))
        if (build === 'maven' && process.env.ION_TEST_PRIME_MAVEN === '1') {
          // CI may populate Maven's cache for this generated, pinned fixture. The
          // build below still executes with --offline, using a disposable cache.
          command = { ...command, args: [...command.args, '-Dmaven.repo.local=' + join(directory, 'Maven cache')] }
          await assert.rejects(invoke(command, root), (error: unknown) => {
            const failure = error as { code?: unknown; stdout?: unknown; stderr?: unknown }
            return failure.code === 1 && /offline mode/i.test(String(failure.stdout) + String(failure.stderr))
          }, 'An empty Maven cache must fail explicitly in offline mode.')
          await invoke({ ...command, args: command.args.filter((argument) => argument !== '--offline') }, root)
        }
        await invoke(command, root)
        const program = await plan.resolveRun!()
        assert.equal(program.args.at(-1), 'demo.Actual')
        const launched = invoke(program, root)
        let stdout = ''
        launched.child.stdout?.on('data', (chunk) => {
          if (launched.child.stdin?.writableEnded) return
          stdout += String(chunk)
          if (stdout.includes('ION-JAVA-PROMPT')) launched.child.stdin?.end('ion\n')
        })
        assert.match((await launched).stdout, /^ION-JAVA-PROMPT\r?\nION-JAVA-RESULT:noi\r?\n$/)
      })
    }
  })
