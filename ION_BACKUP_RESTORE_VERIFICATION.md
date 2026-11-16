# Ion Core Excellence — Milestone 1 verification

## Remaining native acceptance gates — prepared, not executed

**Current verdict: CONDITIONAL.** Continuation began from clean local `c22e625824e1dd58595bb9a044ec7e143fe124f5`. The previously successful [Mac preflight](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43922635358) and [Windows recheck](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43925166585) remain valid for their exact scope and revisions. Their focused cohorts, filesystem tests and nine-case Undo controls were not repeated.

No new native run has started. A new upload is required to make the remaining lifecycle and resource checks available to both hosted operating systems; the user's latest brief explicitly requires authorization first. All entries below marked prepared or unmeasured remain acceptance gaps, not successful tests.

### Concrete prepared checks

- `scripts/test-core-backup-acceptance.mjs` creates meaningful synthetic data through normal stores, then uses actual Settings backup/review/apply controls in an unpackaged production build. It edits a real Monaco buffer without saving, checks Undo/Redo across backup, and uses the production Save All / Keep Drafts / Cancel flow. It observes the real `app.relaunch()` path, requires a different native PID, and reattaches to that new process; it does not substitute a harness restart for a normal restore's relaunch.
- Fresh and populated target profiles verify lessons, personal notes, edited practice source, stale historical sample results, custom themes, settings, roadmap progress/history and collision-remapped detached drafts through normal preload/main-process APIs. Drafts are also opened into real editor tabs. Explicit folder selection/relinking is required. Source code on disk must stay unchanged for Keep Drafts; the separate Save All case expects the explicitly saved synthetic edit.
- Actual source `run-trust.json` is seeded through `RunTrustStore`, alongside synthetic credential sentinels. The archive excludes those files, restored project approvals/automatic tests stay cleared, historical evidence stays stale, smart-tool activation is cleared, and a normal C Run must request fresh approval, which the fixture always denies. No real credentials or code from untrusted locations are used.
- Two controlled cases terminate the **actual new Electron process** after previous-data movement and after publication during startup repair. Receipts include real creation identities and process metrics. The harness then performs an explicit user-equivalent reopen of that crashed disposable profile and verifies recovery. It does not call the transaction helper directly from a standalone Node child in place of application startup.
- A third case injects a publication error in the actual startup filesystem path, verifies rollback to populated prior stores, rejects incoming practice data and validates the retained pre-restore archive through Ion's normal archive bridge. This is deterministic fault injection, not hardware power-loss evidence.
- The CI-only observer entry loads the unmodified built main. It provides native-file-picker responses, logs and denies native execution prompts, observes ownership and optionally injects the stated filesystem fault. It leaves application Save/Keep/Cancel, persistence validation, shutdown, `app.relaunch()` and startup transaction handling intact. It is not included in production build inputs, and no renderer privilege or production test hook was added.

`bootstrap.cjs` requires CI, GitHub Actions, an exclusively owned temporary root/token and a profile beneath it. Native launch scripts also refuse non-Actions execution. Normal and failed sessions retain creation identities before readiness, track relaunches and verify owned-family exit; inability to establish cleanup remains a failure. Nothing is installed or run against the local Mac's live profile.

### Exact source and baseline

Current, Windows-tested `ce035cb` and implemented `881ef00` have identical `src` tree object **`5a87e1591bb0dcdf80aa94bdd0d71ca1a671234e`**. `git diff --exit-code c22e625 -- src package.json package-lock.json` passed before preparation; application source and dependency files remain unchanged. The prepared workflow independently verifies those paths against `881ef00982649b9a26a547b7fab16851e4e04871`, records exact CI revision/tree IDs, and freshly builds that revision. Each native report records the built main SHA-256.

