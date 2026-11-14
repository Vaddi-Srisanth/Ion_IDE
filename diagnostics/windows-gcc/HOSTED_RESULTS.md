# Ion Windows GCC hosted diagnostic report

## Final observer and application gates — 14 November 2026

The structured cohort at `6df9d48` reproduced assigned 2/listed 1 during cleanup after GCC exit 0. Corrected cohort at `2fdd3da` passed 909/909 with zero observer errors/timeouts and complete cleanup; no partial snapshot happened in that cohort, so its exceptional branch has deterministic compiled regression coverage. Original two failures below remain historical, without invented exception details. Full release gates then found a separate save preflight defect, now corrected and verified. [Final report and release matrix](RELEASE_VERIFICATION.md) · [All actual performance deltas](FINAL_PERFORMANCE.md) · [Preserved failure rows](sanitized-results/observer-failures.json). Historical GCC latency remains OPEN. No release or installed-app change.

**14 November 2026 — genuine Windows execution obtained. Original GCC delay NOT resolved. Release held.**

Measured diagnostic commit: `05dde34a4a0773d788282681d5e249d46eee861a`. [Final Windows Actions run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43600747226). The workflow concluded **failure**, because two PowerShell observer attempts failed; one VM job passed and two failed. No unsuccessful samples were replaced or omitted.

## Result

- **909 planned, 909 attempted, 907 successful, 2 unsuccessful, 0 timeouts, 0 unexecuted.**
- Direct PowerShell A: 303 attempts, 301 successful, 2 observer errors after GCC exit 0. Ion Node B: 303/303 successful. Real Electron engine C: 303/303 successful, including execution of the fixed compiled program.
- All 909 samples reported verified owned-process cleanup and complete output. All 606 one-shot A/C controller exits were observed; all three persistent B hosts closed normally. This is owned-Job/protocol evidence, not an independent census of every Windows process.
- The historical 12.67-second compilation /12.62-second READY-to-CLEAN interval did **not** recur. Maximum primary compiler interval in this cohort was **2755.41ms**. This does not prove the intermittent issue is fixed. Earlier diagnostic cohorts also retained a4.03-second direct first compilation; different cohorts are not pooled. The historical and final workloads/OS images are not matched before/after optimization benchmarks, so no speedup is claimed.
- No production execution code, dependency, execution approval, compiler timeout, main branch, release, installer, update feed or installed macOS application was changed.

## Actual environment

All three hosts: `windows-2022`, Microsoft Windows Server 2022 Datacenter x64, OSbuild `10.0.20348`, image `20261112.366.7`, Actions runner `2.338.2`, 4 logical CPUs and17,174,360,064 bytes reported RAM (about16GiB). These are hosted VMs, not8GB physical-laptop tests.

GCC **14.2.0**, target `x86_64-w64-mingw32`, installed at `C:\mingw64\bin\gcc.exe`. PowerShell **7.6.10**, standalone Node **24.22.2**, Electron **45.2.3** with embedded Node **24.22.2**. Runtime identity was checked and recorded on the actual machines. No security-software exclusions or administrator changes were made.

Compiler SHA-256 on all hosts: `09004a692e2e60dc8dc74db053e6a9e14da98a055277d986c66cd87940300263`. Adapter bundle SHA-256: `1965754cbc02b9bf16fca4ca604d11d60ce91430ff8cb2efe19e513304b688c2`, unchanged from the prepared offline handoff. The source-built helper hash differs between some hosts; each host recorded it before/after, with preservation checks passing.

## Matched workload and interpretation

Three independent hosts balance first lane A/B/C. Each lane has one separately reported first exposure and 100 warm samples per host. Fixed C source, sourcehash, compiler path/options, working directory and cleared environment are configured identically within each host. Tool metadata probes and runtime/hash initialization precede trials; these are **not independent OS-cold starts**.

A uses direct PowerShell/.NET Process.Start with a pre-owned Job and membership observation; B uses Ion's existing execute adapter under persistent Node; C uses the existing InteractiveRunner in a fresh, private, windowless Electron host per trial. C receives its fixed manifest through argv because the attempted persistent stdin transport reached EOF. C launches no BrowserWindow and does not use the installed app or profile.

