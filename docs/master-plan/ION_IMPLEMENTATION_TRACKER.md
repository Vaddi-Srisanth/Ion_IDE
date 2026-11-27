# Ion implementation tracker

Current development: `codex/ion-phase-6-copilot` — Phase 3 core workflow checkpointed locally; continue roadmap work through Phase 10<br>
Latest local Phase 3 checkpoint: `e00dcf9` — reviewed push pins one commit, uses an exact remote OID lease, verifies remote state and compare-and-swap updates the cached ref (**2/2 backend tests, renderer, typecheck and production build pass; no live push; Windows/native dialog qualification deferred to Phase 10**)<br>
Latest local Phase 4 checkpoint: `ad71777` — offline solved/unsolved practice filters using retained local verdicts (**9/9 focused tests, typecheck and build PASS; production Electron assertions passed but final inspector shutdown timed out; not pushed**)<br>
Latest local Phase 8 checkpoint: `9b9192b` — lazy offline binary-tree traversal lesson (**macOS targeted checks PASS; not pushed**)<br>
Accepted Phase 2.5 checkpoint: `23dff68d29b07fd519d5b7b83857857bfe6ef20c`; application/build source `036781e7fe99be4480e5f0803fb6b22124be72a8`<br>
Phase 2.5 accepted adapter-foundation milestone: **complete**, native functional/full-suite and matched resource gates passed; broader task capabilities remain documented technical debt<br>
Phase 2.6 Test Explorer: **native acceptance PASS** on `codex/ion-core-excellence-phase-2-tests` at `fee7580cf3a107f54126dff7daa1d0e683a3198d`<br>
Current Phase 2 debugger production source: `bcd2d5560510492b7dae8c69c97a925b2c7db787` with workflow-only evidence commit `041a5b02c886bcbe7255e58b0fb711aeac6e69ac` (**native acceptance PASS**)<br>
Current Editor Essentials candidate: `8cce186b8b2bb3a703bfb434c24c29c89dbc45dd` with evidence commit `c0a33785d006cae0c9eed280ba398c288a3babc9` (**macOS and Windows x64 acceptance PASS**)<br>
Current Phase 2 language-services production source: `6bcc06c059a13461b145e5e4ccec55d22bb3bced` (**native acceptance PASS**)<br>
Accepted editor/workspace foundation: `0718aa7b35894474e1932efba7cee3286dcf0aab`<br>
Phase 1 accepted candidate: `c5306449445e16090c81d8396003b9885b710fd0`<br>
Verification harness checkpoint: `9aaeaeffff5cbb5b20a00ddbe373ba51c4e24578`<br>
Comparison baseline: `d67613a1e9b77c7d677bd304628d57c58542fa71`<br>
Public release: `0.9.9` for Apple Silicon and Windows x64<br>
Local source version: `0.9.9`<br>
Phase 2.6 uses disposable profiles on a development branch. The public v0.9.9 release contains accepted work through Phase 2.5.

## Current cutoff and roadmap decision — 27 November 2026

**Phase 2 is complete within its documented adapter scopes.** That includes the editor/workspace foundation, LSP, Editor Essentials, C/C++ DAP, Tasks and Test Explorer. Development resumed from the preserved Test Explorer branch. Focused correctness, data safety and platform-relevant checks determine each checkpoint. Extended qualification belongs to Phase 10.

Real pytest, JUnit Jupiter and Vitest fixtures passed 21 focused macOS backend tests with zero skips. Hosted macOS ARM64 and Windows x64 passed the [same candidate](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45931559561). The subsequent macOS production journey verified that an archived failure remains inspectable after rediscovery in `c805d52`. See the [Test Explorer report](ION_PHASE_2_TEST_EXPLORER.md) and [Phase 2.5 handoff](ION_ENGINEERING_HANDOFF_THROUGH_2_5.md).

## Phase status