The matched pre-Milestone-1 baseline is **`d67613a1e9b77c7d677bd304628d57c58542fa71`**, whose source tree is `0f1c4e073166bc12919793c7285786576bcfd087`. CI builds an isolated archive of that ancestor with its **ordinary** `node scripts/build.mjs`. It must not use `build:baseline`, which artificially forces eager editor loading. Both builds share the exact installed Electron/compiler/dependency toolchain; the added candidate ZIP-writer dependency is present on disk but unused by the ancestor. This is explicitly a same-current-toolchain source comparison.

### Resource protocol and current measurements

`benchmark-core-backup-native.mjs` prepares **four paired AB/BA observations per OS**, serialized on the same host. Each build gets a fresh disposable profile and process-cold launch followed by a same-profile warm launch; OS caches are not purged. One fixed 80-line C file is opened, with Minimal mode, no compiler runs or terminal/learning panels. Shared phases are editor/Settings closed, Settings open, Settings closed. Candidate-only phases add backup UI open, ten open/close cycles and a final closed window. Baseline backup-open is **not applicable**, not an invented equivalent.

Each phase settles two seconds and observes ten seconds at nominal two-second intervals, recording actual acquisition times. Identity-owned family accounting reuses the existing Mac native probe and Windows CIM/Get-Process adapter. Mac summed RSS and attributed footprint are separate; Windows summed working set and private bytes are separate. CPU is percent of one logical core. Membership churn makes CPU unavailable with retained raw identities. Startup includes visible toolbar readiness and CDP attachment; test-observer overhead is matched and disclosed. Display/window geometry, scale and visibility are recorded. This is hosted-VM/unpackaged-build evidence, not ordinary-laptop hardware, installer, physical display latency or a long-session leak guarantee.

The final closed-backup observation requires stable backup IPC/filesystem counters, no active staging/pending marker, the same editor/model/content and model count, and complete owned-process cleanup after quit. Before first use, the backup service must be absent from the require cache. This combines source evidence with measured bounded observations; it cannot prove that every possible future workload has no background work.

| Required metric | Current before / after status |
| --- | --- |
| Process-cold / warm startup, one-file opening | **Not measured**; prepared paired native lane |
| Mac full-family RSS / attributed footprint | **Not measured**; separate counters required |
| Windows working set / private bytes | **Not measured**; separate counters required |
| Idle CPU with editor, Settings and backup UI open/closed | **Not measured** |
| Cleanup and closed-feature background activity | Native lifecycle lane prepared; local Node control only has run |
| Backup-open cost | Candidate-only measurement pending; no baseline equivalent |

Four pairs will support a bounded median/range comparison, not p95 claims. Every attempt/phase/sample is recorded incrementally, including incomplete and failing samples; cleanup errors cannot skip report publication. No unsuccessful sample is automatically excluded. JSON evidence is retained whole within 16 MiB; text logs are bounded to 2 MiB with explicit truncation labels. No native RAM or CPU improvement is claimed at this checkpoint.

### New local verification only

- Four new Node-only harness controls passed: ownership guard, real Node inspector request/exception/connection disposal, meaningful normal-store seed, and actual owned Node parent/child teardown. **No Electron binary was launched.** Latest result: 4 passed / 0 failed / 0 skipped, about 0.83 seconds; `performance-results/core-native-acceptance/harness-controls-reviewed-final.log`.
- The initial seed control failed because its expected macOS `/var` path differed from the canonical `/private/var` identity. The test was corrected to use `realpath`; the original 2-pass/1-failure log remains at `harness-controls.log`. This was a new fixture assertion error, not an Ion defect.
- Focused static review corrected premature ownership loss, failure-evidence publication ordering and a shadowed launcher variable before upload. No production defect was claimed from that review.
- Syntax checks for the new scripts, fixture bundling/normal-store loading, workflow `actionlint` and whitespace checks passed. No full application unit suite, old native Undo cohort, installer check or broad benchmark was repeated for these test-only changes.

### Authorization boundary

The smallest prepared action is one reviewed fast-forward upload to **`codex/ion-core-native-acceptance`**, starting **two** focused jobs (`macos-15`, `windows-2025`), each bounded to 20 minutes. They check production identity, run only the new harness controls, build candidate and exact ancestor, execute the remaining lifecycle scenarios, then run serialized resource pairs. Failure preserves partial artifacts and stops dependent work; there is no retry, release, merge, installer or update-feed action. No new push is authorized yet. Request approval for the exact local preparation commit before uploading it.

