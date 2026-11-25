# Ion Phase 2 — On-Demand Language Services

Status: local macOS implementation accepted; native Windows and installed TypeScript-server acceptance remain pending on `codex/ion-core-excellence-phase-2-lsp`.

## Accepted baseline

The immutable application baseline is source commit `0718aa7b35894474e1932efba7cee3286dcf0aab`. The documentation-only parent is `5429613`. These are historical measurements from the accepted editor/workspace foundation, not measurements of the language-service candidate.

| Platform/workload | Accepted measurement |
| --- | ---: |
| macOS fresh startup | 293.19 ms |
| macOS warm startup | 289.14 ms |
| macOS first file | 179.83 ms |
| macOS idle summed RSS | 429.09 MiB |
| macOS one source tab | 518.91 MiB |
| macOS ten source tabs | 531.45 MiB |
| macOS idle CPU | 0.31% |
| Windows one-root working set/private | 347.08 / 192.65 MiB |
| Windows five-root working set/private | 344.84 / 187.96 MiB |
| Windows fifty-tab working set/private | 391.89 / 230.07 MiB |
| Windows first file | 336.23 ms |

## Confirmed starting point

- C/C++ navigation is a bounded, single-translation-unit clangd adapter.
- Java diagnostics and navigation use a bounded local JDK worker with a custom protocol.
- One global session in `src/main/index.ts` owns either adapter and stops it after an idle delay.
- Python and JavaScript/TypeScript have no semantic service.
- Renderer providers are attached per visible model; request version checks already reject some stale results.
- Compiler diagnostics are still coupled to the Run Console rather than a reusable Problems source.

## Milestone architecture

1. A main-process `LanguageServiceManager` is the sole owner of service discovery, startup, state, request routing, crash limits, idle shutdown and process cleanup.
2. Adapters expose one bounded interface. Existing Java remains behind an adapter; LSP servers share a hardened JSON-RPC process host.
3. Services are keyed by adapter and authorized workspace root. Multi-root workspaces therefore receive isolated project services and cannot use one root to authorize another.
4. Discovery is non-executing where practical and never searches workspace-controlled executable locations. Startup always uses an absolute, validated executable path and structured arguments.
5. No service starts during application startup. A service starts only after an enabled semantic operation targets an authorized file. Closing the last consumer schedules bounded idle shutdown.
6. Document versions travel end-to-end. Results from an old model version, old service generation, closed tab, changed root or replaced window are discarded.
7. Service output, pending requests and diagnostics are bounded. Restarts are rate-limited. Shutdown escalates from graceful termination to forced process-tree cleanup.
8. Monaco keeps its existing models and undo stacks. Providers are registered lazily and disposed with their visible editor/model ownership.

## First-class languages

| Language | Adapter | Initial behavior |
| --- | --- | --- |
| C/C++ | clangd LSP | definitions, references; expand through shared host |
| Java | existing JDK worker | diagnostics, completion, signatures, definitions, references behind manager |
| Python | installed `pyright-langserver` or `pylsp` | enabled only when a supported executable is installed |
| JavaScript/TypeScript | installed `typescript-language-server` | enabled only when the server and TypeScript runtime are installed |

Ion will not auto-download a server, execute a workspace-provided binary, or claim support when discovery fails. Settings and status UI must show the actual state and setup guidance.

## Acceptance and performance gates

- Zero language-server processes and zero language-service polling when smart tooling is unused.
- Startup, first-file, idle CPU and one-file memory compared against the accepted baseline using matched production builds.
- Per-service startup latency, idle memory, request latency, cleanup latency and retained process count measured separately.
- Native macOS and Windows checks required before completion; unavailable checks remain explicitly unverified.
- Existing editor, backup/restore, recovery, Git, runner, terminal, notebook and learning tests remain green.
- No merge, release, installer, update-feed or installed-application change in this milestone.

## Current tracker

| Item | State |
| --- | --- |
| Baseline and existing adapter audit | Complete |
| Generic bounded LSP process host | In progress |
| Central lifecycle manager | Pending |
| C/C++ migration | Pending |
| Java manager adapter | Pending |
| Python adapter | Pending |
| JavaScript/TypeScript adapter | Pending |
| Monaco providers and generalized Problems | Pending |
| Status/settings/commands | Pending |
| Native acceptance and performance | Pending |

## Local macOS acceptance checkpoint

Application-source candidate `0fb89148b02e507d3414360378a38e73fa50f359` passed type checking, the production build, all 420 unit tests (**394 passed, 0 failed, 26 platform/toolchain skips**), the existing production Java semantic workflow, the existing production clangd navigation workflow, and the new offline Python LSP lifecycle workflow. Focused cancellation tests additionally verify renderer ownership, main-process cancellation and the JSON-RPC `$/cancelRequest` notification.

The Java check preserved basic snippets with Smart Java disabled, then verified JDK diagnostics, completion, signatures, definitions, references, current-buffer Problems and cleanup. The clangd check verified definitions/references, workspace boundaries, process reuse and cleanup; the active clangd fixture measured **19.08 MiB attributed footprint and 34.58 MiB RSS**. The Python check verified no service before opt-in, no service merely from enabling the setting, definition lookup through installed `pylsp`, offline operation, status reporting and cleanup after the last source closed. The Mac has no installed `typescript-language-server`; the JavaScript path produced the expected local setup guidance and remained unverified for actual semantic results.

