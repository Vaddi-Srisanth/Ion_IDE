# Phase 4 — Offline Practice

Practice offers Local Submit for all 27 built-in challenges in the existing Python, C, C++, Java and JavaScript starter languages. Each language needs its matching local toolchain. Search by title or topic, open a problem and try the visible examples. Local Submit runs the saved attempt against a separate set of local cases after the existing source review. Manually entered and lesson-specific problems retain Run samples.

## Judging and data safety

The main process loads the judge on request. Case selection comes from the saved catalog identity. Test inputs, expected answers and solver output stay outside the renderer and the submission ledger. The cases ship with the application and can be inspected locally. Programs execute with the user's permissions. These are practice results, not a secure competitive examination.

The runner uses a private source snapshot, an isolated working directory per input, and the existing limits on runtime and output. A changed digest, declined execution, cancellation or an unverified result preserves prior verdicts. An aggregate verdict records the date, number passed, case count and program runtime. Compilation and setup time are excluded from the reported runtime.

Each attempt retains its ten most recent verdicts. A changed file is marked historical. Restoring a backup makes its imported verdicts historical even if a source file has identical bytes. Public sample results, practice notes, source and manual completion remain separate.

## Evidence

Minutes to Clock has six judge cases. The other 26 problems have three each. Independent reference calculations check all 78 of those private cases and all 104 public examples for those problems. A real Python fixture exercises Minutes to Clock. A solution matching only the public examples fails the private cases, while a general solution passes. Unit cases also exercise compilation and runtime errors, output limits, cancellation, same-size file edits, private-output redaction, bounded history and restoration.

The hosted acceptance uses a disposable profile and the production Electron build. It exercises Python as the representative language. Individual fixture successes and native results are recorded against their tested commit. Extended stress testing and performance comparisons remain assigned to Phase 10.
