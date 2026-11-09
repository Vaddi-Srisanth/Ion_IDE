import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { installedWindowsJavaBuild } from '../src/main/run-console/windows-java-build'

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'ion java install '))
  const workspace = join(root, 'workspace')
  const project = join(workspace, 'Café & project')
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3 }))
  await mkdir(join(workspace, '.mvn'), { recursive: true })
  await mkdir(project)
  const installation = async (home: string, files: string[]) => {
    for (const file of files) {
      const path = join(home, file)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, 'fixture only')
    }
    return realpath(home)
  }
  return { root, workspace, project, installation }
}

const mavenFiles = ['bin/mvn.cmd', 'bin/m2.conf', 'boot/plexus-classworlds-2.9.0.jar', 'lib/maven-core-3.9.11.jar']
const gradleFiles = ['bin/gradle.bat', 'lib/gradle-gradle-cli-main-9.4.1.jar', 'lib/agents/gradle-instrumentation-agent-9.4.1.jar']

test('Windows Maven and Gradle use installed JVM launchers and preserve each path as one argument', async (t) => {
  const { root, workspace, project, installation } = await fixture(t)
  const maven = await installation(join(root, 'Café & Maven install'), mavenFiles)
  const gradle = await installation(join(root, 'Café % Gradle install'), gradleFiles)
  const mavenJar = join(maven, 'boot', 'plexus-classworlds-2.9.0.jar')
  assert.deepEqual(await installedWindowsJavaBuild('maven', workspace, project, [], { MAVEN_HOME: maven }), {
    path: mavenJar, args: [
      '-classpath', mavenJar, '-Dclassworlds.conf=' + join(maven, 'bin', 'm2.conf'), '-Dmaven.home=' + maven,
      '-Dlibrary.jansi.path=' + join(maven, 'lib', 'jansi-native'), '-Dmaven.multiModuleProjectDirectory=' + workspace,
      'org.codehaus.plexus.classworlds.launcher.Launcher',
    ],
  })
  const gradleJar = join(gradle, 'lib', 'gradle-gradle-cli-main-9.4.1.jar')
  assert.deepEqual(await installedWindowsJavaBuild('gradle', workspace, project, [join(gradle, 'bin')], {}), {
    path: gradleJar, args: ['-Xms64m', '-Xmx64m', '-javaagent:' + join(gradle, 'lib', 'agents', 'gradle-instrumentation-agent-9.4.1.jar'),
      '-Dorg.gradle.appname=gradle', '-jar', gradleJar],
  })
})

test('Windows build discovery ignores workspace tools, shims, and incomplete distributions', async (t) => {
  const { root, workspace, project, installation } = await fixture(t)
  const workspaceMaven = await installation(join(workspace, 'pretend maven'), mavenFiles)
  const workspaceGradle = await installation(join(workspace, 'pretend gradle'), gradleFiles)
  const shim = await installation(join(root, 'shim'), ['bin/mvn.cmd', 'bin/gradle.bat'])
  const incomplete = await installation(join(root, 'unpacked incorrectly'), gradleFiles.slice(0, -1))
  const junction = join(root, 'symlink to workspace maven')
  await symlink(workspaceMaven, junction, 'junction')
  assert.equal(await installedWindowsJavaBuild('maven', workspace, project, [join(shim, 'bin')],
    { MAVEN_HOME: workspaceMaven, M2_HOME: junction }), null)
  assert.equal(await installedWindowsJavaBuild('gradle', workspace, project,
    [join(shim, 'bin'), join(workspaceGradle, 'bin')], { GRADLE_HOME: incomplete }), null)
})
