# Project Lens security gate — pending implementation

No Project Lens or Tutor source transmission exists in this milestone. The new learning access performs validated local data operations only; it does not grant execution or network rights.

Before D/E acceptance, require:

- Current-root identity and existing filesystem authority for every path; reject external grants, traversal, symlinks and stale roots/results.
- Read-only, bounded discovery with explicit cancellation; no manifest commands, hooks, compilers, notebooks or dependency installers executed during inspection.
- Obvious credential/private-key exclusions, binary/generated-directory exclusions, visible truncation and exact context review. Secret scanning cannot guarantee absence of secrets.
- Explicit provider/model/file/range/byte review before transmission; recheck content revisions and endpoint identity after consent.
- Repository text and model responses treated as untrusted data; no model-granted ability to read, write, run, commit or push.
- Source-linked responses only from validated, current evidence IDs/ranges; reject invented paths and mark changed evidence stale.
- Tests for malicious manifests/comments, wrong-root requests, changes during consent, late replies, close cancellation, blocked redirects and cross-project context isolation.

Existing execution approvals, notebook interpreter trust, safe saves and recovery must remain independent. A future security-reviewed implementation is required; this document is not a claim that those Lens tests passed.