| Phase | Status | Exit gate |
| --- | --- | --- |
| 0 — Audit and baseline | **Complete** | Six master-plan documents committed, exact candidate verified, failures retained, native evidence linked. |
| 1 — Stability and data safety | **Acceptance PASS** | Core backup/restore, corrected matched performance, packaged migration/rollback, security and native macOS/Windows regression gates passed for the immutable application source `c530644`. Publication/signing is a separate release decision. |
| 2 — Core editor excellence | **Complete at the documented adapter scope** | LSP run `45859946256` passed macOS ARM64 and Windows x64. Editor Essentials run [45863976766](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45863976766) passed its focused native gates. DAP production source `bcd2d55` passed packaged and native macOS in [45876230321](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45876230321) and the identical production tree passed Windows x64 under workflow-only SHA `041a5b0` in [45877000977](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45877000977). [Tasks](ION_PHASE_2_BUILD_TASKS.md) and [Test Explorer](ION_PHASE_2_TEST_EXPLORER.md) cover 2.5 and 2.6. |
| 3 — Git and GitHub | **Core workflow complete at documented scope** | Status/diff/stage/unstage/commit/history, branches/tags, same-tree switch, merge/conflict resolution, stash snapshot/pop, tracked-file discard, cached comparisons, reviewed public/authenticated fetch, pull, and a review-gated pinned-commit push are implemented. GitHub identity, issues/PR listing and detail, reviewed PR creation, sign-in/out, public clone and authenticated clone flow are present. Different-tree checkout is intentionally unavailable. No live push/private transfer occurred; native Windows and native confirmation journey qualification are deferred to Phase 10. Restore of staged changes remains open. [Evidence and limits](ION_PHASE_3_SOURCE_CONTROL.md) |
| 4 — Practice Arena | **Core offline scope complete** | The 27 original offline challenges each provide two staged learner-revealed hints; failed sample output identifies the first differing line. The browser filters by title/topic, difficulty, language and retained solved verdicts; unreadable progress fails closed. Local judging, progress, attempts and recommendations are covered. Current-build macOS production journeys for all five sample runners, persistence/relaunch and shutdown passed; one initial Java sample timeout did not reproduce on two reruns. Native Windows verification and stronger judge isolation remain for Phase 10. [Scope and evidence](ION_PHASE_4_PRACTICE.md) |
| 5 — Provider infrastructure | **Core provider scope complete** | Optional one-use approval, cancellation, response validation, bounded SSE streaming and source leases are implemented. Focused functional checks passed on both native platforms; the Windows job was cancelled during post-job cleanup. Live provider compatibility and broader protocols remain open. [Provider report](ION_PHASE_5_PROVIDERS.md). |
| 6 — GitHub Copilot | Opt-in protocol and Monaco integration checkpoint; native/authenticated acceptance open | Native cancel-by-default consent, command-palette enable/sign-in/sign-out/disable, focused-buffer inline provider, workspace authorization, cancellation and document-close lifecycle are wired. Official platform runtimes are SHA-512 pinned and installed only after explicit activation; not bundled or started on launch. Targeted tests: 12/12 pass; typecheck and production build pass. Real sign-in/completion and native Windows runtime/process cleanup remain unverified. [Copilot report](ION_PHASE_6_COPILOT_FEASIBILITY.md) |
| 7 — Ion AI experiences | Read-only Tutor actions checkpoint `6e57ad6` plus selected-code Tutor action | Ask Ion supports question-only and explicitly selected excerpt requests. Tutor includes evidence-cited file and selection explanations, likely-bug investigation, complexity analysis and test-case design; code remains unchecked by default. The focused explanation suites now pass 30 tests. AI Edit and Agent remain open. [Ask Ion report](ION_PHASE_7_ASK_ION.md) |
| 8 — Education and DSA coaching | Local checkpoint `9b9192b`; targeted macOS checks pass | Saved local evidence drives next-challenge and topic-focus suggestions; Search, Sorting and Graphs focus opens a matching offline lesson. Lazy lessons cover binary search, BFS, DFS, array-based Dijkstra, top-down merge sort, and four binary-tree traversal orders. Optional Tutor analysis requires selected code and a reviewed online request. General trace infrastructure and broader adaptive learning remain open. [Coaching report](ION_PHASE_8_COACHING.md) |
| 9 — Extension platform | Declarative pack checkpoint | Learning pack updates show and bind to the reviewed differences. Executable extension isolation remains open. [Learning pack report](ION_PHASE_9_LEARNING_PACKS.md) |
| 10 — Production hardening | Pending | Full performance, stability, accessibility, security, data safety and exact native qualification. |

