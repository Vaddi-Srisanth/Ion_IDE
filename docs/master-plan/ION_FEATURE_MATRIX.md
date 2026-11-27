# Ion feature matrix

## Current accepted scope

Updated through accepted checkpoint `23dff68d29b07fd519d5b7b83857857bfe6ef20c` and latest production correction `036781e7fe99be4480e5f0803fb6b22124be72a8`. Phase 0/1, editor/workspace milestones 2.1/2.2, LSP 2.3, Editor Essentials, C/C++ DAP 2.4 and the bounded 2.5 task-adapter foundation are accepted at their documented scopes. **Phase 2 remains incomplete.** Test Explorer 2.6 is paused/incomplete on a separate branch and is not included here. This matrix describes accepted development source, not an assertion that every published installer contains it.

Evidence and limits: [tracker](ION_IMPLEMENTATION_TRACKER.md), [editor/workspaces](ION_PHASE_2_EDITOR_EXCELLENCE.md), [LSP](ION_PHASE_2_LANGUAGE_SERVICES.md), [DAP](ION_PHASE_2_DEBUGGER.md), [tasks](ION_PHASE_2_BUILD_TASKS.md). Counts and measurements in older catalog/feature audits remain historical unless those reports explicitly reran them; no new runtime measurements were performed for this documentation update.

Status vocabulary is deliberately strict:

- **Verified** — existing and verified at the cited scope.
- **Incomplete** — useful implementation exists, but the requested professional scope is larger.
- **Unreliable** — implementation exists, but a current acceptance blocker or reproducible defect prevents a completion claim.
- **Missing** — no production implementation.
- **External** — blocked by optional tools, service APIs, credentials, licensing, or platform facilities.
- **Unsupported** — no official/safe integration has been established.
- **Deferred** — intentionally outside the current phase.
- **Paused** — separate unfinished work stopped before acceptance; excluded from the accepted checkpoint.

## Desktop, editor, and data

| Capability | Status | Current scope and next gap |
| --- | --- | --- |
| Standalone Electron desktop app | Verified | macOS-first, packaged Electron app with Windows build/test infrastructure. Linux is not a verified release target. |
| Monaco source editor | Verified | Shared models across up to four editor groups; bounded recent models, undo/redo, independent views, syntax, diagnostics and large-file preview. |
| New/open/save/save as/autosave | Verified | Revision-aware saves and existing save policy. |
| External-change protection | Verified | Conflict banner, reload/save-as behavior, and atomic publication tests. |
| Crash recovery and session resume | Verified | Local drafts and session metadata; full upgrade/endurance acceptance remains release-gate work. |
| Backup and reviewed restore | Verified at hosted native scope | Exact candidate `c530644` passed fresh/populated restore, actual relaunch, interruption recovery, rollback, trust exclusion and cleanup on hosted macOS/Windows; Phase 1 packaged migration/rollback also passed. Maximum archives, physical power loss, external filesystems and long endurance remain coverage limits. |
| Multi-tab editing | Verified | Bounded live Monaco models; hidden tab text/view state retained. |
| Split source/document view | Verified | Document/Markdown preview split plus same/different-source editor groups; views share source models and undo. |
| Source-to-source editor groups | Verified at bounded scope | Up to four nested horizontal/vertical groups, drag/move/focus/close/rebalance, keyboard resize and validated restored layouts. |
| Multi-root workspaces | Verified at bounded scope | Up to eight canonical non-overlapping roots, reviewed `.ion-workspace` descriptors, bounded editor settings, root-aware tools and session restoration without trust import. |
| Explorer create/rename/delete | Verified | Main-process validation and safe mutations. |
| Workspace search/replace | Verified at supported scope | On-demand bounded ripgrep search and reviewed multi-file replacement; main-owned revision/hash snapshots, dirty-buffer guards, atomic per-file writes and explicit partial conflicts. Not an arbitrary refactoring engine. |
| Quick Open / Go to line / command palette | Verified | Existing command registry, shortcuts, and on-demand file enumeration. |
| Breadcrumbs and navigation history | Verified at path/navigation scope | Root-aware file breadcrumbs and semantic Back/Forward; a comprehensive symbol breadcrumb trail remains incomplete. |
| Minimap, bracket matching, folding, multi-cursor | Verified | Monaco-provided editor fundamentals. |
| Snippets and Emmet | Incomplete | Built-in language snippets exist; professional configurable snippet/Emmet system is not verified. |
| Configurable shortcuts | Verified | Validated local command overrides. Conflict UX and full discoverability can improve. |
| Editor Essentials / Explorer interactions | Verified | Accessible Explorer/tab menus, safe batch close/reopen, group-aware Ctrl+Tab MRU, Explorer keyboard navigation/rename/delete, authorized Copy Path/Reveal and on-demand folder terminals. |
| Settings UI and JSON-level personalization | Incomplete | Major preferences exist. A complete searchable settings registry is missing. |
| Accessibility | Incomplete | Keyboard paths and reduced-motion considerations exist; formal WCAG/screen-reader acceptance is not complete. |

