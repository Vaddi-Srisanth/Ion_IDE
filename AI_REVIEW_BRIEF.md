# Independent AI review brief for Ion IDE 0.6.2

Use this brief to request an independent review of the application, its measured performance, and its usefulness for C learners. Start with the small evidence pack. Add the source and test files for an audit that can verify implementation claims.

## Small evidence pack

| File | What it gives the reviewer |
| --- | --- |
| `AI_REVIEW_BRIEF.md` | Scope, review prompt, and exact evidence inventory. |
| `ION_IDE_ANALYSIS.md` | Current capabilities, limitations, and interpretation of the measured results. |
| `README.md` | User workflows, setup, toolchain prerequisites, and explicit limits. |
| `ARCHITECTURE.md` and `RESOURCE_PROFILES.md` | Process and trust boundaries, data ownership, and the difference between Minimal and Full mode. |
| `PERFORMANCE.md` | Reproduction commands, metric definitions, and measured results by release. |
| `PROJECT_AUDIT.md`, `RELEASE_CHECKLIST.md`, and `TEST_PLAN.md` | Verification scope, release constraints, and the proposed learner study. |
| `ROADMAP.md` | Planned milestones. Use it to identify unbuilt work. |
| `PORTABLE_PROFILE.md` | Export scope, path-dependent project metadata, and how to open a portable profile. |
| `PLANNING_EVALUATION.md` | Offline planning rubric and the limits of the simulated provider checks. |
| `package.json` and `package-lock.json` | Version, dependencies, toolchain requirements, and build and test scripts. |

For a quick product critique, add three short synthetic captures if you have them. Show opening and running a C file, recovering an unsaved edit after a forced exit, and fixing an unfamiliar diagnostic in Learn. Show the complete interaction, including toolchain and trust prompts. Use a disposable profile and a made-up workspace.

## Evidence for performance claims

Share reviewed copies of these files. The JSON reports preserve sample-level values, host information, runtime versions, process membership, workload parameters, and artifact fingerprints.

| File under `performance-results/` | Evidence |
| --- | --- |
| `resources-readiness-extended-baseline-2026-11-09T07-14-22.281Z.json` | Matched Ion 0.6.1 baseline. |
| `resources-readiness-extended-final-2026-11-09T07-22-49.982Z.json` | Matched Ion 0.6.2 candidate with extended coding and process cleanup samples. |
| `readiness-performance-gate.log` | Outcome for 32 enforced checks and seven advisory active footprint checks. |
| `readiness-release-gate.log` | Recorded type check, production build, 76 automated test cases, and desktop verification suites. |
| `readiness-integrity-upgrade.log` and `readiness-keyboard.log` | Focused save, upgrade, and native keyboard regression results. |
| `readiness-package.log` | Disk image creation, checksums, strict signature verification, and mounted-app smoke results. |
| `packaged-runtime-2026-11-09T07-30-13.849Z.json` and `packaged-runtime-2026-11-09T07-32-45.729Z.json` | Two signed-bundle launch and idle checks with a longer settle and one tiny C fixture. |
| `packaged-runtime-2026-11-09T07-34-15.824Z.json` | Signed-bundle startup stages. The first launch from a fresh copy took longer before the inspection port appeared. |
| `run-console-2026-11-09T07-09-00.165Z.json` | Optional historical diagnostic. It covers 100 interactive runs of 0.6.1. |

The matched 0.6.2 resource run used production bundles on an Apple M3 with 24 GiB RAM, macOS 27.2 (26B123), Electron 45.2.3, and Chromium 156.0.8078.80. Its five fresh and five warm launches measured 384 and 381 ms to the Welcome screen. Idle measured 421.86 MiB summed RSS, 122.30 MiB attributed physical footprint, and 0.65% of one logical CPU core over ten seconds after a 500 ms settle. The final five seconds were about 0.06%. One open C file, ten tabs, and the project fixture measured 507.72, 524.41, and 549.86 MiB summed RSS. The first open of a 1.50 MiB source took 177 ms, tab switching about 50 ms, and Stop including process exit 52 ms. The separate 20-round coding workload took 27.33 seconds, peaked at 678.88 MiB summed RSS, and averaged 39.98% of one core including reaped native work.

Summed RSS includes multiple processes and can count shared pages more than once. Attributed footprint uses macOS kernel charges and can include GPU allocations. Keep both metrics and their definitions. The short run establishes a regression reference for that machine. It leaves full-session reliability, lower-memory hardware, and any product-level learning advantage unverified. Keep the mounted-app smoke test, matched release benchmark, and new signed-bundle measurement separate. The latter used a longer settle interval and a tiny C fixture and saw 2.55–2.76 s for the first launch from each new copy.

## Source and test files for a deeper audit

Send `src/`, `test/`, and the relevant `scripts/` directories along with `package.json`, `package-lock.json`, `tsconfig.json`, and `vite.config.ts` for a full code review. If the reviewer has a small context window, send one area at a time.

