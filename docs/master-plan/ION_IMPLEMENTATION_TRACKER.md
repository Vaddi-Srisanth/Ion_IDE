# Ion implementation tracker

Current branch: `codex/ion-master-plan-phase-0`
Starting revision: `26eff2a78bf6c577cc787137b2977fb1c2530b3f`
Public release: `0.9.6`
Local source version: `0.9.8`
Installed application: inspected only; untouched

## Phase status

| Phase | Status | Exit gate |
| --- | --- | --- |
| 0 — Audit and baseline | In progress | Six master-plan documents reviewed; baseline commands/tests recorded; exact known/unverified scope established. |
| 1 — Stability and data safety | In progress, release-blocked | Exact-current-candidate native backup restore/relaunch, rollback/interruption, trust exclusion, resource comparison, migrations/lifecycle, and package identity pass. |
| 2 — Core editor excellence | Deferred | Phase 1 gate passes; then representative project journey defines workspace/LSP/debug/test scope. |
| 3 — Git and GitHub | Deferred | Core workspace/tool lifecycle stable; official auth and conflict-safe design reviewed. |
| 4 — Practice Arena | Deferred | Local judge threat/resource model and original content policy approved. |
| 5 — AI infrastructure | Deferred | Provider/context/permission architecture and authenticated acceptance available. |
| 6 — GitHub Copilot | Deferred, official agent SDK identified | Run a separately approved proof of concept for official SDK auth, runtime cost, permissions, and lifecycle. Inline completion remains unsupported without a documented official API. |
| 7 — Ion AI experiences | Deferred | Phase 5 complete and ordinary editor remains independent. |
| 8 — Advanced education | Deferred | Evidence model and curated content quality established. |
| 9 — Extensibility/platforms | Deferred | Extension isolation/API and platform ownership approved. |
| 10 — Production hardening | Deferred | All intended release features pass native, security, endurance, accessibility, installer, and performance gates. |

## Phase 0 checklist

- [x] Inspect repository/Git state and current candidate identity.
- [x] Inspect installed app metadata without launching or changing it.
- [x] Review architecture, product/security/test audits, performance history, and Core backup reports.
- [x] Inventory source/test/script/doc/workflow surface and major production chunks.
- [x] Confirm `npm audit --omit=dev`: zero known production advisories on 23 November 2026.
- [x] Record that nested parent `node_modules` makes local `npm ls --omit=dev` non-reproducible/noisy.
- [x] Classify master-directive capabilities in the feature matrix.
- [x] Define architecture, performance, and security contracts.
- [x] Run focused local Phase 1 tests against this branch: 25 backup tests passed; dark/light backup UI fixtures completed 10 cycles each with zero errors, zero listeners after close, and no closed-background bridge calls.
- [x] Run typecheck and production build once after the documentation checkpoint is stable: both passed on 23 November 2026.
- [x] Review working-tree diff and whitespace; do not commit/push automatically.

## Phase 1 active gate

| Item | State | Evidence / next step |
| --- | --- | --- |
| Backup/restore production implementation | Implemented | Source commit `881ef00`; production `src` unchanged through the starting revision. |
| Windows focused filesystem/interruption correction | Verified at `ce035cb` | Hosted Windows recheck passed 54 focused tests, 5 path/sharing checks, and 9 Undo controls. |
| Remaining native acceptance workflow | Prepared | `.github/workflows/core-backup-verification.yml` builds candidate and `d67613a` baseline on macOS/Windows. |
| Last approved remaining-gates run | Failed, preserved | Run `43937220557`: Windows baseline extraction path defect; macOS Undo fixture assertion. It did not reach restore/resource gates. |
| Local fixture/workflow corrections | Implemented, not natively rerun | Starting revision `26eff2a` changes test/workflow behavior only. |
| Actual restore + relaunch | BLOCKED | Requires authorized push of exact reviewed candidate and two focused native jobs. |
| Normal-interface access to restored data | BLOCKED | Same focused native acceptance. |
| Trust/credentials/active approvals excluded after relaunch | BLOCKED | Same focused native acceptance. |
| Interrupted startup recovery + rollback | BLOCKED | Same focused native acceptance. |
| Backup UI closed/open resource comparison | BLOCKED | Previous run failed before resource lane. |
| Release | BLOCKED | No merge, installer, update-feed change, installation, or release is authorized. |

## Phase 1 acceptance matrix

| Requirement | Automated local | Native macOS | Native Windows | Status |
| --- | --- | --- | --- | --- |
| Archive validation, bounds, corruption, traversal, links, duplicates | Existing focused tests | Earlier scoped evidence | Earlier scoped evidence | Conditional on exact-candidate rerun |
| Store round-trip and legacy input | Existing focused tests | Earlier scoped evidence | Earlier scoped evidence | Conditional |
| Detached draft collisions and recovery limits | Existing focused tests | Earlier scoped evidence | Earlier scoped evidence | Conditional |
| Workspace copy/reference/exclude/relocate | Existing focused tests | Earlier scoped evidence | Earlier scoped evidence | Conditional |
| Credentials/trust/approval exclusion | Existing focused tests | Relaunch not complete | Relaunch not complete | BLOCKED |
| Actual production restore/relaunch | Node/bridge controls only | Not complete | Not complete | BLOCKED |
| Interrupted application lifecycle and rollback | Node transaction controls | Not complete on corrected candidate | Not complete on corrected candidate | BLOCKED |
| Candidate/baseline RAM, startup, idle CPU, cleanup | Harness prepared | No completed sample | No completed sample | BLOCKED |
| Physical 8 GB and hardware power loss | unavailable | Unverified | Unverified | Deferred limitation, not a pass |

## Next concrete action

1. Finish this local documentation checkpoint and run focused non-GUI tests, typecheck, and production build.
2. Review the exact diff and source identity.
3. If the user authorizes the narrow upload, push only the reviewed verification branch/candidate and run the two focused native Core jobs. Do not merge, publish, install, or alter the update feed.
4. If either job fails, preserve artifacts and correct only the demonstrated root cause.
5. If both pass, update the reports with exact measurements and decide Phase 1's next durability/lifecycle gate. Do not begin Phase 2 automatically.

## Reporting ledger

| Date | Change | Verification | Performance | Git/external effect |
| --- | --- | --- | --- | --- |
| 2026-11-23 | Completed initial master audit and controlled Phase 0/1 plan | `test:backup` 25/25; backup UI dark/light 10 cycles each; typecheck passed; production build passed | Historical baseline consolidated. Static lazy chunk remains 8.56 KiB JS + 0.89 KiB CSS. No new native process-tree result. | New local branch and uncommitted docs only; no push/install/release |