Two Python samples recorded 1,537.96–1,696.30 ms cold service start/request, 1,013.96–1,020.08 ms from close through verified stopped state and settlement, and a **220.70–221.20 MiB** active process-tree RSS increase from the locally installed Anaconda `pylsp` stack. After cleanup, the owned process tree was 65.59–66.97 MiB below its pre-service sample. This demonstrates cleanup but is not a claim that every Python server will use the same resources.

### Matched unused-feature benchmark

Three production trials compared the exact accepted source `0718aa7b35894474e1932efba7cee3286dcf0aab` against the pre-cancellation candidate `b160ce62bab3dcf677d2de8021a6542578a13f61` using disposable profiles and identical workloads. The later cancellation patch affects only active semantic requests; its focused production workflows pass, but the exact final candidate still requires the native matched gate. Every local benchmark sample is retained in ignored raw evidence at `performance-results/lsp-milestone/desktop-2026-11-24T09-45-59.921Z.json`.

| Metric | Accepted baseline | LSP candidate | Delta |
| --- | ---: | ---: | ---: |
| Fresh startup median | 320.47 ms | 297.62 ms | -22.85 ms / -7.13% |
| Warm startup median | 321.38 ms | 324.31 ms | +2.93 ms / +0.91% |
| Idle summed RSS median | 428.76 MiB | 428.64 MiB | -0.12 MiB |
| Idle CPU | 0.00% median | 0.31% median | within the observed 0–0.31% sample range |
| One-tab summed RSS | 518.34 MiB | 518.44 MiB | +0.10 MiB / +0.02% |
| Ten-tab summed RSS | 530.91 MiB | 531.72 MiB | +0.81 MiB / +0.15% |
| First file | 179.41 ms | 179.53 ms | +0.12 ms / +0.07% |
| Subsequent file median | 49.88 ms | 49.81 ms | -0.07 ms |
| Typing key-to-second-frame median | 32.00 ms | 32.00 ms | 0.00 ms |

The unused feature therefore adds no measured persistent process, material memory cost, or meaningful startup/file-open regression in this matched sample. This remains a three-trial local result, not a substitute for native Windows acceptance or longer endurance.

## Remaining acceptance gates

- Run the immutable candidate on native Windows with known installed clangd, JDK, Python LSP and TypeScript Language Server versions.
- Exercise real JavaScript and TypeScript semantic results; the current Mac verifies only missing-tool guidance.
- Measure each installed service separately on Windows and retain crash/cleanup/rapid-switch samples.
- Run the applicable production regression and matched Windows resource workload.
- Preserve any failure and update this report and the implementation tracker with exact CI links before declaring Milestone 2.3 complete.

# Quality-first continuation baseline — native run 45383848694

The preserved native acceptance run is [GitHub Actions run 45383848694](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45383848694), application candidate `e155323564174a185a42b9f56755f09e09cfba84`, verification harness `8341b48521c6eec1a1f61a40a56cf05167bcab52`.

- macOS: Python's first cold definition request exhausted the generic 8-second JSON-RPC deadline. The existing trace does not separate process spawn, initialization, document synchronization, and the semantic request, so no root-cause stage or active-service resource result may be claimed yet.
- Windows stdin: the compiler warning echoed the literal source token `INPUT>` before the program launched. The acceptance callback matched that compiler text, called `InteractiveRunner.input()` while no PTY existed, silently dropped the input, marked it sent, and later timed out. The native PTY/ConPTY path did not receive an input request in this sample.
- Windows compiler selection: the workflow prepended LLVM solely to discover `clangd`; Ion then selected Clang 20 for C/C++. The runner's Visual Studio 18 STL requires Clang 22, so the resulting C++ failures are a deterministic verification-environment mismatch, not evidence that the source compiler path regressed.
- Performance: the failed jobs never reached the matched unused-LSP or active-service measurements. Historical numbers remain historical and are not reused as current acceptance evidence.

Milestone 2.3 remains **FAIL** at this baseline. DAP remains blocked.

## Local remediation checkpoint — `f458dd4238ab247de184f710f4cf5f8b384d4516`

The smallest evidence-based corrections are now committed locally:

- Run Console input records only run identity/state and byte counts. `InteractiveRunner` and PTY input now acknowledge whether the active program accepted the chunk; stale, premature, and disposed-run IPC requests fail visibly rather than disappearing.
- The Windows regression test now reacts only to `terminal` stream prompts. This removes the demonstrated false trigger from compiler diagnostics that quote source text while retaining the real prompt/input/cleanup assertion.
- LSP process spawn, initialization, and normal ready-server request deadlines are separate. Pyright alone receives a bounded 20-second cold initialization budget; ready semantic requests retain the normal 8-second budget. Timeouts cancel the outstanding JSON-RPC request.
- Pyright receives lazy `openFilesOnly`, indexing-disabled configuration after initialization. No server is started at application startup.
- Windows CI selects the pinned MinGW C/C++ pair before application tests and passes clangd through a validated explicit external path. The exact PATH, compiler paths, and versions are recorded.

Local evidence at this checkpoint:

| Gate | Result |
| --- | --- |
| Type checking | PASS |
| Production build | PASS |
| Full unit/security suite | 401 passed, 26 platform skips, 0 failed |
| Focused LSP lifecycle/deadline tests | 5 passed, 0 failed |
| Focused real C compile/PTY/input/stop lifecycle | PASS, including unchanged stdin and owned cleanup |
| Native macOS/Windows rerun | Not run; requires a reviewed branch upload and explicit authorization |
| Final LSP capability/rename/resource contract | Incomplete; Milestone remains FAIL |

The failed native run remains evidence. No timeout was globally increased, no ConPTY implementation was rewritten, and no performance value was invented or reused as current acceptance.