| Area | High-value paths |
| --- | --- |
| Desktop security and file authorization | `src/main/index.ts`, `src/preload/index.ts`, `src/shared/contracts.ts`, `src/main/files.ts`, `src/main/quick-open.ts`, `src/main/web-preview.ts`, `test/backend.test.ts`, `test/quick-open.test.ts`, `scripts/test-data-integrity.mjs`. |
| Editor performance, recovery, and accessibility | `src/renderer/App.tsx`, `src/renderer/Workbench.tsx`, `src/renderer/documents.ts`, `src/renderer/MonacoSurface.tsx`, `src/renderer/load-editor.ts`, `src/renderer/CommandPicker.tsx`, `src/shared/shortcuts.ts`, `src/main/recovery.ts`, `test/documents.test.ts`, `test/recovery.test.ts`, `scripts/test-recovery.mjs`, `scripts/test-keyboard.mjs`. |
| Run Console and process lifecycle | `src/main/run-console/`, `src/main/runner.ts`, `src/renderer/run-console/`, `test/interactive-pty.test.ts`, `test/run-plans.test.ts`, `test/service-lifecycle.test.ts`, `scripts/test-run-console.mjs`, `scripts/resource-lifecycle.mjs`. |
| Learning correctness and product scope | `src/main/learning/`, `src/renderer/learning/`, `src/main/projects/`, `src/main/practice/`, `test/learning.test.ts`, `test/fixtures/c-diagnostics.json`, `test/projects.test.ts`, `test/practice.test.ts`, `scripts/workspaces.mjs`, `scripts/evaluate-project-plans.mjs`. |
| Document viewing and data portability | `src/main/viewers/`, `src/renderer/viewers/`, `src/main/preferences.ts`, `src/main/profile-export.ts`, `test/viewers.test.ts`, `test/viewer-tables.test.ts`, `test/viewer-word.test.ts`, `test/profile-export.test.ts`, `scripts/test-profile-export.mjs`, `scripts/test-paged-viewer.mjs`, `scripts/viewer-fixtures.mjs`. |
| Performance instrumentation and packaging | `scripts/benchmark-resources.mjs`, `scripts/benchmark-resource-metrics.mjs`, `scripts/benchmark-resources-probe.c`, `scripts/check-performance-regression.mjs`, `scripts/desktop-harness.mjs`, `scripts/benchmark-run-console.mjs`, `scripts/benchmark-packaged-runtime.mjs`, `scripts/build.mjs`, `scripts/package-mac.mjs`, `scripts/verify-mac-release.mjs`. |

An optional native QA attachment is `release/Ion-IDE-0.6.2-mac-arm64.dmg`. It is roughly 123 MB and ad-hoc signed. Send it only if the reviewer can inspect or run an Apple Silicon macOS build. The source, test logs, and raw performance reports are usually more useful for a text-only review.

## What to remove before sharing

- Copy only the selected files into a separate review folder. Exclude `node_modules/`, `dist/`, `dist-baseline/`, `.git/`, and the rest of `performance-results/`. They add size and can contain unrelated artifacts or path details.
- Keep your live Ion profile and portable backups private. They can contain personal workspace locations, learning history, project specs, test output, recovery drafts, practice attempts, custom themes, or credentials. Exclude user workspaces, private documents, environment files, `.npmrc`, Keychain data, API tokens, and live-provider logs.
- Review the selected files for absolute home and temporary paths, usernames, email addresses, tokens, private URLs, and terminal output. Replace personal paths with stable placeholders such as `<HOME>` and `<SCRATCH>`. Keep version strings, checksums, timings, and process counts intact. Review screenshot recents, title bars, and file content before sharing.
- Prefer the source-generated test fixtures. Binary fixtures such as `test/fixtures/study-slides.pptx` can include author or template metadata. Inspect or omit them if document rendering is outside the review.

## Copy-ready review prompt

```text
Act as an independent desktop IDE reviewer and skeptical product mentor.
I’m sharing Ion IDE 0.6.2, a standalone offline-first desktop IDE with optional
C diagnostic explanations for beginners. Assess the current build against two
goals. It should be a dependable daily-use editor on an ordinary student laptop,
and its C explanations should help students understand and fix errors themselves.

Use the attached repository files, raw benchmark reports, and verification logs.
Separate claims verified by test or runtime evidence, claims supported only by
source inspection, and unverified or roadmap claims. Cite file names and line
numbers or JSON fields for material findings. Treat prior reports as inputs to
check independently. Identify any missing evidence and say what you ran yourself.

1. Inventory capabilities and limitations. Separate syntax highlighting, real
   execution, C diagnostics, project verification, learning history, document
   rendering, and native packaging. Distinguish five-language execution from the
   C-only learning and test workflows.
2. Review runtime performance. Show whole-process-tree RSS, attributed footprint,
   CPU as percent of one core, startup and interaction latencies, and package
   sizes. Compare only matched versions and workloads. Identify baseline
   regressions, memory warmup, sample variability, and the tests needed to
   evaluate an 8 GB Mac and hours-long sessions.
3. Audit security and reliability. Trace renderer-to-main IPC, workspace grants
   and symlinks, revision-aware saves and concurrent writers, crash recovery,
   compiler and PTY shutdown, document parsing, project test approval, offline
   network boundaries, and credential storage. For each serious issue, give a
   concrete reproduction or a test that could confirm it.
4. Assess learning and product strategy. Give the strongest argument against
   switching from a learner’s existing editor and compiler. Explain whether the
   current optional features serve the core C learner. Propose a controlled task
   comparison that measures correct fixes, ability to explain the cause, and
   transfer to a similar error without help. Avoid inferring learning gains from
   passing software tests.
5. Give one score out of 10 with a clear rubric. Lead with the top strengths and
   weaknesses, then a capability matrix, a performance table, and the five most
   valuable fixes ranked by severity, effort, and evidence. For each fix, give a
   pass/fail acceptance check. State what you would freeze or defer. Avoid
   proposing broad rewrites or features without a demonstrated user need.
```

For a reviewer that can run the project on a compatible Mac, provide the build and benchmark instructions from `README.md` and `PERFORMANCE.md`. Use a disposable profile and synthetic files for every run. When live provider evaluation is outside scope, run the planner rubric offline and keep any keys out of the review materials.
