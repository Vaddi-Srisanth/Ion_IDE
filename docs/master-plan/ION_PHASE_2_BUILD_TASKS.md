# Ion Phase 2.5 — Build and tasks

Status: **COMPLETE for the accepted reviewed-adapter foundation — native acceptance PASS; broader task capabilities remain technical debt**
Branch: `codex/ion-core-excellence-phase-2-tasks`

Production candidate: `036781e7fe99be4480e5f0803fb6b22124be72a8`

Matched-performance harness: `bf27e86e4914e5f144812dce8f5d8d3dad49d5fe`

Final functional/full-regression harness: `c7b925caf6aef4e7956301692007330a0e3e1d08`

Accepted pre-task baseline: `99acaaa4bac7239d3f2b8dff672b51ea777cb4d3`

## Implemented scope

- A lazy **Run Task** picker and configurable `Cmd/Ctrl+Shift+B` command.
- Static, bounded inspection of top-level `Makefile`, `CMakeLists.txt`, `package.json`, `pyproject.toml`, `pom.xml`, Gradle, Cargo and Go manifests.
- Profile-owned declarative task records with optimistic revisions. Records contain an adapter, selector, workspace-relative authority and source revision; they do not store a shell command, executable path, environment, approval or repository trust.
- Deterministic, bounded dependency graphs with cycle, depth, fan-out and size rejection.
- Trusted tool discovery outside the workspace and exact review of executable, arguments and working directory before every run.
- Execution through Ion's existing bounded interactive runner and Run Console, including ANSI output, stdin, terminal resize, timeout, Stop and process-tree cleanup.
- Stale manifest, changed workspace, removed root and changed task-record rejection before execution.
- Lazy UI and backend loading. Ordinary editing performs no task discovery, starts no process and adds no listener or polling service.

## Security decisions

- Discovery never executes a manifest, wrapper, package script or repository binary.
- Workspace-controlled executables and PATH precedence are rejected by the existing canonical trusted-tool discovery boundary.
- `package.json` script bodies are validated only for bounded plain-text shape during discovery, then discarded. The stored record retains only the script name. npm resolves the current script after explicit review and launch.
- Build tools can execute project-controlled build logic. The consent surface states this explicitly and is required for every run; task history is not permission.
- The renderer cannot submit an executable, environment or argument list. Main-process adapters construct the plan from a validated task record and current trusted tool discovery.
- Root removal, workspace replacement, Stop and window close cancel the active owner. Shutdown drains the task repository and running graph.

## Local verification

| Gate | Result |
| --- | --- |
| Focused task unit/security tests | 6 passed, 0 failed |
| Full unit/security suite | 487 total: 461 passed, 26 explicit skips, 0 failed |
| Type checking | Passed |
| Production build | Passed |
| Lazy production chunk | `TaskPicker` JavaScript approximately 2.1 kB plus approximately 1.1 kB CSS in the current minified build |

The 26 full-suite skips are existing Windows-only ConPTY/Job Object/filesystem fixtures and unavailable optional tool fixtures on this macOS host. They are preserved and are not counted as passing.

## Native evidence and acceptance scope

| Run | Application / harness identity | Verified scope |
| --- | --- | --- |
| [45880915552](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45880915552) | App `d5d89e19b6a10b0727071c2283c6774baf1b842d`; harness `8e37843c83004fd891b0479fb36006a5f8f5bb25` | Both native hosts passed full unit/security, typecheck, build, six task tests, production Electron discovery, approved npm execution, Stop and descendant cleanup. macOS: 487 tests, 461 passed, 26 skipped. Windows: 477 tests, 460 passed, 17 skipped. No failures. |
| [45881531677](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45881531677) | Same app; harness `8c306d232ccdb87119f46c92056e67ff5cfd1c16` | Both hosts passed the production task journey with added idle/active CPU observations. This run did not repeat the full suite. |
| [45923748325](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45923748325) | App `036781e7fe99be4480e5f0803fb6b22124be72a8`; harness `bf27e86e4914e5f144812dce8f5d8d3dad49d5fe` | Both hosts passed typecheck, production builds, lazy-bundle assertions and matched unused-task performance gates. This run did **not** execute a task or run the full unit/security suite. |
| [45924540081](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45924540081) | Same final app; harness `c7b925caf6aef4e7956301692007330a0e3e1d08` | Both hosts passed typecheck, production build, lazy-bundle assertions, full unit/security suites, production task discovery, approved npm execution, Stop and owned cleanup. macOS: 487 tests, 461 passed, 26 skipped. Windows: 477 tests, 460 passed, 17 skipped. Zero failed/cancelled tests. |

