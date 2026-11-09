# Ion IDE 0.6.2 analysis

## Bottom line

Ion is a standalone, offline-first macOS editor with a genuine interactive runner and a narrower C-learning feature. The release can open a real assignment, edit and save source files, compile and run code, accept terminal input, explain several C diagnostic categories, and restore previously checkpointed drafts after a crash. The strongest evidence concerns file recovery, running local programs, and the bounds of the C classifier. The weakest evidence concerns whether students learn better, whether they choose Ion over an existing setup, and how the app behaves during a long session on an 8 GB Mac.

The inspected build is **0.6.2**. The saved production report hashes match the current `dist/main/index.cjs` and `dist/renderer/index.html`. The local Apple Silicon DMG was ad-hoc signed and was previously mounted, verified, and launched. The repository currently has no commit identifying these sources. The version, bundle digest, evidence files, and a source snapshot are the useful identifiers for an outside review.

## Capability inventory

| Area | What works today | Boundary or qualification |
| --- | --- | --- |
| Desktop and offline behavior | Standalone Electron application with Free Coding, Learn, Projects, and Practice. Native Open and Save dialogs, recent locations, resizable panels, and persistent settings. | Native package verified on Apple Silicon macOS. Initial development dependency installation needs network access. Intel macOS, Windows, and Linux have no equivalent release verification. |
| Source editor | Monaco tabs, lexical highlighting, undo/redo, find and replace within a file, comment and folding controls, editable UTF-8 source, autosave and Save As. Highlights C/C++, Java, Python, JavaScript/TypeScript, HTML/CSS, Markdown, YAML, JSON, and shell formats. | One source-editor surface, up to 64 tabs, three cached Monaco models, and a 2 MiB source limit. Dirty text survives eviction. Undo history tied to an evicted model can reset. Syntax highlighting and execution support differ. |
| File navigation | Folder explorer, create/rename/Trash, Command Palette, Quick Open, Go to Line, remappable shortcuts, keyboard-accessible document split. | Quick Open matches paths and names, visits up to 5,000 entries, scans up to 12 directory levels, and returns up to 40 matches. Explorer refresh is manual. There is no integrated workspace text search, second source pane, or full clean-tab session restore. |
| Save integrity and recovery | Revision checks, atomic publication where supported, explicit confirmation of occupied Save As destinations, recovery after tested renderer and full-process crashes. Recovered drafts open separately from originals. Invalid or newer preference formats stay intact with autosave disabled. | The recovery journal supports 64 drafts, up to 2 MiB each. A snapshot starts on a roughly 350 ms interval while editing, and the last completed snapshot is the recovery point. Power-loss durability is unverified. Concurrent external writes can race between revision check and replacement. |
| Interactive execution | Local C, C++, Java, Python and JavaScript. Real program stdin and stdout, terminal echo, stderr and compiler output, exit codes, timeout/output limits, Stop, and Rerun. External toolchain requirements are visible. | C/C++ use one translation unit plus includes. Python and Node run local scripts. Java supports companion source, packages and local JARs, plus a narrower Maven/Gradle path using available local tools and caches. The current five-language release matrix covers the basic local paths, with plain Java and companion sources. There is no general shell, integrated debugger, language server, or extension host. |
| Web preview | Separate local preview for a supported HTML entry point and workspace CSS/JS/assets. | Preview uses its own network-denied Electron session. It is a local static preview rather than a general deployment or dev-server workflow. |
| C learning | Twelve curated topics, recognized Clang/GCC diagnostic categories, raw diagnostics when uncertain, recurring-error feedback, and clearable local history. It works offline. | The language-specific explanations cover C only. The classifier is bounded. A recorded corpus of 40 diagnostics produced 29 correct classifications, 11 abstentions, and zero wrong classifications in that corpus. This measures a selected fixture set. Student comprehension, retention, and transfer remain unmeasured. |
| Projects | Editable local specifications and milestones, separately recorded manual progress and behavioral evidence. Reviewed C tests compare inputs, output, and exit status. Full Mode supports opt-in automatic tests on save. | Automated verification covers single-file C console behavior. The online planner is an explicit Full Mode action with a configurable HTTPS endpoint. The provider contract and simulated replies were tested. Real provider performance and proposal quality are unverified in this release. |
| Practice | Local problem statements, external references, notes, attempts, and sample results. Tested execution and separate attempt history. | Tests are C-only, with up to eight samples and twenty attempts per problem. There is no external judging/submission integration. |
| Themes | Five built-ins, automatic macOS appearance, custom theme creation, validated JSON import/export, persistence, and applying themes without remounting the editor. | The 0.6.2 suite tests behavior. Longer theme-switch measurements in PERFORMANCE.md use earlier releases. Full accessibility evaluation with assistive technology remains open. |
| Read-only documents | PDF page, zoom and text-layer search. DOCX formatted text, tables and raster images. XLSX and CSV sheet/table viewing, search and paging. PPTX static slide preview, thumbnails, keyboard navigation and full-screen presentation through LibreOffice. Code/document split. | PDF has no OCR search. DOCX reflows and omits some formats. XLSX displays saved formula values and does not recalculate. PowerPoint fidelity depends on LibreOffice and fonts. Document editing is outside scope. |
| Local export | Portable profile contains settings, recent locations, custom themes, learning history, project metadata and evidence. A real export reopened in a disposable profile offline. | Workspace source, unsaved recovery drafts, practice files, browser data and credentials are excluded. Project metadata reconnects by canonical workspace path. A relocated project needs explicit recovery of its specification. |
| Security boundaries | Context-isolated and sandboxed workbench renderer, scoped preload/IPC, path grants, local viewer parsing, process trust prompts and execution limits. Provider secrets stay behind OS-backed credential storage. | Approved native code and build tools execute with the user's OS permissions. The workbench's offline policy does not confine those processes. The desktop suites are regression evidence rather than a third-party penetration test. |

