# Ion Phase 2 — On-Demand Language Services

Status: implementation in progress on `codex/ion-core-excellence-phase-2-lsp`.

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

