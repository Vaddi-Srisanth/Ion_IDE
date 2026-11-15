# Next-generation verification — candidate, not release acceptance

Branch `feature/ion-next-generation`, reviewed base `a108a01`. Product commits A52a7137, B80f89c5, Cf4c6331, Db8132ec, Eceb6b63 and F5489a3c. Subsequent test-only corrections preserve failed evidence. Installed Ion, main, releases and update feed are untouched.

## Current checks

| Check | Actual result | Limit |
|---|---|---|
| Final local typecheck / production build | PASS | Source E/F5489a3c; laterc35371a changes tests only |
| Final local full unit suite |370total,344pass,26skip,0fail| Real local filesystem/process tests where applicable; skips are not passes |
| Evidence sanitizer |12pass,0skip,0fail| Exact fixed resource labels preserved; source/provider/private fields redacted |
| E context/provider/session/editor tests |PASS within full suite| Real disposable files/vault and synthetic transport; not live provider or OS native UI |
| F recommendation merge / real repository |6pass| Includes normal ProjectSpec validation, dependencies/collisions and preservation of manual/test evidence |
| Final compiled renderer |4/4PASS|960×700/1440×900, light/dark,2× headless Chrome; no Electron/native/GPU claim |
| Native practical Python/Java/C |PASS Mac/Windows atea3e079 and5489a3c|Actual installed tools, samples, paste→Undo→Redo, Save and preserved attempts|
| Offline Lens / direct-learning migration |PASS Mac/Windows atea3e079 and5489a3c|Actual filesystem/UI/IPC, security boundaries and retained local data|
| Full nativeea3e079 |12successful jobs,1failed,2unselected| Windows full job failed notebook kernel output and Learning Lens line decoration; Mac/installer/performance/Git/unit jobs passed |
| Native E/F5489a3c |FAIL before optional work on both platforms| New fixture waited for source inside unexpanded folder; no resource samples. Corrected test setup atc35371a; no product change |
| Full native5489a3c |Mac/Windows regression, Windows installer and both matched performance jobs PASS|New E/F fixture still failed; historical intermittent failures remain unexplained|
| Native E/F8c0ae1b |PASS both Mac and Windows|13checks/platform,20review/send/close cycles, invalid-context/provider guards, actual roadmap saves/conflicts, held-request shutdown and zero observed owned processes after exit|
| Live AI/provider teaching quality |NOT RUN|No user key/context sent; synthetic HTTPS responses only|
| Human learning/accessibility/hardware study |NOT RUN|No screen-reader, physical8GB, native scaling or four-hour study claim|

[Exact historical skip inventory](docs/performance/next-generation-test-skips.json) is scoped to the D checkpoint. Local final E/F still has26skips:25Windows-only checks plus opt-in live Maven/Gradle. Native Windows final8c0ae1b full suite:362total,347pass,15skip,0fail. The current and historical skip inventories are both recorded, with exact test names and reported reasons. Genuine Windows C/ConPTY tests do not turn skipped legacy-tool fixtures into passes.

## Failed evidence and test corrections

-43683773521: Git benchmark setup30s timeout thenEBUSY. RawexecFile lacked descendant ownership. Existing runner/Job ownership fixes test cleanup; original command slowness remains unexplained.
-43686655436: starter opened asynchronously; fixture edited too early and dirty-window teardown masked primary failure. Model readiness and primary/cleanup evidence now explicit.
-43687651636: multiline CDPinput Undo differs from coherent paste in both Ion and stockMonaco. Actual paste→Undo→Redo verifies intended behavior; production Undo unchanged.
-43688556658/43690648826: nativeapp://asset discovery and CDPnative Save accelerator assumptions corrected in fixture; real Save button plus disk evidence used.
-43691393265: Windows updater teardown. CR marker delivered, socketclosed, oldCIMqueryfailed; launcherPID differed frommain. ExactPID liveness/transport receipts added; later pass is not root-cause proof for that historical intermittent.
-43693605190: Lens root switch intentionally resets defaultRoadmap. Fixture now asserts reset before explicit reopen.
-43694512103: actual PythonConPTY framing prevented strict traceback classification. Narrow classifier-copy normalization at ea3e079 retains source/structure/exit/ambiguity guards and original output. Focused native Mac/Windows diagnostic journeys subsequently pass; no blanket classifier relaxation.
-43696455608: Windows notebook output and existing Learning Lens highlight timed out. Available logs do not identify root cause; bounded failure-only metadata added without increasing deadlines or retrying until green.
-43700858841: E/F fixture passed initial dormancy checks but waited for nested source before expanding its folder. `openFolder` waits for an immediate child; c35371a waits formain.c and explicitly expandssrc, with per-step failure location. Original failed artifact remains available; zero native AI resource samples are claimed from it.
-43701268755/c35371a: nested source setup now passes; optional resource inspection imported the editor wrapper, which exports only default, instead of the existing Monaco API. Safe fixture-line203 receipt identifies it; module lookup corrected at2af7d82 with no product change. No complete active-resource result is claimed.
-Localui-E-final: rebuilding dist during capture removed a loaded lazy asset, causing404. Entire run retained; unchanged tests against stable final assets pass4/4 inui-E-final-stable. That corrected run alone is final renderer evidence.