The README documents format limits and runner prerequisites. ARCHITECTURE.md describes the process and data boundaries. The current release log records **76 passing tests**, a production build, and desktop suites for saving, keyboard controls, recovery, five-language execution, workspaces, themes and document viewing. The mounted-package log verifies a signed PTY round trip and draft recovery after terminating the packaged app. The upgrade test exercised a disposable 0.6.1 profile in 0.6.2.

## Strong points

1. **It is a real tool with real failure paths.** The release tests check actual files on disk, compiled program output, terminal interaction, child-process exit, and content restored after a renderer or app crash. They also check denial cases and conflicting saves.
2. **Learning can happen inside the edit–compile–fix loop.** The local C rules explain recognized errors without requiring a key or uploading the code. Abstaining on uncertain diagnostics is a better starting point than giving a confident guess.
3. **Core workflows remain useful offline.** Editing, execution with installed toolchains, C explanations, roadmaps, C tests, practice, profile export, themes and supported previews work without a remote service. Optional AI planning has a separate consent path.
4. **Ordinary editor workflow is deliberate.** Keyboard shortcuts, Quick Open, terminal input and Stop make a real difference in a lab. Preferences reject binding conflicts, and the native suite verified remapping and relaunch persistence.
5. **Optional features are loaded on demand.** The tests verified that normal editing leaves document engines and optional panes unloaded. The editor caps cached models, the console bounds replay, and the process tree drains on Minimal-mode window close.
6. **Operational evidence is reproducible.** Raw reports expose build hashes, process membership, workload parameters, sample-level values and regression thresholds. A reviewer can see where an improvement claim would be unsupported.

## Weak points and priorities

| Priority | Weakness | Practical impact | What would close it |
| --- | --- | --- | --- |
| High | Learning value is unproven. | The most distinctive capability has classifier and workflow evidence, but no evidence that beginners understand or retain more. | Compare Ion and a familiar editor on matched unfamiliar C errors. Track correct fixes, explanation quality and transfer to a similar problem. |
| High | Lightweight claims exceed the tested conditions. | The full process tree is materially larger once the editor and optional panes have run. One 24 GiB Mac and a 27-second coding sample cannot establish experience on lower-memory student hardware. | Repeat with real coursework, a browser and notes open on an 8 GB Mac. Collect at least an hour of memory pressure, latency and failure/recovery evidence. |
| High | Atomic replacement lacks an atomic revision comparison across independent writers. | A narrow concurrent-edit window remains despite safeguards. The newest uncheckpointed edits may also be lost after a crash. | Add a deliberately interleaved race test and evaluate preservation of the displaced contents on contested saves. Specify exactly what survives crashes and power loss. |
| High for public release | Distribution coverage is narrow. | The available build is ad-hoc signed for Apple Silicon. Install friction and compatibility outside the tested Mac remain open. | Verify a Developer ID-signed and notarized build on another target Mac. Treat other OSes as separate validation efforts. |
| Medium | Editor depth is limited for multi-file work. | No workspace content search, integrated Git, debugger, LSP navigation/refactoring, general-purpose terminal, or source/source split. Large files, generated trees and undo across evicted tabs hit explicit limits. | Observe which gap repeatedly blocks the target coursework before adding tools or relaxing memory bounds. |
| Medium | Execution, learning and verification have different coverage. | Five languages can run, but only C receives learning feedback and behavioral tests. Real build systems can fall outside the supported launch model. | Publish a language-by-feature matrix and test the actual assignment structures learners use. |
| Medium | More subsystems mean more failure modes. | Document conversion, online planning and practice storage need ongoing validation. Their maintenance cost is real while their impact on the main learning task remains unknown. | Freeze expansion until one workflow earns clear user value. Track maintenance and runtime cost separately for optional modules. |
| Medium | Portability is partial. | The profile export is useful for settings and project records, but it is easy to assume it protects source or unsaved work. Project identity can break after relocation. | Keep export scope explicit and test a restore checklist that pairs workspace backups with the exported profile. |
| Medium | Traceability and wider QA are incomplete. | No Git commit identifies the reviewed source. Hours-long sessions, assistive technology, and live AI-provider quality have no current evidence. | Preserve an immutable source snapshot, attach report digests, and verify each gap with a dedicated test. |

