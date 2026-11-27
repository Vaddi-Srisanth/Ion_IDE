# Ion Phase 2 — editor excellence

## Scope and baseline

Phase 2 preserves the verified Phase 1 application and starts with editor ergonomics. The numerical baseline is the corrected matched production run [45213098671](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45213098671): macOS candidate cold start 1,083.96 ms, first file 597.98 ms, one-file attributed footprint 166.23 MiB, summed RSS 446.51 MiB and one-core idle CPU 1.42%; Windows candidate cold start 1,568.97 ms, first file 406.23 ms, private bytes 178.95 MiB, working set 346.90 MiB and idle CPU 0.00% in that run. These values are historical Phase 1 evidence, not re-labelled Phase 2 measurements.

The current architecture audit confirmed:

- one visible Monaco surface with bounded model retention and persistent view/undo state;
- Monaco mouse multi-cursor primitives, but no loaded keyboard contribution or Ion commands;
- safe multi-tab open/close/cycle/session ordering, but no explicit reordering commands;
- verified Quick Open, Go to Line, definition/references and back/forward navigation;
- verified document/Markdown splits, but no general source editor groups;
- bounded on-demand workspace search, but no reviewed multi-file replace;
- a single granted workspace root.

## Milestone 2.1A — keyboard editing and tab ordering

Implemented as the smallest independently testable editor slice:

- Add Cursor Above, Add Cursor Below, Select Next Occurrence and Select All Occurrences are exposed in the command palette, native Edit menu and configurable shortcut registry.
- The Monaco multi-cursor contribution is dynamically imported only when one of those commands is first used. Ordinary editor startup and normal one-file editing do not request it.
- Move Tab Left and Move Tab Right are exposed through the command palette, native View menu and configurable shortcuts.
- Reordering only changes the ordered `Documents` map. It does not recreate a Monaco model, read or write a file, change the active tab, clear dirty state, or alter undo history.
- Arrow-key shortcut parsing and native accelerator conversion are validated for macOS, Windows and Linux conventions.

### Focused evidence

- `npm run typecheck` — pass.
- `node scripts/test.mjs shortcuts documents` — 11/11 pass, including dirty active-buffer tab movement.
- `npm run build` — pass.
- `npm run test:keyboard` — pass for native multi-cursor loading/action, tab reordering, Quick Open, Go to Line, command palette, document split and remapped Run/Stop.
- Initial test attempt intentionally edited the fixture and reached Ion's unsaved-change quit guard; the product was not weakened. The acceptance assertion was corrected to inspect secondary cursor state without editing.

At the 2.1A checkpoint, the production build kept the ordinary Monaco surface at 611,671 bytes versus the Phase 1 build's 611,106 bytes (+565 bytes / +0.09%). The 19,364-byte JavaScript and 1,183-byte CSS multi-cursor payloads are separate on-demand chunks. These are uncompressed artifact bytes, not RAM measurements.

## Milestone 2.1B — source split foundation

Ion now supports an on-demand second view of the active source document:

- both editor widgets use the exact same Monaco text model and undo stack;
- each widget owns its cursor, selection and scroll view; the secondary view state is retained per tab while the workbench remains open;
- focus can move explicitly to the second editor and Find/multi-cursor commands follow the focused widget;
- the divider supports pointer and keyboard resizing with accessible separator semantics;
- closing the split detaches the model before disposing the second widget; no process, worker or duplicate source buffer is created;
- source splitting is suspended while Markdown preview/source is hidden, so an invisible second editor does not remain active.

Focused Electron acceptance proves that an edit made in the second widget appears in both views, one Undo restores the shared model, save clears the disposable dirty state, keyboard resize works, and the secondary DOM/editor is removed on close.

Matched production artifact sizes against Phase 1 `005c402` are 614,284 versus 611,106 bytes for the lazy Monaco surface (+3,178 bytes / +0.52%) and 370,792 versus 368,346 bytes for the renderer shell (+2,446 bytes / +0.66%). No dependency or startup process was added.

The macOS disposable-profile benchmark recorded startup 306.95 ms and first-file 185.58 ms for this local run. Across five split cycles, median creation was 22.60 ms and close was 27.98 ms. Attributed footprint was 216.61 MiB before the cycles, 277.29 MiB median while open and 185.26 MiB after a five-second final recovery. Summed RSS was 509.78 MiB before, 521.63 MiB median while open and 522.05 MiB after recovery; the retained 12.27 MiB is reported as allocator/working-set retention, not called a leak. Final closed CPU was 0.22% of one logical core. Raw output is locally generated under ignored `performance-results/`; the reusable harness is `scripts/benchmark-editor-split.mjs`.

