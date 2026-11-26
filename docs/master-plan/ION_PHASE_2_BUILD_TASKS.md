# Ion Phase 2.5 — Build and tasks

Status: **IN VERIFICATION**
Branch: `codex/ion-core-excellence-phase-2-tasks`

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

## Native acceptance gate

Before acceptance, one immutable candidate must pass focused production-Electron checks on macOS Apple Silicon and Windows x64:

1. zero task-owned processes before opening or running a task;
2. real manifest discovery through the production preload/main boundary;
3. exact approval followed by an npm task with a disposable output;
4. Stop of a long-running task and complete descendant cleanup;
5. no network requests from the Ion renderer;
6. full unit/security, typecheck and production build on each native host;
7. bounded RAM/CPU/process measurements with the picker closed, open and after task cleanup.

The local macOS Electron registration-crash precaution remains in force. The desktop journey will run only in disposable hosted-native profiles unless that precaution is independently cleared.

## Known limitations

- Discovery is intentionally limited to top-level manifests and reviewed built-in adapters. Arbitrary custom shell tasks are not supported.
- Make/CMake/npm/Python/Cargo/Go use trusted installed tools where available. Native Windows Maven/Gradle launcher coverage is not yet claimed by this milestone and must be reported accurately by native acceptance.
- Tasks run sequentially; parallel graphs, problem matchers, background/watch tasks and user-authored task schemas are deferred.
- General Test Explorer work remains Milestone 2.6. Existing Project Tests are preserved and were not replaced.

## Verdict

The implementation is locally coherent and regression-safe, but Phase 2.5 remains **OPEN / IN VERIFICATION** until the two focused native jobs pass against one immutable candidate. DAP, `main`, releases, installers, the update feed, the installed application and live user data remain unchanged.
