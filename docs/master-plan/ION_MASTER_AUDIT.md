# Ion master audit

This is the preserved Phase 0 audit snapshot. Its findings/verdict are dated to the revision below, not a replacement for later acceptance evidence. See the [current Phase 2.5 checkpoint](ION_ENGINEERING_HANDOFF_THROUGH_2_5.md) and [implementation tracker](ION_IMPLEMENTATION_TRACKER.md) for resolved findings, current limits and the paused Phase 2.6 boundary.

Audit date: 23 November 2026
Audited revision: `c5306449445e16090c81d8396003b9885b710fd0`
Audit branch: `codex/ion-master-plan-phase-0`
Release verdict: **BLOCKED for a new release; current product remains usable at its previously verified scope.**

## Executive finding

Ion is a real offline-first Electron IDE, not a mock-up. Its strongest systems are local editing and recovery, controlled execution, the integrated terminal, optional document/notebook viewers, local learning/practice data, declarative themes, and narrow main-process ownership of privileged work. It already uses extensive demand loading and bounded caches.

Ion is not yet a general replacement for VS Code. The largest missing professional capabilities are universal project-aware language services, debugging, multi-root workspaces, broad build/test discovery, remote Git/GitHub workflows, and a supported extension platform. Core Excellence backup/restore has now completed native restore/relaunch, interruption, rollback, exclusion and cleanup acceptance on hosted macOS and Windows. The largest immediate blocker is narrower: the same matched run found a material macOS candidate regression in cold startup and first-file opening, and the focused workflow was not a packaged installer/update migration gate. Shipping more features before resolving those release gates would increase risk without improving trust.

## Scope and evidence

The audit inspected the repository layout, Git state, package/build configuration, Electron main/preload/renderer boundaries, Monaco ownership, native helpers, update and packaging paths, tests, performance reports, backup/restore design and verification, installed application metadata, and the feature requirements in the master directive.

Evidence is revision-qualified. Historical results are not silently applied to the current candidate. The installed `/Applications/Ion IDE.app` was inspected only by metadata and remains untouched. It reports version `0.9.8`, bundle identifier `dev.ionide.desktop`, and approximately 267 MiB on disk. The public GitHub release observed during this audit remains `0.9.6`. Matching version strings do not prove matching source.

The comparison installation is Visual Studio Code `1.147.0` arm64 (`com.microsoft.VSCode`), approximately 1.6 GiB on disk. It was not launched during this safe audit, so no current matched VS Code RAM/CPU/startup result is claimed.

## Repository and architecture inventory

- 658 tracked files: 260 under `src`, 167 scripts, 70 tests, 67 documentation files, 41 diagnostic assets, and 9 GitHub workflow/configuration files.
- The source tree is approximately 2.23 MB and 46,982 lines. Test and script code is approximately 37,666 lines.
- Electron `45.2.3`, React `19.3.1`, TypeScript `6.0.3`, Vite `8.3.6`, Monaco `0.57.0`, and xterm `6.x` form the desktop/editor base.
- The renderer owns UI, tab/buffer state, and one active Monaco editor. It retains at most three recent source models and keeps evicted unsaved text in the document store.
- Preload exposes a typed, context-isolated bridge. The current surface is broad at roughly 141 invoke methods; it is typed and validated, but should be split by capability during future architecture work rather than expanded as one flat API.
- Main owns filesystem grants, atomic publication, persistence, child processes, terminal sessions, Git, viewers, notebooks, updater work, and backup/restore.
- Optional features are split into dynamic chunks. Terminal, learning, practice, project tools, document viewers, notebooks, formatting, semantic tooling, web preview, profile export, updater, run trust, and backup/restore do not need to initialize for ordinary Welcome/editing.
- The largest renderer artifacts are Monaco/editor code (about 2.72 MB for `editor.api`, 611 KB for the Monaco surface, and 304 KB for the editor worker), PDF worker (about 1.27 MB), paged viewer (459 KB), initial renderer entry (368 KB), and xterm (333 KB). The largest main artifacts are the main entry (225 KB), lazy backup service (142 KB), document worker (105 KB), Run Console (71 KB), and backup transaction code (52 KB).

## Existing strengths

1. **Data ownership and file safety.** Revision checks, safe publication, external-edit conflicts, recovery drafts, bounded session metadata, and per-profile single-instance ownership are real systems with regression coverage.
2. **Resource-aware editor ownership.** Ion uses one visible Monaco editor, bounded model retention, lazy Monaco startup, paged large-file reading, and explicit document-viewer disposal.
3. **Offline core.** Editing, local execution, terminal, viewers, learning packs, practice, themes, and project metadata work without a cloud account.
4. **Security boundaries.** Renderer sandboxing/context isolation, restrictive local protocols/CSP, structured child-process arguments, workspace grants, execution approval, bounded output/time, and disabled network access in preview/conversion contexts are meaningful defenses.
5. **Honest optionality.** Language tools, notebook kernels, terminal shells, document workers, Git commands, and AI-provider requests start only after an explicit feature request.
6. **Evidence culture.** The repository preserves failures, skipped tests, platform limits, process-tree measurements, and revision-qualified CI evidence rather than treating compilation as acceptance.

## Highest-risk gaps