## Next bounded work

The source split ownership foundation is verified. Completing professional groups still requires different-file group assignment, group-aware tab selection/navigation and persisted group restoration. Workspace reviewed replace follows only after revision-aware preview/apply semantics and conflict tests are defined.

## Milestone 2.1C — reviewed workspace replace

The existing on-demand ripgrep search now supports a deliberate review/apply flow. Ion enumerates every affected saved file, reads a stable revision and SHA-256, computes literal case-insensitive replacements, and keeps one expiring, 8 MiB-bounded main-owned snapshot. The renderer can select only paths included in that snapshot. Apply uses Ion's existing serialized, atomic per-file save primitive; a changed file is preserved and reported instead of overwritten. Other reviewed files may still complete, with the partial outcome shown explicitly.

Modified or conflicted open workspace buffers block review. If a clean open buffer is edited after review or a reviewed disk file is published, Ion preserves the buffer and marks that tab for external-change review. Generated folders, document viewers, notebooks, binaries, oversized files and links retain the existing search exclusions. A limited or incomplete search cannot become a replace review.

Verification includes six focused backend tests and production Electron acceptance. The latter performs a real reviewed two-occurrence replacement in a disposable workspace and observes the published bytes. Type checking and production build pass. No dependency, process, background task or startup path was added; the main implementation remains behind the existing workspace-search dynamic import. The renderer shell grew by 368 uncompressed artifact bytes (+0.10%) from the 2.1B checkpoint; Monaco is unchanged.

## Native Windows acceptance

The initial editor-excellence slice passed its final native Windows run [45350808435](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45350808435) at immutable commit `5a70d92a5fc396de1968f7a3fec774832adb9c6f`. Build, type checking, native editor/filesystem tests, the production Electron workflow and session/recovery/model-retention checks all passed. One focused cancellation fixture was explicitly skipped; it was not counted as passing.

Ten split open/close cycles created no child process: every sample retained the same four-process Electron tree. Median open/close latency was 25.57/37.19 ms. Working set moved from 335.91 MiB before the cycles to a 340.81 MiB open median and 321.02 MiB after recovery. Private bytes moved from 179.40 MiB to 187.73 MiB and then 169.46 MiB. Final closed CPU was 0.29% of one core. These hosted-run values characterize the focused Windows workflow; they are not substituted for the broader Phase 1 baseline.

Two preceding failed runs remain visible. [45350028358](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45350028358) attempted to locate the search modal before its lazy UI had opened. [45350331589](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45350331589) demonstrated that repeatedly injecting the command-palette OS accelerator was not a stable automation transport after focus changes on Windows. The final driver verifies the native accelerator explicitly once, then uses Ion's visible command-palette control for subsequent command selection. No production behavior, timeout or file-integrity guard was weakened.

**Milestone verdict: PASS for the implemented multi-cursor, tab-ordering, same-document split and reviewed-replace scope.** Different-file groups, persisted group layouts and multi-root workspaces are deliberately tracked as subsequent Phase 2 milestones.

Phase 2 verification code and the accepted slice were pushed only to `codex/ion-core-excellence-phase-2`. They were not installed, released or merged into `main`; the installed Ion application and live profile remain untouched.

## Milestones 2.1D/2.1E — different-file groups and restored layouts

Commits `4214e4e`, `f47ec7d` and `9bca0ed` add a bounded group-layout model and reuse the existing Monaco model registry. Ion supports nested horizontal and vertical splits with up to four groups, the same or different files in each group, tab drag/move, directional focus, close/rebalance and accessible keyboard resizing. Multiple views of one document share one text model, dirty state and undo stack while retaining independent cursor, selection and scroll state. Moving a tab changes group references and does not recreate its model.

The versioned editor-session snapshot stores layout orientation, bounded percentages, group membership, active group and active tab, alongside the existing per-document view state. Restoration validates the tree, rejects cycles/unknown groups/invalid percentages, drops unavailable documents and falls back to a safe single editor for old or malformed profiles. Production relaunch acceptance preserved a horizontal two-group layout at 56%, different active files and group membership.

