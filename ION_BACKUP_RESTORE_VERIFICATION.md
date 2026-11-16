# Ion Core Excellence — Milestone 1 verification

## Native acceptance follow-up — 2026-11-16

**Verdict: CONDITIONAL — LIMITATIONS REMAIN.** No release-critical application defect was confirmed in this follow-up. Full native acceptance has not passed. The explicit upload authorization boundary prevents hosted execution of this local candidate; lack of a physical Windows PC is not treated as a permanent blocker.

**Exact production source:** `881ef00982649b9a26a547b7fab16851e4e04871`, branch `feature/ion-core-excellence`, clean at inspection. The reported checkpoint matched the repository. Only this workflow preparation and the two requested reports changed afterward; no production execution, editor, backup or restore source was modified. The locally rebuilt main/backup bundle hashes match the original implementation evidence below.

### Fresh evidence, distinct from previous results

| Step / requirement | This follow-up actually executed | Result / remaining limit |
| --- | --- | --- |
| A: focused backing-store / lifecycle checks | `node scripts/test.mjs backup editor-session service-lifecycle` | **31 passed, 0 failed, 0 skipped**, about 7.19 seconds; disposable local profiles and real Node/filesystem/child-process fixtures |
| Production candidate | `npm run build` | Passed; no Electron application launched; main and backup bundle hashes matched the recorded candidate |
| Workflow syntax | `actionlint .github/workflows/core-backup-verification.yml` | Passed |
| Evidence collector controls | Canonical-path redaction, missing-step labels and a 3 MiB synthetic input | Passed after correcting a disposable-fixture /var alias assumption; initial failure retained locally; no collector/source change was needed |
| Existing native fixture syntax | `node --check scripts/test-backup-desktop.mjs` | Passed; this is syntax, not desktop execution |
| B: native macOS acceptance | Not launched | Profile isolation alone does not establish safety from the unresolved development-Electron registration crash. No new local GUI launch, packaged launch or installed-app modification was attempted. |
| C: hosted Windows x64 / macOS | GitHub read-only availability checks only | Not run: GitHub returned `No commit found for the ref feature/ion-core-excellence`; the new workflow also returned 404 on default `main`. Repository access itself was confirmed. |
| D: full regression after a confirmed fix | Not rerun | No production fix was made; do not spend another full cohort before the native environment is available. The earlier 369-pass/26-skip result remains historical evidence for `881ef00`, not fresh native proof. |

Fresh logs are local under `performance-results/core-native-acceptance/`. The 31-case run establishes the exercised store round trips, collision/conflict and malicious-input rejection, streaming cancellation, injected write failures, actual Node-process interruption/replay and owner draining. It does **not** establish the full Electron Save/Keep/Cancel/relaunch path or Windows behavior. No original failure was suppressed or deadline increased. The existing development failure history remains below and in the audit.

### Critical native coverage gaps

The current `scripts/test-backup-desktop.mjs` explicitly verifies real native IPC/create/preview/prepare/cancel and preserves a synthetic draft. It does **not** drive Settings through a complete fresh/populated-profile restore or automatic relaunch. A green result from that script must not be called full native acceptance.

Still unverified: actual Settings backup UI with realistic multi-store data and an unsaved editor buffer; fresh and populated profile restores followed by relaunch; current-data conflicts/changed associations through the desktop flow; recovery collision handling after relaunch; actual desktop kills during startup transaction replay; native metadata and Undo/Redo; no automatic filesystem/run/notebook/Git/test grants; native cleanup and installer/update compatibility. The focused Node cases cover corresponding backing-store logic, not these desktop boundaries. The native fixture must be extended against a working isolated host after its initial smoke succeeds, preserving any first failure instead of building a large untested harness beforehand.

### Native performance status

