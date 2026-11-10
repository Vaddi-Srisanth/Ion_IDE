# Ion IDE roadmap

These milestones describe product scope. The current package uses its own release sequence. See [PROJECT_AUDIT.md](PROJECT_AUDIT.md) for implementation and verification status and [PERFORMANCE.md](PERFORMANCE.md) for measured resource use.

## Performance-first development milestones

Verify each milestone against a preserved production build before opening the next one. Keep the existing editor and process ownership. Measure optional features both closed and active, and check that their cleanup preserves files, drafts, and running work.

| Milestone | Existing foundation | Next verified increment |
| --- | --- | --- |
| A · First launch | The offline intro and optional setup reuse Welcome, its four workspaces, starter files, and Run Console. macOS functional and playback measurements are recorded. | Verify the installed Windows file-open and reduced-motion paths on Windows, and repeat the resource checks on lower-memory hardware. |
| B · Java intelligence | Ion provides basic snippets and an opt-in compiler-backed Java adapter for semantic completion, live diagnostics, signatures, and navigation. | Verify Windows runtime behavior and larger Java workspaces. Expand project classpath and reference coverage only after profiling. |
| C · Learning Lens | C connects diagnostics, source, and lessons. Reviewed Java and Python guides already cover selected errors. | Grow verified C coverage, then extend source-linked Lens to Java. Keep exercise results separate from compiler resolutions. |
| D · Project development | Tabs, Quick Open, search, document and Markdown splits, and explicit C/C++ and Java builds are available. | Verify a second source view with shared models and independent view state, then add on-demand Git and scoped run configurations. |
| E · Debugging | An isolated Apple LLDB-DAP probe ran a C fixture. Run Console is independent. | Integrate one debugger with verified stepping, state inspection, explicit execution consent, and adapter cleanup. |
| F · Usability | Session recovery, optional learning panels, and manual versus test-verified project progress already exist. | Add Quiet Mode, extend view restoration and history navigation, and test a local redacted issue-report export. |

## Release 0.1 — Essential IDE

- Keep the core workflow offline on macOS. Open Free Coding from Welcome, open individual files and folders, navigate the explorer, and edit, save, rename, or move local entries to Trash. Maintain syntax highlighting, multiple tabs, dirty indicators, autosave, resizable panels, persisted settings, and lightweight themes.
- Keep one interactive Run Console for local C, C++, Java, Python, and JavaScript. Verify output and input in that console, readable diagnostics, Stop and Rerun, cleanup after repeated runs, and paths with spaces. Toolchains remain local prerequisites.
- Make recovery a release gate. Verify unexpected renderer and app exits, untitled and named edits, external file changes, explicit discard, and normal saves. A saved or explicitly discarded draft should stay cleared after relaunch. Keep file writes revision-aware and atomic where practical.
- Gate each native release on the production desktop tests, an installed or mounted build check, and a process-tree benchmark with the toolchain, host, and workload recorded. Native support beyond verified platforms stays outside this milestone.

## Release 0.2 — Offline Learning

- Preserve the implemented C concept library, recognized GCC and Clang diagnostics, repetition tracking across distinct source revisions, and local history. Keep raw diagnostics visible when categorization is uncertain.
- Expand the C diagnostic corpus with representative compiler versions and keep the optional panel and history usable during a real edit, compile, and correction loop. Verify that repeated identical runs leave the repetition count unchanged.
- Maintain the 19 individually installable offline packs and their syntax guides, API examples, and exercises. Extend the reviewed diagnostic corpus for C, C++, Java, Python, and JavaScript as new toolchain output is verified. Learning Lens currently uses the C single-file workflow.

### Universal Learning System

The Essential Java Editing milestone establishes the first language adapter. The next milestone extends the existing pack format with shared course hierarchy, lesson navigation, and stable lesson IDs scoped to a pack and language. Use Java as the reference and adapt the existing C pack. Keep existing learning history readable during migration. Keep completed lessons, quiz attempts, practice evidence, and compiler resolutions separate. The future optional Mentor will receive the selected language and lesson context only when asked.

| Wave | Course rollout |
| --- | --- |
| 1 | Java, C, C++, Python, JavaScript |
| 2 | TypeScript, HTML, CSS, SQL, Go, Rust, C# |
| 3 | Kotlin, Swift, PHP, Ruby, Bash, Dart |

Test shared navigation and isolated progress across the first two migrated packs before expanding. Compare memory and startup with 5, 25, 50, and 100 installed packs once the shared course architecture is ready. Track course depth, quiz and practice availability, semantic editing, explanations, and code execution as separate capabilities.

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
