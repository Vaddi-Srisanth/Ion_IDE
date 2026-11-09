import { spawn } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sandbox = '/usr/bin/sandbox-exec'
const unavailable = 'Install a current LibreOffice for macOS in Applications for in-IDE slide previews, or use Open in Default Application.'

async function executable(path: string): Promise<string | undefined> {
  try {
    await access(path, constants.X_OK)
    return await realpath(path)
  } catch {
    return undefined
  }
}

export async function findPresentationEngine(): Promise<string> {
  if (process.platform !== 'darwin' || !await executable(sandbox)) {
    throw new Error('Sandboxed PowerPoint conversion is currently available on macOS. Use Open in Default Application.')
  }
  const override = process.env.ION_SOFFICE_PATH
  for (const candidate of [
    ...(override && isAbsolute(override) ? [override] : []),
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    join(homedir(), 'Applications/LibreOffice.app/Contents/MacOS/soffice'),
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
  ]) {
    const engine = await executable(candidate)
    if (engine) return engine
  }
  throw new Error(unavailable)
}

const profileSettings = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry">
  <item oor:path="/org.openoffice.Office.Common/Security/Scripting">
    <prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop>
    <prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="DisableOLEAutomation" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="DisablePythonRuntime" oor:op="fuse"><value>true</value></prop>
    <prop oor:name="BlockUntrustedRefererLinks" oor:op="fuse"><value>true</value></prop>
  </item>
</oor:items>`

function sandboxRules(directory: string, engine: string): string {
  const bundle = /^(.*?\.app)\/Contents\//.exec(engine)?.[1] ?? dirname(engine)
  const privatePaths = ['/Users', homedir(), '/Volumes', '/private/var/folders', '/private/tmp', '/private/var/tmp', '/private/var/root']
  return `(version 1)
(allow default)
(deny network*)
(deny file-read-data ${privatePaths.map((path) => `(subpath ${JSON.stringify(path)})`).join(' ')})
(allow file-read-data (subpath ${JSON.stringify(directory)}) (subpath ${JSON.stringify(bundle)}))
(deny file-write*)
(allow file-write* (literal "/dev/null") (subpath ${JSON.stringify(directory)}))
`
}

export async function convertPresentation(engine: string, directory: string, input: string, signal: AbortSignal): Promise<string> {
  const profile = join(directory, 'profile')
  const user = join(profile, 'user')
  const policy = join(directory, 'offline.sb')
  await mkdir(user, { recursive: true, mode: 0o700 })
  await Promise.all([
    writeFile(join(user, 'registrymodifications.xcu'), profileSettings, { mode: 0o600 }),
    writeFile(policy, sandboxRules(directory, engine), { mode: 0o600 }),
  ])
  signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    // The fixed shell snippet sets an output file limit and passes arguments unchanged.
    const child = spawn(sandbox, ['-f', policy, '/bin/sh', '-c', 'ulimit -f 196608 && exec "$@"', 'ion-convert', engine,
      '-env:UserInstallation=' + pathToFileURL(profile).href, '--headless', '--nologo', '--nodefault', '--norestore',
      '--convert-to', 'pdf:impress_pdf_Export', '--outdir', directory, input], {
      cwd: directory, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory, LANG: 'en_US.UTF-8' },
    })
    let reason: Error | undefined
    let output = 0
    const stop = (error: Error) => {
      reason ??= error
      if (!child.pid) return
      try { process.kill(-child.pid, 'SIGKILL') } catch { /* Process already exited. */ }
    }
    const abort = () => stop(new Error('Presentation preview was cancelled.'))
    const timeout = setTimeout(() => stop(new Error('The slide conversion exceeded 45 seconds.')), 45_000)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    const onData = (bytes: Buffer) => {
      output += bytes.length
      if (output > 64 * 1024) stop(new Error('The slide converter exceeded its output limit.'))
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', () => { reason ??= new Error('Unable to start the sandboxed slide converter.') })
    child.once('close', (code) => {
      signal.removeEventListener('abort', abort)
      clearTimeout(timeout)
      if (reason) reject(reason)
      else if (code !== 0) reject(new Error('LibreOffice could not render this presentation in Ion’s offline sandbox.'))
      else resolve()
    })
  })
  const output = join(directory, 'input.pdf')
  try {
    await access(output, constants.R_OK)
  } catch {
    throw new Error('LibreOffice could not render this presentation. Check that the file opens in LibreOffice or try Open in Default Application.')
  }
  return output
}
