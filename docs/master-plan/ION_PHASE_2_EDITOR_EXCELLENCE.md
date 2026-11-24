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
