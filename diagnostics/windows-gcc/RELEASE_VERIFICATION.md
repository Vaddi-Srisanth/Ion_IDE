# Final diagnostic and release-verification report — 14 November 2026

**Recommendation: CONDITIONAL RELEASE WITH DOCUMENTED RISKS, for the unsigned/ad-hoc personal-project preview.** This is a recommendation, not a release. No main commit, tag, installer publication, update-feed change, installed-app replacement or real-profile migration was performed. No active P0 was reproduced after the save correction within the tested scope. Historical GCC latency remains open; actual hardware, signing and final publication gates remain distinct.

## Exact revision and evidence boundaries

Control `38cf7ff3`; corrected production source `62b4140`, tree `374fea171ef92bf6a7a7e0045e0bd5816f631c17`. Later commits `bc90d00`, `0020e92`, `d0d61a5` change tests/workflows only. Runtime main hashes match across the performance and startup controls. Five existing optional tracing edits were included explicitly; the only subsequent application behavior change is `WorkspaceFiles.save` in `src/main/files.ts`.

| Run / source | Actual overall result | Meaning |
| --- | --- | --- |
| [43600747226 /05dde34](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43600747226) | FAIL | Original 909 attempts: 907 successful, two observer errors, zero timeouts. Historical rows retained. |
| [43604680641 /6df9d48](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43604680641) | FAIL | New structured instrumentation reproduced one observer count error after successful GCC exit among 909 attempts. |
| [43606392000 /2fdd3da](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43606392000) | FAIL | All 909 corrected diagnostic attempts passed; broader gates found the save-preflight defect and test-environment issues. Do not relabel this workflow green. |
| [43608465391 /62b4140](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43608465391) | FAIL | Mac complete desktop/DMG, Windows installer and benchmark passed. Windows unit/cold observer hit the new PS5 array bug; full desktop stopped Git LFS preflight. |
| [43609270122 /bc90d00](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43609270122) | PASS selected jobs | Six requested jobs passed: complete Windows units, three cold C jobs and both matched performance jobs. Five other jobs intentionally not selected, not retroactively passed. |
| [43609912778 /0020e92](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43609912778) | PASS selected job | Default/direct genuine Git LFS, configuration-race security and independent full shutdown verification. Other suites not selected. |
| [43610901658 /d0d61a5](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43610901658) | PASS selected jobs | Twenty balanced startup pairs per platform, 160 normal exits; other suites not selected. |

This is revision-qualified gate evidence across matching application source, **not a claim that either failed combined workflow passed**. A future publication must require a fresh complete combined run for its exact final tag/artifacts and explicit user authorization. That tag/release gate remains UNVERIFIED because publication is prohibited here.

## Confirmed observer root cause

In `diagnostics/windows-gcc/scripts/windows/gcc-direct-powershell.ps1`, `Members` rejected every `listed != assigned` snapshot. `Drain` called it after compiler exit. Native host C /warm-77-A at `6df9d48` returned assigned 2/listed 1 and threw `System.InvalidOperationException`, operation `job-member-counts`, lifecycle stage `cleanup`; GCC exit 0, output complete and final cleanup true. The original two older exceptions were not exported, so their exact exception type is still unknown; this is a matching reproduced defect, not retroactively invented data.

[Microsoft documents a valid returned PID prefix](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_process_id_list). The correction treats partial lists only as positive observations. Neither missing-child inference nor drain proof uses an incomplete list. `Drain` independently requires `JOBOBJECT_BASIC_ACCOUNTING_INFORMATION.ActiveProcesses == 1` plus verified membership of the live controller. Pre-spawn membership remains complete/self-only; exact child-handle membership, kill-on-close, output/count bounds and existing 15-second compiler /2-second direct-observer cleanup deadlines remain intact. Invalid counts still fail.

The regression compiles and executes the actual pure C# policy: old 2/1 throws; the corrected path recognizes partial data, cannot falsely infer absence, and cannot drain active 2 or an unowned controller. Actual accounting layout 48 bytes/active offset 40 is checked. Native post-fix 909/909 attempts pass with zero observer errors/timeouts and complete owned cleanup. No partial-list snapshot occurred in that post-fix cohort; the deterministic regression exercises the exceptional path. No exception is converted into a successful compiler sample.

## Confirmed file-integrity defect and minimal correction

