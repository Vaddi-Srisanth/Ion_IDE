// Portable source-contract checks. These do not execute PowerShell, GCC or a
// Windows API and must never be reported as native ownership verification.
import assert from 'node:assert/strict'
import { readFile, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'

const source = await readFile(new URL('./gcc-direct-powershell.ps1', import.meta.url), 'utf8')
function embeddedCsharp(text) {
  const normalized = text.replace(/\r\n/g, '\n')
  const begin = normalized.indexOf("@'\n")
  const end = normalized.indexOf("\n'@", begin + 3)
  assert.ok(begin >= 0 && end > begin, 'Embedded adapter boundaries are missing.')
  return normalized.slice(begin + 3, end)
}
const csharp = embeddedCsharp(source)

test('embedded C# extraction accepts real Windows CRLF and LF checkouts without changing source semantics', () => {
  const lf = source.replace(/\r\n/g, '\n')
  assert.equal(embeddedCsharp(lf), embeddedCsharp(lf.replace(/\n/g, '\r\n')))
  assert.match(csharp, /public static IonGccDirectResult Run/)
})
const exec = promisify(execFile)

test('A lane fails closed before running a compiler on unsupported hosts or altered manifests', () => {
  const run = source.indexOf('$nativeResult = [IonGccDirect]::Run')
  for (const guard of ['$IsWindows', 'Is64BitProcess', "ProcessArchitecture.ToString() -ne 'X64'",
    '$PSVersionTable.PSVersion.Major -lt 7', '$manifest.timeoutMs -ne 15000',
    '$manifest.outputBytes -ne 65536', '$expectedSource', '$expectedArgs', 'FileAttributes]::ReparsePoint',
    'GCC_EXEC_PREFIX', 'COMPILER_PATH', "@('TEMP', 'TMP', 'HOME', 'USERPROFILE')"])
    assert.ok(source.indexOf(guard) >= 0 && source.indexOf(guard) < run, guard)
  assert.match(source, /ConvertFrom-Json -AsHashtable/)
  assert.match(source, /Length -gt 65536/)
  assert.match(source, /\$executionStarted=\$executionStarted|executionStarted=\$executionStarted/)
})

test('A lane establishes and verifies noninheritable kill-on-close ownership before Process.Start', () => {
  const begin = csharp.indexOf('public static IonGccDirectResult Run(')
  const body = csharp.slice(begin)
  const order = ['CreateJobObjectW(IntPtr.Zero,null)', 'KILL_ON_JOB_CLOSE|ACTIVE_PROCESS',
    'AssignProcessToJobObject(job,GetCurrentProcess())',
    'IsProcessInJob(GetCurrentProcess(),job,out owned)',
    'Members(job).Count!=1', 's.Event("ownership","controller-job-verified"', 'child.Start()',
    'IsProcessInJob(child.Handle,job,out owned)']
  let previous = -1
  for (const boundary of order) {
    const index = body.indexOf(boundary)
    assert.ok(index > previous, boundary)
    previous = index
  }
  assert.match(csharp, /KILL_ON_JOB_CLOSE = 0x2000/)
  assert.doesNotMatch(csharp, /BREAKAWAY|CREATE_SUSPENDED|ResumeThread/)
})

test('A lane uses structured arguments and a cleared shared environment without a shell command string', () => {
  assert.match(csharp, /UseShellExecute=false/)
  assert.match(csharp, /info\.ArgumentList\.Add\(arg\)/)
  assert.match(csharp, /info\.Environment\.Clear\(\)/)
  assert.match(csharp, /foreach\(var pair in environment\)info\.Environment\.Add/)
  const executableLines = source.split('\n').filter(line => !/^\s*(?:#|\/\/)/.test(line)).join('\n')
  assert.doesNotMatch(executableLines, /Invoke-Expression|Start-Process|cmd\.exe|taskkill|Invoke-WebRequest|ExecutionPolicy Bypass/)
  assert.doesNotMatch(csharp, /Arguments\s*=/)
})

test('A lane bounds evidence and preserves output, exit, stream and owned cleanup boundaries', () => {
  assert.match(csharp, /byte\[8192\]/)
  assert.match(csharp, /EventCount\+\+>=128/)
  assert.match(csharp, /Interlocked\.Add\(ref s\.TotalOutput,size\)>65536/)
  assert.match(csharp, /MAX_CHILDREN = 64/)
  for (const marker of ['spawn-request', 'spawned', 'first-callback', 'last-callback',
    'exit-callback', 'result-finalized', 'result-delivered', 'requested', 'completed', 'child-observed'])
    assert.ok(csharp.includes('"' + marker + '"'), marker)
  const drain = csharp.slice(csharp.indexOf('static bool Drain('), csharp.indexOf('public static IonGccDirectResult Run('))
  assert.ok(drain.indexOf('IsProcessInJob(handle,job,out owned)') < drain.indexOf('TerminateProcess(handle,124)'))
  assert.match(drain, /members\.Remove\(self\)/)
  assert.match(csharp, /r\.events=s\.Events\.ToArray\(\)/)
  assert.match(csharp, /child\?\.Dispose\(\)/)
  assert.match(csharp, /TerminateJobObject\(job,125\)/)
  assert.match(csharp, /TerminateProcess\(GetCurrentProcess\(\),125\)/)
  assert.doesNotMatch(csharp, /Environment\.FailFast|Kill\(true\)/)
})

test('one-shot deadline covers synchronous spawn and cannot terminate a released or reused Job handle', () => {
  const body = csharp.slice(csharp.indexOf('public static IonGccDirectResult Run('))
  assert.ok(body.indexOf('watchdog.Arm(') < body.indexOf('child.Start()'))
  assert.match(body, /watchdog\.Arm\(Math\.Max\(1,\(int\)Math\.Ceiling\(15000-/)
  const cleanup = body.slice(body.indexOf('} finally {'))
  assert.ok(cleanup.indexOf('watchdog?.Dispose()') < cleanup.indexOf('if(job!=IntPtr.Zero)'))
  const timer = csharp.slice(csharp.indexOf('sealed class DeadlineWatchdog'), csharp.indexOf('static async Task Pump'))
  assert.match(timer, /new Timer\(Expired,null,dueMs,Timeout\.Infinite\)/)
  assert.match(timer, /void Expired\(object unused\) \{\s*lock\(gate\) \{\s*if\(!armed\)return;\s*armed=false;/)
  assert.match(timer, /public void Dispose\(\) \{\s*lock\(gate\) \{\s*armed=false;\s*timer\?\.Dispose\(\); timer=null;\s*ownedJob=IntPtr\.Zero;/)
  assert.match(timer, /ThreadPool\.QueueUserWorkItem/)
  assert.match(timer, /session\.Event\("compiler-process","timeout"\)/)
  assert.match(timer, /TerminateJobObject\(ownedJob,124\);\s*TerminateProcess\(GetCurrentProcess\(\),124\);/)
  assert.doesNotMatch(timer, /Thread\.Sleep|\.Wait\(|\.Join\(|\.Result|await /)
})

test('fixed native adapter C# compiles when an existing .NET SDK is available; no Windows code runs', async t => {
  let installed
  const environment = { ...process.env, DOTNET_SKIP_FIRST_TIME_EXPERIENCE: '1', DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' }
  try { installed = await exec('dotnet', ['--list-sdks'], { timeout: 10000, env: environment, maxBuffer: 32768 }) }
  catch (error) {
    if (error.code === 'ENOENT') { t.skip('Optional existing .NET SDK unavailable; native Windows remains unverified.'); return }
    throw error
  }
  const sdk = [...installed.stdout.matchAll(/^([^\s]+) \[([^\]]+)\]$/gm)].at(-1)
  if (!sdk) { t.skip('No existing .NET SDK; native Windows remains unverified.'); return }
  const root = dirname(sdk[2]), packs = join(root, 'packs', 'Microsoft.NETCore.App.Ref')
  const versions = (await readdir(packs)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const refRoot = join(packs, versions.at(-1), 'ref')
  const frameworks = (await readdir(refRoot)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
  const refs = join(refRoot, frameworks.at(-1))
  const scratch = await mkdtemp(join(tmpdir(), 'ion-gcc-direct-csharp-'))
  t.after(() => rm(scratch, { recursive: true, force: true }))
  const input = join(scratch, 'Adapter.cs')
  await writeFile(input, csharp, { flag: 'wx' })
  const args = [join(sdk[2], sdk[1], 'Roslyn', 'bincore', 'csc.dll'), '/nologo', '/target:library',
    '/out:' + join(scratch, 'Adapter.dll'),
    ...(await readdir(refs)).filter(name => name.endsWith('.dll')).map(name => '/reference:' + join(refs, name)), input]
  await exec('dotnet', args, { timeout: 20000, env: environment, maxBuffer: 65536 })
})
