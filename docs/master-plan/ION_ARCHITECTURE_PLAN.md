# Ion architecture plan

## Decision

Keep Electron, React, TypeScript, Vite, and Monaco. The current architecture already pays Electron's fixed process cost but gains mature editing, accessibility, rendering, native packaging, and cross-platform behavior. A framework migration has no measured proof of lowering total process-tree memory enough to justify rewriting file safety, terminal, notebook, viewer, updater, and accessibility boundaries.

The architecture goal is a small always-on kernel plus capability-owned, cancellable services. Optional features must have observable start/stop ownership and no entitlement to stay alive merely because their code was imported once.

## Target shape

```text
Renderer shell
  ├─ documents + one active Monaco surface
  ├─ command/settings registry
  └─ lazy feature panels
          │ typed capability requests
Sandboxed preload
  ├─ files/recovery/settings
  ├─ processes/terminal/tools
  ├─ Git/language/debug/test
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
- One visible Monaco editor with bounded model retention.
- Explicit execution approval and workspace grants.
- Current terminal/Run Console separation: interactive PTY and deterministic test transports solve different problems.
- Data-only learning packs/themes and the offline-first default.
- Lazy viewer, notebook, semantic-tool, formatter, terminal, Git, AI-provider, and backup loading.

## Phase 1: stability kernel

1. **Candidate identity.** Every acceptance artifact records source SHA, build hashes, platform image, tool versions, and profile schema versions.
2. **Backup/restore gate.** Finish native fresh/populated restore, automatic relaunch, normal-store access, excluded trust/credentials/approvals, detached drafts, interruption recovery, rollback, and resource comparison.
3. **Migration contract.** Add a central registry of forward migrations with version, precondition, validation, durability boundary, rollback/recovery behavior, and test fixture. Never infer success from a partially written target.
4. **Owned lifecycle registry.** Make window/service/process ownership queryable for tests: terminal sessions, Run Console jobs, workers, notebook kernels, semantic tools, preview sessions, Git commands, backup operations, and pending profile writes.
5. **Release gate.** Package once, test the exact artifacts, then publish or install only with explicit authorization.

## Phase 2: professional core without permanent daemons

### Workspace model

Extend the granted-root model to a versioned workspace descriptor. It may contain multiple explicitly approved roots, per-root settings, exclusions, and tool preferences. File operations remain rooted in validated grants. Quick Open and search enumerate on demand; an optional bounded index is created only for features that need it and is deleted or invalidated with the workspace.

### Language capability host

Do not embed one language server per supported language into startup. Create a shared lifecycle manager with:

- language/tool metadata separate from executable discovery;
- explicit per-workspace enablement;
- executable paths resolved outside untrusted workspace precedence unless reviewed;
- one server instance per compatible workspace/toolchain when needed;
- bounded request queues, cancellation, revision IDs, output limits, and crash backoff;
- idle grace period followed by shutdown;
- measured memory/process attribution exposed to diagnostics;
- feature degradation to Monaco syntax/basic editing when unavailable.

Start with existing clangd and Java adapters, then add Python and JavaScript/TypeScript through maintained protocol-compatible tools. A language is not advertised as “smart” until completion, diagnostics, navigation, lifecycle, and failure behavior are natively verified.

### Debug host

Use Debug Adapter Protocol rather than custom debuggers. Implement one C/C++ adapter first. Main owns adapter/process launch; renderer owns breakpoints, call stack, scopes, variables, watch, and debug console views. Sessions require explicit start, inherit no shell trust, terminate descendants, cap protocol/output data, and shut down when the last debug session closes.

### Build and test host

Represent tasks and tests as declarative reviewed records. Discovery adapters are opt-in and cannot execute build scripts merely to populate UI. A common run record captures command identity, source/config revision, environment policy, output, duration, cancellation, and cleanup. Existing saved C tests migrate into this model without changing their evidence.

## Phase 3: Git and GitHub

Keep Git CLI invocation in main with structured arguments and a validated repository root. Add remote operations as explicit state machines with cancellation and conflict states. Never parse shell strings or inherit workspace-controlled Git config across a security boundary without validation.

GitHub is a separate provider: official device/OAuth flow, OS-backed token storage, minimum scopes, explicit sign-out/revoke, rate/error handling, and no requirement for offline editing. Pull-request views consume remote data but never execute repository content.

## AI and Copilot boundary

AI is optional infrastructure, not a renderer-wide singleton. Provider sessions receive a reviewed context manifest, limits, cancellation, and a permission ledger. Editing uses proposed diffs and source-revision checks. Agent actions require explicit tool permissions and cannot silently run commands, modify files, read credentials, or broaden workspace access.

GitHub now documents an official Copilot SDK for custom applications and agentic workflows. Phase 6 should start with a disposable proof of concept that measures its native runtime, authentication, subscription/licensing, permission handler, streaming, offline failure, and shutdown behavior. It must not be added to ordinary startup. The SDK does not by itself establish a supported third-party inline-completion API; that capability remains unsupported until GitHub documents one. Private endpoints and browser-session scraping are prohibited. [Official SDK](https://github.com/github/copilot-sdk) · [Where GitHub supports Copilot](https://docs.github.com/en/copilot/get-started/where-to-use-github-copilot)

## Extension boundary

Do not load third-party extension code in the privileged renderer or main process. A future extension host needs a separate constrained process, signed/declared manifests, granular capabilities, resource limits, crash isolation, versioned APIs, and disable/uninstall recovery. Data packages (themes and lessons) remain a safer, separate category.

## IPC evolution

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
