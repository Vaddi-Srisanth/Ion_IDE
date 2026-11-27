# Ion Core Excellence — Backup and reviewed restore

Milestone 1. Local-only implementation on `feature/ion-core-excellence`, based on `d67613a`. No installed application, live profile, main branch, release or update-feed change is part of this milestone.

## User journey

Settings → **Back Up My Ion Data** → select data categories and folder policies → Review Backup → inspect included files and exclusions → choose a new `.ionbackup` file. Current dirty buffers are checkpointed with existing recovery code; backup does not force source-file saves. Existing autosave policy still applies.

Settings → **Restore From Backup** → choose an archive, or a legacy exported Profile folder → inspect validated contents → explicitly select categories to replace/import → optionally map roadmaps and copy workspace folders → review the rollback location → continue through normal Save / Keep Drafts / Cancel → restart. Current categories are kept by default. If Save/Discard changes selected data after the review, restart preparation stops and requires a fresh review.

The UI and privileged implementation load only on request. Main retains paths and ten-minute operation tokens; the renderer receives bounded metadata, not extraction authority. Closing the dialog cancels work and removes owned temporary staging. Progress is event-driven and capped to roughly 20 updates/second, with immediate phase transitions. No formatter, compiler, terminal, worker, monitoring loop or network service is added.

## Coverage and exclusions

| Category | Authoritative data |
| --- | --- |
| Preferences | Validated settings and recent locations; foreign-platform recent paths remain inert or are filtered when unavailable |
| Themes | Registry and referenced custom palettes; built-ins stay in the application |
| Learning | Full local encounter/retry/activity history, not just its UI projection |
| Content | Installed/user-created manifests and referenced lessons, including supported legacy pack files |
| Practice | Problems, notes, all referenced attempts, edited source and saved reports |
| Projects | Specifications, milestones, tests and evidence; unidentified hashed records remain preserved |
| Session | Views, draft links and file/folder references |
| Recovery | Validated binary draft headers and UTF-8 contents |

Configured provider credentials, browser authentication/storage, execution/repository trust, caches, logs, updates and temporary files are outside the allowlist. Source text and notes can contain secrets; filename exclusions cannot guarantee secret detection. Archives are **unencrypted**. SHA-256 establishes integrity, not publisher authenticity.

Folder choices are Reference only / Copy working files / Exclude. Copies omit `.git`, dependency/build/cache directories, credential/environment filenames, symbolic/hard links, special files and non-portable names. The active profile subtree is always pruned, even when an ancestor is selected. The review includes the exact included-file list (100 rows/page) and a bounded exclusion list with an omitted-count indicator. Original working folders are never written by restore.

## Archive and validation

Version-1 ZIP: first entry `manifest.json`; remaining entries under `profile/` or `workspaces/<owned-folder-id>/`. The manifest records archive/application/schema versions, scope, project associations, exclusions, sizes and SHA-256 hashes. Entry payloads stream in 64 KiB chunks. Manifest and each store's bounded metadata may be buffered; the whole archive is never buffered.

Limits: 2 GiB archive and total expanded data, 10,000 payload entries, 128 MiB per payload, 8 MiB manifest, 16 folders, depth 32, 50,000 inspected workspace entries. Existing stricter schema limits also apply (64 recovery drafts, 200 practice problems, etc.). V1 requires normalized portable archive names; excluded workspace names are disclosed. Unsupported schema versions fail rather than being guessed or silently migrated.

The reader rejects traversal, absolute/UNC/device/alternate-stream paths, reserved Windows names, duplicate/case/Unicode-colliding names, file/parent collisions, links, special files, encrypted entries, unsupported compression, missing/unlisted payloads, header disagreements, CRC/SHA errors, truncation and expansion-limit violations. Copied profile records are validated through existing store parsers and cross-record checks before a preview is returned. ZIP extraction never imports ownership, ACLs or executable/elevated modes.

Use of pinned `yazl@3.3.1` follows its [streaming writer design](https://github.com/thejoshwolfe/yazl); the existing [yauzl reader](https://github.com/thejoshwolfe/yauzl) is wrapped with explicit handle ownership, local-header, CRC and SHA validation. License notices are included in the production output. No additional archive framework is introduced.

The existing `ion-local-profile` version-1 folder export is supported. Original checksums did not exist in that format; the preview says so. It is validated and checksummed from the new review onward.

## Restore authority and conflict rules

Replacement is category-level; there is no invented record-level merge. The sole special case is recovery: existing drafts stay, imported drafts receive collision-checked fresh IDs and lose `originalPath`. Combined capacity is checked before any replacement. Session draft IDs are remapped; imported root/file paths never enter active access grants. Original paths/views remain inert metadata. Such metadata survives subsequent session checkpoints.

Project test approvals are cleared. Previous outcomes move to separately validated `restoredEvidence`, displayed as historical/stale and excluded from current verification. Practice reports carry restored provenance and remain non-current until rerun. Automatic test enablement and execution trust are not restored. Smart language services require fresh opt-in. Unmapped roadmap hashes stay local; choosing the archive again allows explicit relinking by roadmap title. Relinking cannot overwrite another imported record mapped to the same root.

Copied workspaces are created in a new, uniquely reserved destination container. No existing project is overlaid. Copies on another volume are not part of a fictitious cross-volume atomic transaction; an interrupted preparation can leave a private/new destination requiring inspection. Profile rollback and original workspaces stay protected.

## Restart transaction and durability

1. Freeze new tool launches; require programs, tests, terminals and kernels to be stopped.
2. Use normal close confirmation. Cancel removes prepared staging.
3. Drain accepted profile-mutating IPC calls, instantiated store queues, automatic-test owners and process cleanup. Lifecycle promises such as updater installation are excluded from the write drain to avoid circular waits.
4. Recheck selected current hashes; identical checkpoint rewrites are accepted, changed contents require renewed review.
5. Create and reread a checksummed pre-restore rollback archive under `.ion-backups/`.
6. Stage safe publications under `.ion-restores/<id>/incoming`, flush files/directories and a transaction journal. Publish a flushed pending marker exclusively.
7. After marker publication, cleanup failure cannot reopen editing. Relaunch through the startup gate.
8. Before constructing normal stores, apply or repair journaled renames. Previous categories move into `previous/`; new categories publish individually. The journal records intent, and verified filesystem state resolves interrupted boundaries.
9. On a failed application, reverse replay restores prior categories. An ambiguous repair preserves both versions and prevents editing with recovery instructions.

Acknowledgement means file flushes plus directory synchronization where Node/the OS supports it; Windows lacks the same directory-fsync interface. This is individually safe publication with journaled restart recovery, not perfect atomicity across files, volumes, hardware failure or arbitrary same-user external modification. Unknown old files are retained in `previous/`; rollback material is not automatically swept.

## Implementation map

- `src/main/backup/format.ts`, `safe-fs.ts`, `profile.ts`: limits, schema allowlists and bounded filesystem reads.
- `archive.ts`: streaming exclusive ZIP publication and untrusted extraction.
- `snapshot.ts`, `restore.ts`: snapshot consistency and permission-safe imported records.
- `service.ts`: one owned operation, expiring reviews, cancellation, folder capabilities and orchestration.
- `pending.ts`, `transaction.ts`: minimal startup probe and durable apply/rollback.
- `src/main/index.ts`, preload/shared backup contract: validated privileged interface and lifecycle integration.
- `src/renderer/backup/BackupDialog.tsx`: lazy review UI using existing theme/Modal controls.

See `ION_BACKUP_RESTORE_VERIFICATION.md` for executed evidence and important native-platform limitations.