The strongest case against switching is straightforward. A learner can already compile assignments in a familiar editor and look up diagnostics. The extra application is worth using only if its C feedback makes the learner better at diagnosing the next error. The fastest way to decide is a small controlled comparison using their actual coursework.

## What the runtime measurements mean

Ion uses **Electron 45.2.3 / Chromium 156.0.8078.80**, with a React workbench, Monaco editor, Node-based main process, and a native terminal helper. The installed Electron of that version reports embedded Node **24.22.2**. The release harness ran on separate Node **26.11.1**. User program runtime depends on the installed compiler/interpreter and the program itself. The C timing below is a tiny compile-and-run workflow. It cannot predict Java builds, Python workloads, or PowerPoint conversion.

The matched 0.6.2 benchmark used an **Apple M3, 24 GiB RAM, macOS 27.2 (26B123), on battery**. It used production bundles launched with the installed Electron runtime and disposable profiles. Fresh means a new process and profile with existing OS caches. Warm means a fresh process using the same prior profile. The native signed bundle check is a separate protocol.

- **Summed RSS** adds resident pages across the whole process family. Shared pages can appear more than once.
- **Attributed footprint** sums macOS `phys_footprint` charges. It includes attributed graphics memory and is a different accounting measure. Neither measure is the same as incremental system-wide RAM pressure.
- **CPU** is the percentage of **one logical core**. `40%` means about 0.4 busy cores on average during the sample. The mixed-workload value includes short-lived reaped compiler/program work.

### Matched production release measurements

| Workload | 0.6.2 result | How to read it |
| --- | ---: | --- |
| Fresh-profile startup | 384.35 ms | Median of 5, range 363.91–429.78 ms to visible Welcome. |
| Warm-profile startup | 381.00 ms | Median of 5, range 354.89–417.38 ms. |
| First open / reopen of a 1.50 MiB source | 177.39 / 52.72 ms | Measures verified editor content. |
| Rotating / cached tab switch | 49.95 / 49.91 ms | Timing includes the automation and render endpoint. |
| Typing to second animation callback | 31.20 ms | Renderer proxy. Physical display latency and dropped frames were unmeasured. |
| Short C Run / Stop through process exit | 190.68 / 51.88 ms | Run is a median of four. Stop includes the program and PTY helper exiting. |
| Idle CPU | 0.65% of one core | Over 10.06 s after a 500 ms settle. About 0.055% in the final 5 s. |
| Mixed coding CPU | 39.98% of one core | Over 27.33 s, including 12.29 percentage points of reaped native child work. |
| Installer / installed bundle | 123,002,880 / 272,140,830 bytes | About 117.30 MiB / 259.53 MiB of storage. |

| Process-tree state | Summed RSS | macOS attributed footprint |
| --- | ---: | ---: |
| Welcome, idle | 421.86 MiB | 122.30 MiB |
| One C file | 507.72 MiB | 341.24 MiB |
| Ten tabs | 524.41 MiB | 405.21 MiB |
| 1.50 MiB source open | 528.05 MiB | 366.68 MiB |
| 1,000-file project fixture | 549.86 MiB | 431.52 MiB |
| Learn / Projects / Practice visible | 590.09 / 595.11 / 598.30 MiB | 479.68 / 464.63 / 449.19 MiB |
| 20 mixed coding rounds | 678.88 MiB peak | Peak footprint not reported by this workload. |

