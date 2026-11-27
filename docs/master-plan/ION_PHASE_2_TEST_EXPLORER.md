# Ion Phase 2.6 — Test Explorer

Status: **IN PROGRESS — resumed after Windows v0.9.9 publication**

Branch: `codex/ion-core-excellence-phase-2-tests`

Starting checkpoint: `23dff68` (Build/Tasks adapter-foundation native evidence).

The last locally verified pytest foundation is `329789c7ff33f163764bfd30b6ce94d1d91a962b`. Subsequent generic framework-selection and Vitest adapter edits were stopped before their tests/typecheck; they are preserved as unfinished work on this branch. No final native Test Explorer acceptance has run. None of this milestone's implementation is included in the accepted Phase 2.5 main delivery. Work resumed from preservation commit `2c025c5cc34b89b0e79255e594b61dd2eff78dee`.

## Implementation sequence and acceptance

1. Shared test discovery, execution, result/history and lifecycle interfaces; one complete pytest journey.
2. Real Java/JUnit and Jest/Vitest adapters using reviewed installed tooling.
3. Targeted production Electron acceptance on macOS ARM64 and Windows x64 with critical data-safety and approval regressions. Expanded resource measurements and long stress sessions belong to Phase 10.

The first slice does not complete Milestone 2.6. Framework discovery must produce real framework test identities; static method-name scanning or a successful task exit cannot substitute for individual test evidence.

## First slice

The command palette and Run menu open a lazy Test Explorer. Opening it reads saved metadata only. Users choose an authorized root, explicitly request discovery, review the executable and arguments, then select a case, file group or all cases. Failed cases can be selected again. Existing saved C behavior tests keep their original UI and approvals and remain accessible from this view.

pytest collection executes imports and configuration, so both discovery and execution require a native approval dialog. Ion uses an installed Python outside all workspace roots and an Ion-owned reporting helper through the existing bounded process runner. No download, watch process or test collection occurs at editor startup. The environment disables automatic third-party pytest plugin loading; projects requiring those plugins are not yet claimed supported.

Tests operate on saved files. Dirty/conflicted editor buffers block the UI request. Source/configuration revisions and root authority are rechecked around approval and execution. Test results are evidence of the observed run, not proof that every external dependency was immutable.

The reporter records actual parameterized identities, setup/call/teardown outcomes, skipped tests, durations and bounded error/output excerpts. Exit zero alone is insufficient. Missing/truncated reports and incomplete cleanup cannot become passing results. Cancellation uses existing Unix process groups and Windows ownership helpers.

History is bounded and stored under `test-explorer-v1`. The new backup category includes validated history. Restore clears runnable discovery, selectors and source snapshots, preserves results as restored/stale history, and grants no filesystem or execution authority. An original root association remains inert; relocated-root relinking is still a follow-up acceptance item.

## Verification status

- Backup integration: three local tests pass, including the actual archive/controlled startup restore path, pre-restore rollback contents, injected publication failure rollback, and malformed records with forged approvals/unsafe paths.
- Local typecheck and production build pass. The full unit/security suite reports **500 total, 474 passed, zero failed, 26 skipped**. Skips are 25 Windows-only fixtures and one unavailable installed Maven/Gradle fixture. Logs are retained under `performance-results/test-explorer-local/2026-11-27T02-00-21-209Z/`.
- Ten focused backend tests pass, including real Python 3.14 with pinned pytest 8.4.2 through production trusted-PATH discovery, parameterized/pass/fail/skip results, cancellation, stale source revisions, hostile reports and sticky incomplete-cleanup errors. No test approval or tool launch occurs on list.
- A synthetic-browser UI check covers wide/narrow layout, empty/discovered/results views and interactions. This is not native Electron acceptance. Native acceptance and matched resource measurements remain pending.
- Java/JUnit and Jest/Vitest: not implemented in this first slice.
- Installed Ion, live user data, main, public installers and update feed: unchanged.

## Framework references

The pytest helper uses documented [collection and reporting hooks](https://docs.pytest.org/en/stable/reference/reference.html) and a fresh process for each [pytest invocation](https://docs.pytest.org/en/stable/how-to/usage.html). Collection can execute project code, including imports. Every future adapter must preserve the same approval boundary; [Vitest collection](https://main.vitest.dev/api/advanced/vitest) also evaluates test files.

## Verdict

**OPEN.** The pytest slice has local evidence; the subsequent Vitest/generalization edits are unverified. Native UI, framework completeness, resource gates, Java/JUnit, and relocated historical-result relinking remain unfinished. Phase 2 overall remains incomplete. The resumed development branch carries these gaps forward.
