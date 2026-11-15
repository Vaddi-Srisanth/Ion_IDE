# Project Lens security boundary

Offline D is implemented locally; AI/source transmission remains unimplemented.

- Exact current WorkspaceFiles root and owner identity are required. Individual file permission is not a project scan grant. No new grants.
- No execution, compiler, build script, dependency hook, Git command, notebook kernel, network or worker is used by analysis. Scripts are displayed as inert React text.
- Explicit bounded metadata/allowlisted manifest discovery; no source/docs contents. Secret/private-key and generated/dependency/binary/lockfile exclusions. Obvious manifest-command credentials/URLs are redacted best effort. This is not infallible secret scanning.
- Stable no-follow file handles, pre/post revisions and ancestor/root device/inode validation. Exact last-snapshot path/revision/range membership required on reference opening. Changed files/roots, forged ranges, symlink escapes and old request ownership are rejected.
- Portable path validation does **not** establish race-free descriptor-relative traversal under hostile concurrent ancestor replacement. Tests cover observed replacement, not every possible OS race. The5s bound/cancellation are cooperative at async boundaries; stalled filesystem calls cannot be forcibly interrupted. These remaining limits are visible in snapshots.
- Analyze/cancel/close owns one bounded snapshot. Canceled analysis cannot accumulate overlapping pending filesystem calls. Hiding the view revokes references; changing roots invalidates work. No persistent monitor/cache or automatic analysis.

21focused filesystem/security tests pass locally. Native Windows and macOS UI/IPC checks are prepared but not yet verified; browser fixture results are not native security proof. Existing safe saves, recovery, execution approvals and notebook trust remain independent.

E remains gated: exact outbound provider/model/context/range/revision/size review, exclusions and explicit informed consent; endpoint/content revalidation; untrusted-data isolation; strict current citation validation; cancellation; no AI-granted read/write/execute/commit/push ability. No project source or key has been sent by this task.
