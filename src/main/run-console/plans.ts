import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, mkdir, open, opendir, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { runLanguage, type RunLanguage } from '../../shared/run-console'
import { compilerSetupMessage, detectCompiler, execute, findWindowsCompiler } from '../runner'
import { windowsEnvironment, workspaceSafeWindowsToolPaths } from '../windows-process'
import { findMainClass } from './java-classes'
import type { NativeProject } from './project-build'
import { installedWindowsJavaBuild, windowsJdkHomes } from './windows-java-build'
import type { RunTrace } from './trace'

export interface CommandPlan {
  executable: string
  args: string[]
  cwd?: string
  timeoutMs?: number
  environment?: NodeJS.ProcessEnv
  input?: string
}

export interface RunPlan {
  language: RunLanguage
  cwd: string
  compile?: CommandPlan
  run: CommandPlan
  resolveRun?: () => Promise<CommandPlan>
  label: string
  toolchain: string
  build?: 'maven' | 'gradle'
}

export class MissingToolchainError extends Error {}

const systemPath = ['/usr/bin', '/bin', '/usr/sbin', '/sbin']
const installedPaths = ['/opt/homebrew/bin', '/usr/local/bin']
const windows = process.platform === 'win32'
const nativeExecutable = (name: string) => windows ? name + '.exe' : name
const maxSourceBytes = 2 * 1024 * 1024
const maxMetadataBytes = 512 * 1024
const maxClassPathBytes = 64 * 1024

function inside(root: string, path: string) {
  const relation = relative(root, path)
  return relation !== '..' && !relation.startsWith('..' + sep) && !isAbsolute(relation)
}

export async function commandPaths(root: string): Promise<string[]> {
  if (windows) return workspaceSafeWindowsToolPaths(root)
  const candidates = [...installedPaths, ...(process.env.PATH ?? '').split(delimiter), ...systemPath]
  const directories = [...new Set(candidates)]
    .filter((directory) => isAbsolute(directory) && !inside(root, directory)).slice(0, 80)
  const checked = await Promise.all(directories.map(async (directory) => {
    const canonical = await realpath(directory).catch(() => null)
    return canonical && !inside(root, canonical) ? directory : null
  }))
  return checked.filter((directory) => directory !== null)
}

export async function executable(path: string, root: string): Promise<boolean> {
  try {
    if (!isAbsolute(path) || inside(root, path) || inside(root, await realpath(path))) return false
    await access(path, constants.X_OK)
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function onPath(name: string, root: string, paths: string[], exclude: string[] = []): Promise<string | null> {
  for (const directory of paths) {
    const candidate = join(directory, nativeExecutable(name))
    if (!exclude.includes(candidate) && await executable(candidate, root)) return candidate
  }
  return null
}

async function readText(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stats = await handle.stat()
    if (!stats.isFile() || stats.size > maxBytes) throw new Error(`${basename(path)} exceeds the runner's file limit.`)
    const bytes = Buffer.allocUnsafe(stats.size + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset > stats.size) throw new Error(`${basename(path)} changed while the runner was preparing.`)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset))
  } finally {
    await handle.close()
  }
}

async function fileExists(path: string) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export function envFor(paths: string[], scratch: string): NodeJS.ProcessEnv {
  if (windows) return windowsEnvironment(paths, scratch)
  return {
    PATH: paths.join(delimiter),
    HOME: homedir(),
    TMPDIR: scratch,
    LANG: 'en_US.UTF-8',
    TERM: 'xterm-256color',
  }
}

async function javaToolchain(root: string, paths: string[], scratch: string, signal: AbortSignal) {
  const envHome = process.env.JAVA_HOME
  const fromHome = async (home: string) => {
    if (inside(root, home)) return
    const canonical = await realpath(home).catch(() => null)
    if (!canonical || inside(root, canonical)) return
    const javac = join(canonical, 'bin', nativeExecutable('javac'))
    const java = join(canonical, 'bin', nativeExecutable('java'))
    if (await executable(javac, root) && await executable(java, root)) return { java, javac, home: canonical }
  }
  if (envHome && isAbsolute(envHome)) {
    const tools = await fromHome(envHome)
    if (tools) return tools
  }
  if (process.platform === 'darwin') {
    const selected = await execute('/usr/libexec/java_home', ['-F'], {
      cwd: '/', input: '', signal, timeoutMs: 2000, budget: { remaining: 4096 },
      environment: envFor(systemPath, scratch),
    })
    const home = selected.output.trim()
    if (selected.exitCode === 0 && isAbsolute(home)) {
      const tools = await fromHome(home)
      if (tools) return tools
    }
  }
  const javac = await onPath('javac', root, paths, process.platform === 'darwin' ? ['/usr/bin/javac'] : [])
  if (javac) {
    const canonical = await realpath(javac)
    const java = join(dirname(canonical), nativeExecutable('java'))
    if (await executable(java, root)) return { java, javac: canonical, home: dirname(dirname(canonical)) }
  }
  if (windows) {
    for (const home of await windowsJdkHomes()) {
      signal.throwIfAborted()
      const tools = await fromHome(home)
      if (tools) return tools
    }
  }
  throw new MissingToolchainError('A local Java JDK is required. Install a JDK containing both javac and java, then reopen Ion.')
}

