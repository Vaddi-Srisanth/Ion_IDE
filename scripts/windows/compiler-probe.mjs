import { execFile } from 'node:child_process'
import { win32 } from 'node:path'
import { promisify } from 'node:util'

const pid = value => Number.isSafeInteger(value) && value > 0 && value <= 0xffffffff
export function compilerProbeTargets(trace) {
  const records = trace?.records
  if (!Array.isArray(records) || records.length > 1024) throw new Error('Invalid bounded compiler trace.')
  const ready = records.findLast(row => row.kind === 'native-status' && row.status === 'READY' && pid(row.payloadPid))
  const child = ready && records.find(row => row.kind === 'spawn-return' && row.id === ready.id && pid(row.pid))
  const call = ready && records.find(row => row.kind === 'spawn-call' && row.id === ready.id
    && row.executable === 'ion-pty.exe' && /^(gcc|clang)\.exe$/i.test(row.payload))
  if (!ready || !child || !call) return null
  return [...new Set([child.pid, ready.payloadPid])]
}

// One-shot test diagnostic. No command lines, paths, process termination,
// persistent monitor, JSON PowerShell module or production import.
export const compilerProbeScript = `
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$rows=@(Get-CimInstance Win32_Process -Filter $env:ION_COMPILER_PROBE_FILTER -Property ProcessId,ParentProcessId,CreationDate,Name | Select-Object -First 17)
if($rows.Count -gt 16){throw 'Compiler diagnostic process bound exceeded'}
[Console]::WriteLine('IONCOMPILER1')
$pc=0;$tc=0
foreach($row in $rows){
  $id=[uint32]$row.ProcessId
  try {
    $p=Get-Process -Id $id -ErrorAction Stop
    $cpu=$p.TotalProcessorTime.TotalMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture)
    $name=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$row.Name))
    [Console]::WriteLine('P|'+$id+'|'+[uint32]$row.ParentProcessId+'|'+$row.CreationDate.ToUniversalTime().Ticks.ToString()+'|'+$cpu+'|'+$name)
    $pc++
    $threads=@($p.Threads | Select-Object -First 65)
    if($threads.Count -gt 64){throw 'Compiler diagnostic thread bound exceeded'}
    foreach($thread in $threads){
      $state=[string]$thread.ThreadState
      $wait=if($state -eq 'Wait'){[string]$thread.WaitReason}else{'NotWaiting'}
      $time=$thread.TotalProcessorTime.TotalMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture)
      [Console]::WriteLine('T|'+$id+'|'+[uint32]$thread.Id+'|'+$state+'|'+$wait+'|'+$time)
      $tc++
    }
  } catch {
    [Console]::WriteLine('E|'+$id+'|'+[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($_.Exception.GetType().Name)))
  }
}
[Console]::WriteLine('END|'+$pc+'|'+$tc)
`

export function parseCompilerProbe(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout) > 128 * 1024) throw new Error('Compiler diagnostic output exceeded its bound.')
  const lines = stdout.trim().replace(/^\uFEFF/, '').split(/\r?\n/)
  if (lines.shift() !== 'IONCOMPILER1') throw new Error('Missing compiler diagnostic header.')
  const end = /^END\|(\d+)\|(\d+)$/.exec(lines.pop() ?? '')
  if (!end || lines.length > 1100) throw new Error('Incomplete compiler diagnostic.')
  const processes = [], threads = [], errors = []
  const decimal = value => /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value))
  const number = value => /^\d+$/.test(value) && pid(Number(value))
  const decode = value => {
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value || bytes.length > 512) throw new Error('Malformed diagnostic text.')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  }
  for (const line of lines) {
    const fields = line.split('|')
    if (fields[0] === 'P' && fields.length === 6 && number(fields[1])
      && /^\d+$/.test(fields[2]) && Number(fields[2]) <= 0xffffffff
      && /^\d{1,20}$/.test(fields[3]) && decimal(fields[4])) {
      processes.push({ pid: Number(fields[1]), parent: Number(fields[2]), created: fields[3], cpuMs: Number(fields[4]), name: decode(fields[5]) })
    } else if (fields[0] === 'T' && fields.length === 6 && number(fields[1]) && number(fields[2])
      && /^[A-Za-z]{1,32}$/.test(fields[3]) && /^[A-Za-z]{1,32}$/.test(fields[4]) && decimal(fields[5])) {
      threads.push({ pid: Number(fields[1]), tid: Number(fields[2]), state: fields[3], wait: fields[4], cpuMs: Number(fields[5]) })
    } else if (fields[0] === 'E' && fields.length === 3 && number(fields[1])) {
      errors.push({ pid: Number(fields[1]), type: decode(fields[2]) })
    } else throw new Error('Malformed compiler diagnostic record.')
  }
  if (processes.length > 16 || threads.length > 1024 || errors.length > 16
    || processes.length !== Number(end[1]) || threads.length !== Number(end[2])) throw new Error('Compiler diagnostic count mismatch.')
  return { processes, threads, errors }
}

export async function captureCompilerProbe(trace, signal) {
  const targets = compilerProbeTargets(trace)
  if (!targets) return { state: 'not-ready', reason: 'No correlated compiler READY/PID record.' }
  const root = process.env.SystemRoot
  if (process.platform !== 'win32' || !root || !win32.isAbsolute(root)) throw new Error('Expected native Windows system directory.')
  const began = performance.now()
  const { stdout } = await promisify(execFile)(win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', compilerProbeScript], {
      windowsHide: true, cwd: root, signal, timeout: 5000, maxBuffer: 128 * 1024,
      env: { ...process.env, ION_COMPILER_PROBE_FILTER: targets.flatMap(value => ['ProcessId = ' + value, 'ParentProcessId = ' + value]).join(' OR ') },
    })
  return { state: 'available', elapsedMs: performance.now() - began, targets, ...parseCompilerProbe(stdout) }
}
