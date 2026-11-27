# Ion engineering handoff through Phase 2.5

This is the accepted **source and evidence checkpoint**, not a public release or an installed-app update. Phase 0 and Phase 1 passed their defined gates. Phase 2 has accepted editor/workspace, language-service, interaction, C/C++ debugger and build-adapter foundations; **Phase 2 overall remains INCOMPLETE**.

## Delivery identity and boundaries

- Previous `main`: `618563662ca4c2c82c8485d1413ad2a398bd3dae`.
- Accepted source/evidence tip: `23dff68d29b07fd519d5b7b83857857bfe6ef20c`.
- Latest accepted production implementation: `036781e7fe99be4480e5f0803fb6b22124be72a8`; later accepted commits contain verification/reporting changes. The delivery preserves that production source, dependencies and build configuration.
- The final delivery commit is recorded by Git and the delivery response; this document does not invent a self-referential commit SHA.
- Published release remains **v0.9.6**. The **v0.9.8 draft remains unchanged**; `0.9.8` in source is development metadata, not evidence of a published release. Release publication was canceled. No installer publication, update-feed change, installation, live-profile change or user-project modification belongs to this handoff.
- Phase 2.6 is **PAUSED / PARTIALLY IMPLEMENTED outside this delivery** on `codex/ion-core-excellence-phase-2-tests`. Its local pytest checkpoint `329789c7ff33f163764bfd30b6ce94d1d91a962b` had 474 passes and 26 skips out of 500; later generic/Vitest edits remain unverified. None of those counts or changes is acceptance evidence for `main`.

## Accepted scope

| Milestone | What is accepted | Important boundary |
| --- | --- | --- |
| Phase 0 | Six audit, architecture, feature, security, performance and implementation-tracking documents, with source identities and retained failures. | An audit and roadmap are not implementation of every listed feature. |
| Phase 1 | Streaming, validated local backup; reviewed restore/relaunch; populated rollback; interrupted-startup repair; settings, themes, lessons, practice/source, roadmaps, history and detached recovery drafts accessible through normal stores. | Credentials, execution trust and active approvals excluded. Historical test evidence cannot authorize execution. |
| 2.1 / 2.2 | Shared-model splits, multi-cursor, group/tab management and restoration, reviewed bounded search/replace, multi-root routing/settings and explicit filesystem grants. | Replacement is safe per file, not an atomic transaction spanning every file; imported paths grant no access automatically. |
| 2.3 | On-demand shared language-service ownership; Java, clangd, Python/Pyright and JavaScript/TypeScript intelligence; diagnostics, navigation, reviewed rename/workspace edits, cancellation and cleanup. | Installed tools and explicit opt-in are required. Language services have their own measurable memory cost. |
| Editor Essentials | Explorer/tab context menus, keyboard tree operations, group-aware Ctrl+Tab history, focus-scoped delete/rename, safe close/reopen and folder terminals. | Accepted before debugger work; no new background process. |
| 2.4 | C/C++ DAP: breakpoints, stepping, stack/scopes/variables, watches, continue/pause, restart/stop and owned-process cleanup. | One session; no accepted Python/Java debugging, remote attach, data breakpoints or disassembly. |
| 2.5 | **Complete for the accepted build-adapter foundation:** on-demand discovery/planning, saved profile records, dependency ordering, explicit run approval, Run Console execution/input/Stop and cleanup. | Broader task scope remains technical debt: workspace-authored task definitions, safe problem matching and native execution journeys for every adapter. Native npm execution is verified; other adapter plans have unit/static coverage, not equivalent native acceptance. |

Existing offline editing, Run Console, terminal, Git, notebooks, learning content, recovery and backup/restore remain part of the regression surface. No new AI/Copilot or Phase 2.6 implementation is included in this delivery.

## Exact verification identities and native runs

| Scope | Application / harness identity | Authoritative evidence |
| --- | --- | --- |
| Phase 1 | App `c5306449445e16090c81d8396003b9885b710fd0`; final harness `43969bcf2b7de3d8ebcd06d7892a46b69cbcdcee` | [Backup/relaunch acceptance 45205283873](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45205283873), [matched 45213098671](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45213098671), [package/security gates 45215470028](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45215470028), [Windows correction 45334910491](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45334910491). |
| Editor/workspace | `0718aa7b35894474e1932efba7cee3286dcf0aab` | [Windows 45364188961](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45364188961); local macOS production workflows and matched measurements in the editor report. |
| LSP | App `6bcc06c059a13461b145e5e4ccec55d22bb3bced`; harness `9aaeaeffff5cbb5b20a00ddbe373ba51c4e24578` | [Final macOS ARM64 + Windows x64 45859946256](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45859946256). |
| Editor Essentials | App `8cce186b8b2bb3a703bfb434c24c29c89dbc45dd`; evidence `c0a33785d006cae0c9eed280ba398c288a3babc9` | [Windows 45863976766](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45863976766); local macOS production keyboard/relaunch acceptance. |
| DAP | App `bcd2d5560510492b7dae8c69c97a925b2c7db787`; final harness `041a5b02c886bcbe7255e58b0fb711aeac6e69ac` | [macOS 45876230321](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45876230321/job/140103900405), [Windows 45877000977](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45877000977/job/140106512467); identical production tree. |
| Build/tasks | App `036781e7fe99be4480e5f0803fb6b22124be72a8`; functional harness `c7b925caf6aef4e7956301692007330a0e3e1d08`; benchmark harness `bf27e86e4914e5f144812dce8f5d8d3dad49d5fe` | [Final full/native 45924540081](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45924540081), [matched resources 45923748325](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45923748325). The benchmark-only run is not substituted for functional acceptance. |