export async function javaToolsFor(root: string, scratch: string, signal: AbortSignal) {
  const paths = await commandPaths(root)
  return { ...await javaToolchain(root, paths, scratch, signal), environment: envFor(paths, scratch) }
}

const identifier = '[$_\\p{ID_Start}][$\\p{ID_Continue}]*'
const packageStatement = new RegExp('(?:^|[^$\\p{ID_Continue}])package\\s+(' + identifier
  + '(?:\\s*\\.\\s*' + identifier + ')*)\\s*;', 'u')

function packageOf(source: string) {
  // Mask comments, ordinary literals and text blocks without touching package
  // components or needing a parser for the remainder of the Java source.
  let cleaned = ''
  let start = 0
  let index = 0
  while (index < source.length) {
    const character = source[index]
    const block = source.startsWith('/*', index)
    const line = source.startsWith('//', index)
    const quote = character === '"' || character === "'"
    if (!block && !line && !quote) { index++; continue }
    cleaned += source.slice(start, index) + ' '
    if (block) {
      const end = source.indexOf('*/', index + 2)
      index = end < 0 ? source.length : end + 2
    } else if (line) {
      index += 2
      while (index < source.length && source[index] !== '\n' && source[index] !== '\r') index++
    } else {
      const terminator = source.startsWith('"""', index) ? '"""' : character
      index += terminator.length
      while (index < source.length) {
        if (source[index] === '\\') { index += 2; continue }
        if (source.startsWith(terminator, index)) { index += terminator.length; break }
        if (terminator.length === 1 && (source[index] === '\n' || source[index] === '\r')) break
        index++
      }
    }
    start = index
  }
  return packageStatement.exec(cleaned + source.slice(start))?.[1].replace(/\s/g, '') ?? ''
}

function sourceRoot(path: string, packageName: string) {
  let directory = dirname(path)
  for (const component of packageName.split('.').filter(Boolean).reverse()) {
    if (basename(directory) !== component) return dirname(path)
    directory = dirname(directory)
  }
  return directory
}

async function jarPaths(directories: string[]) {
  const jars = new Set<string>()
  for (const directory of new Set(directories)) {
    const library = join(directory, 'lib')
    const entries = await opendir(library).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null
      throw error
    })
    if (!entries) continue
    let visited = 0
    for await (const entry of entries) {
      if (++visited > 1024 || jars.size >= 128) throw new Error('The Java lib folders exceed the runner’s dependency limit.')
      if (entry.isFile() && extname(entry.name).toLowerCase() === '.jar') jars.add(join(library, entry.name))
    }
  }
  return [...jars].sort()
}

function classpath(entries: string[]) {
  if (entries.some((entry) => entry.includes(delimiter))) throw new Error('A Java classpath entry contains the classpath separator.')
  const result = [...new Set(entries)].join(delimiter)
  // Windows CreateProcess has a 32,767 UTF-16 code unit limit for the whole command line.
  if (Buffer.byteLength(result) > maxClassPathBytes || (windows && result.length > 24_000)) {
    throw new Error('The Java runtime classpath is too large for Ion Run. Use the project’s own build tool for this configuration.')
  }
  return result
}

function outputEntries(source: string) {
  const entries = source.trim().split(delimiter).filter(Boolean)
  if (entries.length > 1024 || entries.some((entry) => !isAbsolute(entry) || entry.includes('\0'))) {
    throw new Error('The build returned an invalid Java runtime classpath.')
  }
  return entries
}

type JavaProject = { build: 'maven' | 'gradle'; cwd: string; marker: string }

async function findJavaProject(path: string, root: string | null): Promise<JavaProject | undefined> {
  let directory = dirname(path)
  const boundary = root ?? directory
  for (let visited = 0; visited < 64 && inside(boundary, directory); visited++) {
    for (const name of ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
      const marker = join(directory, name)
      if (await fileExists(marker)) return { build: name === 'pom.xml' ? 'maven' : 'gradle', cwd: directory, marker }
    }
    if (directory === boundary || directory === dirname(directory)) return
    directory = dirname(directory)
  }
}