| Priority | Gap | Evidence | Required next action |
| --- | --- | --- | --- |
| P0 | Hosted macOS startup/file-opening regression | Exact run `45205283873` passed safety/lifecycle acceptance but measured +35.85% cold startup and +106.49% median first-file latency against `d67613a`; Windows was approximately flat. | Add stage timings, reproduce with a focused matched protocol, and change production only after the responsible stage is demonstrated. |
| P0 | Packaged exact-candidate release gate is incomplete | The successful Core workflow used ordinary production builds and disposable profiles, not installer upgrade/update/rollback paths. | Tie release artifacts, source SHA, installer migration, update rollback, native tests, and performance samples to one immutable candidate. |
| P1 | Professional language intelligence is narrow | C/C++ is limited to a scoped clangd translation unit; Java uses a bounded compiler worker; most registered languages have syntax only. | Build a capability lifecycle for opt-in per-workspace LSPs before adding servers. |
| P1 | No integrated debugger | No DAP adapter, session ownership, breakpoints, stack/variable UI, or cleanup acceptance. | Implement one reliable C/C++ DAP path first, gated by installed tools and resource tests. |
| P1 | Git is local-only | Status/diff/stage/unstage/commit exist; fetch/pull/push/merge/rebase/conflict/PR workflows do not. | Add remote operations behind explicit user action, credential boundaries, and conflict-safe UI. |
| P1 | Workspace model is single-root and lightly indexed | Quick Open/search are on-demand and safe, but multi-root, symbol graph, breadcrumbs, rename, and large-repo navigation are incomplete. | Extend the existing granted-root model; do not create an always-on global index. |
| P1 | Dependency inventory command is not reproducible in this nested checkout | `npm audit --omit=dev` reports zero advisories, while `npm ls --omit=dev` traverses/pollutes output with the parent workspace's `node_modules`. | Add a clean-checkout/CI dependency-integrity check and document the expected package-manager layout. |
| P2 | AI and Copilot goals are mostly product requirements, not verified integrations | Current optional planning/provider flows use reviewed context and simulated automated responses; no authenticated official Copilot acceptance exists. | Verify official APIs, licensing, authentication, and resource behavior before committing architecture. |
| P2 | Education breadth exceeds validated depth | 19 pack collections and 162 lessons exist, but they are not complete language curricula; Practice has 27 bundled challenges, not a competitive-programming platform. | Curate quality and evidence before scaling catalog size. |

## Performance baseline and limitations

The most recent broad native baseline predates the Core backup source and therefore is a comparison reference, not proof for this branch.

| Workload | macOS hosted footprint / summed RSS | Windows hosted working set / private | Notes |
| --- | ---: | ---: | --- |
| Welcome | 125.20 / 372.59 MiB | 301.02 / not recorded | Different platform counters; do not compare them directly. |
| One C file | 189.45 / 461.77 MiB | 361.45 / 186.27 MiB | One ordinary source file. |
| Ten tabs | 198.64 MiB footprint | 380.14 MiB working set | Source tabs only. |
| Medium workspace | 213.71 MiB footprint | 391.38 MiB working set | Hosted runner workload. |
| Git opened then closed | 268.90 MiB footprint | 445.97 MiB working set | Retained native/allocator memory is not automatically a leak. |

macOS interaction medians: first file 413.64 ms, typing proxy 24.60 ms, scroll proxy 40.24 ms, and tab switch 75.32 ms. Balanced startup measured 892.50 ms fresh and 945.29 ms warm, with the warm result approximately 54 ms slower than its compared baseline and still unexplained. These miss the provisional first-file and tab-switch targets. Windows hosted interaction medians were 384.49 ms first file, 19.10 ms typing proxy, 35.06 ms scroll proxy, and 62.68 ms tab switching.

Current-branch backup UI closed/open measurements now exist at `c530644`; ordinary one-file memory stayed within approximately 1% of the exact baseline and no backup code or calls were active before use. After first use the lazy chunk remained resident, backend counters stopped while closed, and cleanup passed. The same run found the macOS latency regression described above. Four-hour endurance, energy, 50 tabs, a large repository, debugger, AI, and physical 8 GB hardware remain unverified.

## Security findings

- `npm audit --omit=dev` reported zero known advisories for the resolved production graph on 23 November 2026. This is not a complete code security review.
- The updater's authenticity ultimately depends on the GitHub release account, checksums, signing identity, and distribution channel. Public macOS trust still requires real Developer ID signing/notarization; ad-hoc signing is not equivalent.
- Approved programs, build tools, notebook kernels, and terminal commands run with the user's OS permissions. Time/output limits reduce operational damage but are not a sandbox.
- Imported documents, Markdown, themes, backups, provider responses, repository configuration, and remote metadata must continue to be treated as untrusted data.
- Current `.ionbackup` archives are unencrypted. Hashes detect corruption; they do not prove publisher authenticity or protect sensitive source text at rest.
- Recovery drafts intentionally contain unsaved source code. Execution trust, credentials, active test approvals, and repository trust are excluded from restore.

## Duplication, dead paths, and lifecycle observations

No second editor engine, second UI framework, always-running shell, permanent Git daemon, or permanent language server was found. Existing line-based and PTY execution paths serve different correctness requirements and should not be merged without a measured design. Historical documents contain obsolete feature-state statements; the master feature matrix must be the current index and link to revision-qualified evidence.

Static inspection found no application `setInterval` calls and 38 `setTimeout` plus 28 `addEventListener` call sites. Counts do not establish cleanup correctness. Ownership must be verified through lifecycle tests, especially window teardown, terminal/notebook closure, semantic-tool shutdown, document close, and restore restart.

## Phase decision

Phase 0 documentation and baseline consolidation is complete on this branch. Core backup/restore native acceptance passed, but Phase 1 remains conditional on the macOS latency investigation and packaged exact-candidate release gates. No Phase 2 feature work should start. The installed application, public release, update feed, user profile, and projects remained outside this branch's mutation scope.