### Continued development — 27 November 2026

The Phase 3 GitHub account path retrieves credentials through the officially installed `gh auth token` while it can access the user's normal CLI/keyring configuration, then supplies the token only to the isolated main-process `gh api` child. Account controls use official `gh auth login --web` and account-specific `gh auth logout`; only the device code crosses IPC, the device page is allowed only during an active sign-in, and sign-out is cancel-by-default. Sign-in accepts keyring-backed credentials and attempts account-specific cleanup if the CLI falls back to plain-text storage. The latest `77795f5` increment adds reviewed single-file discard that restores the index version, preserves staged content and aborts when the working file changes during confirmation. The focused Source Control suite passed **22/22**, and typechecking, production build, headless renderer journey and production Electron Source Control journey passed on macOS ARM64. The opt-in live-keyring smoke previously passed **13/13** GitHub reads. Native Windows verification, stash pop, pull/push, multi-file restore and authenticated private Git transfer remain open; no release, feed, installed app or public branch was touched. Details are recorded in [Phase 3 source control](ION_PHASE_3_SOURCE_CONTROL.md).

The `f3bae86` checkpoint adds opt-in authenticated GitHub branch fetch after native approval. It transfers only a reviewed fast-forward into the cached remote ref and preserves the index and working files. A local bare-repository fixture verifies the credential stays out of argv and user data remains unchanged. Follow-up checkpoint `8541b83` corrects the same empty-isolated-config issue in authenticated clone by retrieving a credential with official `gh auth token` and passing it only to the clone subprocess environment. An opt-in macOS run cloned the public Ion repository through the actual authenticated CLI path and verified no credential was stored in its remote config. This does not establish private-repository access. Windows journeys, pull/push and account controls remain open.

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
**Phase 1 acceptance: PASS for the defined hosted macOS/Windows scope.** The performance blocker was a demonstrated harness artifact, the corrected production comparison passes, and package/migration/regression gates pass. Public release publication remains separate and still requires an explicit signing/notarization decision. The user authorized Phase 2 after this gate passed.

## Phase 2 implementation tracker

Phase 2 started from Phase 1 checkpoint `005c402` on the dedicated local branch above. `main`, releases, installers, the update feed, the installed application and the live profile remain untouched.

