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

## Threats and controls

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

The implementation is not release-complete until native restore/relaunch, normal-store access, trust exclusion, interruption recovery, rollback, and cleanup pass for the exact candidate on macOS and Windows.

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
