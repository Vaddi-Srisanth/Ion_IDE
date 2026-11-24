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

The production build keeps the ordinary Monaco surface at 611,671 bytes versus the Phase 1 build's 611,106 bytes (+565 bytes / +0.09%). The 19,364-byte JavaScript and 1,180-byte CSS multi-cursor payloads are separate on-demand chunks. These are uncompressed artifact bytes, not RAM measurements.

## Next bounded work

Milestone 2.1B must establish source split ownership before UI expansion: one text model per open document, independent group view state, explicit focus, group-aware commands, session persistence, bounded model retention, and deterministic disposal. It must not duplicate buffers or lose undo history. Workspace reviewed replace follows only after revision-aware preview/apply semantics and conflict tests are defined.

No Phase 2 code has been pushed, installed, released or merged into `main` at this checkpoint.