This checkpoint is **not** the requested final native acceptance verdict: full restore/relaunch, lifecycle rollback and real resource results remain conditional until those jobs actually execute. The installed Ion, user data, main, releases and Milestone 2 remain untouched.

---

The sections below preserve earlier executed results and their scope.

## Windows-only recheck completed — 2026-11-16

**Current verdict: CONDITIONAL — LIMITATIONS REMAIN.** The Windows interruption-fixture correction is now verified on genuine hosted Windows x64. The single approved follow-up job passed. Full Settings restore/relaunch acceptance, installer/update compatibility and native performance measurements are still open; this is not a release-readiness declaration.

The user explicitly approved uploading `ce035cb8bfb009196f88c04d69cf0e824b9155f8` only to `codex/ion-core-native-acceptance` and running one Windows-only job. That fast-forward push succeeded. [Run 43925166585](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43925166585), job `133502572673`, completed successfully at that exact candidate. No second job, manual dispatch or retry was started. Production source remains `881ef00982649b9a26a547b7fab16851e4e04871`; only fixtures, workflow and reports differ.

| Verified Windows check | Actual result |
| --- | --- |
| Exact host | Windows Server 2025 Datacenter 10.0.26100 x64; image `windows-2025-vs2026` / `20261103.298.1`; Node 24.22.2 |
| Type checking | Passed |
| Focused backup/profile/recovery/session/metadata/backend/lifecycle tests | **54 passed, 0 failed, 9 skipped** of 63; 13391.4887 ms |
| Previously failing apply-interruption boundaries | **All four passed:** journal, previous-moved, published, committed; exact child PID/boundary receipt required before accepting termination |
| Multi-category rollback interruption | Passed with actual child termination and original-byte preservation |
| New exit-status rejection control | Passed; missing/wrong receipts, successful exit and unrelated exit codes remain rejected |
| Production build | Passed; no installer produced or installed |
| Real native backup bridge | Passed: archive creation, untrusted preview, prepared-restore cancellation, settings/draft preservation and application close; **controlled restart is not covered** |
| Dedicated Windows filesystem lane | **5 passed, 0 failed, 0 skipped**, 3225.0678 ms: transient/persistent preference sharing locks, canonical Unicode/case-alias Save As, junction/device/ADS rejection, long Unicode paths, atomic-save sharing recovery and external-conflict preservation |
| Native Undo control | **9 cases passed**, completion recorded |
| Evidence collection | Passed; logs retained even though this run succeeded |

This resolves the confirmed **test-fixture** defect without changing the application, loosening assertions to any nonzero code, adding retries or extending application deadlines. Unlike the original failure, the recheck proves that the deliberately killed Windows children reached their requested transaction boundaries and recovery completed afterward. The original four failures remain preserved in run `43922635358`; a successful recheck does not erase them.

The nine skips are unchanged and individually explained in the original preflight section below: two generic C-toolchain fixture/discovery gaps, one POSIX-only C case, three Mac-only metadata cases and three filesystem-symlink fixtures that do not assume Windows privilege. They were **not** counted as passes. The new Windows-specific path/junction/sharing coverage narrows the previous filesystem gap but does not substitute for all three skipped profile/recovery-link fixtures. No full C-run, GCC-latency, updater or packaged-installer acceptance claim follows from this run.

[Windows evidence artifact 14255996096](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43925166585/artifacts/14255996096): GitHub-reported ZIP SHA-256 `4bd8a301d44295b69ae503987dfba29c5804356c914cdcf0536d1155878f4e41`, 5933 bytes; expires 2026-11-23T18:07:05Z. The decoded job log is also retained locally under `performance-results/core-native-acceptance/hosted-43925166585/windows-job.log` (ignored). No user profile, backup payload or workspace was uploaded.