`WorkspaceFiles.save` previously checked a supplied `baseHash` before mutation only when the metadata revision changed. Equal size and restored timestamp can preserve a Windows metadata token. The atomic exchange then wrote the editor content and only afterward detected the external hash mismatch in its preserved backup. `FILE_CHANGED` was correctly reported and external bytes survived in a backup, but the original target had already changed.

The new guard validates stable current bytes whenever a base hash is supplied, regardless of matching metadata. Existing native post-exchange checks/backup preservation still protect interleaved writers. A real-filesystem fixture supplies a current metadata token with the editor's earlier hash to deterministically enter the collision branch on Mac; it failed before (`my unsaved changes` on disk instead of `external`) and passes after, also proving no staging/backup artifact was needed. Original Windows same-size/restored-time and the new deterministic fixture pass in the complete native Windows suite. Current renderer saves supply base hashes. Hashless legacy calls retain their earlier metadata-only limitation; this correction does not promise a global filesystem transaction against arbitrary external writers.

Resource effect: one bounded fresh read/hash on requested hash-supplying saves; no idle work, cache, service or editor recreation. [Measured ordinary-workflow impact](FINAL_PERFORMANCE.md). The near-limit large-save peak was not independently measured.

## Additional test and measurement corrections

| Finding | Root cause / smallest correction | Actual verification | Remaining limit |
| --- | --- | --- | --- |
| Historical-PID cleanup assertion | [Node 24’s `process.kill(pid,0)` implementation](https://github.com/nodejs/node/blob/v24.22.2/deps/uv/src/win/process.c) requests termination rights on Windows and checks reusable numbers. Original PID 7484 had already emitted exit 0/close/cleanup at 105.54 ms;4.8 s-later EPERM cannot prove that supervisor survived. Add limited-rights handle wait, creation/image evidence and actual GCC PID bindings. | Three native cold jobs:51 controlled runs,194 unique-PID observations,193 gone and one demonstrably reused, zero live-owned/unverified. | This proves a real reuse case in the new cohort, not the exact cause of the older EPERM. Unknown/denied remains failure. |
| New PS5 probe failure | `@(ConvertFrom-Json ...)` nested a returned JSON array in Windows PowerShell 5. Use direct typed `uint32[]` conversion. | Actual PS5 singleton/multiple/512/max and invalid-array tests pass; complete Windows suite 253 pass/15 skip. | Windows-only test is skipped on Mac, never called a Mac pass. |
| Intentional crash/reopen | Session fixture killed only Electron main; Chromium children retained profile locks. Use captured live process tree termination before relaunch. | Real Windows same-profile third launch restores ordered tabs, cursor, selection, notebook JSON and drafts. | Forced-test teardown is not a new production shutdown manager. |
| Windows-only fixture assumptions | ConPTY test ignored the already-built helper; practice tests assumed LF output; root-trash assertion assumed Mac wording. Use existing helper environment and exact platform messages; normalize CRLF only in assertions. | Complete Windows units and actual ConPTY tests pass. | Application output and safety rules are unchanged. |
| Mac notebook setup | System Python could not install pinned pandas wheels. Explicitly select Python 3.12 for disposable kernel tests. | Real kernel execution/interrupt and same-kernel continuation pass; notebook trust/cleanup gates pass. | Setup downloads test dependencies; ordinary app operation remains offline. |
| Terminal benchmark | Baseline label skipped terminal workloads; zsh-only prompt fixture ran under an unconfigured runner shell. Opt into matched shell workloads and configure only the ephemeral account. | Both real production builds run n=3, two sessions, hide/close and create/close cycles. | No user shell/settings changed. |
| Benchmark evidence | Failed trials could disappear; baseline metadata named candidate; abnormal exit could be called cleanup. Persist incomplete/partial receipts, correct baseline identity and require normal exit. | Actual failure-receipt tests, strict sanitized collection tests and final matched native runs pass. | Normal-exit receipts alone do not certify every descendant; separate native cleanup gates do. |
| Intro transient / Git LFS preflight | One intro phase was missed; one later Git LFS preflight failed without original error details. Preserve state/structured failure details rather than inventing causes or extending deadlines. | Later unchanged production intro and both LFS routes pass; original failures remain. | These two earlier transient causes are unclassified, not claimed fixed by a rerun. |

The only new production behavior after `2fdd3da` is the supplied-hash preflight; other corrections above are test tooling. No dependencies, compiler timeouts, execution approval boundaries, GPU acceleration, renderer design or frameworks changed.

## Compiler timing and historical issue

Latest compiler cohort: three `windows-2022` x64 hosts, GCC 14.2.0 at `C:\mingw64\bin\gcc.exe`, target `x86_64-w64-mingw32`, Node 24.22.2, Electron 45.2.3, PowerShell 7.6.10.909 planned/executed/successful;0 timeouts;0 observer errors. All three persistent Node hosts and 606 one-shot A/C controllers were observed closed; all compiler jobs reported complete output and verified owned cleanup. Exact tool hashes/environment receipts are in the artifacts.

A=direct PowerShell/.NET GCC; B=Ion Node pipe runner; C=Ion Electron execution engine. Below are warm per-host 100-sample primary request→finalized intervals, milliseconds, nearest-rank p 95/p 99 with no filtering. These include differing observer/supervisor costs and are not pure compiler CPU or full renderer/Run Console latency.

| First-lane host / lane | Warm n | Median | p 95 | p 99 | Max |
| --- | ---: | ---: | ---: | ---: | ---: |
| B / A | 100 | 68.30 | 74.89 | 100.28 | 100.82 |
| B / B | 100 | 67.10 | 73.02 | 77.10 | 99.85 |
| B / C | 100 | 77.83 | 86.35 | 95.45 | 104.59 |
| C / A | 100 | 69.62 | 76.68 | 80.75 | 119.11 |
| C / B | 100 | 69.90 | 78.39 | 81.16 | 83.84 |
| C / C | 100 | 80.35 | 88.62 | 97.66 | 112.49 |
| A / A | 100 | 94.03 | 103.61 | 107.32 | 107.45 |
| A / B | 100 | 93.08 | 105.20 | 108.20 | 113.19 |
| A / C | 100 | 111.57 | 127.09 | 137.70 | 142.95 |

Maximum across all 909 primary intervals was 2861.10 ms, on an initial compiler exposure. That does not explain the historical 12673.68 ms sample or its 12622.26 ms READY→CLEAN interval. For example the retained first-B trace records spawn request 0.7481 ms, supervisor spawn 3.5769, READY 5.4568, CLEAN 2212.6919, stdout end 2213.6994, stderr end 2213.8574, supervisor exit callback 2214.2646, close 2214.5484, finalized 2214.7620 and result delivered 2214.7788 ms, all one local monotonic clock. Successful compilation need not emit stdout. [Exact sanitized trace](sanitized-results/representative-compiler-timeline.json).

**OPEN: historical GCC delay.** Independent GCC/cc 1/linker kernel-exit and native reader-shutdown start timestamps are not available in lanes B/C; READY→CLEAN cannot be assigned entirely to GCC. No ETW/antivirus attribution or security-software disabling occurred. A clean small-source CI cohort is not a prevalence estimate for real projects. Existing limits/Stop and truthful compiler errors mitigate a rare slow operation, but do not explain it. No “fixed” label is applied.

## Final release-verification matrix

| Requirement | Environment / evidence | Result | Remaining risk |
| --- | --- | --- | --- |
| Observer policy / ownership | Deterministic compiled regression + three Windows 2022 hosts /909 attempts | PASS | Special partial branch tested deterministically; no claim of universal absence of observer faults. |
| Save integrity, conflicts, Unicode, metadata | Mac native units/desktop; Windows 268-case suite, scoped filesystem fixtures and desktop integrity | PASS | Hashless legacy API limitation; external concurrent mutations still use explicit preserved-conflict handling. |
| Recovery / session / Undo-Redo | Hosted Mac and Windows actual editor flows, crash/reopen and recovery durability checks | PASS | Abrupt power loss/physical-disk failure is not simulated. |
| C/C++/Java Scanner/Python input/JS; Stop/Rerun | Actual Windows desktop; Mac production regression; three cold Windows C jobs | PASS | Installed local toolchains required; no compiler bundled. |
| Terminal / ConPTY / zsh | Native real shells, resize/input/hide/multiple sessions; complete shutdown fixtures | PASS | No physical Windows-console/display certification. |
| Git security / LFS / saved project tests | Race fixture both OS; default/direct six-case LFS runs; actual saved-suite GUI | PASS current checks | One earlier unclassified LFS availability failure remains historical, not a claimed production fix. |
| Optional learning, themes, Markdown, document and notebook flows | Hosted actual workbench suites; real Jupyter kernel fixture | PASS tested paths | Optional external formatter/PPTX conversion coverage is limited below; online AI calls not exercised. |
| Mac DMG / packaged launch | Exact 62 b 4140 disposable image: integrity, structure, permissions, ad-hoc signing, mount/copy, app launch/recovery and normal exit | PASS preview policy | Developer ID/notarization and user's macOS 27 registration conditions UNVERIFIED. |
| Windows installer / upgrade / rollback | Exact 62 b 4140 NSIS candidate against checksum-pinned public 0.9.6, disposable install/profile | PASS preview policy | Unsigned preview; retail desktop policies/SmartScreen not certified. |
| Resource cleanup |194 native PID identity observations; Windows 24 startup/shutdown cycles plus live program/shell/suite cancellation; Mac full shutdown | PASS bounded workloads | Not an indefinite/four-hour leak guarantee. |
| Matched performance / dormant tracing | Both platforms n=3 + n=20 startup, exact hashes and same-host controls | PASS measurement; CONDITIONAL budget judgment | Mac warm median+54.40 ms; other short-window regressions retained. No claimed RAM optimization; source causality unproven. |
| Dependency/security review | Hosted npm audit high gate; intended-file credential pattern scan; reviewed source scope | PASS scoped review | Not a formal penetration test or proof of vulnerability absence. |
| Physical 8 GiB hardware / four-hour run / physical input latency | Not available | UNVERIFIED | Hosted Mac has 7 GiB allocation; that is not physical-hardware evidence. |
| Entire final-tag publication pipeline | Prohibited here; earlier two combined runs remain FAIL | UNVERIFIED / not authorized | Require a fresh combined tag run and user publication authorization before distribution. |

## Tests, skips and resource interpretation

Final local non-GUI Mac:276 total,250 passed,0 failed,26 skipped. Hosted Mac complete workbench at `62b4140`:274 unit cases,249 passed,25 skipped; later two observer tests are tooling-only and have local/native Windows evidence. Complete Windows suite at `bc90d00`:268 total,253 passed,0 failed,15 skipped. Native PS5 conversion is included. Supplemental sanitizer/workload tests:11 passed,0 skipped. Type checking and production builds pass. The original restricted local terminal test's EPERM and its unrestricted passing counterpart are both retained; it was process-inspection permission, not an ignored failure.

[Exact skipped-case inventory and coverage gaps](TEST_VERIFICATION_MATRIX.md). Mac skips are Windows-specific checks plus the flag-gated Windows JVM-build fixture; Windows equivalents actually run natively. Windows skips include Mac-only metadata/shell cases, symlink/permission capability gaps, and legacy no-cwd compiler-discovery fixtures: their “no compiler” reason does not mean GCC was absent. Scoped Windows RunPlan/GCC execution and source-snapshot protections have separate real native coverage. Ruff/Black are absent in GUI formatting fixtures. LibreOffice PowerPoint visual conversion, hardware/accessibility, authenticated signing, online providers and long-session coverage are not claimed passing.

Full memory, CPU, tab/file/typing proxies, all positive and negative deltas, environment, role attribution, terminal state and uncertainty are in [FINAL_PERFORMANCE.md](FINAL_PERFORMANCE.md) and [numeric data](sanitized-results/final-measurements.json). Windows working set/private bytes must not be compared directly with Mac attributed footprint/RSS. No new background resource owner was introduced. The source phrase “optimized” is not substituted for measurements.

## Delivery and reproduction

Branch only: `codex/ion-gcc-hosted-diagnostics`. Manual workflow `desktop-build.yml` selects `diagnostic` / `all` / `release` / `performance` / `follow-up` / `git-checks` / `startup`. `all` runs 909 diagnostics then full gates; `startup` runs 20 balanced pairs per OS. Workflows use bounded jobs/output and sanitized evidence-only artifacts with 14-day retention. No automatic uploads outside Actions artifacts; no installer binaries uploaded. Local copies of all downloaded cohort ZIPs/JSON remain in ignored `performance-results/gcc-actions-runs/`, checksum verified. [Manifest of preserved observer failures](sanitized-results/observer-failures.json). Raw historical source/archive evidence was not deleted or rewritten.

Do not publish on this report alone. Resolve any newly observed P0, review exact future publication changes, run the combined tag gates and obtain the user's permission. The unresolved rare delay, small Mac warm-start cost, preview signing and hardware limits justify the conditional recommendation; they are not disguised as completed fixes.