The final production correction changes bundling and dynamic-import resolution, so earlier execution evidence alone was insufficient. Run `45924540081` closes that gap by loading and running the newly separated backend on both native hosts. It deliberately skips the baseline checkout/build and matched comparison steps because the successful comparison already covers the same immutable application/build source. These workflow skips are not missing functional tests.

The accepted slice is the bounded adapter foundation described above. The directive's broader saved workspace task definitions and safe problem matching are still pending; profile-owned discovered records do not fully satisfy those capabilities. Native execution coverage currently proves npm, while the other adapter plans have unit/static coverage and need representative toolchain journeys before broader native claims. This checkpoint does not declare all professional task functionality complete.

The Windows skips include macOS metadata fixtures, POSIX terminal/link/search-cleanup fixtures, unavailable optional Maven/Gradle tooling and environment-dependent runtime fixtures; all original skip records remain in `unit.log`. Platform totals differ because platform-specific test registration differs. Neither suite's skips are counted as passes.

The native hosts used Node `24.22.2` and npm `11.19.1`. UTM ARM64 was not used for these Windows x64 results. All Electron launches used disposable hosted profiles, preserving the local macOS registration-crash precaution.

### Final-build task journey resource observations

Run `45924540081` performs one successful disposable npm task and one long-running npm task stopped through the Run Console. The renderer is offline and reports no unexpected network requests or runtime errors. Approved task completion took **1,402 ms on macOS** and **2,875 ms on Windows**, including UI launch and completion observation.

| Phase | macOS summed RSS | macOS CPU, % one core | Windows working set | Windows CPU, % one core |
| --- | ---: | ---: | ---: | ---: |
| Before opening picker | 389.52 MiB | 8.691% | 300.97 MiB | 0% observed |
| Picker open | 397.61 MiB | 0.805% | 305.60 MiB | 0% observed |
| After successful task | 402.52 MiB | 0.800% | 318.39 MiB | 0% observed |
| After Stop | 412.00 MiB | 0.808% | 319.46 MiB | 0% observed |

The active waiting task measured 0% CPU on both hosts in its short observation interval. Each printed phase had zero external child RSS after the relevant cleanup. The process family was closed by the fixture's normal shutdown path. These are single-journey observations sampled over 1.2 seconds, not steady-state averages or long-term leak measurements; Windows 0% means no CPU increment was observed at the probe's resolution. The early macOS sample is not a settled idle baseline. Use the matched ten-second measurements below for unused-feature cost.

## Confirmed startup bottleneck and correction

The first completed matched comparison, [45922846266](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45922846266), failed the macOS warm-start gate: baseline median **631.17 ms**, candidate **779.96 ms**, **+23.57%**. Windows passed that run. Inspection found that `scripts/build.mjs` omitted `tasks/service` from the existing optional-service entrypoints and externalization rule. Esbuild consequently included the task backend in the eager main bundle despite the source's dynamic import.

Commit `036781e7fe99be4480e5f0803fb6b22124be72a8` adds the missing backend entrypoint and applies the existing optional-service rule. The eager main bundle falls from **303,441 bytes to 291,846 bytes**, compared with **289,386 bytes** before tasks. The task service becomes a separate **19,092-byte** chunk. No application execution policy, file-safety rule, timeout or dependency changed.

The new matched run clears the startup gates, but its broader latency differences should not all be attributed to this two-line bundling correction: hosted-runner scheduling and filesystem caches vary. The measured improvement establishes that the final candidate meets the current matched budget; it is not a universal speedup claim.

## Matched unused-task performance

Run [45923748325](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45923748325) uses four serialized AB/BA pairs, a fresh profile per attempt, Minimal mode and identical 80-line C source. Each attempt cold-starts, shuts down, warm-starts, opens the first file, inserts twenty characters and samples the complete process family six times over ten seconds. Startup ends when Settings is observable. Typing measures Monaco content change to the second animation frame; it is a presentation proxy, not physical key-to-photon latency.

| Metric (median) | macOS baseline | macOS candidate | Windows baseline | Windows candidate |
| --- | ---: | ---: | ---: | ---: |
| Cold startup | 1,077.50 ms | 875.62 ms (-18.74%) | 1,657.69 ms | 1,721.26 ms (+3.83%) |
| Warm startup | 535.12 ms | 482.49 ms (-9.83%) | 1,635.98 ms | 1,487.06 ms (-9.10%) |
| First file | 774.56 ms | 509.66 ms (-34.20%) | 420.90 ms | 396.75 ms (-5.74%) |
| Typing proxy | 30.70 ms | 30.80 ms | 27.90 ms | 28.10 ms |
| Idle CPU, % of one core | 1.930% | 1.422% | 0.058% | 0.239% |
| Summed process RSS / Windows working set | 454.70 MiB | 455.17 MiB | 349.99 MiB | 353.24 MiB |
| macOS attributed footprint / Windows private bytes | 168.49 MiB | 171.52 MiB | 178.64 MiB | 183.08 MiB |
| Owned process count | 4 | 4 | 4 | 4 |
| External child processes | 0 | 0 | 0 | 0 |