| Metric requested | Native macOS before / after | Native Windows before / after |
| --- | --- | --- |
| Welcome startup and one-file memory | Not measured | Not measured |
| Process-tree RSS / macOS-attributed footprint | Not measured; keep these counters separate | Not applicable to the footprint metric |
| Windows working set / private bytes | Not applicable | Not measured; keep these counters separate |
| Idle CPU / Settings / backup-panel opening | Not measured | Not measured |
| Small/large backup duration and peak memory | Prior Node service figures only, not native results | Not measured |
| Restore validation duration and peak memory | Not measured | Not measured |
| Cancel/cleanup and memory after closing UI | Node/previous browser controls only | Not measured |

The earlier limited folder export (about 8 ms) and comprehensive checksummed backup (about 139 ms) are **different operations**, despite their common synthetic input records. They do not establish a native regression ratio, startup slowdown or full-app RAM result. This follow-up did not rerun unrelated benchmarks or manufacture unavailable values. The dormant implementation still has only a fixed startup-marker check and lazy archive/UI loading by source inspection; no new runtime process, worker, cache or polling was added here.

### Smallest prepared hosted action — permission required

The workflow now has a push trigger restricted to **`codex/ion-core-native-acceptance`**, plus dispatch, two jobs (`macos-15`, `windows-2025`), a 20-minute per-job bound, no automatic retry and no cancellation of an earlier job. Existing repository action pins/Node version are reused. It selects the existing Windows GCC path, uses the existing dependency/build setup and retains bounded sanitized logs even on failure. No installer, backup archive, profile, credential store or workspace is uploaded. Repository permissions are read-only; credentials are not persisted by checkout.