async function mavenPaths(project: JavaProject) {
  const xml = await readText(project.marker, maxMetadataBytes)
  if (/<!DOCTYPE/i.test(xml)) throw new Error('Maven projects with a DOCTYPE are unsupported.')
  const { parser } = await import('sax')
  const options = { xmlns: false, strictEntities: true }
  const xmlParser = parser(true, options)
  const tags: string[] = []
  const fields = new Map<string, string>()
  let dependencies = false
  xmlParser.onopentag = (tag) => {
    if (tags.length >= 128) throw new Error('The Maven project configuration is too deeply nested.')
    const name = tag.name.split(':').at(-1)!
    if (name === 'parent' || name === 'dependency') dependencies = true
    tags.push(name)
  }
  xmlParser.onclosetag = () => { tags.pop() }
  xmlParser.ontext = (text) => {
    if (tags.length !== 3 || tags[0] !== 'project' || tags[1] !== 'build') return
    const key = tags[2]
    if (key === 'directory' || key === 'sourceDirectory' || key === 'outputDirectory') {
      fields.set(key, (fields.get(key) ?? '') + text)
    }
  }
  xmlParser.write(xml).close()
  const base = (value: string) => value.replace(/\$\{(?:project\.)?basedir\}/g, project.cwd)
  const build = resolve(project.cwd, base(fields.get('directory')?.trim() || 'target'))
  const local = (value: string) => {
    const path = resolve(project.cwd, base(value).replace(/\$\{project\.build\.directory\}/g, build))
    if (!inside(project.cwd, path) || path.includes('${')) throw new Error('This Maven project uses a source or output path that Ion cannot resolve.')
    return path
  }
  return {
    sourceDirectory: local(fields.get('sourceDirectory')?.trim() || 'src/main/java'),
    classes: local(fields.get('outputDirectory')?.trim() || join(build, 'classes')),
    dependencies,
  }
}

async function cachedGradle(project: JavaProject, root: string): Promise<string | null> {
  let directory = project.cwd
  for (let visited = 0; visited < 64 && inside(root, directory); visited++) {
    const wrapper = join(directory, 'gradle', 'wrapper', 'gradle-wrapper.properties')
    if (await fileExists(wrapper)) {
      const properties = await readText(wrapper, 8192)
      if ((properties.match(/^\s*distributionUrl\s*=/gm) ?? []).length !== 1) return null
      const match = /^\s*distributionUrl\s*=\s*https\\?:\/\/services\.gradle\.org\/distributions\/(gradle-[0-9][\w.-]{0,48}-(?:bin|all))\.zip\s*$/m.exec(properties)
      if (!match) return null
      const distribution = match[1]
      const versionFolder = distribution.replace(/-(bin|all)$/, '')
      const cache = process.env.GRADLE_USER_HOME && isAbsolute(process.env.GRADLE_USER_HOME)
        ? process.env.GRADLE_USER_HOME : join(homedir(), '.gradle')
      // Gradle uses this URL hash as a cache directory name. Its own install
      // marker is required so we never run a partially extracted distribution.
      const url = 'https://services.gradle.org/distributions/' + distribution + '.zip'
      const cacheKey = BigInt('0x' + createHash('md5').update(url).digest('hex')).toString(36)
      const distributionHome = join(cache, 'wrapper', 'dists', distribution, cacheKey)
      const candidate = join(distributionHome, versionFolder, 'bin', 'gradle')
      return await fileExists(join(distributionHome, distribution + '.zip.ok')) && await executable(candidate, root)
        ? candidate : null
    }
    if (directory === root || directory === dirname(directory)) break
    directory = dirname(directory)
  }
  return null
}

const gradleInit = `gradle.projectsEvaluated {
    def runDirectory = new File(System.getProperty('ion.run.directory')).canonicalFile
    def runSource = new File(System.getProperty('ion.run.source')).canonicalFile
    def project = gradle.rootProject.allprojects.find { it.projectDir.canonicalFile == runDirectory }
    def main = project?.extensions?.findByName('sourceSets')?.findByName('main')
    if (main == null || !main.allJava.files.any { it.canonicalFile == runSource }) {
        throw new GradleException('The active file is not in this Gradle project’s main Java source set.')
    }
    project.tasks.register('ionPrepareRunClasspath') {
        dependsOn(main.classesTaskName)
        doLast {
            new File(System.getProperty('ion.run.classpath')).setText(main.runtimeClasspath.asPath, 'UTF-8')
            new File(System.getProperty('ion.run.classes')).setText(main.output.classesDirs.asPath, 'UTF-8')
        }
    }
}
`

