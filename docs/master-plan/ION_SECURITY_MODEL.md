# Ion security model

## Assets

- User source code, unsaved drafts, notes, learning/practice data, project plans, test evidence, custom themes, and settings.
- Filesystem grants and workspace associations.
- Provider/GitHub credentials and authentication state.
- Execution, repository, notebook-kernel, and test approvals.
- Update artifacts and application identity.
- Availability: the editor must recover from crashes, malformed data, and optional-tool failures.

## Trust zones

| Zone | Trust | Rules |
| --- | --- | --- |
| Sandboxed renderer | Untrusted for privileged work | No Node access. Receives bounded data and opaque handles. Cannot choose arbitrary main-process paths or executables. |
| Preload bridge | Narrow mediator | Versioned typed requests, origin/window validation, no generic filesystem/shell primitive. |
| Main process | Privileged authority | Validates grants, paths, revisions, schemas, limits, and operation ownership. Owns all external processes and durable publication. |
| Native helpers/workers | Privileged but constrained | Structured IPC/arguments, bounded lifetime/output, private temp space, explicit ownership and cleanup. |
| Workspace/repository | Untrusted data and executable-content source | Configuration, symlinks/reparse points, hooks, build scripts, binaries, notebooks, and documents cannot gain authority by location alone. |
| Network/provider/GitHub | Untrusted remote | Explicit opt-in, TLS, minimum data, schema/size validation, cancellation, no hidden requests. |
| Backup/update/package | Untrusted input until verified | Validate structure, size, hashes, schemas, paths, identity/signature policy, and rollback before application. |

## Core invariants

1. **History is not permission.** Restored test results remain stale evidence. Backup restore never activates execution trust, repository trust, credentials, automatic tests, or runnable commands.
2. **Location is not trust.** A workspace-controlled executable cannot win tool discovery before explicit authorization. Executable discovery and execution are separate operations.
3. **Renderer intent is not authority.** Main resolves and validates actual paths, grants, revisions, roots, and operation tokens.
4. **No shell interpolation.** External tools receive executable plus structured arguments and a controlled environment.
5. **Revision before publication.** Saves, formatting, AI edits, test evidence, and restore application reject stale source/data revisions.
6. **Private staging before commit.** Documents, backups, updates, and generated binaries use private bounded staging with cleanup and safe publication.
7. **Explicit process ownership.** Every compiler, program, terminal, kernel, language server, debugger, converter, Git command, and AI runtime belongs to a window/session and has cancellation/teardown.
8. **Offline means quiet.** Ordinary editing initiates no network request. Update, provider, GitHub, and remote-Git operations are explicit or clearly enabled.
9. **Failure preserves data.** Conflicts retain both versions; interrupted restore resumes or rolls back; repair failure preserves evidence and recovery instructions.

## Accepted controls and current watchlist — through Milestone 2.5

The following is an evidence summary for accepted application checkpoints, not a fresh security scan or a signed-release claim. Earlier failures, platform skips and coverage limits remain in the linked reports.