The primary interval is each adapter's monotonic compiler spawn-request → finalized-result span, including that adapter's supervision/cleanup. C's additional program execution and Electron startup are excluded from that primary span; outer observer/adapter spans remain in artifacts. Different supervision costs mean these numbers **do not establish Ion as faster than bare GCC**. Do not pool separate VM hosts blindly. All failed finite measurements remain in statistics.

## Warm compiler intervals (milliseconds)

Each row contains 100 samples. Nearest-rank p95/p99, no outlier filtering. A=direct PowerShell, B=Ion Node runner, C=Electron execution engine.

| Host first lane | Path | Median | p95 | p99 | Maximum | Unsuccessful | Timeouts |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A | A | 113.69 | 130.65 | 136.14 | 139.57 | 1 | 0 |
| A | B | 93.04 | 98.18 | 105.80 | 113.38 | 0 | 0 |
| A | C | 110.49 | 117.44 | 131.58 | 133.10 | 0 | 0 |
| B | A | 98.34 | 111.89 | 116.31 | 130.21 | 0 | 0 |
| B | B | 72.01 | 80.44 | 87.94 | 100.46 | 0 | 0 |
| B | C | 83.42 | 97.91 | 103.48 | 107.55 | 0 | 0 |
| C | A | 119.66 | 130.97 | 136.63 | 138.35 | 1 | 0 |
| C | B | 94.59 | 110.19 | 116.99 | 127.99 | 0 | 0 |
| C | C | 111.84 | 126.50 | 131.24 | 132.51 | 0 | 0 |

## First compile exposures (milliseconds)

| Host first lane | Direct A | Ion Node B | Electron C |
| --- | ---: | ---: | ---: |
| A | 2755.41 | 96.04 | 108.43 |
| B | 71.66 | 2478.46 | 83.23 |
| C | 97.73 | 98.00 | 2665.53 |

The first actual compilation on each host is slow regardless of which path goes first. That is consistent with shared first-compilation/toolchain/OS warmup cost. It does not identify antivirus, filesystem caching, GCC, or Ion as the historical 12.62-second cause.

## Where the longest waits occurred

- Host A / first-A:2755.4075ms primary interval; spawn returned after3.8119ms. About2729.6678ms elapsed before the GCC exit callback; exit-to-finalization was25.7397ms, including25.1434ms cleanup. This slow first exposure also occurs through direct PowerShell.
- Host B / first-B:2478.4553ms primary interval; supervisor-spawn callback3.1620ms, READY-to-CLEAN receipt2470.7240ms, exit-callback-to-finalization0.6052ms. The wait is inside the payload/Job interval, not delayed result delivery after supervisor exit.
- Host C / first-C:2665.5304ms primary interval; supervisor-spawn callback5.2982ms, READY-to-CLEAN receipt2651.4287ms, exit-callback-to-finalization0.4842ms. The separate post-compile program/result interval was44.8135ms.
- B/C actual kernel GCC/cc1/linker exit times and native reader/Job-cleanup initiation remain uninstrumented. READY/CLEAN are receipt observations. No antivirus or filesystem activity tracing was collected.

## Two retained failures — not GCC timeouts

| Host | Attempt | GCC exit | Primary interval | Failure stage | Cleanup/output |
| --- | --- | ---: | ---: | --- | --- |
| A | `warm-18-A` | 0 | 91.5095ms | PowerShell observer after exit, during cleanup | Both verified |
| C | `warm-33-A` | 0 | 93.7992ms | PowerShell observer after exit, during cleanup | Both verified |

Both traces show `compiler-process/exit-callback` with exit 0, then `adapter-cleanup/requested`, `diagnostic/failed`, successful cleanup and result finalization. The PowerShell controller correctly exits 1 for an observer error; the workflow remains failed. The precise C# exception type/message was kept private and is absent from sanitized artifacts, so its root cause is **not established**. Do not reclassify these as compiler errors or discard their timings. A follow-up can export a tightly whitelisted observer error kind/native error code and boundary, then run a focused direct-lane regression. Do not weaken Job ownership or ignore membership errors.

