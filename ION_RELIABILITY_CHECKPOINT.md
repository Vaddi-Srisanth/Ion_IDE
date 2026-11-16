# Ion Core Excellence — Milestone 1 checkpoint

Local feature delivery based on `d67613a`, on `feature/ion-core-excellence`. Application version stays 0.9.8: this is a source checkpoint, not a new public release. Installed Ion, its live profile, user projects, main, releases and the update feed were not modified. No push, installer, application launch or Milestone 2 work is part of this checkpoint.

## Implemented

- Lazy Settings backup/restore actions, a small versioned checksummed ZIP format and existing legacy-folder compatibility.
- Validated authoritative data across preferences, themes, learning/content, practice/source/reports, roadmaps/history, session references and recovery.
- Explicit folder policies, visible exclusions, exclusive archive publication, cancellation and bounded streaming.
- Reviewed category replacement, detached imported drafts, explicit roadmap mapping and new workspace-copy destinations.
- Independent historical test evidence, cleared approvals and stale practice results.
- Verified pre-restore backup, accepted-write/process-owner draining, startup apply/rollback and failure instructions.

The original source/save/undo/runner systems remain in place. Changes to existing stores expose their validators/drains and preserve new restored metadata; they are not architectural replacements.

## Reproduced defects addressed while building this feature

These are implementation defects found in the new backup path, not claims of previously observed user-data loss:

| Finding | Evidence and correction |
| --- | --- |
| Archive handle ownership | The first round-trip cohort exposed EBADF on archive close. The reader now owns one handle and supplies bounded ranges through a non-owning reader; archive close/cancel paths pass. |
| Incomplete marker / post-arm failure | Injected publication errors and post-arm cleanup failures previously allowed an orphaned transaction or editing after pending intent. A flushed exclusive marker, durable stage directory tree and restart-required state preserve the journal and force startup repair. |
| Ancestor-folder self-inclusion | A disposable ancestor-folder fixture copied active profile/staging records during snapshot construction. The canonical active-profile subtree is now pruned. No published credential leak was established. |
| Invalid folder token cleanup | Folder capabilities validate before staging allocation; repeated reviews and expired/unknown folder inputs leave no owned stage. |
| Interrupted multi-category rollback | Real child-process kills at journal/publication/rollback boundaries verify replay from filesystem state and preservation of prior bytes. |
| Accepted-write ownership | New restore needs more than existing store-queue snapshots. Accepted mutating calls are tracked, lifecycle-dependent updater promises are excluded, automatic-test execution can settle through its final evidence publication, and stores drain before finalization. A deferred real evidence write verifies the barrier. |
| Active cancellation and ENOSPC | Streaming cancellation waits for input-handle closure; transaction-stage failures clean their exclusively owned directory before any pending marker. Fault-injection tests preserve current data. |

No broad save algorithm, compiler, Git, notebook execution or updater rewrite was made.

## Verification verdict

See `ION_BACKUP_RESTORE_VERIFICATION.md` for exact commands, results, timings, resource counters, all skipped cases and measurement limits. Tests use synthetic data under uniquely owned disposable directories. No local Electron GUI was launched because the registration-crash precaution remains active. The production renderer was exercised in headless Chrome with an explicit fixture bridge; it is not a substitute for native IPC/relaunch verification.

This is a locally tested Milestone 1 implementation, **not a release-readiness declaration**. Native Mac/Windows dialog/close/relaunch, real restart interruption and Windows directory/locking semantics still require the prepared isolated-host checks. The manual-only workflow and native script are prepared but neither uploaded nor run.

## Known limitations and retained historical evidence

- No encryption, record-level merge, automatic secret detector guarantee, perfect cross-volume atomicity or power-loss guarantee beyond available flush/journal primitives.
- Backup/restore is bounded, but the full 2 GiB / 10,000-entry limit and 8 GB hardware were not exercised end-to-end. Strict schema validation can require repair of malformed current data before a complete rollback backup can be created.
- Rollback archives and previous categories stay local for safety. No automatic retention sweeper is added. After a process crash before arming, leftover private staging/new workspace destinations may need manual inspection; they cannot overwrite original projects.
- Saved-file session paths are inert references after import; only explicitly recovered drafts reopen through the restored session. Relink roadmaps by reviewing the same backup and choosing a folder. Prior binaries with strict record readers are not guaranteed to understand the new restored-history fields.
- Historical Windows GCC 12.67-second / READY-to-CLEAN 12.62-second outlier remains unexplained. Existing hosted results are retained in `diagnostics/windows-gcc/REMAINING_WINDOWS_TASKS.md`; this milestone does not label it fixed.
- Historical notebook, Learning Lens and macOS Electron registration incidents remain in the audit record. Later passing cohorts are not proof that every original intermittent condition was resolved.

## Repair and rollback instructions

If startup repair cannot safely complete, Ion stops before stores/editor initialization. Do not delete either version. With Ion quit, copy the entire affected profile first. Inspect `.ion-restores/<transaction-id>/journal.json`, `previous/`, `incoming/` and `unapplied/`, and the verified archive recorded under `.ion-backups/`. Recovery drafts are separate from source files. Manual repair must preserve both versions and remove pending intent only after the intended profile is verified. Do not test repair against the live profile.

Source rollback is a normal reviewed revert of this local milestone. Profile rollback after an actual restore is a separate operation using the retained pre-restore material; reverting source alone does not reverse data. Neither rollback was applied to the user's installed application.

The next authorized action is local review of this checkpoint. No push, release, installation or next milestone follows automatically.
