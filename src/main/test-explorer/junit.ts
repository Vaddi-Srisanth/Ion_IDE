import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, open, realpath, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { isWithin, revision } from '../files'
import { commandPaths, envFor, onPath } from '../run-console/plans'
import { junitHelper } from './junit-helper'
import { relativeTestPath, testLimits, validateSelector } from './model'
import { safeTool, type TestPlan } from './pytest'

const standaloneSha256 = '3fdfc37e29744a9a67dd5365e81467e26fbde0b7aa204e6f8bbe79eeaa7ae892'
const installJar = 'Set ION_JUNIT_PLATFORM_JAR to the installed JUnit Platform Console Standalone 1.13.4 jar outside every workspace.'

async function installedJdk(root: string, roots: readonly string[], paths: string[]) {
  const java = process.platform === 'win32' ? 'java.exe' : 'java'
  const javac = process.platform === 'win32' ? 'javac.exe' : 'javac'
  const home = process.env.JAVA_HOME
  const fromPath = await onPath('java', root, paths, process.platform === 'darwin' ? ['/usr/bin/java'] : [])
  const candidates = [home && isAbsolute(home) ? join(home, 'bin', java) : undefined, fromPath]
  for (const tool of candidates) {
    if (!tool || !await safeTool(tool, roots)) continue
    const canonical = await realpath(tool)
    if (await safeTool(join(dirname(canonical), javac), roots)) return canonical
  }
  throw new Error('Install a JDK 17 or newer outside all workspaces and set JAVA_HOME to its home directory.')
}

// Read only the bounded, opened regular file. A source revision also binds the
// bytes to the service's workspace inspection before its native review.
async function reviewedBytes(path: string, limit: number, expected?: string) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const info = await handle.stat({ bigint: true })
    if (!info.isFile() || info.size > BigInt(limit) || (expected && revision(info) !== expected) || await realpath(path) !== path) {
      throw new Error('JUnit input changed or exceeded its inspection limit. Review again.')
    }
    const bytes = Buffer.alloc(Number(info.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== Number(info.size) || revision(await handle.stat({ bigint: true })) !== revision(info) || await realpath(path) !== path) {
      throw new Error('JUnit input changed while reading. Review again.')
    }
    return bytes.subarray(0, offset)
  } finally { await handle.close() }
}

// Pin exactly the bytes used by source-file launch. The installed jar can move or
// change after review without substituting a different launcher for this operation.
async function stageJar(scratch: string, roots: readonly string[]) {
  const chosen = process.env.ION_JUNIT_PLATFORM_JAR
  if (!chosen || !isAbsolute(chosen) || roots.some(root => isWithin(root, chosen))) throw new Error(installJar)
  const canonical = await realpath(chosen).catch(() => null)
  if (!canonical || roots.some(root => isWithin(root, canonical))) throw new Error(installJar)
  const data = await reviewedBytes(canonical, 8 * 1024 * 1024)
  if (createHash('sha256').update(data).digest('hex') !== standaloneSha256) throw new Error('Unrecognized JUnit Platform jar. ' + installJar)
  const staged = join(scratch, 'junit-platform-console-standalone-1.13.4.jar')
  await writeFile(staged, data, { flag: 'wx', mode: 0o600 })
  return { installed: canonical, staged }
}

async function stageJavaSources(root: string, target: string, sources: Readonly<Record<string, string>>) {
  const java = Object.keys(sources).filter(path => path.endsWith('.java'))
  const conventional = java.filter(path => path.startsWith('src/main/java/') || path.startsWith('src/test/java/'))
  const paths = conventional.length ? conventional : java.filter(path => !path.includes('/'))
  if (paths.length > testLimits.sources) throw new Error('Too many saved Java sources.')
  await mkdir(target)
  let bytes = 0
  for (const relative of paths) {
    const parts = relativeTestPath(relative).split('/')
    const data = await reviewedBytes(join(root, ...parts), testLimits.sourceBytes - bytes, sources[relative])
    bytes += data.length
    const copy = join(target, ...parts)
    await mkdir(dirname(copy), { recursive: true })
    await writeFile(copy, data, { mode: 0o600, flag: 'wx' })
  }
}

export async function prepareJunit(root: string, roots: readonly string[], scratch: string, operation: 'discover' | 'run', selectors: string[]): Promise<TestPlan> {
  if (selectors.length > testLimits.cases || (operation === 'run') !== (selectors.length > 0) || new Set(selectors).size !== selectors.length) {
    throw new Error('Choose distinct discovered JUnit tests to run.')
  }
  for (const value of selectors) {
    const selector = validateSelector(value)
    if (!/^[^:]+\.java::\[engine:junit-jupiter\]\//.test(selector)) throw new Error('Invalid JUnit selection. Discover the tests again.')
  }
  const paths = (await commandPaths(root)).filter(path => roots.every(other => !isWithin(other, path)))
  const executable = await installedJdk(root, roots, paths)
  const jar = await stageJar(scratch, roots)
  const helper = join(scratch, 'IonJUnit.java'), request = join(scratch, 'selectors.txt'), report = join(scratch, 'report.json')
  const classes = join(scratch, 'classes'), sources = join(scratch, 'sources')
  if (scratch.includes(delimiter)) throw new Error('The temporary directory contains a Java classpath separator.')
  await mkdir(classes)
  await writeFile(helper, junitHelper, { mode: 0o600, flag: 'wx' })
  await writeFile(request, selectors.join('\n'), { mode: 0o600, flag: 'wx' })
  return { executable, args: ['-Xmx256m', '-Djava.io.tmpdir=' + scratch, '--class-path', [jar.staged, classes].join(delimiter),
    '--source', '17', helper, operation, sources, classes, jar.staged, request, report], cwd: root, environment: envFor(paths, scratch),
    stageSources: reviewed => stageJavaSources(root, sources, reviewed),
    timeoutMs: operation === 'discover' ? testLimits.discoveryMs : testLimits.runMs, operation, report,
    warning: 'JUnit Jupiter 5.13.4 uses ' + jar.installed + '. Ion compiles saved Java sources in src/main/java and src/test/java (or .java files at the workspace root) in a private directory using the JDK and standalone JUnit classpath. Discovery loads project classes. Tests and extensions run with your account permissions, including file and network access. Parameterized tests and factories run as a whole method.' }
}
