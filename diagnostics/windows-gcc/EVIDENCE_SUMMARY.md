# Preserved GCC evidence and measurement boundaries

**Historical handoff evidence, preserved before approved hosted CI. See [HOSTED_RESULTS.md](HOSTED_RESULTS.md) for new actual Windows measurements.**

**14 November 2026 — diagnostic package prepared; Windows execution unverified; release held.** No cause for the rare delay is asserted. No installed app/profile is needed or changed.

The prior local checkpoint passed 246 unit tests, skipped 25, and passed 17 separate diagnostic-tool tests. [Prior report](../gcc-latency/REPORT.md) and its hashed raw receipts remain unchanged in the source checkout. The handoff ships a sanitized extraction and hashes instead of duplicating private paths/logs into a shareable archive.

| Retained native Windows checkpoint / sample | Compile interval | READY → CLEAN receipt | Outcome |
| --- | ---: | ---: | --- |
| `38cf7ff3`, CI19 cold1 | 12,673.68 ms | 12,622.26 ms | Success; exit 0; cleanup verified |
| `38cf7ff3`, CI19 cold2 | 3,371.01 ms | 3,345.84 ms | Success; exit 0; cleanup verified |
| `38cf7ff3`, CI19 cold3 | 2,317.84 ms | 2,299.72 ms | Success; exit 0; cleanup verified |
| `1cf4ec51`, CI12 | 15,107.06 ms | 14,979.26 ms | Timeout; retained separately |
| `d5a2e47f`, CI14 cold3 | 15,140.52 ms | 14,516.63 ms | Timeout; retained separately |

The three same-checkpoint current samples have median 3,371.01 ms and maximum 12,673.68 ms, zero failures of three. Their empirical p95/p99 are the maximum, but three samples are insufficient for meaningful population tails. Older failures are not pooled with them. The retained slow run spends only 1.85 ms from CLEAN receipt to supervisor exit callback, then 0.18 ms to stdio closure. This narrows the unknown interval **before CLEAN receipt**; it does not assign that interval to GCC.

One targeted snapshot saw actual GCC PID 8624 and cc1 PID 10120, plus supervisor PID 6492 and conhost PID 2852. Cumulative CPU was 15.625, 46.875, 0 and 15.625 ms respectively. Waiting states have no file/stack/AV attribution. Main request and main observer clocks have independent origins; do not subtract them. A supervisor PID/spawn event is not the GCC PID/start event.

## Exact source owners

| Stage | Existing source / function | What is measured | Still missing |
| --- | --- | --- | --- |
| Request / authorization / IPC | `src/main/index.ts`: `startInteractive`, `runInteractive` | Original correlated request clock, source checks, main IPC send boundaries | Original physical click and renderer paint in the same calibrated clock; C handoff tests engine, not this UI path |
| Compiler selection / plan | `src/main/run-console/plans.ts`: `prepareRun` | Discovery and command-plan markers | Handoff uses explicit GCC; original ambient PATH discovery not repeated |
| Process runner / output | `src/main/runner.ts`: `execute` | Supervisor spawn request/callback, first/last output callbacks, stream completion, supervisor exit/close, result finalization | Actual OS GCC/cc1/linker exit, scheduling/file waits |
| Native ownership | `src/main/windows-process.ts`: `monitorWindowsPipeProcess`; `src/main/run-console/pty-windows.cpp`: pipe runner | Validated payload READY PID / native CLEAN receipt; production creation-time Job ownership | Native cleanup initiation, per-reader and Job-drain spans independently observed on Windows |
| Engine / program / terminal | `src/main/run-console/engine.ts`: `InteractiveRunner.run`; `pty.ts` | Compilation, source guards, program launch/readiness/end, publication callback | UI delivery/paint, full original workspace load |

The optional production tracing changes from the prior investigation are shipped as **`evidence/optional-production-tracing.patch`**, separately reviewable against approved checkpoint `38cf7ff333d02be298a71c4b5315d317d57157c6`. They are already reflected in the bundled test adapter; do not apply the patch twice or to installed binaries. This handoff adds only diagnostic scripts/docs/bundled test adapters; it makes no further production change, timeout increase or execution-policy change. Adapter source hashes are in `scripts/windows/gcc-package.json`.

## Evidence organization

- Original raw inputs: `release-blockers/windows/{ci12,ci14-cold3,ci19-cold1,ci19-cold2,ci19-cold3}/windows-run-diagnostic.json` in the source checkout. Never modified by package preparation.
- Hashed reanalysis: `release-blockers/gcc-latency/retained-trace-analysis.{json,csv}`. Existing failing samples and missing observations remain explicit.
- Previous tests/build: `release-blockers/gcc-latency/{unit-full-authorized.log,lifecycle-final.log,diagnostic-tests.log,typecheck-final.log,build.log,skipped-tests.json}`. Historical test results do not verify new Windows scripts.
- Package shareable evidence: `sanitized-results/historical-evidence.json`, with numeric boundaries, original receipt hashes and checkpoint identities only. No raw paths, compiler output, user profile or personal crash report is copied.
- New native results: generated only when someone actually runs the Windows commands. The prepared package contains **no fabricated native result**.

No new application RAM/CPU/startup/input/graphics measurement is possible under current host restrictions. The handoff is not loaded by Ion and adds no application dependency/service. No performance improvement or runtime-regression absence is claimed. Local verification details, archive hashes and preparation size are recorded in the source checkout's `release-blockers/gcc-handoff/VERIFICATION.md`.