The reason for the scoped push trigger is concrete: this new workflow is absent from `main`, and GitHub requires a new dispatch workflow to exist on the default branch before it can be dispatched. See [GitHub's manual workflow documentation](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) and [branch-scoped push triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow). No merge into main is needed for the scoped-push route.

After explicit approval **only**, inspect the destination and publish the reviewed acceptance checkpoint to that one new ref:

```sh
git status --short --branch
git ls-remote github refs/heads/codex/ion-core-native-acceptance
git push github HEAD:refs/heads/codex/ion-core-native-acceptance
```

The push itself starts the two jobs. Do not also dispatch a duplicate run. If the destination already exists or push/authentication is rejected, stop and inspect it; never force-push or alter access settings silently. This uploads the actual `881ef00` candidate plus reviewed verification/report changes, not merely a workflow testing old main.

Initial hosted sequence: type check and focused backup/integrity tests → production build → **limited native bridge smoke** → Windows path/sharing cases and native Undo control. This is a bounded environment/preflight run, not the complete acceptance campaign. Preserve every result. Full restore/relaunch, native resource accounting and upgrade/rollback remain explicit gates after a working host is established; do not issue NATIVE ACCEPTANCE PASSED from the smoke alone.

**Git / safety:** the preparation is committed locally on the existing Core Excellence branch. No upload or hosted run is authorized yet. Installed Ion, its live profile, real projects, main, releases, tags and update feed are unchanged. Stop at this acceptance checkpoint pending the narrow branch/CI authorization. Milestone 2 remains unstarted.

---

This report covers the local feature candidate based on `d67613a`; it is not a release or installed-app benchmark. The installed Ion, live profile, main, releases and update feed were not changed. All exercised data was synthetic and disposable.

## Executed checks

| Check | Result | Evidence / scope |
| --- | --- | --- |
| Initial existing profile/recovery/session/metadata subset | 16 passed, 0 failed | `node scripts/test.mjs profile-export recovery file-metadata editor-session`; captured before completing the new path |
| Final type checking | Passed | `npm run typecheck`; `performance-results/core-typecheck.log` |
| Final full unit/integration suite | 369 passed, 0 failed, 26 skipped (395 total) | `npm test`; `performance-results/core-full-unit.log`; actual local filesystem/process/compiler fixtures where applicable |
| New backup/restore cases | 24 passed | `node scripts/test.mjs backup`; `performance-results/core-final-targeted.log` |
| Controlled failing-before variant | Failed as expected | Removing the new staging-conflict guard in an isolated build gives “Missing expected rejection” for an external profile write during transaction staging; `performance-results/core-staging-conflict-before.log`. The production source is not weakened. |
| Production build | Passed | `npm run build`; `performance-results/core-production-build.log` |
| Production renderer in headless Chrome | Passed in light and dark themes | `node scripts/test-backup-ui.mjs`; fixture bridge explicitly labeled; lazy asset loading, default Keep choices, backup/restore review, 10 open/close cycles per theme, zero retained progress subscribers, no continuing backup calls after close |
| Editor preservation control | Passed in the real production Monaco renderer | C block-comment paste, backup checkpoint/review/close, same editor/model identity, one Undo restores original. This is a headless control, not OS clipboard/native Electron proof. |
| Workflow syntax and script syntax | Passed | `actionlint .github/workflows/core-backup-verification.yml`; `node --check` on the three new scripts |
| Local Electron desktop suites / native Undo fixture | Not run | Registration-crash precaution; no hidden or visible local Electron launch was made |
| Native Windows x64 / native controlled restart | Unverified | No new CI branch/upload authorized; prepared manual-only workflow and CI-only native bridge script were not run |

Early development fixtures exposed an incorrect test language option and a missing synthetic catalog, which were fixture setup errors. An early archive round-trip also exposed a real EBADF handle-ownership error, corrected before the passing cohorts. Passing counts above describe the final candidate, not those earlier failures.

## What the new tests establish

Normal-store round trips cover edited practice source, notes/reports, a custom theme, custom offline lessons, learning activity, roadmap history and detached recovery drafts. Historical results stay stale; imported approvals are empty; a source-profile credential marker never appears in the payload. Legacy exports retain an explicit missing-original-checksum warning.

Tests cover changed previews and changes during final staging; default reference/copy exclusions; explicit relocated roadmap mapping and new copy destinations; colliding draft IDs and capacity rejection; unselected current-category preservation; exclusively published existing backups; corrupted/truncated/header-disagreeing ZIPs; traversal/device/ADS/reserved names, duplicates, case/Unicode rejection, links/special modes, encryption and oversized expansion declarations; cancellation before and during actual streaming; injected ENOSPC/sharing/permission failures; marker-publication errors; post-arm cleanup errors; and repeated cleanup.

Actual child processes are killed at journal, previous-moved, published and committed boundaries. A multi-category application is forced into rollback, killed during reverse replay and reopened; all original category hashes are recovered. These are process-crash tests, not power-cut durability or native GUI-relaunch tests.

The restored session keeps imported file paths inert, and old drafts remain independently recoverable. Roadmap evidence is validated independently of approval. A real deferred evidence-file write verifies that automatic-test owner draining waits through its final publication. Existing save-conflict/recovery/checkpoint/unit regressions passed; native desktop shutdown and the exact native Undo fixture remain unverified.

## Performance method

Measured 2026-11-16T17:08:52.794Z, Apple M3, 8 logical CPUs, 24 GiB RAM, Darwin 27.2.0, arm64, Node v26.13.1. Production bundles were used. Filesystem caches were uncontrolled/warm; no OS cache purge, security-software change, app installation or power-setting change was performed. Normal host background activity was not controlled. This is not an 8 GB laptop result.

`node scripts/benchmark-backup.mjs` runs 30 interleaved fresh Node children for the old export and 30 for the new common-payload backup, plus 10 distinct workspace-copy runs. It retains all samples/errors, validates completed output outside the timed interval and checks for abandoned staging. The common synthetic payload contains 10 custom themes, one roadmap, learning activity and preferences (14 authoritative payload files). The legacy adapter provides the validated synthetic preference snapshot; this is service cost, not an exact old Settings/IPC journey. Workspace copying adds 40 files totaling 10 MiB. It is reported separately because the old exporter cannot do that job.

No app renderer/GPU/native-runtime memory is attributed from these Node figures. Node current RSS and OS rusage peak RSS are separate counters; peak includes child bootstrap/imports, and these are not macOS-attributed footprint or summed Electron process-tree RSS. There is no arbitrary RAM promise.

| Shared payload metric | Legacy limited folder export | Checksummed reviewed backup | Unit |
| --- | --- | --- | --- |
| Common payload total | 8.14 | 139.45 | ms |
| Common payload p95 | 12.15 | 244.27 | ms |
| Common payload maximum | 13.34 | 278.49 | ms |
| Module load | 0.53 | 5.03 | ms |
| Action CPU time | 7.97 | 105.59 | CPU-ms |
| OS process peak RSS | 48.66 | 61.67 | MiB |
| Node current RSS after action | 17.44 | 25.25 | MiB |

The new operation is materially slower and uses more transient memory on request. That cost buys schema/reference validation, repeated consistency hashes, private staging, streaming compression, exclusive publication and synchronized output; it is not described as an optimization. The old exporter remains available. The added cost is paid by an explicit backup action, not a continuously running service.

Workspace copying (10 runs): median **516.28 ms**, maximum **524.40 ms**, median CPU **388.38 CPU-ms**, median OS peak RSS **66.27 MiB** (maximum 67.67 MiB). No failed benchmark samples (70 completed / 0 failed). P95 on only 10 workspace samples is not treated as a reliable tail estimate.

Forty repeated review/cancel cycles: Node current RSS 21.47 → 22.74 MiB (delta 1.27 MiB); final five sampled points stayed within 0.45 MiB. Heap rose and fell with collection; this short bounded cohort does not prove absence of every long-session leak. No abandoned owned stage remained. After closure, a 1000 ms observation consumed 0.421 CPU-ms in the benchmark process; this is not a sustained full-Ion idle-CPU measurement. The UI lifecycle cohort separately found no retained progress listeners or continuing backup calls.

The only new ordinary-startup operation is a fixed marker existence check. One hundred warm, isolated probes: median 0.0223 ms, p95 0.0542 ms, maximum 0.2161 ms. These probe timings exclude module initialization and Electron readiness; they are **not application startup time**.

| Production build bytes | `d67613a` | Candidate | Change |
| --- | --- | --- | --- |
| Main startup bundle | 218,387 | 224,679 | +6,292 |
| Preload | 9,780 | 10,321 | +541 |
| Initial renderer JS | 366,920 | 368,346 | +1,426 |
| Full generated `dist` | 15,234,090 | 15,449,660 | +215,570 |

The lazy backup renderer JS is 8,569 bytes and is not requested while closed. Archive libraries are absent from the ordinary startup dependency path. This is generated-output size, not installer/installed Electron bundle size. The baseline was built from a temporary detached `d67613a` worktree using the same installed toolchain; that owned worktree was removed.

Candidate bundle SHA-256:

- `main/index.cjs`: `c422e06afd10c3d87941745b2b8fc4f6b1ae2d06573286cd21ef44575e741a95`
- `main/backup/service.cjs`: `5870d4b11de7a01a36ff9148235e4d1b8c82c318bbb726dd133c75eb09df2c0b`
- `main/backup/transaction.cjs`: `20168fa4eb3c074e91fb884ef51bf50c4c6ef98d357b0de3365c65ff5c46646e`

Raw local evidence: `performance-results/core-backup-benchmark/results.json`, `core-static-build-comparison.json`, `core-backup-ui/results.json`, their logs and light/dark screenshots. These generated files are local/ignored; this report records the portable results, and the committed scripts reproduce them without personal data or automatic uploads.

| Required native metric | Before / after status |
| --- | --- |
| Electron cold/warm startup | Not measured — local Electron registration precaution |
| Full process-tree RSS / macOS-attributed footprint | Not measured — no native application launch |
| Full-app idle/active CPU, GPU, scrolling/input latency | Not measured — headless UI is not native performance evidence |
| Native RAM after backup/restore and long sessions | Unverified — requires isolated native candidate runs |
| Installed bundle / installer size | Not measured — no installer or installed-app update requested |
| Windows native resource/locking/relaunch behavior | Unverified — workflow prepared but not uploaded/run |

No dependency, editor model, worker, background service or offline feature was removed to obtain these results. No full-application RAM improvement or zero-regression claim is made.

## All final suite skips

There are 25 Windows-specific cases, skipped because this host is macOS, plus the installed Maven/Gradle JVM-launcher case because both required installed tools were not available. These remain coverage gaps rather than passes:

1. Windows Run Console stops the process tree
2. Windows preferences recover from a sharing lock and preserve the old file on a persistent lock
3. installed Maven and Gradle JVM launchers compile a project and run its real entry point offline
4. Windows Run Console uses ConPTY for TTY, resize, Unicode argv and interactive input
5. Windows ConPTY forwards control input to the program
6. Windows ConPTY bounds busy program output and execution time
7. Windows terminal launches in the workspace and explicit close cleans up a detached child
8. Windows Run Console falls back to line input if the installed helper is absent
9. native Windows PowerShell5 deserializes scalar PID members before the first liveness API
10. Windows pipe supervisor preserves structured argv, input, separate output and real exit 125
11. Windows pipe Job owns detached descendants after natural leader exit
12. Windows pipe Job cleans descendants on cancelled
13. Windows pipe Job cleans descendants on timeout
14. Windows pipe Job cleans descendants on output-limit
15. Windows pipe Job kills descendants when the native supervisor is terminated
16. Windows pipe Job observes owner death without a persistent monitoring service
17. Windows pipe supervisor repeats clean executions and fails closed when missing
18. Windows pipe Stop waits for native Job drain and CLEAN acknowledgement
19. Windows runnable pipe commands keep the console hidden while preserving stdin, output, exit status and Job ownership
20. Windows runnable pipe handles fast native exits without losing READY, output or cleanup acknowledgement
21. Windows pipe Stop queued before READY observation drains the owned runnable command
22. Windows selected compiler and GCC diagnostics survive creation-time-owned runnable pipe launch
23. Windows workspace keeps canonical Unicode paths and confirms a case-alias Save As
24. Windows workspace denies junction escapes, case-variant roots, devices, and data streams
25. Windows workspace reads and saves long paths with Unicode names
26. Windows atomic saves recover from transient sharing locks and preserve external edits

The separate native desktop, shutdown, updater, full Undo-control and packaged-app suites were **not executed** this milestone; they are not hidden inside the unit-suite skip count. Previous successful native cohorts in the engineering audit apply to their recorded candidates only.

## Prepared native verification and remaining gates

`.github/workflows/core-backup-verification.yml` is manual-only, read-only in repository permissions, and selects macos-14/windows-2022. It is unrun. It prepares dependencies, type checking, focused data-integrity tests, a production build, a CI-only native backup bridge check and the existing native Undo regression. Upload/activation requires separate authorization; no CI was triggered here.

On an approved isolated native CI host: `npm ci`, `npm run typecheck`, `node scripts/test.mjs backup profile-export recovery editor-session file-metadata backend`, `npm run build`, `node scripts/test-backup-desktop.mjs`, then `node scripts/test-undo-control.mjs`. The new native script creates its own profile, verifies real IPC/create/preview/prepare/cancel and clean close. It does not by itself establish full GUI restore/relaunch.

Before release, additionally exercise the full normal Save / Keep Drafts / Cancel and automatic relaunch path on both OSs; kill the actual application at journal boundaries and verify repair before editing; test Windows sharing locks/permissions and directory-publication behavior; measure the complete candidate process tree with the same displayed workspace; run the long-session and 8 GB hardware workload when available. Keep local Electron GUI launches blocked until registration-crash conditions are understood and an isolated safe environment is approved.

Exclusive publication uses filesystem hard links. A filesystem without that capability fails safely; external-volume compatibility is unverified. Retained rollback archives/previous categories consume disk deliberately; no background retention sweeper was introduced. Maximum-capacity archives and hardware power-loss recovery were not tested.

## Local delivery gate

Type check, final unit cohort, production build, focused renderer controls and bounded service benchmarks passed. Review the staged source/documentation and credential/PII scan, create one local stabilization/feature commit, then stop. Native-platform caveats prevent labeling this a release-ready installer. No push, release, installed-app replacement or next milestone is authorized by this checkpoint.