| Suite checkpoint | macOS pass / skip / fail | Windows pass / skip / fail |
| --- | ---: | ---: |
| Editor/workspace | 388 / 26 / 0, local | 387 / 17 / 0 |
| LSP | 428 / 26 / 0 | 427 / 17 / 0 |
| Editor Essentials | 441 / 26 / 0, local | 440 / 17 / 0 |
| DAP | 455 / 26 / 0 | 454 / 17 / 0 |
| Final build/tasks | **461 / 26 / 0, 487 total** | **460 / 17 / 0, 477 total** |

Phase 1 additionally recorded 12 actual lifecycle cases and seven disposable-profile observations per host, with zero failures in the final backup run. Final delivery preparation repeated only typecheck, production build and six focused task tests in the isolated delivery worktree; all passed. No new broad qualification is implied. Skips remain skips: platform-specific ConPTY/Job Object, POSIX/macOS metadata, filesystem/process fixtures and unavailable toolchain cases are identified in the detailed reports. Counts from different checkpoints are not additive.

## Measured performance, with comparable workloads

These are retained measurements on their stated candidates, not fresh measurements of the documentation merge or promises for every computer. RSS, macOS attributed footprint, Windows working set and private bytes are different counters. CPU is reported relative to one logical core. Never compare unlike host/workload tables as a single trend.

**Phase 1:** exact baseline `d67613a1e9b77c7d677bd304628d57c58542fa71` versus `c530644`, four serialized AB/BA pairs with sibling production-artifact placement:

| Metric, baseline → candidate | macOS ARM64 | Windows x64 |
| --- | ---: | ---: |
| Cold / warm startup, ms | 1217.83 → 1083.96 / 709.63 → 606.68 | 1677.57 → 1568.97 / 1536.48 → 1558.34 |
| First file, ms | 687.44 → 597.98 | 408.80 → 406.23 |
| One-file primary memory, MiB | Footprint 165.42 → 166.23; RSS 446.02 → 446.51 | Private 177.16 → 178.95; working set 348.55 → 346.90 |
| Idle CPU | 1.44% → 1.42% | 0.12% → 0.00% observed |

Backup UI median open time after Settings was 444.72 ms on Mac / 832.51 ms on Windows. Ten open/close cycles stopped backend calls/storage activity when closed, preserved the Monaco model and cleaned owned process families. Ordinary editing had `backupLoaded: false` and zero backup calls; the lazy chunk remains resident after first use without continuing work. The original macOS regression came from asymmetric benchmark artifact roots, independently isolated before the harness was corrected; no production safety check was removed.

**Editor/LSP:** the matched local editor foundation changed first-file latency 179.08 → 179.83 ms, one-file RSS 518.42 → 518.91 MiB and idle CPU remained 0.31%. Final hosted unused-LSP Mac medians were cold 911.19 → 958.76 ms (+5.22%), warm 746.19 → 671.17 ms, first file 491.45 → 356.36 ms, one-file RSS 461.88 → 461.95 MiB, ten tabs 477.00 → 477.58 MiB and idle CPU 2.47% → 2.20%. No language server started in ordinary editing. Detailed reports retain individual samples and their distinct baseline identities.

Active services are separate from Ion: final clangd RSS was 46.88 MiB Mac / 87.84 MiB Windows; Pyright 384.84 / 388.78 MiB; TypeScript service tree 519.25 / 434.60 MiB. Pyright spawn/init/sync/cold-definition/warm-completion timings were 3.43/536.68/2.41/900.12/21.12 ms on Mac and 5.97/222.66/2.19/655.98/25.10 ms on Windows. Owned service processes returned to zero. Tools: Node 24.22.2, Pyright 1.1.407, TypeScript Language Server 4.4.0, TypeScript 5.9.3; clangd 17.0.0 Mac / 20.1.8 Windows; Java 21.0.13 Mac / 17.0.21 Windows. These are fixture costs, not universal server budgets.

**Final build/tasks:** baseline `99acaaa4bac7239d3f2b8dff672b51ea777cb4d3` versus production `036781e7`, four ABBA pairs per host, fresh profiles and the same 80-line C file in Minimal mode:

| Median, baseline → candidate | macOS ARM64 | Windows x64 |
| --- | ---: | ---: |
| Cold / warm startup, ms | 1077.50 → 875.62 / 535.12 → 482.49 | 1657.69 → 1721.26 / 1635.98 → 1487.06 |
| First file, ms | 774.56 → 509.66 | 420.90 → 396.75 |
| Typing-to-second-frame proxy, ms | 30.70 → 30.80 | 27.90 → 28.10 |
| One-file memory, MiB | RSS 454.70 → 455.17; footprint 168.49 → 171.52 | Working set 349.99 → 353.24; private 178.64 → 183.08 |
| Idle CPU | 1.930% → 1.422% | 0.058% → 0.239% |
| Ordinary-editing processes | 4 → 4; zero task children | 4 → 4; zero task children |

The real task-service bundling defect was corrected: main bundle 303,441 → 291,846 bytes, with a separate 19,092-byte service chunk. All 16 paired build attempts were retained and passed; task UI stayed unloaded, and all owned processes cleaned up. The measured +3.03 MiB Mac footprint, +4.44 MiB Windows private memory and +0.181 percentage-point Windows idle CPU are costs, not claimed savings. Hosted Mac had an Apple M1 virtual CPU/7 GiB; Windows Server 2025 x64 had AMD EPYC/~16 GiB. These are not physical 8 GB consumer-device measurements. Four pairs support median/range conclusions, not reliable tail quantiles; typing is a render proxy, not end-to-end human input latency.

## Preserved failures and remaining limitations

- Backup runs [45203328964](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45203328964), [45203815424](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45203815424) and [45204705215](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45204705215) retain artifact-lookup and stale-review harness failures. Updated checks require rejection and renewed review after changed saved data; they do not bypass it.
- The LSP report retains diagnostic-generation/URI/toolchain failures and final intermediate runs, including [45852597271](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45852597271) exposing eager clangd startup. The final lifecycle/security results include hostile protocol messages, unauthorized paths, stale results, multi-root isolation and cleanup; failed runs were not relabeled as passes.
- DAP runs [45873546987](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45873546987) and [45874935926](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45874935926) exposed approval hashing and lazy breakpoint synchronization defects, corrected before acceptance. Windows adapter selection was pinned separately; DAP active memory/endurance is not a completed measurement.
- Tasks run [45922846266](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45922846266) preserved the +23.57% Mac warm-start failure that led to the lazy-bundling correction. [45922138259](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45922138259) and [45923549384](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45923549384) preserve harness event/tool assumptions. Reports retain slow samples, including initial multi-second starts.
- Hosted tests do not establish four-hour endurance, physical power-loss behavior, maximum 2 GiB/10,000-entry archive coverage, every external filesystem, or consumer Windows 10/11/8 GB behavior. The tested Mac package is ad-hoc signed; Developer ID and notarization are not claimed. Earlier package migration/rollback acceptance is historical Phase 1 evidence, not a newly published or requalified Phase 2.5 installer.
- No new feature work follows this handoff. Broader tasks, Test Explorer, additional debuggers and remaining Phase 2 requirements need separate scope and acceptance. Existing historical incident evidence remains available; bounded acceptance does not prove every possible race or environment safe.

## Report index

| Read this for | Detailed source of truth |
| --- | --- |
| Current phase state and deferred work | [Implementation tracker](ION_IMPLEMENTATION_TRACKER.md), [master audit](ION_MASTER_AUDIT.md), [feature matrix](ION_FEATURE_MATRIX.md) |
| Architecture/security/performance rules | [Architecture plan](ION_ARCHITECTURE_PLAN.md), [security model](ION_SECURITY_MODEL.md), [performance budget](ION_PERFORMANCE_BUDGET.md) |
| Backup design, native evidence and preserved history | [Backup design](../../ION_BACKUP_RESTORE_DESIGN.md), [backup verification](../../ION_BACKUP_RESTORE_VERIFICATION.md), [reliability checkpoint](../../ION_RELIABILITY_CHECKPOINT.md) |
| Editor, multi-root and interaction acceptance | [Editor excellence](ION_PHASE_2_EDITOR_EXCELLENCE.md) |
| Language capabilities, server costs, safety and all intermediate runs | [Language services](ION_PHASE_2_LANGUAGE_SERVICES.md) |
| C/C++ debugging and its scope limits | [Debugger report](ION_PHASE_2_DEBUGGER.md) |
| Final production full suites, individual performance samples and task debt | [Build/tasks report](ION_PHASE_2_BUILD_TASKS.md) |

**Handoff verdict: accepted source through the defined Phase 2.5 foundation is ready for the authorized source-only delivery. Phase 2 remains incomplete; Phase 2.6 is paused. This is not a release-publication or installed-application readiness declaration.**
