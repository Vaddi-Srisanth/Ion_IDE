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
