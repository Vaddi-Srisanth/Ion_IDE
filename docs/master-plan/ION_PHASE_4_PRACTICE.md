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