**Performance interpretation:** the original Windows cohort took 15979.68 ms with four failures; this cohort took 13391.4887 ms with a new status-control case and all executed cases passing. These are suite durations, not comparable app-performance samples or evidence of an optimization. Startup, process-tree RAM/working set/private bytes, attributed footprint, idle CPU and post-close memory recovery were **not measured**. No production source/dependency delta was introduced. The successful Mac build/smoke/nine-case Undo evidence remains tied to `97890af`; Mac CI was not repeated for the test-only correction.

**Remaining acceptance gates:** actual Settings UI and unsaved Monaco buffer backup; completed fresh/populated profile restore followed by automatic relaunch and normal-store access; Save/Keep Drafts/Cancel; actual Electron interruption during startup repair; desktop conflict/permission flows; installer/update compatibility; matched native full-process resource measurements. Earlier maximum-capacity, power-loss, external-filesystem and 8 GB hardware limitations remain. No additional workflow or broad test campaign was started under this single-job approval.

**Git and safety:** the verification ref is `ce035cb`; `main` remained `a108a01bad53a6008761049c28a86e90bdd0374e` at both recorded inspections. Installed Ion, its live data and real projects were untouched. No local Electron window, merge, tag, release, installer, update-feed change or Milestone 2 work occurred. The result-report update is committed locally on `feature/ion-core-excellence` and is not automatically pushed.

---

The following section records the earlier failed preflight and local correction **before** the successful recheck. Its pending-state statements describe that earlier checkpoint; use the result above for current status.

## Authorized native preflight and fixture correction — 2026-11-16

**Verdict: CONDITIONAL — LIMITATIONS REMAIN. Full native acceptance has not passed.** The two approved hosted jobs completed: Mac passed; Windows failed four interruption fixtures. No release-critical application defect was established by this run. The original Windows failure is preserved, and the locally corrected fixture remains unverified on Windows. Do not release from this checkpoint.

**Exact production source:** `881ef00982649b9a26a547b7fab16851e4e04871`. The uploaded candidate was `97890af677d939b7cdfcc0db0a863018f820ad2d`, containing that implementation plus workflow/report preparation. Local work remains on `feature/ion-core-excellence`. The follow-up changes only the interruption test, the narrowly scoped workflow and these two reports; no production module, dependency, security rule or data format changed.

### Actual hosted evidence

The user explicitly approved uploading `97890af` to `codex/ion-core-native-acceptance` and starting two jobs. The single-ref, non-forced push succeeded. [Run 43922635358](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43922635358) tested that exact SHA. No duplicate dispatch or retry was started.

| Check | macOS | Windows |
| --- | --- | --- |
| Host | macOS 15.8.2 / 24H232, hosted `macos-15-arm64`, image 20261112.0539.3 | Windows Server 2025 Datacenter 10.0.26100 x64, hosted `windows-2025-vs2026`, image 20261103.298.1 |
| Node | 24.22.2 arm64 | 24.22.2 x64 |
| Type checking | Passed | Passed |
| Focused backup/profile/recovery/session/metadata/backend/lifecycle cohort | **62 passed, 0 failed, 0 skipped**, 8319.995875 ms | **49 passed, 4 failed, 9 skipped** of 62, 15979.68 ms |
| Production build | Passed | **Not run** after focused failure |
| Actual native backup IPC smoke | Passed: create/archive/preview/prepare/cancel, synthetic settings/draft preservation and clean close | **Not run** |
| Native Undo control | **9 cases passed**, completion recorded | **Not run** |
| Dedicated Windows path/sharing lane | Not applicable | **Not run** |
| Sanitized evidence upload | Passed | Passed, including original failures |

These are genuine hosted OS executions, not physical-hardware or local desktop measurements. The native bridge smoke is deliberately limited: it does not drive Settings through a completed restore and automatic relaunch. Successful Mac tests cannot establish Windows correctness.

Artifacts (7-day retention; expiry 2026-11-23):

