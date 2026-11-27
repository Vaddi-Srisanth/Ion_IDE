# Project Lens — offline foundation D

Implemented locally beside the existing editor: Projects → Project Lens → Analyze. Opening the panel does not start discovery. The existing Roadmap remains the default and uses its original model/test approvals; dirty drafts block switching tools. The Lens renderer is a separate lazy chunk. No new dependency, worker, renderer, index, watcher, network request or background process.

`ProjectLensSession` owns one pending filesystem analysis and one bounded snapshot; superseding Analyze, Cancel, hiding Projects, root change and window closure revoke it. A pending OS call retains ownership through cleanup; Analyze returns explicit busy feedback until it finishes, with no retries or polling. The service takes the current WorkspaceFiles owner, requires its exact authorized root, stores its root device/inode, and rejects stale/forged references before opening through the normal editor. It does not create filesystem grants. Range-aware navigation reuses the existing source history.

Default hard caps: depth6,2,500entries visited,500returned eligible files,64KiB per manifest,256KiB total manifest bytes,128KiB serialized snapshot,5s cooperative duration. Files are inspected incrementally; only allowlisted manifests are opened. Binary files, secrets/private-key names, hidden/generated/dependency folders and lockfile contents are excluded. Directories/filehandles close on completion/cancellation; no snapshot persists to user data.

Language counts come from filename extensions. package.json dependencies/frameworks and entry declarations are parsed. Other recognized manifests (Python/Java/CMake/Make/Cargo/Go) currently establish filename/structure evidence only; their dependencies and scripts are not semantically parsed. Source/docs/test contents are not read. Test-shaped paths and entry candidates do not prove behavior. Scripts are bounded redacted inert text. Partial results show limits and uncertainty.

Local evidence:21real-temp-directory analyzer/session tests, including wrongroot/individualgrant/symlinks, malicious manifests, no execution, quotas/cancellation, obsolete requests, root replacement preserving source inode, stale file revisions and exact reference membership. Four production-renderer light/dark laptop/desktop cases at2× pass with explicit test-only transport; actual native filesystem/UI journeys pass both platforms atdf089aa (run43694512103), with7manifest handles opened/closed and no skipped symlink checks.

This is the offline structure foundation, not complete semantic project understanding, AI answers, architecture inference, project health verification or a Tutor. Offline analysis does not itself produce those conclusions. Explicit, reviewed AI explanation actions are integrated separately in E; their output is unverified prose, not a local health test.

## Reviewed explanation layer E/F

The optional context/session modules are separate lazy main-process chunks. A private current-snapshot lease authorizes only explicitly selected references; it is never serialized into a renderer read/execute grant. Saved file prefixes use finite reads and revision/owner/ancestor checks. The active unsaved buffer is explicitly labeled editor-provided evidence. Payload review precedes any network activity. See [provider integration](ION_AI_PROVIDER_INTEGRATION.md) for limits and consent.

Validated suggestions may enter the original roadmap only through editable, explicit selection and normal revision-aware save. The project specification remains independent of explanation implementation; tests, approvals and verification are unchanged. There is no automatic test generation/execution in this handoff.