interface PrepareOptions {
  path: string
  root: string | null
  scratch: string
  signal: AbortSignal
  nativeProject?: NativeProject
  trace?: RunTrace
}

async function prepareJava(options: PrepareOptions, paths: string[], environment: NodeJS.ProcessEnv): Promise<RunPlan> {
  const { path, root, scratch, signal } = options
  const boundary = root ?? dirname(path)
  const tools = await javaToolchain(boundary, paths, scratch, signal)
  signal.throwIfAborted()
  const source = await readText(path, maxSourceBytes)
  const packageName = packageOf(source)
  const sources = sourceRoot(path, packageName)
  const project = await findJavaProject(path, root)
  const cwd = project?.cwd ?? root ?? sources
  const label = 'Java · ' + basename(path)
  const javaEnv = { ...environment, JAVA_HOME: tools.home }
  const java = (classes: string[], main: string): CommandPlan => ({
    executable: tools.java,
    args: ['-Djava.io.tmpdir=' + scratch, '-classpath', classpath(classes), main],
    environment: javaEnv,
  })
  const filenameClass = [packageName, basename(path, '.java')].filter(Boolean).join('.')
  const launch = (classes: string[], dependencies: string[], verifyFresh = false) => async () => {
    const main = await findMainClass(path, packageName, classes, signal, verifyFresh)
    return java([...classes, ...dependencies], main)
  }
  const base = { language: 'java' as const, cwd, label }
  if (project?.build === 'maven') {
    const launcher = windows ? await installedWindowsJavaBuild('maven', boundary, cwd, paths) : null
    const mvn = launcher?.path ?? (windows ? null : await onPath('mvn', boundary, paths))
    if (!mvn) throw new MissingToolchainError(windows
      ? 'Install Apache Maven 3.9 locally and set MAVEN_HOME, M2_HOME, or add its bin folder to PATH. Prepare its plugins and dependencies in the local cache.'
      : 'This project uses Maven. Install Maven locally and make its plugins and dependencies available in the local cache.')
    const { sourceDirectory, classes, dependencies } = await mavenPaths(project)
    if (!inside(sourceDirectory, path)) throw new Error('The active file is outside this Maven project’s main Java source directory.')
    const runtime = join(scratch, 'maven-classpath')
    return {
      ...base, build: 'maven', toolchain: mvn,
      compile: {
        executable: launcher ? tools.java : mvn, timeoutMs: 120_000, environment: javaEnv,
        args: [...(launcher?.args ?? []), '--offline', '--batch-mode', '--no-transfer-progress', '-Dstyle.color=never',
          '-f', project.marker, 'compile', ...(dependencies ? ['dependency:build-classpath', '-DincludeScope=runtime',
            '-DoutputEncoding=UTF-8', '-Dmdep.outputFile=' + runtime] : [])],
      },
      run: java([classes], filenameClass),
      resolveRun: async () => launch([classes], dependencies ? outputEntries(await readText(runtime, maxClassPathBytes)) : [], true)(),
    }
  }
  if (project?.build === 'gradle') {
    const launcher = windows ? await installedWindowsJavaBuild('gradle', boundary, cwd, paths) : null
    const gradle = launcher?.path ?? (windows ? null : await cachedGradle(project, boundary) ?? await onPath('gradle', boundary, paths))
    if (!gradle) throw new MissingToolchainError(windows
      ? 'Install Gradle 8.10–8.x or 9.x locally and set GRADLE_HOME or add its bin folder to PATH. Prepare its plugins and dependencies in the local cache.'
      : 'This project uses Gradle. Install Gradle or prepare its declared Gradle wrapper distribution and dependencies in the local cache.')
    const runtime = join(scratch, 'gradle-classpath')
    const classes = join(scratch, 'gradle-classes')
    const init = join(scratch, 'ion-run.gradle')
    await writeFile(init, gradleInit, { mode: 0o600, flag: 'wx' })
    const buildEnv = { ...javaEnv, ...(process.env.GRADLE_USER_HOME && isAbsolute(process.env.GRADLE_USER_HOME)
      ? { GRADLE_USER_HOME: process.env.GRADLE_USER_HOME } : {}) }
    return {
      ...base, build: 'gradle', toolchain: gradle,
      compile: {
        executable: launcher ? tools.java : gradle, timeoutMs: 120_000, environment: buildEnv,
        args: [...(launcher?.args ?? []), '--offline', '--no-daemon', '--no-build-cache', '--console=plain', '--max-workers=2',
          ...(windows ? ['--no-watch-fs', '--no-configuration-cache'] : []),
          '-Porg.gradle.java.installations.auto-download=false', '--project-dir', cwd, '--init-script', init,
          '-Dion.run.directory=' + cwd, '-Dion.run.source=' + path, '-Dion.run.classpath=' + runtime,
          '-Dion.run.classes=' + classes, 'ionPrepareRunClasspath'],
      },
      run: java([scratch], filenameClass),
      resolveRun: async () => launch(outputEntries(await readText(classes, maxClassPathBytes)),
        outputEntries(await readText(runtime, maxClassPathBytes)), true)(),
    }
  }

  const classes = join(scratch, 'classes')
  await mkdir(classes, { mode: 0o700 })
  const libraries = await jarPaths([cwd, sources, dirname(path)])
  return {
    ...base, toolchain: tools.javac,
    compile: {
      executable: tools.javac, environment: javaEnv,
      args: ['-encoding', 'UTF-8', '-proc:none', '-d', classes, '-classpath', classpath([classes, ...libraries]),
        '-sourcepath', classpath([sources]), path],
    },
    run: java([classes, ...libraries], filenameClass),
    resolveRun: launch([classes], libraries),
  }
}

