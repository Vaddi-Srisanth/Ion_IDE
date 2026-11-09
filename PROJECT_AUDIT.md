# Ion IDE stabilization audit

## 0.6.2 production-readiness follow-up

The release gate adds production desktop checks for write conflicts, canceled replacement, unsaved-close recovery, keyboard navigation, native shortcut overrides, and portable-profile relaunch. It also reuses the offline workspace suite as an upgrade test. A profile produced by 0.6.1 reopened in 0.6.2 with its editor setting, recent folder, source file, learning history, practice attempts, and verified roadmap evidence intact.

- Save As asks before replacing an occupied path and rechecks the confirmed revision before publication. The desktop checks preserve both the external file and the unsaved editor buffer when a close-and-save fails. Atomic saves preserve POSIX mode bits where applicable and reject input that would silently replace an invalid Unicode code unit.
- Ion leaves unreadable or future-version preferences in place and keeps autosave off until valid settings load. Recent entries must still resolve to their stored canonical location.
- Command Palette, Quick Open, Go to Line, and configurable shortcuts use the existing command and editor paths. Quick Open runs only on demand against the currently authorized workspace. Code/document splits support keyboard focus and sizing. The workbench still has one source editor.
- A versioned local profile export includes preferences, custom themes, learning history, and project metadata. Portable-profile verification launches a writable copy offline. Project metadata remains bound to its canonical workspace path. [Portable profile instructions](PORTABLE_PROFILE.md)

The mounted Apple Silicon disk image passed signature, launch, and unsaved draft recovery checks. Public distribution still requires Developer ID signing and notarization. No lower-memory Mac or cross-platform build was evaluated in this pass. See the [current performance gate](PERFORMANCE.md) and [release checklist](RELEASE_CHECKLIST.md).

## 0.6.1 stabilization baseline

Scope is the macOS-first Electron application, its preload and workbench, local data stores, native PTY helper, optional systems, dependency graph, and build and verification scripts. The comparison baseline is the preserved Ion IDE 0.6.0 production build. The stabilization build is 0.6.1. Product scope gates are listed in [ROADMAP.md](ROADMAP.md).

## Essential release scope

| Requirement | Evidence and current status |
| --- | --- |
| Standalone launch | Production Welcome and sandboxed app-protocol loading are exercised in the desktop harness. The Apple Silicon release has a separate mounted-DMG verification path. |
| Open, create, edit, and save | Desktop tests exercise the real editor, individual files, new files, Save As, autosave, explorer operations and external-change conflict recovery. File tests check path grants, stale revisions, bounded UTF-8 reads, and atomic publication. |
| Folders and explorer | Native folder selection, targeted directory expansion, rename, and Trash work. The explorer offers manual refresh for external tree changes. |
| Multiple tabs and syntax | One shared Monaco surface with up to three cached text models. Current grammar support includes C/C++, Java, Python, JavaScript, TypeScript, HTML, CSS, Markdown, YAML, JSON and shell formats. The editor preserves dirty text on eviction. Undo history is scoped to the cached model. |
| One-click execution | An installed local compiler or interpreter runs the saved active source through the interactive Run Console. See the matrix below for host coverage. |
| Interactive stdin and stdout | The native PTY uses a single terminal surface for input, echo, stdout, and stderr. Compiler output arrives in the same console. |
| Stop and Rerun | Real run, rerun, and process cleanup are verified through the desktop runner matrix. Close and renderer loss use the same ownership boundary. |
| Compiler and runtime errors | Raw diagnostics are streamed, compile and runtime failures are distinct, and the console shows exit status. |
| Offline C explanations | Desktop Learn checks cover actual Clang diagnostics, correction, an unchanged rerun, recurrence, and local history. Reviewed GCC fixtures cover the parser. Unsupported categories preserve the compiler text and show general guidance. |
| Resizable, collapsible panels | Desktop tests exercise explorer and output resizing, collapse, and reopening. Optional panes use the same workbench layout. |
| Lightweight themes | Five built-ins, automatic macOS appearance, validated custom themes, JSON import/export, and persistence work offline. Theme switches preserve editor state and undo. |
| Persistent settings | Versioned local settings and recent items survive a full launch cycle. |
| Recovery after an unexpected crash | Added private atomic checkpoints for named and untitled buffers. Desktop tests crash the renderer and terminate the app process, verify restoration as detached tabs and unchanged originals, and exercise Save As and explicit discard. |
| Free Coding | Welcome opens a plain editor without requiring learning, projects, an account, or credentials. The cold-workbench resource check verifies optional workspace chunks stay unloaded. |

## Release verification

- Type checking, production bundling, and all 66 Node tests passed. The production desktop suites checked file and editor behavior, crash recovery, resource lifecycle, themes, offline learning, projects, practice, and the supported document formats. The planning rubric passed against four reviewed offline fixtures.
- The Apple Silicon 0.6.1 DMG passed checksum and strict signature checks. The mounted app launched with a disposable profile, ran the bundled PTY round trip, rendered offline previews, and restored a draft after forced exit. The full interactive language matrix ran against the same production application bundles before packaging.
- Native QA here covers the Apple M3 on macOS 27.2. Intel Mac, Windows, Linux, and a credentialed live planning request are outside the verification evidence for this release.

## Runner verification

`npm run test:run-console` passed against the final production build with Apple Clang 21.0.0, OpenJDK 26.0.2.1, Python 3.15.2, and Node.js 26.11.1. Each row ran from the same Unicode workspace path containing spaces. The suite verifies a simple result, two reruns, terminal echo and the interactive program's response, the error below, and Stop with the program PID gone.

| Language | Exercised error |
| --- | --- |
| C | Clang compiler error |
| C++ | Clang++ compiler error |
| Java | javac compiler error |
| Python | Interpreter runtime exception |
| JavaScript | Node runtime exception |