## Languages, execution, and tools

| Capability | Status | Current scope and next gap |
| --- | --- | --- |
| Syntax highlighting | Verified | 23 registered language entries with native renderer fixture coverage. |
| C/C++ execution | Verified | Local clang/GCC toolchains, compile diagnostics, PTY input, stop/rerun, cleanup. |
| Java execution | Verified | `javac/java`; optional Maven/Gradle requires installed tools/caches. |
| Python execution | Verified | Installed Python 3. |
| JavaScript execution | Verified | Installed Node.js. |
| Other language execution | Incomplete | Registry is broader than runner support; do not equate syntax with execution. |
| Integrated terminal | Verified | Lazy PTY shell, multiple sessions, resize/input/search/copy, bounded scrollback, explicit cleanup. |
| Format document | Verified at supported-tool scope | clang-format, Ruff/Black, Prettier, optional Java formatter. Missing tools are reported; no universal formatter claim. |
| C/C++ semantic tooling | Verified at clangd scope | Diagnostics, completion, hover/signatures, definitions/declarations/references, symbols, reviewed rename and code-action queries; installed trusted clangd required. No universal project-indexing claim. |
| Java semantic tooling | Verified at JDK-adapter scope | Bounded JDK worker behind the shared lifecycle manager: completion/signatures/navigation/diagnostics. This is not a complete Java language server or universal Java refactoring support. |
| Python language service | Verified at Pyright scope | Installed trusted Pyright: unsaved-buffer diagnostics, completion, hover/signatures, definition/references and reviewed rename through the shared host; native cold/warm, isolation and cleanup acceptance passed. |
| JavaScript/TypeScript language service | Verified at tested-server scope | Installed TypeScript Language Server and TypeScript runtime: synchronized diagnostics, completion, hover/signatures, navigation and reviewed rename; native lifecycle and cleanup passed. |
| Go/Rust/C#/other LSP | Missing | Syntax and some lesson metadata only. |
| Language-server lifecycle manager | Verified | Root/adapter-isolated on-demand processes, bounded JSON-RPC, version/generation handling, cancellation, bounded restart, idle shutdown and owned cleanup. Unused smart tooling starts no server. |
| Reviewed server-provided workspace edits | Verified at text-edit scope | Main-owned expiring review; canonical-root, dirty-buffer, revision/hash, overlap, link and removed-root checks before safe publication. Server requests do not grant filesystem authority or automatic approval. |
| C/C++ debugger / DAP | Verified at Milestone 2.4 scope | Lazy trusted clang/lldb-dap path with reviewed saved-source launch, breakpoints, call stack, scopes, variables, watches/evaluate, stepping, continue/restart/stop and owned cleanup. Python/Java debugging, attach, remote and advanced breakpoint types remain unimplemented. |
| Build/task adapter foundation | Verified at bounded scope | Lazy Run Task picker; static top-level Make/CMake/npm/Python/Maven/Gradle/Cargo/Go manifest inspection, profile records and bounded sequential graph. Native execution/Stop/cleanup proves npm; remaining adapter journeys, workspace task definitions and safe problem matching stay open. |
| General Test Explorer | Paused / incomplete | Phase 2.6 work is isolated on its unfinished branch and excluded from this checkpoint. Existing saved Project Tests and historical C console evidence remain available. Framework discovery/tree/history and debugging tests are not accepted features. |
| Problems panel | Verified at runner scope | Compiler/run diagnostics and Learning Lens links. Cross-language live problem aggregation is incomplete. |

## Git, GitHub, updates, and distribution

