# Ion Phase 2 — On-Demand Language Services

Status: **PASS**. The final semantic/editing candidate passed immutable macOS ARM64 and Windows x64 native acceptance on `codex/ion-core-excellence-phase-2-lsp`.

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

## Final local candidate — `0e1442fb360d9b72a642b63d874cb1e037538566`

The secure Windows npm discovery correction at `2d2767900a680199ad1deb57f52f73d5f7c724d2` passed native Windows run [45842413385](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45842413385). The run exercised real JavaScript and TypeScript through TypeScript Language Server 4.4.0 and TypeScript 5.9.3, alongside Node 24.22.2, clangd 20.1.8, Java 17.0.21.1 and Pyright 1.1.407. Its unit/security result was 420 passed, 17 skipped and 0 failed. Runs `45828091548` and `45825449360` remain preserved evidence of the preceding success and portability failure.

The final local candidate completes the remaining bounded semantic surface and reviewed-edit path:

- clangd diagnostics, completion, hover, signature help, definitions, declarations, references, document/workspace symbols, rename and code-action queries;
- Python and JavaScript/TypeScript diagnostics, completion, hover, signatures, definitions, references and rename through the shared host;
- main-owned workspace-edit review with canonical-root authorization, dirty-buffer, revision/hash, external-change, overlap, symlink/junction and removed-root checks before atomic publication;
- an expiring, single-use approval token; language servers never write files directly;
- immediate service cleanup when a root is removed, including shared JavaScript/TypeScript adapter identity;
- F2 Rename Symbol through the production menu/shortcut path without recreating Monaco models.

Local gates passed: type checking, production build, Java production workflow, native clangd production workflow, exact pinned Pyright/TypeScript lifecycle, and the full unit/security suite (**426 passed, 26 platform/toolchain skips, 0 failed; 452 total**). One earlier full-suite worker stall and one new-test assertion defect were retained during development; the isolated LSP lane passed and the corrected final full suite completed cleanly.

### Exact matched unused-LSP comparison

Five alternating AB/BA production pairs compared accepted source `0718aa7b35894474e1932efba7cee3286dcf0aab` with this exact application source. All samples are retained locally in ignored evidence at `performance-results/lsp-final-exact/desktop-2026-11-26T15-31-02.221Z.json`.

| Metric | Accepted baseline | Final candidate | Delta |
| --- | ---: | ---: | ---: |
| Fresh startup | 330.38 ms | 315.19 ms | -15.19 ms / -4.60% |
| Warm startup | 337.92 ms | 346.93 ms | +9.01 ms / +2.67% |
| First file | 178.89 ms | 180.04 ms | +1.15 ms / +0.64% |
| Idle summed RSS | 427.95 MiB | 428.78 MiB | +0.83 MiB / +0.19% |
| One-tab summed RSS | 517.08 MiB | 518.59 MiB | +1.51 MiB / +0.29% |
| Ten-tab summed RSS | 530.47 MiB | 532.03 MiB | +1.56 MiB / +0.29% |
| Idle CPU | 0.62% | 0.61% | -0.01 pp |
| Subsequent file | 46.54 ms | 46.50 ms | -0.04 ms |
| Typing key-to-second-frame | 31.70 ms | 31.55 ms | -0.15 ms |

Ordinary editing started no language server and no background indexer or poller. The historical `610.62 -> 959.05 ms` startup regression did not reproduce under matched artifact placement and alternating order; the final candidate is within the required 10% startup and first-file gates.

Active-service measurements remain separate from Ion. Locally, clangd added 19.52 MiB attributed footprint / 37.14 MiB RSS and returned definition in 104.73 ms. Pyright added 247.34 MiB service RSS in this fixture and cleaned to zero service processes. TypeScript Language Server plus tsserver added 525.45 MiB service RSS and cleaned to zero; this external tool cost is reported rather than attributed to Ion.

## Final immutable native acceptance — run 45859946256

Final run: [GitHub Actions 45859946256](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45859946256)<br>
Production implementation: `6bcc06c059a13461b145e5e4ccec55d22bb3bced`<br>
Verification harness: `9aaeaeffff5cbb5b20a00ddbe373ba51c4e24578`

The harness commit changes only bounded Windows test-fixture cleanup. The shipped `src` tree is identical to the production implementation above. Both final jobs checked out and built the full harness SHA, proved its identity, and exercised the same production sources.

