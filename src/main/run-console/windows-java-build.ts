import { opendir, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'

function inside(root: string, path: string) {
  const fromRoot = relative(root, path)
  return fromRoot !== '..' && !fromRoot.startsWith('..' + sep) && !isAbsolute(fromRoot)
}

async function installedFile(home: string, path: string, workspace: string) {
  const file = await realpath(join(home, path)).catch(() => null)
  if (!file || !inside(home, file) || inside(workspace, file)) return null
  return (await stat(file).catch(() => null))?.isFile() ? file : null
}

async function matchingJar(home: string, directory: string, name: RegExp, workspace: string) {
  const canonical = await realpath(join(home, directory)).catch(() => null)
  if (!canonical || !inside(home, canonical) || inside(workspace, canonical)) return null
  const listing = await opendir(canonical).catch(() => null)
  if (!listing) return null
  let match: string | null = null
  let count = 0
  for await (const entry of listing) {
    if (++count > 512) return null
    if (!entry.isFile() || !name.test(entry.name)) continue
    if (match) return null
    match = entry.name
  }
  return match ? installedFile(home, join(directory, match), workspace) : null
}

type BuildLauncher = { path: string; args: string[] }

async function maven(home: string, workspace: string, project: string): Promise<BuildLauncher | null> {
  const [core, launcher, config] = await Promise.all([
    matchingJar(home, 'lib', /^maven-core-3\.9\.\d+\.jar$/, workspace),
    matchingJar(home, 'boot', /^plexus-classworlds-\d+(?:\.\d+)+\.jar$/, workspace),
    installedFile(home, join('bin', 'm2.conf'), workspace),
  ])
  if (!core || !launcher || !config) return null

  // Maven reads .mvn settings at the nearest Maven base, scoped to the
  // workspace. The launcher never runs mvn.cmd or any shell startup files.
  let base = project
  for (let directory = project; inside(workspace, directory); directory = dirname(directory)) {
    const configDirectory = await realpath(join(directory, '.mvn')).catch(() => null)
    if (configDirectory && inside(workspace, configDirectory)
      && (await stat(configDirectory).catch(() => null))?.isDirectory()) {
      base = directory
      break
    }
    if (directory === dirname(directory)) break
  }
  return {
    path: launcher,
    args: [
      '-classpath', launcher, '-Dclassworlds.conf=' + config, '-Dmaven.home=' + home,
      '-Dlibrary.jansi.path=' + join(home, 'lib', 'jansi-native'),
      '-Dmaven.multiModuleProjectDirectory=' + base, 'org.codehaus.plexus.classworlds.launcher.Launcher',
    ],
  }
}

async function gradle(home: string, workspace: string): Promise<BuildLauncher | null> {
  const cli = await matchingJar(home, 'lib', /^gradle-gradle-cli-main-(?:8\.\d{2,}|9\.\d+)(?:\.\d+)?\.jar$/, workspace)
  if (!cli) return null
  const version = basename(cli).slice('gradle-gradle-cli-main-'.length, -'.jar'.length)
  const agent = await installedFile(home, join('lib', 'agents', 'gradle-instrumentation-agent-' + version + '.jar'), workspace)
  if (!agent) return null
  return {
    path: cli,
    args: ['-Xms64m', '-Xmx64m', '-javaagent:' + agent, '-Dorg.gradle.appname=gradle', '-jar', cli],
  }
}

export async function installedWindowsJavaBuild(
  kind: 'maven' | 'gradle',
  workspace: string,
  project: string,
  paths: string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<BuildLauncher | null> {
  const homes = kind === 'maven' ? [environment.MAVEN_HOME, environment.M2_HOME] : [environment.GRADLE_HOME]
  const candidates = new Set([...homes, ...paths.filter((path) => basename(path).toLowerCase() === 'bin').map(dirname)])
  for (const candidate of candidates) {
    if (!candidate || !isAbsolute(candidate) || inside(workspace, candidate)) continue
    const home = await realpath(candidate).catch(() => null)
    if (!home || inside(workspace, home)) continue
    const script = kind === 'maven' ? 'mvn.cmd' : 'gradle.bat'
    if (!await installedFile(home, join('bin', script), workspace)) continue
    const launcher = kind === 'maven' ? await maven(home, workspace, project) : await gradle(home, workspace)
    if (launcher) return launcher
  }
  return null
}

export async function windowsJdkHomes() {
  const programs = process.env.ProgramW6432 ?? process.env.ProgramFiles
  if (!programs || !isAbsolute(programs)) return []
  const candidates: string[] = []
  for (const vendor of ['Java', 'Eclipse Adoptium', 'Microsoft', 'Amazon Corretto']) {
    const vendorHome = join(programs, vendor)
    const listing = await opendir(vendorHome).catch(() => null)
    if (!listing) continue
    const versions: string[] = []
    let count = 0
    for await (const entry of listing) {
      if (++count > 128) break
      if (entry.isDirectory() && /^(?:jdk[-_]?|amazon-corretto-)[0-9]/i.test(entry.name)) versions.push(entry.name)
    }
    versions.sort((left, right) => right.localeCompare(left, 'en', { numeric: true }))
    candidates.push(...versions.map((version) => join(vendorHome, version)))
  }
  return candidates
}