| Capability | Status | Current scope and next gap |
| --- | --- | --- |
| Git status/diff/stage/unstage/commit | Verified | Explicit, short-lived commands; scoped root; bounded output; secure index handling. |
| Git history/blame/branches/stash | Missing | No complete user-facing workflows. |
| Fetch/pull/push | Missing | Remote credential and conflict model must be designed first. |
| Merge/rebase/conflict editor | Missing | No three-way merge UI or safe operation state machine. |
| GitHub sign-in/repos/issues/PRs | Missing | Requires official OAuth/device flow and token storage review. |
| GitHub Copilot sign-in/chat/agent | External | An official Copilot SDK now exists for custom applications, but Ion has no implementation or authenticated acceptance. Authentication, subscription/licensing, bundled runtime cost, permissions, and shutdown behavior require a proof of concept. [Official SDK](https://github.com/github/copilot-sdk) · [GitHub usage overview](https://docs.github.com/en/copilot/get-started/where-to-use-github-copilot) |
| Copilot inline completion | Official protocol available. Ion integration pending. | GitHub documents third-party inline completions and device sign-in. Signed-out protocol testing and authenticated editor acceptance are separate. [Language Server SDK](https://github.com/github/copilot-language-server-release#inline-completions). |
| Update check/download | Incomplete | GitHub release comparison/checksum flow exists; signing/notarization, exact-candidate upgrade/rollback, and cross-platform acceptance remain release gates. |
| macOS installer | External | Builds exist; trusted public distribution requires Apple Developer ID/notarization credentials. |
| Windows installer | Incomplete | Build and native CI exist; exact-current-candidate upgrade/rollback acceptance remains required. |
| Linux package | Deferred | Architecture is portable in parts, but no verified production release. |

## Learning, practice, projects, and AI

| Capability | Status | Current scope and next gap |
| --- | --- | --- |
| Offline learning Marketplace | Verified at catalog scope | 19 installable collections and 162 lessons; not complete end-to-end courses for every language. |
| Learning Lens | Incomplete | Strongest for selected C diagnostics; other languages have reviewed explanations but not equivalent source-linked coverage. |
| Local learning history | Verified | Encountered/resolved diagnostic events with conservative mastery semantics. |
| Practice browser | Verified at local scope | Topic/difficulty filtering and 27 bundled challenges. |
| Multi-language local samples | Verified at adapter scope | C/C++/Java/Python/JavaScript adapters with installed runtimes. |
| Competitive-programming judge | Missing | No large hidden-test corpus, scoring, constraints engine, submissions, or isolation-grade sandbox. |
| LeetCode account/submission integration | Unsupported | No official integration has been verified; premium login scraping is not acceptable. |
| Algorithm visualizer | Missing | No production visualization engine or trace protocol. |
| Adaptive learning path | Missing | History exists, but no evidence-based personalization engine. |
| Projects/roadmaps/test evidence | Verified at local scope | Versioned specifications, milestones, reviewed tests, historical evidence, manual/verified status. |
| Project Lens planning | Incomplete | Optional reviewed provider workflow exists; authenticated live-provider breadth and multi-provider acceptance are incomplete. |
| AI provider vault | Incomplete | OS-backed credential storage and explicit provider requests exist. Universal streaming/tool permission architecture is not complete. |
| Ask/Tutor/Edit/Agent modes | Missing | Tutor/planning pieces exist, but the requested four-mode cross-workspace system is not implemented. |
| Offline local AI model | External | No model is bundled or downloaded; future support must be opt-in and measured. |
| AI code completion by default | Deferred | Conflicts with Ion's learning-first principle. Any future completion must be explicit and separately scoped. |

## Documents, notebooks, themes, and extensions

| Capability | Status | Current scope and next gap |
| --- | --- | --- |
| Markdown source/preview/split | Verified | Sanitized GFM, live unsaved preview, local resource restrictions. |
| PDF viewer | Verified | Paged/ranged local rendering, zoom/search/navigation, disposal. |
| DOCX viewer | Verified with limits | Reflowed headings/tables/images; not full Word fidelity. |
| XLSX/CSV viewers | Verified with limits | Paged read-only tables, sheet selection/search, cached formula values. |
| PPTX viewer | External | Static rendering depends on available LibreOffice/macOS conversion; no animation/editing and no universal compatibility claim. |
| Jupyter notebook source/view/run | Incomplete | Offline notebook support with optional local kernel and approval; broad kernel/lifecycle/platform acceptance is incomplete. |
| Web preview | Verified at local scope | Separate network-denied session and workspace-limited assets. |
| Built-in themes | Verified | 16 declarative themes plus automatic system mode. |
| Theme import/export/create | Verified | Validated data-only definitions; active palette loaded, metadata registry retained. |
| Theme scale benchmarks | Verified historically | 5/20/100-theme and repeated-switch evidence exists historically; current exact candidate should retain regression coverage. |
| Extension API/marketplace | Missing | Learning packs/themes are data packages, not arbitrary code extensions. |
| Remote development/containers/SSH | Deferred | Major security/resource/product surface; not Phase 1–2. |

## Remaining ordering and boundaries

Phase 1's defined hosted acceptance passed before professional-tooling development. Phase 2.5's adapter foundation is accepted, but broader task requirements and Phase 2.6 remain incomplete. The user paused Test Explorer development; no resumed feature work is implied by this report. Later AI, Copilot, extension and remote-development proposals remain unimplemented or limited exactly as described above. Release/installation authority and exact-artifact verification remain separate from source-milestone acceptance.
