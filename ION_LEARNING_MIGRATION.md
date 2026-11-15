# Learning compatibility and data safety

No global schema migration, profile rewrite or eager pack installation is performed. The existing schema1 learning registry, immutable per-pack files and legacy storage-less JSON remain authoritative. A first explicit bundled selection uses a shared internal helper inside the existing serialized store operation; it does not queue another serialized method and deadlock.

Installed/imported IDs and versions take precedence. A missing/damaged installed manifest fails visibly rather than being silently replaced. Corrupt registries fail without rewriting their contents. Removing a saved copy uses the existing confirmed store operation and leaves Practice attempts, source, notes and diagnostic history alone. Built-in content remains available for a later explicit selection.

Real temporary-directory tests in `test/learning-direct-selection.test.ts` cover fresh Python/Java/C selection, concurrent selection, malformed unselected content staying unread, old profiles and selected versions, imported ID precedence, corrupt/missing files, and unchanged exercise identities, attempts, notes and source. Existing `lesson-`+hash identity is reused. Before the correction, six of seven new cases failed; current source passes all seven and the combined 15-case pack suite.

These fixtures are disposable, not the user's real data. Actual old preference/history fixtures remain byte-identical. No live profile or recovery drafts were opened for this task. Existing profile export does not include all Practice attempts/notes; do not describe it as a complete practice backup. Native Windows migration execution remains unverified until authorized CI runs.
