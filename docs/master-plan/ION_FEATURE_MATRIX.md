# Ion feature matrix

Status vocabulary is deliberately strict:

- **Verified** — existing and verified at the cited scope.
- **Incomplete** — useful implementation exists, but the requested professional scope is larger.
- **Unreliable** — implementation exists, but a current acceptance blocker or reproducible defect prevents a completion claim.
- **Missing** — no production implementation.
- **External** — blocked by optional tools, service APIs, credentials, licensing, or platform facilities.
- **Unsupported** — no official/safe integration has been established.
- **Deferred** — intentionally outside the current phase.

## Desktop, editor, and data

| Capability | Status | Current scope and next gap |
| --- | --- | --- |
| Standalone Electron desktop app | Verified | macOS-first, packaged Electron app with Windows build/test infrastructure. Linux is not a verified release target. |
| Monaco source editor | Verified | Single visible editor, bounded recent models, undo/redo, selections, syntax, diagnostics, and large-file preview. |
| New/open/save/save as/autosave | Verified | Revision-aware saves and existing save policy. |
| External-change protection | Verified | Conflict banner, reload/save-as behavior, and atomic publication tests. |
| Crash recovery and session resume | Verified | Local drafts and session metadata; full upgrade/endurance acceptance remains release-gate work. |
| Backup and reviewed restore | Unreliable | Production source is implemented; corrected exact-candidate native restore/relaunch and resource acceptance is incomplete. |
| Multi-tab editing | Verified | Bounded live Monaco models; hidden tab text/view state retained. |
| Split source/document view | Verified | Document/Markdown preview split is available. General source-to-source editor groups are incomplete. |
| Source-to-source editor groups | Incomplete | Keyboard split controls and document split exist; full group management is missing. |
| Multi-root workspaces | Missing | Current authorization and explorer model is single-root. |
| Explorer create/rename/delete | Verified | Main-process validation and safe mutations. |
| Workspace search/replace | Incomplete | On-demand bounded ripgrep search exists. Full multi-file reviewed replace is not established. |
| Quick Open / Go to line / command palette | Verified | Existing command registry, shortcuts, and on-demand file enumeration. |
| Breadcrumbs and navigation history | Incomplete | Navigation back/forward exists for semantic locations; comprehensive breadcrumbs/symbol trail is missing. |
| Minimap, bracket matching, folding, multi-cursor | Verified | Monaco-provided editor fundamentals. |
| Snippets and Emmet | Incomplete | Built-in language snippets exist; professional configurable snippet/Emmet system is not verified. |
| Configurable shortcuts | Verified | Validated local command overrides. Conflict UX and full discoverability can improve. |
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
| C/C++ semantic navigation | Incomplete | Scoped clangd definition/references for an active translation unit; no full project index/rename/completion suite. |
| Java semantic tooling | Incomplete | Bounded JDK compiler worker for completion/signatures/navigation/diagnostics; not a complete Java language server. |
| Python language server | Missing | Syntax/run/format exist; project-aware completion, navigation, refactor, and diagnostics do not. |
| JavaScript/TypeScript language service | Missing | Syntax/run/format exist; project-aware TypeScript service is not integrated. |
| Go/Rust/C#/other LSP | Missing | Syntax and some lesson metadata only. |
| Language-server lifecycle manager | Missing | Needed before adding universal LSPs; must enforce per-workspace opt-in, idle shutdown, limits, and ownership. |
| Debugger / DAP | Missing | No breakpoints, stack, variables, watches, stepping, or debug console. |
| Build-system discovery | Incomplete | Run plans and optional Java project launchers exist. General task/build graph support is missing. |
| Test Explorer | Incomplete | Saved project C console tests and evidence exist; framework discovery/tree/rerun/debug is missing. |
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
| Copilot inline completion | Unsupported | Requires a documented, licensed official integration and explicit acceptance; otherwise it remains unsupported. |
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

## Required ordering

The matrix is not a feature backlog sorted by excitement. `Backup and reviewed restore`, exact-candidate release identity, recovery/migration durability, and lifecycle cleanup are the only active product gates in Phase 1. Missing professional tooling starts only after those gates are closed.
