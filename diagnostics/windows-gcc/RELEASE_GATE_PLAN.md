# Isolated release verification plan

Baseline: published `38cf7ff333d02be298a71c4b5315d317d57157c6`.
Candidate: the five previously local optional tracing changes in `src/main/index.ts`, `runner.ts`, `windows-process.ts`, `run-console/engine.ts`, and `run-console/plans.ts`, plus their existing lifecycle/pipe regression tests. These exact source changes are reviewed in `evidence/optional-production-tracing.patch`. No execution deadline, ownership rule, code-generation feature, dependency or product UI is changed.

The new manual/reusable release workflow will run real hosted macOS and Windows application tests, build disposable installers for verification, and upload sanitized JSON evidence only. No installer binaries are published or uploaded. Installed Ion and live user profiles on the user's Mac remain untouched. Local Electron GUI launches remain prohibited; hosted macOS uses fresh VM profiles, separate from the previous unsafe local registration conditions.

Windows coverage adds a Java Scanner input fixture and explicit session-restoration and Markdown checks to the existing production suite. macOS adds an actual disposable Jupyter kernel fixture; viewing/editing alone is not reported as kernel execution. Existing exact prior-installer hash verification and real upgrade/rollback tests are retained.

Baseline and candidate builds for performance use identical locked dependencies on the same individual VM. Do not use `build:baseline` (it intentionally changes editor loading); the control is an ordinary production build of the exact baseline revision. Measurements retain per-platform RSS/attributed-footprint or working-set/private-byte meanings. Three trials estimate variability; differences inside noise are not improvements. The hardware is hosted, not a physical college laptop. No measured result exists until its workflow completes.

The rare historical GCC wait remains open and is assessed by risk and actual release gates. Observer errors remain failures; compiler result validity is recorded separately. Neither failure is erased. Release recommendations will be PASS/FAIL/UNVERIFIED by requirement, with one of the three requested final decisions, not an automatic publication.