- [Mac logs, artifact 14255196134](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43922635358/artifacts/14255196134), ZIP SHA-256 `25b956c9ac7c14b979cc012a4cd4e611e7c24ab1af3af58943e5a8f607e968a1` (GitHub-reported digest).
- [Windows logs, artifact 14254483966](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43922635358/artifacts/14254483966), ZIP SHA-256 `10756722d27bb3fd6f6d4472e2f24135c9ce39cf8970763f0c0ff55ac8f98fa9` (GitHub-reported digest).
- Decoded job logs, including the failed sample, are preserved locally under `performance-results/core-native-acceptance/hosted-43922635358/`. This directory is ignored, not published. No backup/profile/workspace archive was uploaded.

### Windows failure: exact boundary and correction

The four failed cases were `actual process interruption resumes safely at journal`, `previous-moved`, `published` and `committed`. Each failed at the original `test/backup.test.ts:180` close callback with an empty `Error`. That callback rejected `code === 1` before reaching the next assertion, which explicitly permitted a nonzero Windows termination status. Thus exit code 1 could never reach the intended Windows check. The separate multi-category rollback interruption fixture accepted Windows nonzero termination and passed. This establishes a fixture logic defect; it does not independently prove that all four Windows children reached their requested restore boundaries.

The local correction in `test/backup.test.ts` adds an exclusively created receipt in the disposable profile immediately before deliberate self-termination. Shared `interruptRestore` / `verifyInterruption` helpers require the exact child PID and requested boundary, empty stderr, and either SIGKILL or Windows exit 1 without a signal. Missing/wrong receipts, successful exit, unrelated exit codes and reported errors fail. The parent removes the receipt before checking restart recovery. All existing real kills, replay assertions and byte-preservation checks remain. Stderr retention is bounded to 4096 characters; unused child streams are ignored. No application timeout increased, retry added or exception suppressed.

A new deterministic status-control test uses a real Node child exiting with 1 and verifies Windows status interpretation plus rejection of missing/wrong receipts and other termination states. It explicitly does not pretend to be a native Windows kill. The five actual local SIGKILL fixtures still exercise transaction recovery. Windows confirmation of the receipt remains a required follow-up.

### Local correction checks

- `node scripts/test.mjs backup`: **25 passed, 0 failed, 0 skipped**, 6054.280417 ms, including five actual child interruptions and the new status control.
- `npm run typecheck`: passed.
- `actionlint .github/workflows/core-backup-verification.yml`: passed.
- `git diff --check`: passed.
- `node scripts/test.mjs backup profile-export recovery editor-session file-metadata backend service-lifecycle`: **63 passed, 0 failed, 0 skipped**, 6192.941209 ms on the local Apple M3 / 24 GiB Mac with Node 26.13.1. This includes actual C execution and metadata checks on this Mac; it does not establish their Windows behavior.
- The earlier full suite remains historical evidence for production source `881ef00`: 369 passed / 26 skipped. No new full suite or production build is claimed for the fixture-only correction; production inputs are unchanged.

Local logs: `fixture-correction.log`, `fixture-typecheck.log` and `fixture-focused.log` under `performance-results/core-native-acceptance/`. No local Electron GUI was launched, hidden or visible. The registration-crash precaution remains active.

### All nine Windows skips and their coverage impact

1. C compilation/stdin/diagnostics/repetition: `No local C compiler detected.`
2. Detached-output-stream C test: requires a POSIX toolchain.
3. Linked backup-profile payload rejection: fixture does not assume Windows symlink privileges.
4. macOS xattr/Finder-tag/quarantine/ACL/ownership/mode preservation: Mac-only.
5. macOS metadata read-denial protection: Mac-only.
6. macOS private replacement-stage metadata transfer: Mac-only.
7. Legacy profile-export symlink rejection: fixture disabled on Windows.
8. Recovery storage-directory symlink rejection: fixture disabled on Windows.
9. Saved-snapshot compiler/revalidation test: `No installed C compiler.`

