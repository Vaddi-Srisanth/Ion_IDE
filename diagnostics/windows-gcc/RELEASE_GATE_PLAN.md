# Isolated release verification plan

Baseline: published `38cf7ff333d02be298a71c4b5315d317d57157c6`.
Candidate: the five previously local optional tracing changes in `src/main/index.ts`, `runner.ts`, `windows-process.ts`, `run-console/engine.ts`, and `run-console/plans.ts`, plus their existing lifecycle/pipe regression tests. These exact source changes are reviewed in `evidence/optional-production-tracing.patch`. No execution deadline, ownership rule, code-generation feature, dependency or product UI is changed.

The new manual/reusable release workflow will run real hosted macOS and Windows application tests, build disposable installers for verification, and upload sanitized JSON evidence only. No installer binaries are published or uploaded. Installed Ion and live user profiles on the user's Mac remain untouched. Local Electron GUI launches remain prohibited; hosted macOS uses fresh VM profiles, separate from the previous unsafe local registration conditions.

Windows coverage adds a Java Scanner input fixture and explicit session-restoration and Markdown checks to the existing production suite. macOS adds an actual disposable Jupyter kernel fixture; viewing/editing alone is not reported as kernel execution. Existing exact prior-installer hash verification and real upgrade/rollback tests are retained.

Baseline and candidate builds for performance use identical locked dependencies on the same individual VM. Do not use `build:baseline` (it intentionally changes editor loading); the control is an ordinary production build of the exact baseline revision. Measurements retain per-platform RSS/attributed-footprint or working-set/private-byte meanings. Three trials estimate variability; differences inside noise are not improvements. The hardware is hosted, not a physical college laptop. No measured result exists until its workflow completes.

The rare historical GCC wait remains open and is assessed by risk and actual release gates. Observer errors remain failures; compiler result validity is recorded separately. Neither failure is erased. Release recommendations will be PASS/FAIL/UNVERIFIED by requirement, with one of the three requested final decisions, not an automatic publication.


## First full-gate findings retained

Run43606392000 preserved all909 successful diagnostic attempts, Windows installer/rollback acceptance, and complete matched ordinary production samples. It also caught a real file-save preflight defect: supplied content hashes were checked before mutation only when metadata differed. Same-size+restoredtime could swap first, preserve external bytes in a backup, then reject. The correction always checks supplied hashes before staging, retaining postexchange race protection. A deterministic real-filesystem test fails before/pass after on Mac; Windows verification is pending the next candidate. This is the only new production behavior in that follow-up. It adds a bounded fresh read/hash on a requested save and no idle service.

Other retained failures are test boundaries: historical PID0 access denial despite an already-recorded supervisor exit; parent-only intentional crash leaving Windows profile holders; CRLF output expectations; missing prebuilt ConPTY fixture; a macOS Python/package wheel mismatch; and an account-shell mismatch in the terminal benchmark. Corrections remain test-only. The missed Windows introduction phase has diagnostic state capture but no invented cause or production change. All these earlier failures remain separate from the next gate.

The terminal baseline now explicitly opts into the same shell workload. Baseline Windows metadata names the actual verified baseline commit. Failed benchmark trials are retained with partial data and cleanup state. The expanded Windows CI budget bounds two full three-trial benchmark builds and the additional interleaved workload; no application/compiler execution timeout is changed.
