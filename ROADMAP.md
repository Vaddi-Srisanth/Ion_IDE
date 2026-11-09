# Ion IDE roadmap

These milestones describe product scope. The current package uses its own release sequence. See [PROJECT_AUDIT.md](PROJECT_AUDIT.md) for implementation and verification status and [PERFORMANCE.md](PERFORMANCE.md) for measured resource use.

## Release 0.1 — Essential IDE

- Keep the core workflow offline on macOS. Open Free Coding from Welcome, open individual files and folders, navigate the explorer, and edit, save, rename, or move local entries to Trash. Maintain syntax highlighting, multiple tabs, dirty indicators, autosave, resizable panels, persisted settings, and lightweight themes.
- Keep one interactive Run Console for local C, C++, Java, Python, and JavaScript. Verify output and input in that console, readable diagnostics, Stop and Rerun, cleanup after repeated runs, and paths with spaces. Toolchains remain local prerequisites.
- Make recovery a release gate. Verify unexpected renderer and app exits, untitled and named edits, external file changes, explicit discard, and normal saves. A saved or explicitly discarded draft should stay cleared after relaunch. Keep file writes revision-aware and atomic where practical.
- Gate each native release on the production desktop tests, an installed or mounted build check, and a process-tree benchmark with the toolchain, host, and workload recorded. Native support beyond verified platforms stays outside this milestone.

## Release 0.2 — Offline Learning

- Preserve the implemented C concept library, recognized GCC and Clang diagnostics, repetition tracking across distinct source revisions, and local history. Keep raw diagnostics visible when categorization is uncertain.
- Expand the C diagnostic corpus with representative compiler versions and keep the optional panel and history usable during a real edit, compile, and correction loop. Verify that repeated identical runs leave the repetition count unchanged.
- Maintain the 19 individually installable offline packs and their syntax guides, API examples, and exercises. Extend the reviewed diagnostic corpus for C, C++, Java, Python, and JavaScript as new toolchain output is verified. Learning Lens currently uses the C single-file workflow.

## Release 0.3 — Project Intelligence

- Preserve the implemented offline roadmap editor, saved milestones, reviewable specifications, and manual completion. Keep behavioral evidence separate from manual completion and identify stale results after source edits.
- The optional online planner already requests structured proposals from a user-configured HTTPS provider in Full Mode. Local validation and simulated replies are tested. Verify a credentialed end-to-end request and review model output against the existing planning rubric before claiming live provider coverage.
- Approved C console tests already check behavior using stdin and expected stdout. On-save tests are opt-in, scoped to the open project in Full Mode, and debounced. Broader behavioral test adapters remain future work. Preserve explicit approval, offline execution after planning, and test evidence tracked separately from milestone status.

## Later optional milestones

- **Document viewers.** Retain the lazy, read-only PDF, CSV, DOCX, and XLSX previews and the macOS PowerPoint preview. Maintain large-file, malformed-input, original-file integrity, and teardown regressions. PowerPoint is conditional on a separate LibreOffice installation. Keep static rendering compatibility and resource limits documented.
- **Coding practice.** Keep the offline challenge catalog and its filters, original problems, examples, notes, saved attempts, and local sample execution for C, C++, Java, Python, and JavaScript. Official submissions stay on the original problem site.

## Next three development priorities

1. Keep recovery, atomic saves, external-edit conflicts, and cancellation in the native release gate. Re-run them from a disposable profile against the shipped package.
2. Establish a comparable performance baseline on a lower-memory Mac. Compare process-tree memory, idle CPU, and run and tab cleanup using the same production workload before tuning further.
3. Extend the offline C diagnostic regression corpus and verify that unsupported diagnostics keep their original compiler text.