| Area | Accepted evidence and security boundary | Remaining scope / limitation |
| --- | --- | --- |
| Backup, recovery and user data | Phase 1 application `c5306449445e16090c81d8396003b9885b710fd0` passed real restore/relaunch, normal-store access, detached drafts, changed-preview rejection, interruption recovery, populated rollback and trust/credential exclusion on both hosted platforms. See the [tracker's exact native acceptance](ION_IMPLEMENTATION_TRACKER.md#exact-native-acceptance) and completed release gates. | Archives remain unencrypted. Maximum-capacity archives, external filesystems, physical power loss and four-hour endurance are not established by those fixtures. |
| Multi-root editing and reviewed writes | Accepted editor/workspace foundation preserves explicit grants, shared Monaco models/undo, dirty buffers and restored layouts. Reviewed replacements revalidate revisions and hashes through safe publication; restored paths grant no trust. | Continue testing native locks, junctions, casing and interrupted writes as each subsystem changes. |
| Language services | Application `6bcc06c059a13461b145e5e4ccec55d22bb3bced` passed [native run 45859946256](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45859946256): root isolation, stale/cancelled request rejection, bounded hostile-protocol handling, unauthorized-path protection and zero owned services after shutdown. Server-provided edits require main-owned review tokens and root/revision/hash/link checks. | The supported semantic adapters are the bounded scope in the [LSP report](ION_PHASE_2_LANGUAGE_SERVICES.md); installed language-server processes are not an OS security sandbox. |
| C/C++ debugging | Application `bcd2d5560510492b7dae8c69c97a925b2c7db787` passed native and packaged journeys on both platforms with trusted compiler/adapter discovery, bounded DAP, saved-source hash binding, explicit launch and owned adapter/debuggee cleanup. The same-size rewrite defect and its correction are retained in the [debugger report](ION_PHASE_2_DEBUGGER.md). | Python/Java debugging, attach/remote debugging and long-session measurements are not accepted by this checkpoint. |
| Build/task foundation | Application `036781e7fe99be4480e5f0803fb6b22124be72a8` passed [final native run 45924540081](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45924540081) on macOS ARM64 and Windows x64: static discovery, approved real npm execution, Stop and owned cleanup. Full unit/security results were 461 passed / 26 skipped on macOS and 460 passed / 17 skipped on Windows, with zero failures. | Saved workspace task definitions, problem matchers and native execution of the other adapter plans remain open. The [task report](ION_PHASE_2_BUILD_TASKS.md) preserves skips, intermediate failures and exact evidence identities. |

Task discovery performs bounded static inspection and does not execute manifests, wrappers, scripts or workspace binaries. Main resolves trusted installed tools outside every workspace root, constructs structured executable/argument/cwd plans, and requires exact execution review for every run. Renderer requests cannot supply arbitrary executable paths, environment variables or arguments. Stored task records contain declarative selectors and source revisions, not shell commands or approvals. Current source/task/workspace identity is rechecked before execution; root removal, replacement, Stop and shutdown cancel and drain the owned operation.

**Explicit approval is essential:** npm, Make and other build tools can execute project-controlled build logic with the user's account permissions. Ion's offline-first behavior means it does not install task dependencies or start discovery/processes/network work during ordinary editing; it does not promise that an approved build script cannot access files or the network. Task history and restored evidence never grant permission. Tests use disposable profiles and roots; this acceptance did not authorize modifying user projects or the installed app.

The eager task-backend bundling defect was corrected without changing execution approvals, dependencies, timeouts or file integrity. Process cleanup is verified for the recorded bounded journeys, not all possible third-party scripts. Milestone 2.6 is paused on its separate development branch and its code is excluded from this accepted checkpoint. Signing, notarization, supply-chain provenance, long-session coverage and the unresolved historical GCC/notebook/Learning Lens evidence remain distinct watchlist items; successful recent tests do not erase them.

## Threats and controls

This table preserves the original threat inventory. Its forward-looking entries are refined by the accepted-control summary above; they are not a claim that later LSP, DAP or task acceptance has not occurred.

| Threat | Existing control | Remaining work |
| --- | --- | --- |
| Path traversal, links, reparse points, device/ADS paths | Validated workspace roots; native safe operations; archive rejection rules | Keep native Windows/macOS regression fixtures tied to exact candidates. |
| Stale/late write overwrites | File revisions, edit versions, serialized writes, safe publication | Endurance and upgrade tests with real profile copies. |
| Malicious theme/lesson/backup/document | Data-only schemas, size limits, sanitization, staged parsing, network denial | Fuzz/corpus expansion; encrypted backups remain missing. |
| Workspace executable shadowing | Tool resolution outside workspace and approval boundaries in reviewed paths | Centralize this invariant in the future language/build/debug capability host. |
| Child-process escape/orphan | Process groups/jobs, output/time caps, window/session cleanup | Exact-candidate repeated lifecycle tests and owned-process inventory. |
| Git configuration/index races | Scoped structured Git commands, validated configuration view, private index and lock | Preserve malicious-config and remote-operation tests as Git expands. |
| Notebook active content | Explicit kernel approval and local environment | Complete cross-platform kernel shutdown and trust-reset acceptance. |
| Markdown/preview script or remote load | Sanitization, blocked unsafe schemes, restricted local protocols, network-denied sessions | Continue parser updates and malformed-input tests. |
| AI prompt/content exfiltration | Explicit provider action, preview/review, OS-backed key storage | Add per-request context manifests, redaction controls, streaming limits, and real authenticated acceptance. |
| Update substitution/downgrade | Release comparison and checksums | Signed/notarized macOS artifacts, signed Windows artifacts, channel authenticity, upgrade/rollback tests. |
| Backup disclosure | Explicit local archive and documented exclusions | Current archives are unencrypted; add optional encryption only as a separately reviewed format version. |
| Supply-chain vulnerability | Lockfile, pinned sensitive dependencies, audit | Add isolated clean-install integrity/SBOM and release provenance; current nested-checkout `npm ls` is noisy. |

## Backup/restore security gate

V1 `.ionbackup` uses ZIP with a versioned manifest, store schemas, SHA-256 entry hashes, and strict 2 GiB/10,000-entry/128 MiB-entry/8 MiB-manifest limits. It rejects traversal, absolute/device/UNC/ADS/reserved names, duplicates and case/Unicode collisions, links, special files, malformed headers, unsupported schemas, and decompression-limit violations.

Restore validates into a private unique stage before preview. It imports drafts as detached copies, requires explicit category replacement, restores copied workspaces only into a new destination, and never turns imported paths into filesystem grants. Application occurs through a controlled restart and durable journal with a verified pre-restore rollback archive.

Native restore/relaunch, normal-store access, trust exclusion, interruption recovery, rollback and cleanup are mandatory gates. They passed for the Phase 1 candidate recorded above; they must be revalidated when relevant production behavior changes. Acceptance is separate from public packaging/signing authorization, and the documented capacity, filesystem and power-loss limitations remain.

## AI and Copilot requirements

- No default code generation or completion in learning workflows.
- Provider keys never enter renderer persistence or backups.
- Context is explicit, reviewable, bounded, and cancellable.
- Edit mode proposes a diff and rechecks source revisions; Agent mode requires granular tool permission.
- Official authentication and service APIs only. The current official Copilot SDK is eligible for a future measured agent/chat proof of concept; it does not authorize private inline-completion endpoints. No premium-account scraping, browser-cookie reuse, private endpoint emulation, or claims without authenticated tests. [Official SDK](https://github.com/github/copilot-sdk)
- Closing the AI surface ends unnecessary streams/runtimes and releases context buffers.

## Distribution requirements

Checksums are integrity evidence, not publisher identity. A public macOS release needs verified Developer ID signing and notarization; Windows needs an authenticated signing/distribution policy. The updater must verify channel, version, artifact identity/integrity, compatibility, and rollback behavior. It must replace the intended installed app through the platform installer rather than create ambiguous duplicate copies.

## Verification policy

Security tests preserve exploit fixtures in disposable roots, never personal files. Skipped platform checks remain unverified. `npm audit` returning zero advisories is recorded but never substitutes for path, IPC, process, archive, update, and data-integrity testing.
