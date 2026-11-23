# Ion implementation tracker

Current branch: `codex/ion-master-plan-phase-0`<br>
Current verified candidate: `c5306449445e16090c81d8396003b9885b710fd0`<br>
Comparison baseline: `d67613a1e9b77c7d677bd304628d57c58542fa71`<br>
Public release: `0.9.6`<br>
Local source version: `0.9.8`<br>
Installed application and live profile: untouched

## Phase status

| Phase | Status | Exit gate |
| --- | --- | --- |
| 0 — Audit and baseline | **Complete** | Six master-plan documents committed, exact candidate verified, failures retained, native evidence linked. |
| 1 — Stability and data safety | **In progress — performance blocked** | Core backup/restore acceptance passed on macOS and Windows, but the macOS cold-start and first-file regressions must be explained or corrected; packaged upgrade/migration gates also remain. |
| 2 — Core editor excellence | Deferred | Phase 1 must pass first. No Phase 2 work is authorized. |
| 3–10 | Deferred | Follow the architecture, security and performance gates in this roadmap. |

## Phase 0 completion

- Commit `c1267b6` added only the six reviewed Phase 0 audit documents after diff and credential/personal-data scans.
- Commits `df62239`, `c5217ff` and `c530644` corrected deterministic acceptance/benchmark harness defects exposed by native runs. They do not change production `src`.
- The verification branch alone was pushed. `main`, tags, releases, installers, update feed, installed Ion, live profile and user projects were not changed.
- Local boundary checks passed before native execution: 25/25 backup tests, backup UI dark/light ten-cycle fixtures, type checking, production build and zero production `npm audit` advisories.

## Exact native acceptance

Final run: [45205283873](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45205283873)<br>
Candidate: `c5306449445e16090c81d8396003b9885b710fd0`

| Gate | macOS 15 arm64 | Windows Server 2025 x64 | Result |
| --- | --- | --- | --- |
| Candidate/baseline source identity and ordinary production builds | [Passed](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45205283873/job/137799218970) | [Passed](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45205283873/job/137799218249) | PASS |
| Settings backup with current unsaved editor content | Passed | Passed | PASS |
| Undo/redo and editor/model identity | Passed | Passed | PASS |
| Fresh and populated restore, actual quit/relaunch | Passed | Passed | PASS |
| Lessons, practice source/attempts/evidence, settings, roadmaps and detached drafts through normal stores/interfaces | Passed | Passed | PASS |
| Credentials, execution trust and active test approvals excluded | Passed | Passed | PASS |
| Save requires renewed review after current data changes | Passed | Passed | PASS |
| Cancel preserves current process and edits | Passed | Passed | PASS |
| Real startup interruption at `previous-moved` and `published`, then recovery | Passed | Passed | PASS |
| Injected publication failure and populated pre-restore rollback | Passed | Passed | PASS |
| Four alternating baseline/candidate resource pairs | 8/8 attempts passed | 8/8 attempts passed | PASS with macOS regression below |
| Process-family cleanup | Empty after every attempt | Empty after every attempt | PASS |

Each platform recorded 12 lifecycle cases, seven disposable-profile observations and zero failures. The artifacts are [macOS 14834197418](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45205283873/artifacts/14834197418) and [Windows 14834177738](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45205283873/artifacts/14834177738). They contain bounded sanitized logs and raw structured measurements.

## Failures preserved and investigated

| Run | Failure | Root cause | Correction |
| --- | --- | --- | --- |
| [45203328964](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45203328964) | Both acceptance jobs failed before lifecycle execution with `import(undefined)`. | Harness inferred the hashed Monaco editor chunk from browser performance entries, where it is not guaranteed to appear. | Resolve the exact single `editor.api-*.js` artifact from each production build and import that app-origin URL. |
| [45203815424](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45203815424) | Both jobs expected a new process after Save All, but Ion kept the current process and rejected restore. | The test expected stale confirmation to remain valid after Save All changed selected current data. Product behavior was correct. | Assert rejection and durability, perform a fresh review, reconfirm, then require relaunch. No timeout increase or production weakening. |
| [45204705215](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45204705215) | All lifecycle cases passed; both resource lanes failed at the same Monaco lookup. | Benchmark retained the already-corrected performance-entry assumption. | Apply the deterministic artifact resolution to the benchmark as well. |

No final-run failure, slow sample or skip was removed. The macOS resource timing issue below remains open rather than being relabeled as noise.

## Matched performance summary

Medians are across four serialized AB/BA pairs on each hosted OS. Memory is the median of each attempt's settled phase; counters are platform-specific and not cross-compared.

| Metric | macOS baseline | macOS candidate | Delta | Windows baseline | Windows candidate | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold start | 1,061.12 ms | 1,441.56 ms | **+380.44 ms / +35.85%** | 1,149.27 ms | 1,152.82 ms | +3.55 ms / +0.31% |
| Warm start | 760.29 ms | 758.56 ms | -1.73 ms / -0.23% | 1,117.77 ms | 1,147.28 ms | +29.51 ms / +2.64% |
| First file | 678.52 ms | 1,401.06 ms | **+722.54 ms / +106.49%** | 353.13 ms | 358.71 ms | +5.58 ms / +1.58% |
| One-file attributed footprint / private bytes | 163.95 MiB | 159.84 MiB | -4.11 MiB / -2.51% | 179.62 MiB | 180.76 MiB | +1.14 MiB / +0.63% |
| One-file summed RSS / working set | 445.29 MiB | 446.02 MiB | +0.74 MiB / +0.17% | 350.02 MiB | 348.87 MiB | -1.16 MiB / -0.33% |
| One-file idle CPU, one core | 1.64% | 1.58% | -0.06 pp | 0.32% | 0.13% | -0.19 pp |

The macOS candidate first-file samples were 642.75, 1,389.00, 1,413.12 and 1,516.30 ms; the baseline range was 658.77–721.40 ms. Because three of four candidate samples were slow while Windows remained flat, this is a material, platform-specific regression signal. The current evidence does not isolate the cause. Phase 1 therefore remains performance-blocked.

Opening backup after Settings took a 444.72 ms macOS median and 832.51 ms Windows median. After ten open/close cycles, backend call and storage counters stopped changing while closed, the existing Monaco model remained identical, and every owned process family cleaned up. Code stayed unloaded during ordinary one-file editing (`backupLoaded: false`, zero backup calls). After first use the lazy chunk remains resident by design; this is not ongoing background work.

## Remaining Phase 1 gates

- Trace the hosted macOS cold-start and first-file regression with stage timings; do not remove recovery or integrity checks to win the number.
- Verify packaged installer/update migration, rollback and profile preservation on the exact release candidate. This workflow used ordinary production builds, not installers.
- Exercise maximum archive limits, external-filesystem publication behavior, physical power interruption and long-duration/physical 8 GB workloads where available.
- Run the full release regression/security/package gate against one immutable candidate. The focused workflow is not a substitute for every release test.

## Verdict

**Core backup/restore native acceptance: PASS at `c530644`.**<br>
**Phase 0: COMPLETE.**<br>
**Phase 1: CONDITIONAL / NOT RELEASE-READY.** Native safety and cleanup criteria passed, but the unexplained macOS latency regression and broader packaged-release gates prevent a genuine Phase 1 completion claim. Phase 2 remains deferred.