The GCC setup step did confirm `C:\mingw64\bin\gcc.exe` exists. The two generic compiler fixtures call `detectCompiler(signal)` without a workspace. On Windows that function deliberately performs discovery only when given a `cwd`, then returns null otherwise. Therefore these two skips are a fixture/discovery-interface coverage gap, not evidence that GCC was absent or that Windows execution passed. No compiler-discovery security policy was changed to hide the gap. Existing Windows-specific execution evidence remains attached to its original revisions, not this run. Archive symlink-entry rejection and other malicious-ZIP tests did execute, but do not substitute for real filesystem-link tests.

Build, native bridge, native Undo and dedicated Windows filesystem checks were separate steps skipped after failure, not part of the nine unit-test skips. The entire full-suite historical list of 26 local skips is retained below.

### Safety, restore behavior and remaining gates

Focused native-host Node tests exercised normal-store round trips with meaningful synthetic data, detached draft collisions, stale historical evidence, category conflicts, explicit copied/reference/excluded workspace choices, relocation, credential/trust exclusion, malicious archives, cancellation, ENOSPC and rollback. Mac also verified its actual metadata fixtures and all four apply interruption boundaries plus rollback. Windows passed other backup cases and the rollback interruption; four apply interruptions remain unverified until corrected fixtures run there. None of this is ZIP extraction alone, and none is a full desktop restore/relaunch acceptance claim.

Still required: genuine Windows follow-up; actual Settings backup/restore with unsaved Monaco content; fresh and populated profiles restored and reopened through automatic relaunch; Save/Keep Drafts/Cancel; native application interruption during startup repair; actual desktop permission/conflict handling; installer/update compatibility; full-process memory/CPU and closed-panel cleanup measurements. Maximum-size archives, hardware power loss, external filesystems without hard-link publication and 8 GB hardware remain unverified. No additional GUI fixture expansion was attempted while Windows preflight is failing.

### Performance: measured limits, no invented improvements

| Metric | Before / after in this follow-up |
| --- | --- |
| Production source/dependency delta | None; only test/workflow/report changes |
| Startup, one-file RAM, idle CPU, Settings/backup UI latency | **Not measured** |
| macOS process-tree RSS / attributed footprint | **Not measured**; distinct counters |
| Windows working set / private bytes | **Not measured**; distinct counters |
| Native backup/restore latency, peak memory, post-close recovery | **Not measured** |
| Focused suite wall time | Mac 8.320 s / Windows 15.980 s on different hosts; test duration, not an application performance comparison |

Earlier Node service figures remain below: common comprehensive backup median 139.45 ms, 10 MiB workspace median 516.28 ms. The approximately 8 ms limited folder export does less work and is not an equivalent baseline. No native RAM reduction, zero-overhead guarantee or platform performance percentage is claimed. No background process, worker, poller, Monaco model, application cache or runtime dependency was added by the correction.

### Next minimal action — fresh authorization required

The original approval was for `97890af` and two jobs, both now completed. The correction has not been uploaded. The prepared workflow now selects **only `windows-2025`**, retaining the 20-minute bound, read-only permissions, pinned actions, exact revision capture and always-preserved bounded logs. Mac's successful run is preserved; repeating it unchanged would waste CI. This prospective Windows job runs the corrected focused fixtures, then production build, limited native bridge smoke, Windows paths/sharing and native Undo if prior steps pass. It still cannot establish full native acceptance.

After fresh explicit approval only, inspect the remote ref (expected `97890af`) and push the reviewed local follow-up to the **same** dedicated verification branch, without force. The scoped push starts one Windows job; do not dispatch a duplicate. Main, releases, installers, tags, update feed and installed Ion must remain untouched. Further complete restore/relaunch testing is a separate gate, not implicitly authorized by one recheck.

**Git / safety:** one reviewed candidate was pushed only to `codex/ion-core-native-acceptance`; this local follow-up stays on `feature/ion-core-excellence`. No merge, release, installation or Milestone 2 work occurred. The user's live profile and real projects were not used for testing.

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