## Diagnostic defects corrected before the measured cohort

1. Windows CRLF checkout broke embedded C# extraction and threatened source/bundle hashes. Scoped LF attributes plus a CRLF/LF extraction regression correct this. An actual Git checkout with autocrlf enabled preserved the hashes.
2. Electron 45 requires explicit runtime installation; npm package installation alone supplied no electron.exe. The workflow now invokes its pinned official installer with packaged checksums and verifies the executable exists.
3. The persistent Electron test host quit when its stdin closed before a request. Safe native markers reproduced that on all three hosts. C now uses a one-shot manifest, drains the final result write, then quits. All 303 final C trials succeeded. The underlying reason stdin reached EOF is not attributed to GCC or production Ion.
4. Already-exited persistent hosts were incorrectly labeled normal requested shutdowns. A real-child-process regression now rejects that classification; intentional one-shot exit remains explicitly supported.
5. Safe host failure locations and partial/final-result retention were added. Missing evidence, conflicting results, premature exits and malformed records cannot become cosmetic successes.

## Earlier failed cohorts preserved

| Run | Checkpoint | Outcome before final measurements |
| --- | --- | --- |
| [43598239651](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43598239651) |966cfbe| CRLF fixture-contract failure on all hosts;0 compiler trials |
| [43598625226](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43598625226) |9c0b78c| Missing Electron runtime;0 compiler trials |
| [43598920572](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43598920572) |9c2de33|6 attempts:3 successful A/B compiles,3 pre-compiler C failures |
| [43599442133](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43599442133) |9c467dc|6 attempts; same pre-compiler C exit, no host assertion trace |
| [43600068025](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43600068025) |b90e17c|6 attempts; stdin-closed and premature-exit markers confirmed |

These are source-differing diagnostic cohorts, not replacements for failed samples. Their18 attempted operations and9 pre-compiler C failures remain separate from the final 909. All 18 Actions artifacts from the six cohorts were retained locally with archive checksums; uploaded sanitized artifacts have 14-day retention.

## Verification and release status

- Latest available local diagnostic suite: **49 passed,0 failed,0 skipped**. Includes real child-process/stream cleanup tests, C# compilation without Windows execution, sanitization and evidence retention.
- Final Windows contract suite: **41 passed,0 failed,3 skipped per VM**. The skips are the two macOS-refusal guards (inapplicable on Windows) and standalone package-builder integration (already passed separately in the source checkout). Native compiler trials then ran as reported above.
- Workflow syntax validation passed. The one-shot host and correction are verified on actual Windows x64. Full app desktop regression, installer upgrade, Mac launch, app RAM/CPU/startup and physical 8 GB hardware were not measured by this diagnostic task. No release readiness is implied.
- No additional app dependency/service or production import was added. App memory/performance improvement is **not claimed**; compiler latency is the measured workload.
- Main remained `077bc6a9a29153cb9ed0f5f81f5147cb8dfff09b`. Only `codex/ion-gcc-hosted-diagnostics` was pushed, without force. No tags, releases, installers or installed-app changes.
- **Original failure: not reproduced; root cause unknown; issue open; release held.** Two direct-observer errors are an additional diagnostic limitation, not hidden passes.

## Artifacts and next precise tasks

Full sanitized final traces, ledger, metadata, host exits and results are attached to the final Actions run. Local retained copies and machine-readable summary accompany this report. No automatic uploads beyond the explicitly approved CI artifacts occurred.

1. Add safe structured native observer failure classification to investigate the two A errors; retain both current failures and current statistics.
2. If further original-delay investigation is authorized, capture exact B/C GCC-child kernel exits and native Job/reader phases so a future READY-to-CLEAN outlier can be subdivided. Current evidence cannot assign its 12.62seconds to GCC itself.
3. Record filesystem/security scanning attribution only through non-destructive, appropriately permissioned diagnostics; never disable protections or raise compiler deadlines to obtain passing results.
4. Keep ordinary app/installer release gates separate. This report supplies Windows execution evidence, not a release approval.