The suite also passed packaged Java classes and companion source files, stale-class rejection, an infinite loop stopped by the IDE, alternate-screen restoration, Save before Run and external revision reload, and rejection when the workspace changes during run approval. Separate resource and recovery suites checked cleanup when a window closes or the renderer crashes. Maven/Gradle behavior was outside this pass's five-language standalone matrix.

## Repairs in this pass

- Added a recovery journal separate from file grants and preferences. It writes one bounded snapshot per dirty tab at a time, reads only metadata on startup, and loads draft text when needed. Local limits are 64 drafts and 2 MiB of UTF-8 text per draft. Originals remain outside the recovery write path. A completed checkpoint survives an app crash. The latest edits can be newer than the last completed checkpoint, and sudden power-loss durability has not been tested.
- A crashed renderer releases its window's processes, viewer sessions, panel state, and filesystem grants before recreating the workbench. Automatic replacement is rate-limited. The desktop crash test verifies that a waiting C child exits when its renderer goes away.
- Removed the unused manual C IPC route. The interactive editor has one launch path. The same bounded executor and compiler detection still support the separate deterministic C transport that Projects and Practice require for stdin and independent stdout/stderr. The live runner streams terminal data once, retains a small excerpt only for active C learning, and sends a summary instead of re-sending the compiler transcript.
- A Run request checks the original workspace root before launch. With Save before Run enabled, it also verifies the loaded editor revision and presents the existing Reload/Save As controls for a stale source. The opt-out setting deliberately runs the saved version. Practice approval is cancellable. The close-tab Save path rechecks for edits that arrived during the save.

## Optional systems

| Module | Classification | Verified behavior and boundary |
| --- | --- | --- |
| Online AI project planning | Partially implemented | Explicit Full Mode action, HTTPS provider adapter, OS-backed credential encryption, structured-response checks, and review before applying a plan. Provider responses were simulated in automated tests. No live credentialed provider call was made. |
| Project roadmaps | Implemented and verified | Offline specifications, milestone edits and persistence, and separate manual versus verified progress. |
| Automatic project tests | Implemented and verified for single-file C | Reviewed stdin/stdout/exit tests, opt-in Full Mode save trigger, debounce, cancellation, and separate evidence. Busy runs can leave an automatic check stale until another save or a manual test. Other language and behavioral adapters remain future work. |
| Coding practice | Implemented and verified for local C | Locally entered problems, notes, separate attempts, and sample execution. External links can point to the original problem. There is no platform submission integration. |
| PDF | Implemented and verified | Offline page ranges, zoom, navigation, text-layer search, corrupt-file handling, bounded canvas window and worker disposal. |
| DOCX | Implemented and verified | Reflowed sections, headings, formatting, tables, static raster images, search, split view, and unchanged originals. Some layout and embedded media are unsupported. |
| PowerPoint | Implemented and verified with an external engine | Real diagram and chart pixels, slide thumbnails, keyboard navigation, and full-screen mode using a separate headless LibreOffice engine. Engine absence shows setup and external-opening options. Rendering is static and depends on the converter and fonts. |
| XLSX and CSV | Implemented and verified | Paged cells, sheet selection, search, split view, quoted CSV, malformed-input behavior, and cleanup. Excel shows cached formula values. |
| Additional learning packs | Not implemented | The C pack is the only curated learning pack. Language grammars and runner support are independent. |

No mock run results or enabled placeholder modules were found in these flows. Existing on-demand panel and Full Mode gates match the current scope. The reviewed flows do not need additional feature flags. A manually initiated Projects test can finish after closing the panel, while whole-window cleanup stops the shared runner. A complete host kill can leave private temporary artifacts for the OS to reclaim. Normal close and renderer-crash cleanup are explicit.

## Dependency, resource, and security findings

- Each direct runtime package has a concrete owner: React and React DOM for the workbench, Monaco for editing, xterm and its fit addon for the Run Console, PDF.js for paged previews, csv-parse for CSV, and SAX/yauzl for Office XML archives. No direct runtime dependency could be removed without replacing a working subsystem. The recorded npm audit reported zero advisories in the resolved graph at the time of the run.
- Normal workbench requests pass through origin-validated IPC and a CSP-protected local protocol. The renderer has no Node access. Workbench HTTP, HTTPS, and WebSocket requests are blocked in production. The explicit planner is the sole IDE service that contacts an online provider. The web preview uses a separate, network-denied session.
- Monaco loads on demand. The explorer lists expanded directories instead of indexing the whole workspace. There is no language server, persistent compiler, app-level polling loop, or filesystem watcher. Viewer engines and workers start on demand. Shared runtime code can remain in process caches after a pane closes, while live handles, canvases, workers, test queues and child processes have explicit teardown.
- Local programs and Maven/Gradle plugins run with the user's permissions once approved. Timeouts, output caps, and process-group cancellation are operational controls. PowerPoint uses a separate macOS conversion process with restricted writes and blocked network access. These boundaries leave residual risk from code, build scripts, or malicious documents. Native signing here is ad hoc. Public distribution still requires a Developer ID signing and notarization workflow.
- [PERFORMANCE.md](PERFORMANCE.md) records the matched production process-tree benchmarks and identifies which aspirational RAM targets the build meets by each macOS accounting metric.

## Next three priorities

1. Keep recovery, external-edit conflicts, file writes and cancellation in the native release gate. Exercise them on an installed build with disposable user data before public distribution.
2. Re-run the same process-tree and lifecycle workload on a lower-memory Mac, then target the largest measured cost while preserving isolation and the editor workflow.
3. Expand the offline C diagnostic corpus across real compiler versions and retain conservative fallback behavior before adding another learning pack.