| Milestone | Status | Evidence / remaining gate |
| --- | --- | --- |
| 2.1A — Multi-cursor commands and tab ordering | **Accepted on macOS and Windows** | Standard add-above/add-below/select-next/select-all commands are configurable and discoverable. Monaco's 19.36 kB multi-cursor contribution loads only on first use. Reordering preserves the active tab, dirty buffer and model identity. Unit, production Electron, type and build checks pass. |
| 2.1B — Source editor split foundation | **Accepted on macOS and Windows** | The on-demand same-document split shares one model/undo stack, keeps independent cursor/selection/scroll/focus state, supports keyboard focus/resize and disposes on close. Ten Windows cycles retained four owned processes and recovered below the pre-cycle memory samples. Different-file groups and persisted group restoration are the next milestone. |
| 2.1C — Workspace reviewed replace | **Accepted on macOS and Windows** | The existing bounded search offers explicit preview and selection. Main owns an expiring snapshot, revalidates revisions and hashes, publishes via the atomic save path, rejects changed files and reports partial failures. Modified open buffers block review. Long Unicode paths and Windows case-insensitive behavior passed natively. |
| 2.1D — Different-file editor groups | **Accepted on macOS and Windows** | Nested horizontal/vertical layouts, up to four groups, same/different files, shared models, independent view state, drag/move/focus/close/rebalance, keyboard resize and production relaunch persistence pass. |
| 2.1E — Restored editor-group layouts | **Accepted on macOS and Windows** | Orientation, 56% resize ratio, membership and active files survived production relaunch. Invalid/older layouts fail closed. |
| 2.2 — Multi-root workspace | **Accepted on macOS and Windows** | Explicit grants, add/remove/reorder, bounded saved descriptors/settings, root-aware search/replace/Quick Open/breadcrumbs/terminal/Git/run/projects/notebooks and session restoration pass. Windows casing, junction, Unicode, long-path and sharing-lock gates passed. |
| 2.3 — Reusable LSP host | **Accepted on macOS ARM64 and Windows x64** | Final run [45859946256](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45859946256) passed production build/typecheck, full unit/security suites, Java, clangd, Pyright, TypeScript, multi-root isolation, reviewed rename/workspace edits, hostile protocol/path cases, resource gates and zero owned service processes after cleanup. Production source `6bcc06c059a13461b145e5e4ccec55d22bb3bced`; test-only harness `9aaeaeffff5cbb5b20a00ddbe373ba51c4e24578`. Preserved failures and exact measurements are in `ION_PHASE_2_LANGUAGE_SERVICES.md`. |
| Editor Essentials — menus, Explorer keyboard and MRU tabs | **Accepted on macOS and Windows x64** | Candidate `8cce186b8b2bb3a703bfb434c24c29c89dbc45dd` adds accessible tab/Explorer context menus, bounded group-aware Ctrl+Tab history, safe batch close/reopen, Explorer tree keyboard semantics, focus-scoped delete/rename, authorized Copy Path/Reveal and selected-folder integrated terminals. Local macOS typecheck/build, 22 focused tests, the 467-test suite (441 pass/26 explicit skips), keyboard/relaunch and production Electron acceptance passed. Focused Windows run [45863976766](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45863976766) passed 440/457 tests with 17 explicit skips, both production workflows, restoration and resource cleanup. No dependency or background process was added. |
| 2.4 — C/C++ DAP | **Accepted on macOS ARM64 and Windows x64** | Lazy bounded DAP host, trusted clang/lldb-dap discovery, reviewed saved-source binding, breakpoint/call-stack/scope/variable/watch/evaluate UI, stepping, continue/restart/stop and owned cleanup pass. macOS packaged/native job [45876230321](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45876230321/job/140103900405) and Windows packaged/native job [45877000977](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45877000977/job/140106512467) passed. Exact scope, failures and limitations are in `ION_PHASE_2_DEBUGGER.md`. |
| 2.5 — Build/tasks | **Adapter foundation accepted; broader scope open** | App `036781e7fe99be4480e5f0803fb6b22124be72a8` passes final native full suites, lazy task loading, approved npm execution, Stop and cleanup in [45924540081](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45924540081), harness `c7b925caf6aef4e7956301692007330a0e3e1d08`: macOS 461/487 passed, 26 skipped; Windows 460/477 passed, 17 skipped; zero failures. Matched run [45923748325](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45923748325) passes startup/first-file budgets with four processes, zero task children and full cleanup. Saved workspace task definitions, safe problem matching and remaining adapter native journeys are still pending. Exact costs, individual samples and preserved failures are in `ION_PHASE_2_BUILD_TASKS.md`. |
| 2.6 — Test Explorer | **Native acceptance PASS; development branch** | Preserved at `2c025c5cc34b89b0e79255e594b61dd2eff78dee` on `codex/ion-core-excellence-phase-2-tests`. Real pytest/JUnit/Vitest adapters, review boundaries and relocated history passed local targeted verification. Build, 21 targeted tests and offline Electron checks passed on both hosts in run 45931559561. Development resumed after Windows v0.9.9 publication. Existing saved project tests remain intact in main. |