Panel snapshots are cumulative Full Mode stages after previous work. The process tree was already at **585.08 MiB RSS** before opening the first optional pane. Subtracting the Welcome result would overstate each panel's cost. At the project snapshot, the Chromium GPU helper accounted for **259.05 MiB of 431.52 MiB** attributed footprint. That is memory accounting rather than GPU utilization. The short active-snapshot settle interval was 500 ms.

All **32 enforced comparisons** against 0.6.1 passed. Seven active footprint comparisons were advisory because there was one observation per build. Idle RSS rose **3.97 MiB**. The sampled median fresh/warm launches rose **15.84 / 23.60 ms**. No speed or RAM improvement is established. Extended RSS rose during large-file warmup, then measured **665.27–666.66 MiB** across rounds 12–20. That is stabilization within this workload, with a 27-second observation horizon. GPU utilization, actual displayed frame times, system swap or memory pressure, and hours-long stability remain unmeasured here.

### Fresh measurements of the signed .app

The release bundle was copied to a disposable directory and signature-checked before each run. The app opened with synthetic recent entries, Minimal Mode, and local browser inspection on the same M3. Nothing from the live user profile was needed. These observations use a 5-second settle and much smaller file fixture than the matched release workload, so they form a separate measurement.

| Signed app, two idle checks | First check | Repeat |
| --- | ---: | ---: |
| Welcome RSS / attributed footprint, median | 408.67 / 118.30 MiB | 410.16 / 118.80 MiB |
| Welcome CPU over about 30 s | 0.28% of one core | 0.30% of one core |
| One tiny C file, RSS / attributed footprint, median | 478.37 / 168.12 MiB | 480.37 / 172.91 MiB |
| One file idle CPU over about 15 s | 1.60% of one core | 2.04% of one core |
| First open of that C file | 179.15 ms | 167.38 ms |

Across these checks and a startup-only diagnostic, the **first launch of each new bundle copy** took **2.55–2.76 s** to visible Welcome. Later launches with fresh profiles took **351–438 ms** (six launches). Same-profile relaunches took **336–387 ms** (nine launches). The startup-only diagnostic observed the local inspection port at **2.50 s** on the slow launch, versus about **145–147 ms** in later launches. Most of the observed delay preceded inspection attachment. This protocol includes process spawn and inspection timing. The underlying cause and normal Finder installation timing remain open.

All three checks recorded the same release ASAR SHA-256, `0b0bb309ee28b36150f7ed93aae491b6ac2456b6d181fea9aabb7c145db02163`. Raw files are `performance-results/packaged-runtime-2026-11-09T07-30-13.849Z.json`, `performance-results/packaged-runtime-2026-11-09T07-32-45.729Z.json` and `performance-results/packaged-runtime-2026-11-09T07-34-15.824Z.json`. The final file contains the startup-stage breakdown only.

### Earlier evidence kept separate

- The 100-run interactive C diagnostic covers **0.6.1**. RSS was 510.22 MiB before the first run, 537.55 MiB after run 100, and 526.50 MiB after closing the console. The native helper and program exited after every run.
- The 160-page PDF split benchmark covers **0.5.0**. It sampled 595–608 MiB RSS while PDF and source were visible. It does not establish current office conversion cost.
- The long theme-switch benchmark covers **0.4.0**. The current release suite validates theme behavior, with no equivalent long 0.6.2 benchmark in this evidence pack.
- The native/WKWebView alternatives are historical probes with a smaller feature workload. Their results are useful for comparing hypotheses and cannot be treated as forecasts for a port of the full app.

## Reproduction and reviewer handoff

- Production QA uses `npm run test:regression`, `node scripts/verify-mac-release.mjs`, and the commands and fixtures documented in PERFORMANCE.md.
- The signed-bundle check can be repeated with `node scripts/benchmark-packaged-runtime.mjs`. It uses the released `.app`, an isolated synthetic workspace and macOS kernel counters. Add `--startup-only` to repeat the launch-stage diagnostic.
- Use `AI_REVIEW_BRIEF.md` to request independent review. Send the brief, this report, the source/tests/build configuration, and the specific raw evidence files. Source plus test logs are more useful than a DMG alone for an AI that cannot run macOS software.

Primary raw evidence lives under `performance-results/` in the matched readiness baseline/final JSON files, `readiness-performance-gate.log`, `readiness-release-gate.log`, `readiness-integrity-upgrade.log`, and `readiness-package.log`. Give an outside reviewer a separate source snapshot with reviewed copies of logs. Live profiles and recovery data can contain personal code and paths.
