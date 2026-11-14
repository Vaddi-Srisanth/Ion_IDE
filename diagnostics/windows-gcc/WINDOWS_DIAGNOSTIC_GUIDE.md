> Updated hosted execution evidence is in [HOSTED_RESULTS.md](HOSTED_RESULTS.md). C now runs once per manifest via argv; its stdin transport is not used. The source-checkout sealed handoff remains unchanged as historical evidence.

# Windows GCC diagnostic guide

**Diagnostic handoff only. GCC issue unresolved; release held. Native Windows execution is UNVERIFIED.** This package neither installs Ion nor uses an existing Ion profile. It never uploads results. Review the scripts before running them.

## Prerequisites

- A genuine **Windows x64** host. Target Windows 10 22H2 / Windows 11; the new harness has not yet been tested on either. Do not use macOS, Wine or an ARM emulation result as native x64 verification.
- Installed **Node.js 24 x64** (reference 24.22.2), **PowerShell 7 x64** (7.4 or later), and an explicitly selected installed **MinGW-w64 GCC x64** supporting C17. Do not use a compiler from the disposable workspace.
- A separate trusted **Electron 45.2.3 Windows x64 runtime** directory, including its supporting files. Use a development/runtime copy, **not the user's installed Ion executable**. No Electron window is created; this is a private main-process engine test, not a UI benchmark.
- Existing Visual Studio C++ x64 Build Tools and Windows SDK to build Ion's unchanged process helper. If unavailable, supply a separately verified x64 `ion-pty.exe` built from the exact included `pty-windows.cpp` and record its SHA-256. No large compiler/runtime is bundled or downloaded by this package.
- A writable local test parent such as `C:\IonDiagnostics`, outside OneDrive, network shares, source projects and personal-data folders. The selected run directory **must not exist**. Run as your ordinary account. If policy disallows nested Jobs or unsigned local scripts, stop and record the failure; do not elevate, bypass execution policy, change antivirus or add exclusions to make it pass.

The package includes a prebundled, source-hashed production runner/engine adapter. **No npm install, network connection or installed macOS Ion is required for execution.** Arrange the prerequisite tools beforehand; the package cannot provide missing Windows tooling offline.

## Run from the extracted package root

Open PowerShell 7. Replace only the tool paths and new run-directory name below with your actual trusted local paths. Do not pass arbitrary source files, shell commands or additional compiler options.

```powershell
Set-Location C:\IonDiagnostics\ion-gcc-diagnostic-package
node --version
$PSVersionTable.PSVersion
node build-helper.mjs
node scripts/windows/gcc-diagnostic.mjs --plan --samples 100
node scripts/windows/gcc-diagnostic.mjs --run --samples 100 --workspace C:\IonDiagnostics\run-001 --gcc C:\msys64\mingw64\bin\gcc.exe --pwsh 'C:\Program Files\PowerShell\7\pwsh.exe' --helper C:\IonDiagnostics\ion-gcc-diagnostic-package\native\ion-pty.exe --electron C:\Tools\electron-45.2.3\electron.exe --allow-electron-test
$LASTEXITCODE
```

`build-helper.mjs` uses the existing native build script, the included C++ source and locally installed MSVC/SDK. It creates only `native/ion-pty.exe` and temporary build files; it does not build/install the application. Native helper behavior still needs verification. If a verified matching helper was supplied, skip that build and point `--helper` to it. Run from the package root as shown.

The comparison schedules **303 attempts**: one first-compile exposure for each lane, then 100 warm attempts per lane with rotating lane order. A `--samples 30` pilot schedules 93 attempts; p99 will be withheld. There are **no retries**. Expect several minutes, depending on PowerShell compilation/startup and the Windows host; a deadline hit can extend this. Ctrl+C requests cancellation and stops scheduling; cleanup may take several seconds. Do not repeatedly kill/restart tests to discard a slow sample.

| Lane | Executes | Primary comparison |
| --- | --- | --- |
| A | PowerShell `ProcessStartInfo.ArgumentList`, direct GCC; controller assigned to a kill-on-close Job before GCC starts | Compiler spawn request → finalized compiler result, within the adapter's Stopwatch clock |
| B | Ion's existing `execute` under standalone Node and the unchanged native Job helper | Same semantic interval, within Node's monotonic clock; includes Ion helper cost |
| C | Production `InteractiveRunner` in a private, actual Electron main-process test host | Compiler interval extracted from trace; program/PTY and source checks reported separately |

The fixed two-line C source, argument list, working directory, source/output paths and allowlisted compiler environment are shared. The generated output is removed between samples, outside the timed interval. C also executes the fixed program through Ion's normal engine; **its total adapter time must not be compared as compile latency with A/B**. This harness does not reproduce the original large workspace, renderer, Run-button UI or application startup. Those remain distinct follow-up tests.

Metadata hashing and runtime initialization precede the first compile. The bounded GCC `--version` postlude runs only after a complete schedule and is recorded privately, outside sample statistics. A starts a new PowerShell process per sample; B/C hosts persist for this run. First exposure is **not OS-cold**. To investigate cold behavior, use separate ordinary fresh Windows sessions and new run directories; preserve every session and note its lane order/cache conditions. Do not purge system caches or disable protection. Live trace persistence and A's 100-ms Job snapshots add diagnostic overhead, so these are diagnostic timings, not an uninstrumented performance claim.

