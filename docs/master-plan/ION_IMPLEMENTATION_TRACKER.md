# Ion implementation tracker

Current branch: `codex/ion-master-plan-phase-0`<br>
Current verified candidate: `c5306449445e16090c81d8396003b9885b710fd0`<br>
Verification harness checkpoint: `43969bcf2b7de3d8ebcd06d7892a46b69cbcdcee`<br>
Comparison baseline: `d67613a1e9b77c7d677bd304628d57c58542fa71`<br>
Public release: `0.9.6`<br>
Local source version: `0.9.8`<br>
Installed application and live profile: untouched

## Phase status

| Phase | Status | Exit gate |
| --- | --- | --- |
| 0 — Audit and baseline | **Complete** | Six master-plan documents committed, exact candidate verified, failures retained, native evidence linked. |
| 1 — Stability and data safety | **Acceptance PASS** | Core backup/restore, corrected matched performance, packaged migration/rollback, security and native macOS/Windows regression gates passed for the immutable application source `c530644`. Publication/signing is a separate release decision. |
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
| Settings, custom themes, lessons, practice source/attempts/evidence, roadmaps and detached drafts through normal stores/interfaces | Passed | Passed | PASS |
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

No final-run failure, slow sample or skip was removed. The macOS timing signal from that run was retained and later resolved by the stage-level, co-located-artifact investigation below; it was not relabeled as noise.

## Corrected matched performance summary

The initial run below the historical divider used asymmetric artifact roots and produced a benchmark-harness regression signal on hosted macOS. Stage instrumentation and independent artifact placement established the cause. [Corrected run 45213098671](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45213098671) copied the exact baseline and candidate production builds to sibling directories under the same temporary root, alternated AB/BA order and retained all four attempts. Memory is the median of each settled phase; platform-specific counters are not cross-compared.

| Metric | macOS baseline | macOS candidate | Delta | Windows baseline | Windows candidate | Delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Cold start | 1,217.83 ms | 1,083.96 ms | -133.87 ms / -10.99% | 1,677.57 ms | 1,568.97 ms | -108.60 ms / -6.47% |
| Warm start | 709.63 ms | 606.68 ms | -102.95 ms / -14.51% | 1,536.48 ms | 1,558.34 ms | +21.85 ms / +1.42% |
| First file | 687.44 ms | 597.98 ms | -89.46 ms / -13.01% | 408.80 ms | 406.23 ms | -2.58 ms / -0.63% |
| One-file attributed footprint / private bytes | 165.42 MiB | 166.23 MiB | +0.81 MiB / +0.49% | 177.16 MiB | 178.95 MiB | +1.79 MiB / +1.01% |
| One-file summed RSS / working set | 446.02 MiB | 446.51 MiB | +0.49 MiB / +0.11% | 348.55 MiB | 346.90 MiB | -1.65 MiB / -0.47% |
| One-file idle CPU, one core | 1.44% | 1.42% | -0.02 pp | 0.12% | 0.00% | -0.12 pp |

Mac cold-start samples were baseline `4281.19, 1137.10, 1200.62, 1235.04` ms and candidate `1330.81, 1145.78, 1019.81, 1022.14` ms. First-file samples were baseline `1689.38, 691.10, 570.67, 683.79` ms and candidate `611.44, 584.52, 461.90, 786.52` ms. No outlier was removed. The renderer-only source-visible aggregate was +13.67%, but its AB/BA paired median was +20.70 ms / +5.99%; the primary user-request-to-visible-editor measurement improved 13.01%. Both required 10% gates pass.

Stage medians showed no candidate production bottleneck: main start to ready 223.20 -> 171.30 ms, ready to window 221.36 -> 180.53 ms, window to loaded 374.30 -> 309.63 ms and loaded to UI-ready 137.06 -> 103.76 ms. Candidate pending-restore checks were only 13.21–28.52 ms; file open/read IPC and scoped filesystem work were normally single-digit milliseconds. The production hot path was therefore not changed and no safety check was removed.

Opening backup after Settings took a 444.72 ms macOS median and 832.51 ms Windows median. After ten open/close cycles, backend call and storage counters stopped changing while closed, the existing Monaco model remained identical, and every owned process family cleaned up. Code stayed unloaded during ordinary one-file editing (`backupLoaded: false`, zero backup calls). After first use the lazy chunk remains resident by design; this is not ongoing background work.

### Exact investigation changes

- `scripts/core-native/bootstrap.cjs` adds CI-gated, bounded main-process/IPC/filesystem stage tracing with path scopes only.
- `scripts/core-native/session.mjs` records launch, window, load, inspector attachment and UI-ready stages using monotonic timestamps.
- `scripts/benchmark-core-backup-native.mjs` records file request, React commit, Monaco mount, paint, layout and long-task stages without source content.
- `.github/workflows/core-backup-verification.yml` places both exact production artifacts under one temporary root and alternates execution order.
- `.github/workflows/ion-release-verification.yml` pins the intended MinGW directory after every GitHub Actions path addition; `scripts/diagnose-windows-tool-selection.mjs` verifies the exact production selector result.
- `scripts/benchmark-development-workflows.mjs` puts the observable long-running case first and traces its process/status lifecycle through Ion's existing 15-second compile plus four-second cleanup boundary. It does not extend the application timeout.

None of these files is shipped as a new feature or alters the production `src` tree. The confirmed macOS bottleneck was in benchmark placement, so the smallest safe production correction was no production correction.

## Completed Phase 1 release gates

- Stage-level macOS startup/file-open tracing and the corrected co-located build comparison passed in [45213098671](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45213098671).
- The immutable candidate's full native macOS, package, update handoff, security and matched-performance lanes passed in [45215470028](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45215470028); the initial Windows lane failures are retained and were CI environment/harness defects, not suppressed samples.
- Genuine Windows toolchain discovery, complete application regression and paired process/resource workflow passed after the narrow corrections in [45334910491](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45334910491).
- Windows installer migration from the previous package, rollback after injected failure, Unicode profile/settings/code preservation and process cleanup passed. macOS DMG integrity, bundle permissions, disposable native launch, update handoff/recovery and clean shutdown passed. The macOS package is ad-hoc signed; Developer ID signing and notarization are not claimed.
- Maximum 2 GiB/10,000-entry archives, external filesystems, physical power interruption, four-hour endurance and consumer 8 GB hardware remain documented coverage limits, not silently passing tests.

## Verdict

**Core backup/restore native acceptance: PASS at `c530644`.**<br>
**Phase 0: COMPLETE.**<br>
**Phase 1 acceptance: PASS for the defined hosted macOS/Windows scope.** The performance blocker was a demonstrated harness artifact, the corrected production comparison passes, and package/migration/regression gates pass. Public release publication remains separate and still requires an explicit signing/notarization decision. Phase 2 remains deferred until the user starts it.
