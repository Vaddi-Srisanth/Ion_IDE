# Windows hosted GCC investigation — review candidate

Status: **prepared locally; upload and execution require explicit approval.**
The rare GCC delay is unresolved. This package does not fix it or authorize a release.

## Scope and provenance

The dedicated branch is `codex/ion-gcc-hosted-diagnostics`, based on the already-published stabilization commit `38cf7ff333d02be298a71c4b5315d317d57157c6`.
The only changes are the two diagnostic workflows and this test fixture. No application source at the repository root, version, installer, release feed, or installed application is changed.

The fixture includes the previously prepared, instrumented execution adapter and its source/hash manifest (`scripts/windows/gcc-package.json`). Its bundle is identical to the earlier offline handoff. The optional tracing changes relative to the base are separately reviewable in `evidence/optional-production-tracing.patch`; they are contained in this test adapter, not applied to production code.

## How it will run after approval

GitHub normally requires a manual workflow to be registered on the default branch. To avoid changing `main`, this branch replaces **only its own copy** of the existing registered `.github/workflows/desktop-build.yml` with a manual-only bridge. That bridge calls the dedicated `.github/workflows/windows-gcc-diagnostic.yml` at the same commit. Neither file responds to pushes, pull requests, tags or releases on this branch.

After approval and uploading this branch, select the existing Desktop verification workflow in GitHub Actions, choose **Run workflow**, select `codex/ion-gcc-hosted-diagnostics`, and run it. Alternatively, with an authenticated GitHub CLI:

```sh
gh workflow run desktop-build.yml --repo Vaddi-Srisanth/Ion_IDE \
  --ref codex/ion-gcc-hosted-diagnostics -f samples=100
```

Do not dispatch against `main`. No push, dispatch, merge or release has occurred merely by preparing these files.

## Experiment

- Three independent GitHub-hosted **`windows-2022` x64** runners; first-lane order A/B/C, B/C/A and C/A/B respectively. Each runner has different hardware/OS caches; report each separately.
- Use the image's explicit `C:\mingw64\bin\gcc.exe`, require **GCC 14.2.0**, and record its canonical installation path, version output-derived version, and SHA-256. Fail setup if it is absent or the version differs; never fall back to workspace tools or PATH lookup.
- Pin **Node 24.22.2** and **Electron 45.2.3**. Record actual runner image, OS, PowerShell and runtime metadata. MSVC and the Windows SDK build the existing ownership helper from the included unchanged C++ fixture source.
- A: GCC launched from PowerShell with structured arguments, under a pre-owned kill-on-close Windows Job.
- B: the bundled Ion `execute` runner under Node.
- C: the bundled Ion `InteractiveRunner` inside a real, private Electron main process. It compiles and runs the fixed fixture. No window or user's installed app/profile is opened. This is engine execution, **not full editor UI/harness parity**.
- Each host schedules one first exposure and 100 warm compilations per lane: **303 attempts per host, 909 total planned**. Optional 30-sample setting schedules 93 per host / 279 total. Incomplete attempts are counted, never replaced or retried.
- One fixed C fixture, absolute compiler, arguments, working directory and cleared environment per host. Hashes document identity. No personal source or secrets are needed.
- Tool identity probing and runtime initialization happen before trials. These are **first compile exposures, not independent OS-cold launches**. No cache purge or antivirus changes. PowerShell starts per A attempt; B/C hosts persist. Compare compiler intervals separately from host/controller overhead and C's additional program run.

## Bounds and failures

The existing **15-second compiler deadline remains unchanged**. A separate ten-minute whole-session budget stops scheduling, requests owned cancellation and marks results incomplete. Job limit is 25 minutes; the run step has a 12-minute outer guard. No arbitrary retry or raised deadline hides a slow result.

Any unknown cleanup, malformed protocol, evidence overflow or broken ownership stops further scheduling on that host. The two other hosts continue (`fail-fast: false`). Every completed, slow, unsuccessful and unfinished attempt is retained where observed; absent final messages remain gaps with unknown timings, not fabricated zeros. A setup failure is also an unsuccessful run.

Output is bounded at 64 KiB per operation, traces at 256 events per attempt, private sample records at 256 KiB, and attempts at 303 per host. The shareable artifact collector has an independent 16 MiB budget and fails visibly rather than silently truncating evidence. No permanent service or production dependency is added.

## Artifacts and analysis

Each job always attempts collection and upload, including when setup/run fails. Uploads contain only `environment.json` and the collector's freshly reserved `collection/` directory. Raw working directories, source buffers, arbitrary messages, stdout/stderr, environment values, credentials and machine/user paths are not uploaded. Only the public GCC installation path and reviewed metadata fields may be disclosed. Sanitized partial traces and ledger entries preserve correlation IDs, stages, statuses, PIDs and numeric monotonic timestamps. Raw evidence remains disposable on the hosted runner and is not an upload fallback.

Artifact names include first lane, workflow run ID and attempt number; retention is 14 days. Download them from the Actions run's Artifacts section. Keep unsuccessful runs alongside successful runs; do not rerun solely to obtain a green result.

Report per host/lane/phase: attempted/planned/unexecuted, median, nearest-rank p95 (at least 20 measured samples), p99 (at least 100), maximum, timeout count, unavailable intervals, output completion and cleanup. All unsuccessful finite measurements remain in statistics. Do not pool different VM hosts or compiler versions blindly.

The primary compiler boundary is spawn request to finalized compile result, in that adapter's own monotonic clock. B/C additionally expose READY-to-CLEAN receipt, supervisor exit/close and stream completion. A's Process.Start return is actual GCC startup; B/C's spawn callback is the supervisor, not GCC. Never subtract timestamps across process clocks. Compiler-free output has no first-output timestamp; missing boundaries remain null.

## What remains unknown

The original Windows sample took 12.62 seconds between READY and CLEAN receipts. That does not prove GCC spent the time compiling. B/C do not independently observe kernel exit of GCC/cc1/linker or internal native Job/reader cleanup initiation. Antivirus/filesystem attribution, full UI delivery, application memory/CPU and macOS stability are outside these measurements. Hosted VMs do not establish physical 8 GB hardware performance.

If the delay reappears, use its correlation ID and retained stage traces to narrow the interval. If it stays inside READY-to-CLEAN without independent native substage evidence, the cause remains unknown; propose a separately reviewed targeted instrumentation patch. If it does not reappear, report **not reproduced**, not fixed. Release status stays held regardless of workflow color until all release gates are reviewed.