Focused unit tests, production keyboard acceptance, type checking and production build pass on macOS. The exact combined foundation later passed native Windows acceptance at `0718aa7b35894474e1932efba7cee3286dcf0aab`.

## Milestone 2.2 — secure multi-root workspaces

Local commit `bc9ca7b` replaces the single-root assumption with an explicit ordered set of at most eight canonical, non-overlapping roots. Every root is independently inspected and granted. Removing a root revokes transient run trust for that subtree, closes dependent Git ownership, invalidates searches/replacement reviews and removes its filesystem authority. Adding or restoring a root never imports execution, repository, terminal or test trust.

The Explorer supports add/remove/reorder and duplicate-name disambiguation. Version-one `.ion-workspace` files contain only absolute roots plus a strict subset of editor settings; they are size-bounded, validated before authority changes and shown in an explicit grant review. Root-aware behavior covers Quick Open, per-root and combined search, reviewed combined replacement, breadcrumbs, terminal cwd, Git selection, C/C++ build manifests, saved project tests, Project Lens, Markdown assets, notebooks, formatters, web preview and the existing on-demand semantic adapters. Session restoration grants only the validated saved roots.

Local evidence:

- complete unit/security suite: 386 passed, 0 failed, 26 explicitly skipped platform fixtures;
- production editor session: ordinary recovery, persisted editor groups/two roots, and reviewed workspace opening all passed;
- production keyboard workflow: multi-cursor, same-document split, different-file groups, reviewed replace, navigation, shortcuts and relaunch all passed;
- type checking and production build passed;
- no installed application, live profile, release, update feed or `main` change.

### Matched performance and focused workload

Three paired macOS trials compared the exact pre–multi-root `9bca0ed` build to `bc9ca7b`. Candidate medians were fresh startup 293.19 ms (-10.75%), warm startup 289.14 ms (-8.71%), first file 179.83 ms (+0.42%), idle summed RSS 429.09 MiB (+0.59 MiB), one-tab RSS 518.91 MiB (+0.49 MiB), ten-tab RSS 531.45 MiB (+1.43 MiB) and idle CPU 0.31% (unchanged). All samples were retained.

In the focused five-root production workload, whole-workspace search found one match in each root in 11.30 ms; review took 9.60 ms and all five atomic file publications completed in 39.10 ms. The owned Electron tree stayed at four processes through one/five roots, 10/50 tabs, four same-file groups, four different-file groups, repeated group cycles and restoration. No background service exists merely because multiple roots are configured.

The fifty-tab checkpoint was 354.27 MiB attributed footprint / 549.63 MiB summed RSS. After five four-group create/close cycles and five seconds of recovery it was 286.10 / 612.08 MiB. The footprint recovered below the preceding workload; RSS retained 62.45 MiB of allocator/working-set pages and is not labeled a leak. A fresh restored fifty-tab/five-root session measured 350.91 MiB footprint / 500.50 MiB RSS. These are local Apple Silicon observations, not Windows substitutions.

### Combined native Windows acceptance

The final focused run [45364188961](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45364188961) passed on Windows Server 2022 x64 at exact source `0718aa7b35894474e1932efba7cee3286dcf0aab`. Type checking and production build passed. The complete native suite reported **387 passed, 0 failed, 17 explicitly skipped** out of 404 tests; skips remain visible and include unsupported/unavailable environmental fixtures. Production Electron acceptance passed multi-cursor, same- and different-file groups, reviewed replacement, shortcuts and relaunch. Session acceptance passed ordinary recovery, two-root/group restoration, reviewed `.ion-workspace` opening without trust import, and model undo/redo retention.

The five-root workload measured first file 336.23 ms, one-root startup 312.70 ms, five-root startup 303.59 ms, ten tabs 434.10 ms, the next forty tabs 1,874.87 ms, same-file four groups 209.11 ms and different-file four groups 364.89 ms. Whole-workspace search took 55.10 ms; replacement review took 54.10 ms and five safe publications completed in 163.20 ms with zero failures. Group-layout restoration took 319.07 ms after a 354.33 ms startup. Idle sampled CPU was 0.00% of one core.

Every Windows resource sample retained exactly four owned Electron processes; no terminal, compiler, Git, debugger, test or language-service process appeared. One root measured 347.08 MiB working set / 192.65 MiB private bytes, five roots 344.84 / 187.96, fifty tabs 391.89 / 230.07, four same-file groups 398.51 / 234.04 and four different-file groups 397.41 / 225.98. After five group cycles with the fifty loaded tabs still present the process retained 456.61 / 293.91; a fresh restored session measured 344.59 / 182.23. This is bounded allocator/model retention in one run, not proof of a leak or a RAM improvement.

