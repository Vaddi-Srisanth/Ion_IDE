# Ion architecture plan

## Accepted checkpoint and scope

This report describes accepted development checkpoint `23dff68d29b07fd519d5b7b83857857bfe6ef20c`, whose latest production correction is `036781e7fe99be4480e5f0803fb6b22124be72a8`. Phase 0, Phase 1, the editor/workspace foundation, LSP, Editor Essentials, C/C++ DAP and the Phase 2.5 task-adapter foundation have passed their documented acceptance scopes. **Phase 2 overall remains incomplete.** Broader task functionality remains open; Phase 2.6 Test Explorer is **paused and incomplete on a separate development branch**, and is excluded from this accepted source.

Acceptance is scoped to the builds and platforms in the [implementation tracker](ION_IMPLEMENTATION_TRACKER.md), [editor/workspace report](ION_PHASE_2_EDITOR_EXCELLENCE.md), [language-services report](ION_PHASE_2_LANGUAGE_SERVICES.md), [debugger report](ION_PHASE_2_DEBUGGER.md) and [build/tasks report](ION_PHASE_2_BUILD_TASKS.md). Their earlier pending/failed sections preserve investigation history; final acceptance sections establish the later verdicts. This architecture update adds no new runtime or benchmark evidence and does not assert that a published installer contains this development checkpoint.

## Decision

Keep Electron, React, TypeScript, Vite, and Monaco. The current architecture already pays Electron's fixed process cost but gains mature editing, accessibility, rendering, native packaging, and cross-platform behavior. A framework migration has no measured proof of lowering total process-tree memory enough to justify rewriting file safety, terminal, notebook, viewer, updater, and accessibility boundaries.

The architecture goal is a small always-on kernel plus capability-owned, cancellable services. Optional features must have observable start/stop ownership and no entitlement to stay alive merely because their code was imported once.

## Current core and capability boundaries

```text
Renderer shell
  ├─ shared documents/models + up to four lazy editor groups
  ├─ command/settings registry
  └─ lazy feature panels
          │ typed capability requests
Sandboxed preload
  ├─ files/recovery/settings
  ├─ processes/terminal/tools
  ├─ Git/language/debug/tasks + existing Project Tests
  └─ viewers/notebooks/backup/update
          │ validated IPC
Main capability host
  ├─ workspace authority + safe filesystem publication
  ├─ profile stores + migrations + transaction journal
  ├─ owned process/session registry
  ├─ optional service factories
  └─ native helpers/workers
```

## Preserve

- Existing application identity and profile formats.
- `WorkspaceFiles`, safe file mutations, revision checks, recovery drafts, session restoration, and the single-instance lock.
- Bounded Monaco model retention, shared dirty state and undo history across editor groups, and independent cursor/scroll state per view.
- Explicit execution approval and workspace grants.
- Current terminal/Run Console separation: interactive PTY and deterministic test transports solve different problems.
- Data-only learning packs/themes and the offline-first default.
- Lazy viewer, notebook, semantic-tool, formatter, terminal, Git, existing optional provider, backup, debugger and task loading. This preserves existing optional provider functionality; it does not imply completion of future AI phases.

## Phase 1: accepted data-safety boundary

Backup UI and archive implementation load on request. Main owns archive paths, expiring review tokens and private staging; store schemas and bounded readers validate data before replacement. Controlled restart applies a durable restore journal before normal stores initialize. Recovery resumes or rolls back an interrupted transaction; it does not promise atomicity across every file or volume. Restored drafts are detached and historical outcomes do not import execution permission.

Hosted macOS/Windows acceptance at `c5306449445e16090c81d8396003b9885b710fd0` covered populated/fresh restore, actual relaunch, normal-store access, credential/trust/approval exclusion, interruption, rollback and resource cleanup. Later Phase 1 package/migration gates passed as recorded in the tracker. Maximum archive limits, physical power loss, external filesystems, four-hour endurance and consumer 8 GB hardware remain coverage limits. A universal migration registry or consolidated lifecycle registry remains a future architecture proposal; existing per-service owners and their tested drains are the implemented boundary.

## Phase 2: implemented services without permanent daemons

### Workspace model

Version-one `.ion-workspace` descriptors hold at most eight canonical, non-overlapping roots and a strictly validated subset of editor settings. `WorkspaceFiles` grants each reviewed root independently. Adding/restoring a root imports no execution, terminal, repository or test trust; removing one revokes authority and invalidates dependent operations. This is a bounded settings schema, not a general per-root tool-preference system.

The editor-group layout supports up to four same- or different-file views, shared models/undo, independent view state, group-aware navigation and validated session restoration. Quick Open and search enumerate on demand. Reviewed workspace replace uses main-owned expiring snapshots, saved-file revisions/hashes and existing atomic per-file publication; partial conflicts are reported. No permanent project index is created for these workflows.

### Language capability host

`src/main/language-tools/manager.ts` owns root/adapter-isolated sessions. `lsp-process.ts` implements bounded JSON-RPC and `lsp-adapter.ts` handles synchronization/semantic requests; Java's existing JDK worker participates through the shared adapter interface. Implemented boundaries include:

- language/tool metadata separate from executable discovery;
- explicit per-workspace enablement;
- trusted installed executable paths outside every workspace root, without workspace-controlled PATH precedence;
- lazy service instances keyed by adapter and authorized root when an enabled semantic request needs them;
- bounded request queues, cancellation, revision IDs, output limits, and crash backoff;
- idle grace period followed by shutdown;
- service memory/process measurements reported separately from Ion in acceptance evidence;
- feature degradation to Monaco syntax/basic editing when unavailable.

Native acceptance covers clangd, Java's JDK adapter, Pyright and TypeScript Language Server, including diagnostics, completion, navigation, stale-result/cancellation handling, multi-root isolation and cleanup. `workspace-edit-review.ts` owns reviewed rename/general text edits, root authorization, revision/hash checks and safe publication; a server request is not filesystem authority. Supported capabilities differ by adapter. This is not universal LSP compatibility, an always-on background index, or a complete Java language server. No language server is bundled or downloaded automatically.

### Debug host

`src/main/debug/` implements one lazy, bounded C/C++ path through installed clang and `lldb-dap`. Opening the panel starts no compiler or adapter. Explicit Start Debugging reviews the canonical saved-source revision/hash and trusted executable plan; main owns adapter, debuggee and scratch files. The renderer displays breakpoints, call stack, scopes, variables, watches and the debug console, with step/continue/pause/restart/stop actions. One session per window is supported and Stop/close drains its process tree. Python/Java debugging, attach, remote debugging and advanced breakpoint types remain unimplemented. Active-adapter RAM and long-session growth are not established by the cleanup tests.

### Build/task host and paused Test Explorer

`src/main/tasks/` provides static, bounded top-level manifest discovery, profile-owned declarative records, revision validation and bounded sequential dependency graphs. Main constructs structured plans from trusted external tools; records cannot store arbitrary executables, environments, shell commands or approvals. Each execution receives native review and reuses the existing interactive runner/Run Console. Stop, root removal and shutdown cancel owned work. Production execution is natively verified for npm; other built-in adapters require representative native journeys. Workspace-authored task definitions, safe problem matching, parallel/watch tasks and broader task scope remain open.

The task backend and picker are separate on-demand build chunks. Acceptance found and corrected an eager-backend bundling defect in `scripts/build.mjs`; a source-level dynamic import alone was insufficient. Ordinary editing keeps the picker unloaded and starts no task child process or polling service.

Existing Project Tests retain their established approvals, saved C console tests and historical evidence. General Test Explorer is not in this accepted checkpoint. Its separate, paused work must establish approved framework discovery/execution, cancellation, bounded results/history and backup-safe persistence before acceptance. No automatic migration of existing tests is claimed.

## Planned Phase 3: Git and GitHub

Keep Git CLI invocation in main with structured arguments and a validated repository root. Add remote operations as explicit state machines with cancellation and conflict states. Never parse shell strings or inherit workspace-controlled Git config across a security boundary without validation.

GitHub is a separate provider: official device/OAuth flow, OS-backed token storage, minimum scopes, explicit sign-out/revoke, rate/error handling, and no requirement for offline editing. Pull-request views consume remote data but never execute repository content.

## Planned AI and Copilot boundary

AI is optional infrastructure, not a renderer-wide singleton. Provider sessions receive a reviewed context manifest, limits, cancellation, and a permission ledger. Editing uses proposed diffs and source-revision checks. Agent actions require explicit tool permissions and cannot silently run commands, modify files, read credentials, or broaden workspace access.

GitHub now documents an official Copilot SDK for custom applications and agentic workflows. Phase 6 should start with a disposable proof of concept that measures its native runtime, authentication, subscription/licensing, permission handler, streaming, offline failure, and shutdown behavior. It must not be added to ordinary startup. The SDK does not by itself establish a supported third-party inline-completion API; that capability remains unsupported until GitHub documents one. Private endpoints and browser-session scraping are prohibited. [Official SDK](https://github.com/github/copilot-sdk) · [Where GitHub supports Copilot](https://docs.github.com/en/copilot/get-started/where-to-use-github-copilot)

## Planned extension boundary

Do not load third-party extension code in the privileged renderer or main process. A future extension host needs a separate constrained process, signed/declared manifests, granular capabilities, resource limits, crash isolation, versioned APIs, and disable/uninstall recovery. Data packages (themes and lessons) remain a safer, separate category.

## Proposed IPC evolution

The flat preload surface is typed but large. Evolve it without breaking existing consumers:

1. Group methods into versioned capabilities.
2. Issue opaque, expiring operation/session tokens from main.
3. Bind tokens to window, workspace root, resource type, and operation.
4. Validate result sizes and revisions at both edges.
5. Add capability-level lifecycle and denied-request metrics available only in diagnostics.
6. Remove deprecated methods only after compatibility fixtures prove no remaining caller.

## Dependency policy

- One dependency must have one named owner and one measured reason to exist.
- Prefer protocols and installed tools over bundling compilers, office suites, language servers, or AI runtimes.
- Pin native and archive/security-sensitive dependencies.
- Run audit plus a clean-install integrity check in an isolated checkout so parent `node_modules` cannot contaminate evidence.
- Dynamic import is not sufficient: services also need deterministic teardown and bounded retained state.

## Non-goals through Phase 2

- Framework migration.
- VS Code extension compatibility.
- Remote SSH/containers.
- Bundled compilers or language-server fleet.
- Always-on project indexing.
- Default AI completion.
- Feature work that bypasses the Phase 1 release gate.