## Outputs, cleanup and sharing

Everything from the run stays under its new directory:

```text
run-001/
  attempts.jsonl                 synced start/completion ledger; unfinished attempts remain visible
  report-private.json            identities, paths, host exits, totals and trace references
  raw/<attempt>.events.jsonl      live messages, including partial evidence from failed runs
  raw/<attempt>.json              bounded complete/failed sample
  raw/<attempt>.invalid-result.json  malformed result, when applicable
  sanitized-results/results.json summary with privacy-sensitive text removed
  sanitized-results/<attempt>.json numeric lifecycle traces safe for manual review
  manifests/, work/, temp/, home/, profile/  disposable fixture/runtime state
```

Exit 0 means all scheduled diagnostic attempts, reported cleanup, preservation checks and normal host exits satisfied the harness checks. **It does not mean the GCC defect is fixed or Ion is release-ready.** Exit 1/2, missing final files, a nonzero `unexecuted`, unknown cleanup, forced host exit, overflow or `diagnosticVerification: incomplete-or-failed` requires investigation. No failure/outlier is silently replaced. A hard interruption can leave only the ledger/live trace: keep them.

```powershell
$r = Get-Content C:\IonDiagnostics\run-001\report-private.json -Raw | ConvertFrom-Json
$r | Select-Object complete,unexecuted,allCleanupVerified,hostCleanupVerified,binariesUnchanged,sourceUnchanged
$r.hostShutdown | Format-Table lane,pid,normal,exited,code,signal
$r.groups | ConvertTo-Json -Depth 8
```

Review compiler intervals, median, empirical p95 (at least 20 available values), empirical p99 (at least 100), maximum, timeout count, missing intervals and unsuccessful count. Small-sample tail estimates remain uncertain. Check each raw trace for native CLEAN/stdio closure in B/C, and A's controller-only Job drain. `hostCleanupVerified` requires normal host exits; a forced close remains unverified. Job membership snapshots can miss short-lived children; they are observations, not a complete kernel lifecycle trace.

For an additional non-destructive spot check, use **only recorded PIDs** from this run:

```powershell
$ids = @($r.hostShutdown.pid) + @($r.samples.payloadPid)
$ids | Where-Object { $_ } | Sort-Object -Unique | ForEach-Object {
    Get-Process -Id $_ -ErrorAction SilentlyContinue | Select-Object Id,ProcessName,StartTime
}
```

An absent PID supports cleanup at that time. A present PID may have been reused: inspect identity/start time, do not terminate it by name or PID alone. Do not use broad `taskkill` commands. If cleanup is unknown, stop testing and retain the run directory; do not delete files underneath a potentially surviving owned process. Perform interruption/controller-loss and repeated-create/close verification first in a disposable Windows VM, as listed in `REMAINING_WINDOWS_TASKS.md`.

Share **only `sanitized-results/` after manual inspection**. It removes raw compiler output, all paths, environment values, free-form errors, usernames and hardware identifiers. Counts, monotonic durations, limited event names, PIDs and SHA-256 hashes remain. Never share `report-private.json`, manifests, raw traces or whole profiles without reviewing them. Nothing is uploaded automatically. You can regenerate the sanitized summary into a **new** filename:

```powershell
node scripts/windows/gcc-diagnostic.mjs --sanitize C:\IonDiagnostics\run-001\report-private.json --out C:\IonDiagnostics\run-001\sanitized-results\reviewed-summary.json
Compress-Archive -Path C:\IonDiagnostics\run-001\sanitized-results\* -DestinationPath C:\IonDiagnostics\run-001-sanitized.zip
```

Per-attempt result files are bounded at 256 KiB, live traces at 256 events plus a bounded final message, combined compiler output at 64 KiB, tails at 8 KiB per stream, and the schedule at 303 attempts. The per-host queued protocol budget is 512 KiB; the synced attempt ledger is capped at 3 MiB. A cap failure stops scheduling and remains a failed/incomplete result. Hosts stop after the workflow; no services or monitoring processes are installed. Evidence persists locally; manual deletion of the explicitly disposable directory is optional **after verified cleanup**.

## When a slow run recurs

Preserve the entire local directory, including incomplete attempts. READY/CLEAN and Node exit events are callback receipts. They do not establish GCC's actual kernel exit time, file-lock ownership or antivirus cost. B/C native cleanup initiation and individual cc1/linker lifecycles still require independent Windows capture. Do not call this an antivirus or GCC bug without that evidence.

If permitted, a short, separately labeled WPR/WPA capture can supply process/scheduling/file evidence; inspect available sessions/profiles first and never cancel somebody else's recording. WPR/Defender collection can require administrator privileges; **the basic harness does not**. If unavailable, mark that evidence unavailable rather than elevating by default. Do not mix profiled and ordinary timing samples. [Microsoft Job behavior](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects), [structured process arguments](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.argumentlist), [WPR options](https://learn.microsoft.com/en-us/windows-hardware/test/wpt/wpr-command-line-options).
