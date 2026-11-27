# Phase 4 — Offline Practice

Practice offers Local Submit for all 27 built-in challenges in the existing Python, C, C++, Java and JavaScript starter languages. Each language needs its matching local toolchain. Search by title or topic, open a problem and try the visible examples. Local Submit runs the saved attempt against a separate set of local cases after the existing source review. Manually entered and lesson-specific problems retain Run samples.

## Judging and data safety

The main process loads the judge on request. Case selection comes from the saved catalog identity. Test inputs, expected answers and solver output stay outside the renderer and the submission ledger. The cases ship with the application and can be inspected locally. Programs execute with the user's permissions. These are practice results, not a secure competitive examination.

The runner uses a private source snapshot, an isolated working directory per input, and the existing limits on runtime and output. A changed digest, declined execution, cancellation or an unverified result preserves prior verdicts. An aggregate verdict records the date, number passed, case count and program runtime. Compilation and setup time are excluded from the reported runtime.

Each attempt retains its ten most recent verdicts. A changed file is marked historical. Restoring a backup makes its imported verdicts historical even if a source file has identical bytes. Public sample results, practice notes, source and manual completion remain separate.

## Evidence

Minutes to Clock has six judge cases. The other 26 problems have three each. Independent reference calculations check all 78 of those private cases and all 104 public examples for those problems. A real Python fixture exercises Minutes to Clock. A solution matching only the public examples fails the private cases, while a general solution passes. Unit cases also exercise compilation and runtime errors, output limits, cancellation, same-size file edits, private-output redaction, bounded history and restoration.

The hosted acceptance uses a disposable profile and the production Electron build. It exercises Python as the representative language. Individual fixture successes and native results are recorded against their tested commit. Extended stress testing and performance comparisons remain assigned to Phase 10.

## Catalog progress

Practice → Progress counts each of the 27 challenges once across attempts and languages. Opening a saved attempt, submitting a solution, and obtaining an accepted verdict are separate events. Accepted counts require a retained verdict for the current suite. Imported-only submission history is identified. An unreadable record produces an incomplete-count notice without changing the saved data.

Opening the tab requests one cancellable scan of problem metadata and verdict ledgers. Refresh requests a new scan. Closing the tab cancels an active request. The scan reads no source files and does not hold the write queue while iterating. A regression test pauses a real ledger read and saves notes on a different problem before resuming it.

The initial Local Submit candidate `7c065a21378db6db9b7203c7cfe9cb8599265d6c` passed the real Python submit, close and reopen journey on both platforms. The focused suites passed 73 tests on macOS ARM64 and 71 on Windows x64. Windows skipped the privilege-dependent backup symlink fixture and the C fixture because its runner had no configured C compiler. Neither skip affected the Python journey. [Native results](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45934035322)

The catalog progress candidate `a87fb41d886bc230f20d05f604552507aa89b0bb` passed 77 of 77 focused macOS tests and 75 of 77 Windows tests. Windows skipped the same two fixtures listed above. Both production desktop journeys submitted a solution, reopened the profile and displayed its saved progress. The local headless renderer also verified cancellation and stale replies when changing views. These results verify the built-in catalog and the tested journeys. Performance comparisons and certification of every compiler/challenge combination remain open. [Native progress verification](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45934414618)

## Progressive problem hints and sample feedback — 27 November 2026

Each of the 27 original offline problems now has two staged hints. The first hint is hidden until requested, and the second is revealed only after the learner asks again. Hints remain separate from the hidden local judge cases and are shown only in the selected problem preview. Failed visible sample comparisons identify the first output line that differs while retaining the expected and captured output. Nothing sends source or results to a provider.

Targeted macOS verification passed 38 practice-store/judge tests, including exact coverage for two non-empty hints on every original challenge and the existing hidden-case privacy checks. The production Electron Practice journey verified sequential reveal and then completed the existing five-language sample, persistence and offline flows. Typecheck and production build passed. Native Windows verification remains open.

## Solved-state catalog filter — 27 November 2026

The offline problem browser now filters to **Solved** or **Not solved** using retained local accepted verdicts for the current challenge suite. The progress scan starts only when one of those filters is selected. If any local record needed to establish progress is unreadable, the filter fails closed with a clear error instead of guessing that a problem is unsolved. Search, topic, difficulty and language filters continue to combine with solved status.

Targeted macOS verification passed **9/9 Practice tests**, including accepted/unsolved classification and fail-closed behavior for unreadable records; type checking and production build passed. The disposable production Electron journey exercised empty solved results, unsolved matches, all five starter languages and offline profile persistence. All feature assertions passed through relaunch, but the test process returned nonzero during final shutdown: after the test window closed, the inspector WebSocket completed its close handshake while Electron logged “Waiting for the debugger to disconnect” until the harness deadline. This is retained as a harness/shutdown verification issue; native Windows verification remains open.

## Current-build Practice journey recheck — 27 November 2026

After the Phase 3 production build, `node scripts/test-practice-submit.mjs` and the full `node scripts/test-practice-catalog.mjs` journey passed on macOS ARM64. The catalog journey covers all five language sample runners, challenge filters and preview, offline relaunch, persisted code/results, and clean desktop shutdown. One initial Java sample assertion timed out; an instrumented rerun and a subsequent unmodified rerun both passed, so the existing deadline was retained. The earlier shutdown timeout did not reproduce. This is a targeted current-build recheck, not a new native Windows run or an exhaustive all-language judge qualification.
