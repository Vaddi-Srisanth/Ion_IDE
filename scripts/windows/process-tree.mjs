import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { familyFor, identityCpuPercent } from '../process-family.mjs'

const execute = promisify(execFile)
const script = Buffer.from(`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = [int]$env:ION_TEST_ROOT_PID
$profile = $env:ION_TEST_PROFILE
$known = @($env:ION_TEST_KNOWN_PIDS | ConvertFrom-Json)
$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CommandLine,Name,ExecutablePath,CreationDate)
$owned = [Collections.Generic.HashSet[int]]::new()
[void]$owned.Add($root)
foreach ($item in $all) {
  if ($known -contains [int]$item.ProcessId) { [void]$owned.Add([int]$item.ProcessId) }
  # This deliberately broad candidate prefilter only bounds Get-Process work.
  # Node performs final exact argument/executable/creation-identity attribution.
  # A profile-other candidate is NEVER charged merely for reaching this stage.
  if ($profile -and $item.CommandLine -and
      $item.CommandLine.IndexOf($profile, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $item.Name -match '^(electron|ion ide|crashpad_handler)\\.exe$') {
    [void]$owned.Add([int]$item.ProcessId)
  }
}
do {
  $count = $owned.Count
  foreach ($item in $all) {
    if ($owned.Contains([int]$item.ParentProcessId)) { [void]$owned.Add([int]$item.ProcessId) }
  }
} while ($owned.Count -gt $count)
$rows = @(
  foreach ($item in $all) {
    if (!$owned.Contains([int]$item.ProcessId)) { continue }
    try {
      $proc = Get-Process -Id $item.ProcessId -ErrorAction Stop
      $created = ([DateTimeOffset]$item.CreationDate).ToUnixTimeMilliseconds()
      $counterCreated = ([DateTimeOffset]$proc.StartTime).ToUnixTimeMilliseconds()
      if ($created -ne $counterCreated) { continue }
      [pscustomobject]@{
        pid = [int]$item.ProcessId
        parent = [int]$item.ParentProcessId
        name = $item.Name
        command = [string]$item.CommandLine
        executablePath = [string]$item.ExecutablePath
        started = $created.ToString([Globalization.CultureInfo]::InvariantCulture)
        startedMs = $created
        identityResolutionMs = 1
        workingSet = $proc.WorkingSet64
        privateBytes = $proc.PrivateMemorySize64
        cpuSeconds = $proc.TotalProcessorTime.TotalSeconds
      }
    } catch {
      if (Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue) { throw }
    }
  }
)
ConvertTo-Json -Compress -InputObject $rows
`, 'utf16le').toString('base64')

export async function windowsProcessTree(session) {
  if (process.platform !== 'win32') throw new Error('Use native Windows for the process-tree probe.')
  const began = performance.now()
  const family = familyFor(session, 'win32')
  const { stdout } = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', script], {
    windowsHide: true, timeout: 20_000, maxBuffer: 1_000_000,
    env: { ...process.env, ION_TEST_ROOT_PID: String(session.pid), ION_TEST_PROFILE: session.profile,
      ION_TEST_KNOWN_PIDS: JSON.stringify([...family.known.keys()]) },
  })
  const candidates = JSON.parse(stdout.trim().replace(/^\uFEFF/, ''))
  const selected = family.select(Array.isArray(candidates) ? candidates : candidates ? [candidates] : [])
  const members = selected.members.map(row => ({ pid: row.pid, parent: row.parent, name: row.name,
    started: row.started, startedMs: row.startedMs, kind: family.kind(row), workingSet: row.workingSet,
    privateBytes: row.privateBytes, cpuSeconds: row.cpuSeconds }))
  return {
    timeMs: (began + performance.now()) / 2,
    rootAlive: selected.rootAlive,
    workingSetMiB: members.reduce((sum, item) => sum + item.workingSet, 0) / 1024 ** 2,
    privateMiB: members.reduce((sum, item) => sum + item.privateBytes, 0) / 1024 ** 2,
    members,
  }
}

export function windowsTreeCPU(first, last) {
  const identity = sample => ({ ...sample,
    cpuSecondsByIdentity: Object.fromEntries(sample.members.map(p => [p.pid + ':' + p.started, p.cpuSeconds])) })
  return identityCpuPercent(identity(first), identity(last))
}
