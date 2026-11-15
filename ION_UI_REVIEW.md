# Ion UI review

## Baseline observations from actual source

Welcome spends substantial height on a large wordmark and decorative diagram; the useful actions are compressed into one workspace row. The four equal workspace rows obscure the dominant Code experience. The activity rail can toggle only the current learning/project mode, making other destinations hard to discover after entering an editor. Learn starts with a pack-installation prerequisite and exposes a Marketplace before study.

## Validation boundary

Original and revised captures will use the actual production React renderer with an explicit test-only bridge in headless Chrome, external requests blocked, and disposable fixtures. They are **renderer screenshots**, not native app screenshots or evidence of main-process correctness. Local Electron launch is not safe under the recorded registration-crash constraint. Windows native display scaling, native fullscreen, OS dialogs, GPU presentation, screen-reader behavior and native Electron memory remain unverified unless independently executed.

Review Welcome, one source file and Learn at small and desktop sizes, light/dark appearance, keyboard focus and reduced motion. Keep failures and console errors. Do not expand broad UI changes before inspecting those representative captures.

## Milestone A actual review

Baseline capture `ui-baseline-retry` and revised `ui-A-verified` passed all four 960×700 / 1440×900 dark/light cases. Inspected the actual Welcome, code and lesson PNGs; no page overflow, console/network errors or second Monaco widget. New keyboard-focus and draft-protection journeys also pass. These are real compiled React/Monaco renderer captures with a test transport, not native Electron screenshots.

- [Before: Welcome](docs/screenshots/next-generation/baseline-welcome-dark.png)
- [After: Welcome](docs/screenshots/next-generation/milestone-a-welcome-dark.png)
- [Before: workbench](docs/screenshots/next-generation/baseline-workbench-dark.png)
- [After: workbench](docs/screenshots/next-generation/milestone-a-workbench-dark.png)
- [Revised light lesson](docs/screenshots/next-generation/milestone-a-learn-light.png)

One initial fixture capture failed on an unsupported service-release test method; an explicit no-service fixture implementation corrected it. A later interaction test assumed an obsolete Monaco textarea; using actual visible editor input corrected the harness without changing product timeouts. Both failed reports remain local. Theme validation caught 4.36:1 light Run-hover contrast and stale metadata swatches; the actual palette and metadata were corrected, retaining the 4.5:1 assertions.

## Milestone B actual review

Fresh direct-language selection and actual Content settings journeys passed four cases at 1× and four at2× browser scale. Inspected the compact Content modal and corrected singular lesson-count grammar. [Learn](docs/screenshots/next-generation/milestone-b-learn-dark.png) · [Content settings](docs/screenshots/next-generation/milestone-b-content-dark.png). These remain renderer fixture captures, not native display-scaling or desktop tests.

Repeated Content settings open/close ran20 cycles in each of four cases (80 total). Tests retained the original source and Monaco widget and observed zero preview tokens, pending previews or project listeners after close. DOM listeners stayed559; nodes 803→797. Forced-GC browser JS heap rose about107–116KiB across20 cycles, with smaller late increments. This is short-workload evidence only; it does not prove indefinite leak absence or native memory recovery.


## Milestone D actual review

Four production-renderer cases pass at960×700/1440×900, light/dark,2× browser scale. Inspected both Lens captures: compact headings, explicit Analyze, readable declared/uncertain evidence, source links and collapsible details fit without page overflow. The editor remains the existing Monaco widget. Opening references preserves its source/Undo identity; dirty Roadmap/Practice forms still block navigation. No automatic scan or renderer network requests.

[Dark desktop Lens](docs/screenshots/next-generation/milestone-d-lens-dark.png) · [Light laptop Lens](docs/screenshots/next-generation/milestone-d-lens-light.png). These are real compiled UI screenshots with **synthetic test metadata**, not proof of analysis duration, React behavior verification, native display scaling or AI understanding. Actual filesystem/security/native execution is verified separately. Native screen-reader and human usability tests remain unavailable.

## Final E/F renderer inspection

Actual compiled React/Monaco, stable final production assets, four light/dark960×700/1440×900 cases at2×,17assertions/12captures each: all pass. Review uses explicit context selection, readable exact excerpts and quiet provider controls; answer sections/citations and editable roadmap review use existing themes. Inspected small light review and desktop dark proposals; inputs/selects/textareas use theme variables after correcting native gray/white defaults. No new editor, animation or floating toolbar.

[Reviewed context](docs/screenshots/next-generation/milestone-e-context-light.png) · [Answer](docs/screenshots/next-generation/milestone-e-answer-dark.png) · [Roadmap review](docs/screenshots/next-generation/milestone-f-review-dark.png). Captures use synthetic test context and responses, not real provider output. Native scaling/fullscreen/screen-reader usability and educational usefulness still require separate verification.

An overlapping capture failed because a concurrent production build deleted its loaded lazy asset. That run is preserved; only the subsequent stable-assets4/4run supplies final evidence.

### Populated-field accessibility regression

The native journey identified a populated textarea label failure; a minimal real-Chrome reproduction showed Description/Acceptance exact-label matches0 despite visible controls. Added explicit accessible names to these fields and Objective. The strengthened final production-renderer journey now asserts1match each, edits every populated field and verifies persisted description/citation note, two exact criteria and objective. Four scenarios pass with no selector weakening. Final captures now reflect this corrected candidate.
