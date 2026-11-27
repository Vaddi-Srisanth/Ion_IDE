# Ion next generation — implementation plan

Feature branch: `feature/ion-next-generation`. Exact reviewed base: `a108a01bad53a6008761049c28a86e90bdd0374e` (0.9.8 source delivery; application commit `42caf55`). The original dirty workspace, verification branch, canceled reuse experiments, installed app and real profiles are excluded. The user subsequently authorized this feature branch and native CI only. Main merges, installer publication, update-feed and installed-app changes remain unauthorized.

## Concise baseline

Ion already has a lazy Monaco editor, actual file/recovery services, xterm shells and Run Console, local toolchains, Git, approved C project tests, installed lesson packs, diagnostic history, exercise attempts and an optional description-only AI planner. Navigation is state-based; there is no reason to add a router, UI framework, second editor, extension host or database. Syntax support does not imply execution, formatting, semantics or debugging support for every language.

At the reviewed baseline, Learn required explicit pack installation. General course completion is not stored: diagnostic encounters, C explanation views and Practice attempts are separate evidence. Existing exercise identity and tests must be reused. Project Lens was absent at the baseline; offline foundation D is now implemented. The planner's original description consent is preserved; E adds a distinct explicit reviewed-source consent boundary.

## Ordered milestones

| Milestone | Working slice | Gate / status |
| --- | --- | --- |
| A | Welcome, compact workbench navigation, theme-compatible design tokens, representative Learn layout | Implemented locally; four renderer cases plus real Monaco Undo/navigation and dirty-form protection verified. A/B native desktop/installer tests passed; one Windows benchmark fixture failed |
| B | Direct built-in language selection, content settings, preserved imports and progress, Practice route within Learn | Implemented locally with actual disk and renderer journeys; no eager full-catalog payloads or destructive migration |
| C | Small reviewed Python/Java/C learning paths, graduated hints, actual exercise/test evidence | Three practical flow lessons implemented; dedicated C/Python/Java native journeys pass both platforms; complete course paths remain unfinished |
| D | Explicit bounded, authorized, cancellable offline Project Lens | Local implementation plus21filesystem tests/four renderer cases; native Mac/Windows completion passed; final E/F resource gate pending; no execution/autoscanning |
| E | Tutor and Lens AI with exact source-context review, revision checks, validated citations, cancellation | Implemented atceb6b63 with bounded revision-bound review/send/citations; existing vault reused; native Mac/Windows13checks pass at8c0ae1b; no live user-key calls |
| F | Evidence-backed proposals reviewed/edited into existing roadmap model | Implemented at5489a3c through existing revision-aware Projects.save; local merge/renderer checks pass; native persistence/conflict gates pass at8c0ae1b; no automatic execution/completion |
| G | Native Mac/Windows, accessibility, migration, visual and matched resource verification | 13selected native jobs pass at8c0ae1b; measured Mac renderer footprint cost, live-provider/human/hardware acceptance remain open |

Milestones are committed separately after applicable checks. Native checks that cannot run safely are recorded as unverified; headless browser renderer tests are useful visual evidence but do not replace Electron IPC, native OS, process or installer tests.

## Known foundation limits

The source-delivery CI passed ten jobs, failed Windows paired-benchmark fixture setup, and left two optional diagnostic jobs unselected. Historical Windows GCC latency remains unexplained. Do not increase timeouts or relabel those failures. Local Electron registration crashes remain uncharacterized; no local Electron GUI launch is allowed for this work. Feature-only native CI is now authorized; failures are retained and investigated. The installed 0.9.8 app stays untouched.