## Native Lens boundary

[Native D evidence](docs/performance/next-generation-D-native.json): Mac and Windows each10checks,7manifest handles opened/closed,0source/outside content reads during offline analysis, no skipped symlink fixtures. Tests cover exact owner/root/reference revision, quotas, explicit action, inert scripts, cancellation and unmount. Portable checks are not an OS sandbox or proof against all hostile concurrent ancestor races.

## Final renderer evidence

`performance-results/ui-EF-accessibility-final/report.json`:17assertions and12captures/case; source→AI→source retains exact original Monaco model/widget and Undo. Explicit review/send/cancel/citations, held configuration cancellation, proposal editing and actual bridge-save flow pass with a synthetic test bridge. One new Not Started milestone is saved; no tests/approvals/evidence are invented. No request/console/static errors. Twenty Content Settings cycles/case retain stable listener counts; native resources measured separately.

All full logs/failed reports remain in local ignored evidence or revision-specific GitHub artifacts. No deadline was raised, failing sample removed, security approval weakened or local Electron launched for this feature task.

## Confirmed roadmap accessibility correction

Detailed primary capture in43702058575/79fadc5 identifiesline441: exact Description label fill times out while the proposal remains present, selected and enabled. The earlier teardown error had hidden this primary failure; the corrected failure path now cancels work, explicitly discards only disposable proposal edits and exits cleanly.

Real headless Chrome reproduces populated nested-textarea label lookup counts: Title1, Description0, Acceptance0; explicit aria-labels make Description1/Acceptance1 and editing succeeds. Minimal production correction adds accessible names to Description, Acceptance criteria and Objective. No timeout or test selector was weakened. The full compiled-renderer journey now edits these fields and checks persisted description/criteria/goal. Native re-verification and repeated active-resource cleanup now pass at8c0ae1b; original failing samples remain retained. The proposed regex diagnosis was rejected after directly parsing source bytes: the actual existing regex was already correct; no such production/test fix is claimed.

## Subsequent native verification progress

At1432c8a, both real roadmap persistence and conflict/reload stages pass, preserving tests/manual status/approvals/evidence. Native Mac then fails the deliberately simulated provider-error stage: the fixture used Page.evaluate's callback convention with ElectronApp.evaluate. The latter passes Electron first and the selected value second; the transport mode therefore never became `http-error`. Test-only8c0ae1b uses the correct argument and asserts the applied mode before proceeding. No production behavior, error assertion or deadline is relaxed. Native verification subsequently passes all E/F checks at8c0ae1b, including20cycles and20/60s natural memory recovery.

Cancellation was requested for superseded runs43701268755/43701511606/43702058575/43702703220 after their failed focused evidence was collected, to free hosted runners.43701511606 had already completed(409); completed evidence remains intact. Any canceled remaining jobs are coverage gaps for those runs, not successes. Run43700858841 retains the completed full regressions/installers/matched performance; the latest source receives its own gates.

## Final E/F native evidence

Run[43702977386](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43702977386), product8c0ae1b. [Mac](docs/performance/next-generation-EF-native-macos.json) and [Windows](docs/performance/next-generation-EF-native-windows.json) each pass13end-to-end checks,20review/send/close cycles and normal held-request shutdown. Real OS safeStorage is available on both runners; credentials and HTTPS responses are synthetic. Existing unsaved code, saved source hashes, Undo, manual milestone status, tests, approvals and evidence remain intact.20cycle snapshots retain one editor and the same two legitimate open-file models; no added child process and0observed owned processes after shutdown. No live-provider/TLS/model-quality claim. Broader final-candidate regression/installer/paired benchmark jobs subsequently complete successfully in the same run.

## Final selected automated gate verdict

Exact source8c0ae1b, run43702977386: **13jobs successful,0failed,2unselected**. Mac full regression, real notebook, DMG verification; Windows full regression, installer/upgrade and recovery; complete Windows units; dependency security; Git/LFS/shutdown; three independent cold-C controls; both focused practical/Lens/E/F jobs; and both matched production benchmark jobs complete. Benchmark completion does not establish absence of a resource regression: the measured renderer footprint increase remains explicitly open.

Two unselected jobs are manually requested909attemptWindowsGCCdiagnostics and the independentpaired-startup diagnostic. The ordinary push does not select these workflow-dispatch lanes; existing four-pair startup measurements and three cold-C controls are different coverage. The rare historicalGCCdelay is not declared fixed. All26localMac and15Windows unit skips, with exact names/reasons, are listed in the current inventory. Optional live Maven/Gradle and consumerWindowsmanual tests, screen readers, physical8GB, four-hour sessions and live-model quality remain unverified.

Source and tests were reviewed before their feature-branch pushes; final documentation/numeric evidence passed whitespace, JSON parsing and commoncredential/privatepath scans. Synthetic credential marker strings are tests, not user keys. Documentation-only source handoff skips redundant CI; it does not claim a different application revision was tested. Installed application/profile, main, tags, releases, visibility and update feed remain unchanged.