The separate ten-cycle split workload had 32.84 ms median open and 37.74 ms median close latency. Working set moved 336.99 -> 342.52 median-open -> 321.32 MiB recovered; private bytes moved 180.17 -> 188.61 -> 168.57 MiB. All 23 samples retained four processes. Compared with the earlier focused Windows run, median open was 7.27 ms slower while close and memory recovery were effectively stable; one hosted sample is insufficient to label that a production regression.

Failed runs remain preserved rather than suppressed: [45360309331](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45360309331) exposed POSIX-only workspace fixtures; [45361189304](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45361189304) exposed missing UI synchronization/error preservation; [45362069941](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45362069941) established the real case-insensitive renderer-scoping defect; [45362818098](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45362818098) exposed an `ENOENT` polling defect; and [45363524001](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45363524001) exposed autosave racing a dirty-buffer test. Only the renderer-scoping defect changed production code; the other corrections made disposable acceptance deterministic and preserved original failures.

**Current verdict: PASS for the implemented editor/workspace foundation.** Functional, integrity, security, restoration and bounded-resource acceptance passed on macOS and Windows. General LSP/DAP work has not begun, no installed application or live profile was changed, and no release/main/update-feed action occurred.

## Editor Essentials checkpoint — professional daily interactions

Candidate `8cce186b8b2bb3a703bfb434c24c29c89dbc45dd` closes the interaction gaps identified after LSP acceptance without adding a service, dependency, renderer, poller or startup task:

- tab context menus expose split, Close, Close Others, Close to the Right, Close Saved, Close All and Reopen Closed Editor;
- dirty batch closes pause at Ion's existing Save/Discard/Cancel boundary instead of bypassing recovery or file-conflict handling;
- Ctrl+Tab and Ctrl+Shift+Tab traverse a bounded, stable, group-aware MRU snapshot keyed by group and tab identity;
- Explorer is an accessible roving-focus tree with Arrow, Home/End, Enter/Space, F2, Escape and focus-scoped macOS Command+Backspace / Windows Delete behavior;
- Explorer context menus reuse the established safe create, rename and Trash operations, and add authorized Copy Path and Reveal actions that revalidate the existing workspace grant and reject link escapes;
- Open in Integrated Terminal creates an on-demand shell at the selected folder through the existing PTY infrastructure; ordinary editing still starts no terminal;
- Save All, close variants, reopen and Focus Explorer are available in the existing command/shortcut registry rather than a duplicate command system.

Local macOS verification against a disposable production profile passed: type checking, production build, 22 focused model/security tests, the complete unit/security suite (**467 total, 441 pass, 26 explicit platform/environment skips, 0 fail**), the existing production keyboard/relaunch workflow, and the new production Editor Essentials workflow. The latter verifies Explorer keyboard rename, MRU traversal, tab context close/reopen and the authorization-checked path bridge. No remote request or uncaught renderer error was observed.

Focused Windows x64 run [45863976766](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45863976766) passed on the first attempt against evidence commit `c0a33785d006cae0c9eed280ba398c288a3babc9`, which contains production candidate `8cce186b8b2bb3a703bfb434c24c29c89dbc45dd`. The host was Windows Server x64 `10.0.20348` with Node `24.22.2`. The native suite reported **457 total, 440 pass, 17 explicit skips, 0 fail**; build/typecheck, the established editor workflow, the new Editor Essentials workflow, session/recovery/model retention, ten split lifecycle cycles, and multi-root/search/replace/restore resources all passed.

The ten-cycle workload kept exactly four owned Electron processes throughout. Closed-baseline RSS was 336.58 MiB and recovered RSS was 322.47 MiB (−14.11 MiB); closed-baseline private memory was 180.14 MiB and recovered private memory was 171.04 MiB (−9.10 MiB). Median open/close latency was 38.61/45.42 ms and measured closed idle CPU was 0%. The broader multi-root workload also retained four processes, measured one-root startup at 384.90 ms, first-file opening at 394.26 ms, and restored-session RSS/private memory at 347.43/190.45 MiB. These are single hosted-run measurements, not universal hardware claims.

**Editor Essentials verdict: PASS on macOS and Windows x64.** The installed application, live profile, `main`, releases and update feed remain unchanged.