| Gate | macOS 15 ARM64 | Windows 2025 x64 |
| --- | --- | --- |
| Production build and typecheck | PASS | PASS |
| Unit/security suite | 428 pass, 26 skip, 0 fail / 454 | 427 pass, 17 skip, 0 fail / 444 |
| Java intelligence and cleanup | PASS | PASS |
| clangd semantic surface, reviewed rename and cleanup | PASS | PASS |
| Pyright diagnostics, cold/warm semantics and cleanup | PASS | PASS |
| TypeScript Language Server lifecycle and cleanup | PASS | PASS |
| Multi-root isolation, stale-result rejection and cancellation | PASS | PASS |
| Malformed/oversized protocol and unauthorized-path protection | PASS | PASS |
| Owned service processes after shutdown | 0 | 0 |

Pinned/recorded tools were Node 24.22.2, Pyright 1.1.407, TypeScript Language Server 4.4.0 and TypeScript 5.9.3. macOS used Apple clangd 17.0.0 and Java 21.0.13; Windows used clangd 20.1.8 and Java 17.0.21. Windows independently selected MinGW GCC while clangd remained the explicitly validated semantic executable.

### Native semantic timing and resource evidence

| Measurement | macOS ARM64 | Windows x64 |
| --- | ---: | ---: |
| clangd cold definition workflow | 872.08 ms | 2,376.28 ms |
| clangd service RSS | 46.88 MiB | 87.84 MiB |
| clangd shutdown observed | 251.56 ms | 775.51 ms |
| Pyright discovery upper bound | 135.38 ms | 111.39 ms |
| Pyright process spawn | 3.43 ms | 5.97 ms |
| Pyright initialization | 536.68 ms | 222.66 ms |
| Pyright workspace configuration | 7.36 ms | 1.49 ms |
| Pyright document synchronization dispatch | 2.41 ms | 2.19 ms |
| Pyright cold definition | 900.12 ms | 655.98 ms |
| Pyright warm completion | 21.12 ms | 25.10 ms |
| Pyright first diagnostics | 274.00 ms | 281.92 ms |
| Pyright active service RSS | 384.84 MiB | 388.78 MiB |
| TypeScript service RSS | 519.25 MiB | 434.60 MiB |

Ion's own process tree remained separate in the measurements. After Pyright and TypeScript shutdown, service RSS returned to zero and the Electron process count returned to four on both hosts. The macOS trace observed the protocol exit notification but not the later process-exit callback inside its narrow trace window; independent process-tree sampling verified no retained server process.

### Matched unused-LSP performance

The final hosted macOS comparison retained five alternating samples per build. No language server or background indexer started in ordinary editing.

| Metric | Accepted comparison | Final candidate | Delta |
| --- | ---: | ---: | ---: |
| Fresh startup | 911.19 ms | 958.76 ms | +47.57 ms / +5.22% |
| Warm startup | 746.19 ms | 671.17 ms | -75.02 ms / -10.05% |
| First file | 491.45 ms | 356.36 ms | -135.09 ms / -27.49% |
| Idle summed RSS | 368.66 MiB | 369.31 MiB | +0.65 MiB / +0.18% |
| One tab | 461.88 MiB | 461.95 MiB | +0.07 MiB / +0.02% |
| Ten tabs | 477.00 MiB | 477.58 MiB | +0.58 MiB / +0.12% |
| Idle CPU | 2.47% | 2.20% | -0.27 pp |
| Typing key-to-second-frame | 30.50 ms | 30.65 ms | +0.15 ms / +0.49% |

The required startup and first-file limits pass, and unused LSP adds no meaningful idle resource cost. Active Java Smart mode is reported separately: its one retained hosted sample increased editor RSS from 469.17 to 550.61 MiB and attributed footprint from 189.54 to 241.28 MiB while the JDK service was active; warm completion was 20.36 ms, first diagnostics 1,748.56 ms, and the post-close Electron tree was within 3.45 MiB of Basic mode.

### Preserved failures

- [45850775625](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45850775625): brittle Pyright raw-exit observation and Windows root-removal handling.
- [45851929847](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45851929847): cleanup assertion treated a lower post-cleanup count as failure.
- [45852597271](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45852597271): Smart C++ opt-in eagerly launched clangd before an explicit semantic request.
- [45854295177](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45854295177): transient Windows scratch deletion after TypeScript shutdown.
- [45855793417](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45855793417): measured cold Windows clangd definition exceeded the generic eight-second request budget.
- [45858699825](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45858699825): all reftable assertions passed, then test-fixture removal hit transient Windows `EBUSY`; bounded test-only recursive cleanup retries corrected the harness.
- [45857558803](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45857558803): intermediate Windows-only proof that the bounded clangd correction passed before the final cross-platform run.

No failed sample was deleted or relabeled as a pass. No global timeout was increased, no server was made eager, and no workspace-controlled executable or direct server file write was permitted.

**Milestone 2.3 verdict: PASS.** DAP was not started during this milestone. The next work item is the previously requested Editor Essentials / Interaction Audit and its bounded corrections before any debugger implementation.