export async function prepareRun(options: PrepareOptions): Promise<RunPlan> {
  const { path, root, scratch, signal, trace } = options
  const language = runLanguage(basename(path))
  if (!language) throw new Error('Open a C, C++, Java, Python, or JavaScript source file to run it.')
  signal.throwIfAborted()
  const cwd = root && inside(root, path) ? root : dirname(path)
  trace?.('tool-paths', 'start')
  const paths = await commandPaths(cwd)
  trace?.('tool-paths', 'end', paths.length)
  const environment = envFor(paths, scratch)
  const label = basename(path)
  if (language === 'java') return prepareJava({ ...options, root: root && inside(root, path) ? root : null }, paths, environment)
  if (language === 'c' || language === 'cpp') {
    const project = options.nativeProject
    let executablePath: string | null
    trace?.('compiler-discovery', 'start')
    if (windows) {
      executablePath = await findWindowsCompiler(paths, cwd, language === 'cpp')
    } else {
      const compiler = await detectCompiler(signal)
      const cpp = compiler?.replace(/(?:clang|gcc)(?=-\d+$|$)/, (name) => name === 'clang' ? 'clang++' : 'g++')
      executablePath = language === 'cpp' ? (cpp && await executable(cpp, cwd) ? cpp : null) : compiler
    }
    trace?.('compiler-discovery', 'end', !!executablePath)
    signal.throwIfAborted()
    if (!executablePath) throw new MissingToolchainError(compilerSetupMessage(language === 'cpp' ? 'C++' : 'C'))
    const program = join(scratch, nativeExecutable('program'))
    return {
      language, cwd, label, toolchain: executablePath,
      compile: {
        executable: executablePath, environment,
        args: ['-x', language === 'cpp' ? 'c++' : 'c', language === 'cpp' ? '-std=c++17' : '-std=c17',
          '-Wall', '-Wextra', '-fdiagnostics-color=never',
          ...(project?.includeDirectories.flatMap((directory) => ['-I', directory]) ?? []),
          ...(project?.sources ?? [path]), '-o', program],
      },
      run: { executable: program, args: [], environment },
    }
  }
  if (language === 'python') {
    const framework = '/Library/Frameworks/Python.framework/Versions/Current/bin/python3'
    let python = await onPath('python3', cwd, paths, process.platform === 'darwin' ? ['/usr/bin/python3'] : [])
      ?? (await executable(framework, cwd) ? framework : null)
    if (!python && windows) python = await onPath('python', cwd, paths)
    if (!python && process.platform === 'darwin' && await detectCompiler(signal) === '/usr/bin/clang'
      && await executable('/usr/bin/python3', cwd)) python = '/usr/bin/python3'
    if (!python) throw new MissingToolchainError('A local Python 3 interpreter is required. Install Python 3 and reopen Ion.')
    const pythonEnvironment = windows ? { ...environment, PYTHONIOENCODING: 'utf-8' } : environment
    return {
      language, cwd, label, toolchain: python,
      run: { executable: python, args: ['-u', path], environment: pythonEnvironment },
    }
  }
  const node = await onPath('node', cwd, paths)
  if (!node) throw new MissingToolchainError('A local Node.js runtime is required. Install Node.js and reopen Ion.')
  return { language, cwd, label, toolchain: node, run: { executable: node, args: [path], environment } }
}