macOS host: macOS 15 / Darwin `24.6.0`, ARM64 Apple M1 Virtual, three logical cores, 7 GiB RAM. Windows host: Windows Server 2025 / `10.0.26100`, x64 AMD EPYC, four logical cores, approximately 16 GiB RAM. Summed RSS/working sets may count shared pages repeatedly and are not interchangeable with footprint/private bytes.

Candidate memory increased by **0.47 MiB RSS / 3.03 MiB footprint** on macOS and **3.25 MiB working set / 4.44 MiB private bytes** on Windows. Windows idle CPU increased by **0.181 percentage points of one core** in this short sample. These are recorded costs, not claimed savings. All sixteen build attempts across both hosts passed, the TaskPicker chunk stayed unloaded, no task child process started, and every owned process family was empty after shutdown.

### Individual latency samples and outliers

Each cell lists baseline / candidate in milliseconds. No slow sample is discarded.

| Platform / pair | Cold startup | Warm startup | First file |
| --- | ---: | ---: | ---: |
| macOS 1 (AB) | 3,432.30 / 968.99 | 572.20 / 608.96 | 952.99 / 496.01 |
| macOS 2 (BA) | 1,179.35 / 664.41 | 493.55 / 380.11 | 413.55 / 523.30 |
| macOS 3 (AB) | 884.71 / 1,294.40 | 498.04 / 526.10 | 596.13 / 621.83 |
| macOS 4 (BA) | 975.64 / 782.25 | 685.80 / 438.89 | 1,103.60 / 421.77 |
| Windows 1 (AB) | 3,714.81 / 4,208.59 | 1,651.68 / 1,497.57 | 1,162.83 / 399.89 |
| Windows 2 (BA) | 1,508.72 / 1,650.61 | 1,620.27 / 1,638.05 | 403.77 / 433.86 |
| Windows 3 (AB) | 1,799.88 / 1,791.91 | 1,784.93 / 1,476.55 | 438.02 / 393.62 |
| Windows 4 (BA) | 1,515.50 / 1,492.41 | 1,453.83 / 1,471.84 | 398.92 / 388.14 |

With four startup samples per build/platform, nearest-rank p95 equals the maximum and does not establish a stable population tail. The eighty typing observations per build had macOS baseline/candidate p95 **47.2/47.4 ms**, maximum **254.9/48.9 ms**; Windows p95 **29.1/29.2 ms**, maximum **29.8/30.2 ms**. Full stage/process data and sample ordering remain in each run artifact's `paired-unused-resources.json`.

## Preserved intermediate failures

- [45922138259](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45922138259): cancelled after the harness waited for a DOM input event not guaranteed by CDP text insertion. The correction observes the actual Monaco model-change event and bounds that observation; production code was unchanged.
- [45922846266](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45922846266): macOS warm-start budget failed; Windows passed. The eager task-backend bundling defect was subsequently corrected as described above.
- [45923549384](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45923549384): both jobs failed before measurement because the verification assertion depended on unavailable `rg` (exit 127). The correction uses Node's built-in file reading and assertions.

These failures are retained alongside the successful run. None was cleared by raising timeouts or discarding samples.

## Known limitations

- Discovery is intentionally limited to top-level manifests and reviewed built-in adapters. Arbitrary custom shell tasks are not supported.
- Make/CMake/npm/Python/Cargo/Go use trusted installed tools where available. Native Windows Maven/Gradle launcher coverage is not yet claimed by this milestone and must be reported accurately by native acceptance.
- Tasks run sequentially; parallel graphs, problem matchers, background/watch tasks and user-authored task schemas are deferred.
- General Test Explorer work remains Milestone 2.6. Existing Project Tests are preserved and were not replaced.
- Task definitions are profile-owned and rediscoverable, not embedded in `.ion-workspace` files. npm resolves the current script only after explicit execution approval; it can execute project-controlled code.
- CMake's approved build directory is `.ion/cmake-build`. Python invokes isolated `compileall`; the current native journey does not verify Python's generated-file behavior. Discovery itself does not run these tools.
- Four matched pairs establish this bounded acceptance workload, not long-session leak freedom, laptop battery usage or performance on all hardware.

## Verdict

The **reviewed adapter foundation passes** native macOS ARM64 and Windows x64 functional, full regression, startup/resource and cleanup gates on application `036781e7fe99be4480e5f0803fb6b22124be72a8`. Broader Phase 2.5 requirements remain open: saved workspace task definitions, safe problem matching and representative native journeys for the remaining adapters. No release or installed-app change is part of this checkpoint.