Phase 2 performance baseline remains the corrected Phase 1 comparison in this document. No new always-running process, worker, listener or service was added in this accepted slice. The multi-cursor contribution is a separate lazy chunk and ordinary one-file editing does not request it.

### Local macOS editor/workspace foundation checkpoint

The final source candidate passed type checking, production build, the production keyboard workflow twice, the production editor-session workflow and the complete local unit/security suite: **388 passed, 0 failed, 26 skipped**. The skips are Windows-only ConPTY, Job Object, filesystem-lock/path and native process-tree fixtures plus an unavailable Maven/Gradle fixture; they were not counted as passing.

The production relaunch workflow verified a two-root workspace, two different-file editor groups, a horizontal 56% layout, group membership and active files. A clean disposable profile then opened the saved `.ion-workspace` only after explicit review and recovered both roots without execution trust. The saved descriptor contains only the explicit roots and bounded editor settings; repository, run, terminal and test trust are deliberately excluded.

A three-trial matched comparison used the exact pre–multi-root commit `9bca0ed` and candidate `bc9ca7b`, identical production builds, disposable profiles and all retained samples. Median fresh startup was 328.51 -> 293.19 ms (-10.75%), warm startup 316.73 -> 289.14 ms (-8.71%), first file 179.08 -> 179.83 ms (+0.42%), one-tab summed RSS 518.42 -> 518.91 MiB (+0.49 MiB / +0.09%), ten-tab RSS 530.02 -> 531.45 MiB (+1.43 MiB / +0.27%), idle RSS 428.50 -> 429.09 MiB (+0.59 MiB / +0.14%) and idle CPU remained 0.31% of one core. These macOS RSS numbers can double-count shared Chromium pages; no RAM-reduction claim is made.

The focused five-root workload recorded 11.30 ms whole-workspace search, 9.60 ms replacement review and 39.10 ms reviewed publication across five files. Ten tabs opened in 284.53 ms, the next forty in 1,311.57 ms, the same file reached four groups in 104.84 ms and four different files reached four groups in 223.43 ms. Five create/close cycles took 1,599.41 ms. The owned process count stayed exactly four for every sample; no terminal, language server, debugger, compiler, Git or test process appeared. After cycles, attributed footprint was 286.10 MiB versus 354.27 MiB at the preceding fifty-tab checkpoint; summed RSS retained allocator pages at 612.08 versus 549.63 MiB and is reported as retention, not a leak. Raw ignored evidence is under `performance-results/editor-foundations-local-macos-2026-11-24T08-50-02.528Z.json` and `performance-results/desktop-2026-11-24T08-50-50.670Z.json`.

**Foundation verdict: PASS for the implemented editor-group and multi-root scope.** Local macOS and hosted Windows implementation, security, restoration and bounded resource gates pass. LSP and DAP were subsequently implemented and accepted as separately measured milestones above.

### Native Windows combined-foundation gate

Final run: [45364188961](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45364188961)<br>
Immutable source: `0718aa7b35894474e1932efba7cee3286dcf0aab`<br>
Host: Windows Server 2022 x64<br>
Sanitized raw evidence: [artifact 14906681428](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45364188961/artifacts/14906681428)

