# Ion Core Excellence — Bounded roadmap

This milestone started from reviewed checkpoint `d67613a`. Existing audit evidence remains in `ENGINEERING_AUDIT.md`, `TEST_COVERAGE_AUDIT.md`, `BOTTLENECK_REPORT.md`, `PERFORMANCE.md` and the Windows diagnostic handoff. Those reports describe their historical candidates; their numbers are not relabeled as measurements of this milestone.

| Order | Delivery | Dependency and acceptance journey |
| --- | --- | --- |
| 1 — this checkpoint | Protect and restore user work | Back up meaningful local data, review conflicts, preserve current drafts, restart safely, recover interrupted apply/rollback; no execution approval restored. Local implementation and verification only. Native-platform gates remain explicit. |
| 2 — not started | One representative Python assignment | Begin only after Milestone 1 review and native restore/close verification. Open an existing assignment, explicitly approve a saved task/test configuration, run tests, inspect actual expected/actual failures, edit manually and rerun. Offline, cancelable and bounded; no hidden commands. |
| 3 — not started | Project-aware navigation | Reuse current language-service infrastructure. For the same assignment, navigate definition/references and Back/Forward across files. Plain editing starts no server; opt-in tooling reports its measured memory/process cost and stops cleanly. |
| 4 — not started | One reliable Python debugger | Reuse process ownership and a reviewed adapter. Break, step, inspect actual state, stop, and prove no orphan process. User source remains authoritative; execution state is never confused with learning mastery. |
| 5 — not started | Focused refactoring and source splits | Separate deliveries after navigation/debugging reliability. Preview a rename with conflicts/Undo and edit side-by-side without duplicate or leaked models. |
| 6 — not started | Deeper learning integration | Reviewed diagnostic/runtime explanations using installed offline content; actual evidence only, no automatic code generation or invented mastery. |

Every future delivery needs a small acceptance journey, disposable-data regressions, production-build measurements and a reviewed boundary. No marketplace expansion, new themes, UI redesign, additional framework or permanently running language service is authorized by this roadmap.

Distinguish three kinds of work: missing capabilities need product acceptance; reproduced defects need failing-before/passing-after tests; historical intermittent incidents remain unresolved until their original conditions are characterized. In particular, retain the Windows GCC latency, notebook and Learning Lens evidence. A backup feature neither fixes nor reopens those investigations.

The next action after this local checkpoint is review/native verification when separately authorized. It is not automatic Milestone 2 development, installation, publication or CI upload.
