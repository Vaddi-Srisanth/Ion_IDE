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

No Phase 2 code has been pushed, installed, released or merged into `main` at this checkpoint.