- Type checking, production build, production editor workflow, real relaunch/session/recovery/model retention, ten split cycles and the complete multi-root resource workload passed.
- Native unit/security/recovery result: **387 passed, 0 failed, 17 skipped** of 404. Skips are preserved, not reported as passing.
- The five-root workload retained exactly four Electron processes throughout. One root measured 347.08 MiB working set / 192.65 MiB private bytes; five roots 344.84 / 187.96; fifty tabs 391.89 / 230.07; and the restored session 344.59 / 182.23.
- Search across five roots took 55.10 ms. Reviewed replacement took 54.10 ms and all five safe publications completed in 163.20 ms. Different-file four-group creation took 364.89 ms; persisted restoration took 319.07 ms.
- Ten split cycles recovered from 336.99 MiB working set / 180.17 MiB private bytes to 321.32 / 168.57, with four processes in all 23 samples. Median split open/close was 32.84/37.74 ms.
- Windows exposed one production defect: renderer-only workspace membership compared valid Windows path identities case-sensitively. `a6bc93e` normalizes renderer comparisons on Windows while leaving main-process canonical authority unchanged; platform-specific unit coverage and the production workflow pass.
- Failed runs [45360309331](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45360309331), [45361189304](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45361189304), [45362069941](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45362069941), [45362818098](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45362818098) and [45363524001](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45363524001) remain linked. They exposed, respectively, platform-specific fixture paths, missing cleanup/error synchronization, the production casing defect, missing-file polling and an autosave/test race.

The 2.1B macOS disposable-profile benchmark exercised five open/close cycles. Median split creation was 22.60 ms and close was 27.98 ms. Opening the second editor increased median attributed footprint from 216.61 MiB to 277.29 MiB and summed RSS from 509.78 MiB to 521.63 MiB. Five seconds after the final close, attributed footprint was 185.26 MiB (-31.36 MiB from the pre-cycle sample), summed RSS was 522.05 MiB (+12.27 MiB allocator/working-set retention), and observed owned-tree CPU was 0.22% of one core. This five-cycle result establishes disposal and bounded short-run behavior, not a long-session leak claim. No extra process was created.

Milestone 2.1C adds no service, watcher, poller or dependency. Its main-process implementation remains behind the existing workspace-search dynamic import, and it retains at most one two-minute, 8 MiB review snapshot. The production renderer shell is 371,160 bytes versus 370,792 at the 2.1B checkpoint (+368 bytes / +0.10%); the Monaco surface is unchanged at 614,284 bytes. Focused unit and Electron acceptance cover exact selection, case-insensitive literal replacement, external-change rejection, partial failure reporting and publication through the safe file writer. Cross-file replacement deliberately guarantees per-file atomicity with explicit partial results, not a false all-files transaction.

### Native Windows editor-excellence acceptance

Final run: [45350808435](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45350808435)<br>
Immutable source: `5a70d92a5fc396de1968f7a3fec774832adb9c6f`<br>
Host: Windows Server 2022 (`10.0.20348`) x64, Node `24.22.2`

- Production build and type checking passed.
- 21 native Windows editor/filesystem tests passed; one cancellation test was explicitly skipped because that fixture is not supported in the focused lane.
- Production Electron acceptance passed multi-cursor, configurable bindings, same-model split/undo, independent view state, keyboard navigation/resizing, tab movement, modified-buffer protection and reviewed replacement.
- Session/recovery/model-retention acceptance passed after a real relaunch.
- Ten split open/close cycles kept exactly four owned processes in all 23 samples. Median open/close latency was 25.57/37.19 ms. Summed working set was 335.91 MiB before, 340.81 MiB median while open and 321.02 MiB after recovery (-14.89 MiB). Private bytes were 179.40 MiB before, 187.73 MiB median while open and 169.46 MiB after recovery (-9.93 MiB). Final closed CPU was 0.29% of one core.
- Failed runs [45350028358](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45350028358) and [45350331589](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45350331589) are preserved. Both exposed Windows automation routing assumptions in the acceptance driver; production code and safety protections were not changed.

**Initial editor-excellence milestone verdict: PASS.** Different-file editor groups, restored layouts and multi-root workspaces remain separate, not-yet-accepted milestones.
