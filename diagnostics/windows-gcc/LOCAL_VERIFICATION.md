# Local review and verification

Prepared 14 November 2026 on macOS 27.2.1 arm64, Node 26.11.1, actionlint 1.7.12. **No new native Windows evidence yet. No upload or workflow dispatch authorized yet. GCC issue unresolved; release held.**

## Changes reviewed

Only the diagnostic branch's registered workflow bridge, new dedicated Windows diagnostic workflow, and self-contained `diagnostics/windows-gcc/` fixture differ from published base `38cf7ff333d02be298a71c4b5315d317d57157c6`.

The existing production execution adapter is copied into this fixture with its optional tracing patch and source hashes for inspection. Its SHA-256 is `1965754cbc02b9bf16fca4ca604d11d60ce91430ff8cb2efe19e513304b688c2`, identical to the prior sealed handoff. No root application source, package dependency, lockfile, version, user profile or installed application changed in this branch. No production fix is asserted.

Added test-only controls: balanced A/B/C first-lane scheduling across independent hosts; bounded ten-minute diagnostic session with cancellation; exact trusted toolchain metadata; fail-closed artifact collection preserving partial/slow/failed evidence and whitelisted host-exit status. The 15-second compiler deadline is unchanged; no retry was added.

## Checks actually run

Source-checkout diagnostic tests:

```sh
node --test scripts/windows/gcc-actions.test.mjs scripts/windows/gcc-diagnostic.test.mjs scripts/windows/compare-gcc-latency.test.mjs scripts/windows/gcc-direct-powershell.test.mjs scripts/windows/analyze-gcc-traces.test.mjs
```

**45 passed, 0 failed, 0 skipped.** This includes real filesystem recovery/sanitization tests, actual JSONL child transport/termination, prior receipt analysis, scheduling and bounded-budget checks, and compilation of the embedded C# adapter using the already-installed .NET SDK. No Windows APIs execute on macOS.

The standalone fixture's exact CI test command:

```sh
node --test scripts/windows/gcc-actions.test.mjs scripts/windows/gcc-diagnostic.test.mjs scripts/windows/compare-gcc-latency.test.mjs scripts/windows/gcc-direct-powershell.test.mjs
```

**39 passed, 0 failed, 1 skipped.** The sole skip is the package-builder integration: a prepared standalone fixture does not contain esbuild or source-checkout packaging inputs. That integration passed in the source checkout above. It is not skipped to hide an execution failure.

On Windows, two additional macOS-refusal tests explicitly skip because they test rejection of macOS execution. Native Windows correctness will instead be exercised by the actual A/B/C trials. The optional C# compilation check explicitly reports a skip if an existing .NET SDK is absent. These are expected platform/dependency distinctions; record actual Windows totals rather than predicting a pass.

Both workflow files pass local `actionlint` validation. Staged code whitespace checks pass. The preserved historical unified patch has ten blank context lines consisting of one required context-prefix space, which `git diff --check` flags when a patch is added as a new text file; this evidence file is intentionally kept byte-identical, and is excluded only from that whitespace-style check. Node syntax checks pass. Intended files were reviewed for credential patterns, private home paths, unrestricted artifact paths, automatic triggers and production changes. Only whitelisted sanitized evidence can be uploaded. Workflow permissions are read-only; checkout does not persist credentials; no secrets are supplied to compiler/engine hosts.

Application type-check/build, installer, GUI, full desktop regression and application soak tests were **not rerun**: this branch changes diagnostic tooling only, and repeated local Electron GUI launches remain prohibited due to the earlier registration crash. The separate working source checkout and its prior stabilization work were preserved.

## Measurement status

| Metric | Previous evidence | This candidate |
| --- | --- | --- |
| Rare Windows compiler interval | CI19 slow sample 12,673.68 ms; READY → CLEAN receipt 12,622.26 ms | Pending approved Windows Actions run |
| Direct GCC vs Ion Node vs Electron | No matched native comparison | Pending; up to 909 planned attempts, all unsuccessful attempts retained |
| Windows median/p95/p99/max/timeouts | Historic three samples are insufficient for dependable tails | Not measured yet |
| macOS/Windows application startup, RAM, attributed footprint, CPU, GPU, typing and tab latency | Prior reports describe different application checkpoints/workloads | Not measured; no application optimization or performance gain claimed here |
| New background services / app dependencies | None for these diagnostics | None added; these files are outside the production import/build graph |
| Original root cause | Unknown | Unknown; no automatic resolution based on a green workflow |

These portable test timings are not Windows performance results. Hosted VM/compiler version, every actual attempted sample, lifecycle intervals, gaps, cleanup and provenance must be reviewed after execution. First compile exposures are not OS-cold samples; report the metadata priming and separate VM cohorts.

## Remaining gates and rollback

Explicit approval is required to upload **only** `codex/ion-gcc-hosted-diagnostics` and manually run its workflow. Do not merge, tag, publish, install or alter the update feed. If the connection lacks write/Actions permissions, report the precise access failure; do not change repository visibility or silently use a different publication path.

After authorized execution, download all three job artifacts, including failed jobs, and report exact runner image/toolchain versions, attempted/planned/unexecuted counts, per-lane/host statistics and unknown intervals. Keep the original finding open if not reproduced or still unexplained. A production correction, if justified by evidence, requires a separate reviewable patch and regression tests.

Rollback is simply to leave this local diagnostic branch unused. No application migration, profile change, executable replacement or main-branch rollback is needed.
