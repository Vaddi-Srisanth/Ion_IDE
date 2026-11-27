# Ion Phase 2.6 — Test Explorer

Status: **PASS for the Phase 2.6 adapter foundation**

Branch: `codex/ion-core-excellence-phase-2-tests`

Starting checkpoint: `23dff68` (Build/Tasks adapter-foundation native evidence).

The pytest foundation `329789c` and preservation checkpoint `2c025c5` predate the final acceptance. Both native hosts tested application and harness `fee7580cf3a107f54126dff7daa1d0e683a3198d`. Public v0.9.9 contains accepted work through Phase 2.5.

## Implementation sequence and acceptance

1. Shared test discovery, execution, result/history and lifecycle interfaces; one complete pytest journey.
2. Real Java/JUnit and Jest/Vitest adapters using reviewed installed tooling.
3. Targeted production Electron acceptance on macOS ARM64 and Windows x64 with critical data-safety and approval regressions. Expanded resource measurements and long stress sessions belong to Phase 10.

The first slice does not complete Milestone 2.6. Framework discovery must produce real framework test identities; static method-name scanning or a successful task exit cannot substitute for individual test evidence.

## First slice

The command palette and Run menu open a lazy Test Explorer. Opening it reads saved metadata only. Users choose an authorized root, explicitly request discovery, review the executable and arguments, then select a case, file group or all cases. Failed cases can be selected again. Existing saved C behavior tests keep their original UI and approvals and remain accessible from this view.

pytest collection executes imports and configuration, so both discovery and execution require a native approval dialog. Ion uses an installed Python outside all workspace roots and an Ion-owned reporting helper through the existing bounded process runner. No download, watch process or test collection occurs at editor startup. The environment disables automatic third-party pytest plugin loading; projects requiring those plugins are not yet claimed supported.

Tests operate on saved files. Dirty/conflicted editor buffers block the UI request. Source/configuration revisions and root authority are rechecked around approval and execution. Test results are evidence of the observed run, not proof that every external dependency was immutable.

The reporter records actual parameterized identities, setup/call/teardown outcomes, skipped tests, durations and bounded error/output excerpts. Exit zero alone is insufficient. Missing/truncated reports and incomplete cleanup cannot become passing results. Cancellation uses existing Unix process groups and Windows ownership helpers.

History is bounded and stored under `test-explorer-v1`. The new backup category includes validated history. Restore clears runnable discovery, selectors and source snapshots, preserves results as restored/stale history, and grants no filesystem or execution authority. Restore review can relink each history to a chosen folder. Two histories cannot target the same folder. Relinking grants neither execution nor file access.

## Adapter coverage

| Adapter | Reviewed tool | Verified behavior and scope |
| --- | --- | --- |
| Python | pytest 8.4.2 | Real collection, parameter identities, individual and grouped execution, skip/failure evidence and cancellation. Third-party plugins are opt-in outside this adapter. |
| Java | JDK 17+ and JUnit Platform Console Standalone 1.13.4 | Compiles reviewed, saved Java bytes into a private temporary directory. Jupiter executes by unique ID. Parameterized methods and factories are selected as complete methods. Root and conventional source folders are supported. The standalone classpath does not resolve Maven or Gradle dependencies. |
| JavaScript/TypeScript | Project-installed Vitest 4, verified with 4.1.0 | Case, file and grouped selection, pass/fail/skip, source navigation, application-level cancellation with partial results, and rejection when a case identity changes before execution. Jest uses a different runner and has no adapter in this checkpoint. |

Adapters start only after an explicit request. Each discovery and execution has a separate review. A mismatched runner exit and case report prevents Ion from displaying an all-passing result.

## Verification

- 21 focused backend, framework and archive/restore tests passed locally on macOS ARM64 with zero skips. The combined run took 9.77 seconds in this environment. An initial invocation with the JUnit fixture but without JAVA_HOME failed two Java tests at JDK discovery. Setting JAVA_HOME to the installed JDK and retaining the same inputs produced the passing run.
- Tests cover revoked workspace authority, changed saved files, incomplete reports, bounded cancellation, stale outcomes and rollback. Two restored histories targeting one folder fail before application. Relocated history opens read-only as historical evidence and requires fresh discovery and approval to execute.
- Production TypeScript checks and Vite/Electron build passed. The focused hosted workflow provisions its own tools and drives discovery, selection, failure navigation, cancellation, backup and relaunch in the disposable production desktop application.
- Earlier pytest checkpoint `329789c` passed 474 tests in the historical full suite with 26 skips. This is separate from the current 21-test run.

## Native evidence

| Candidate | macOS ARM64 | Windows x64 | Finding |
| --- | --- | --- | --- |
| [aa4f52e](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45930760940) | 21 backend tests passed. Desktop quit failed. | 21 backend tests passed. Desktop quit failed. | The harness requested quit while Test Explorer was open. Its cleanup could mask an earlier failure. |
| [1730db8](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45931146508) | Passed | Desktop passed. Two Java backend checks failed. | A same-length edit could share the inspected file metadata. The cancelled Java case also reported a scratch directory removal failure. The OS lock owner was not identified. |
| [fee7580](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45931559561) | Passed | Passed | Both ran typecheck, production build, 21 adapter/backup tests with zero skips and the offline production desktop journey. |

Source review now adds a bounded SHA-256 digest read from the inspected regular file. Java stages exactly the reviewed bytes. A deterministic test holds the metadata portion constant across different content. Test Explorer also uses the existing bounded Windows scratch-removal policy, still reports permanent cleanup failure and retains pending paths for drain. The desktop journey separately checks that Stop reaps an actual test and child process. On the final local candidate, 22 focused checks passed including the scratch cleanup policy test.

## Retained results after rediscovery

Cases removed from the current discovery remain inspectable in the selected historical run. Choosing one clears the live selection and disables Run Selected. A disposable macOS ARM64 desktop journey ran a failing pytest case, moved its test file outside the workspace, rediscovered a remaining test and opened the original assertion details. The original hosted Windows evidence above covers the adapter and lifecycle checkpoint; this follow-up changes the shared renderer.

## Verdict

**PASS for pytest, JUnit Jupiter and Vitest within the documented scope.** Desktop interaction was driven with pytest. JUnit and Vitest used the production service with real frameworks on both native hosts. Jest, arbitrary Maven/Gradle dependency resolution, third-party pytest autoload and long-duration qualification are outside this checkpoint.
