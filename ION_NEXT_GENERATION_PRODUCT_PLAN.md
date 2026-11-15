# Ion next generation — implementation plan

Feature branch: `feature/ion-next-generation`. Exact reviewed base: `a108a01bad53a6008761049c28a86e90bdd0374e` (0.9.8 source delivery; application commit `42caf55`). The original dirty workspace, verification branch, canceled reuse experiments, installed app and real profiles are excluded. No push, merge, installer publication or update-feed change is authorized by this brief.

## Concise baseline

Ion already has a lazy Monaco editor, actual file/recovery services, xterm shells and Run Console, local toolchains, Git, approved C project tests, installed lesson packs, diagnostic history, exercise attempts and an optional description-only AI planner. Navigation is state-based; there is no reason to add a router, UI framework, second editor, extension host or database. Syntax support does not imply execution, formatting, semantics or debugging support for every language.

The current Learn entry requires explicit pack installation. General course completion is not stored: diagnostic encounters, C explanation views and Practice attempts are separate evidence. Existing exercise identity and tests must be reused. Project Lens does not exist yet. The planner's consent currently covers goal descriptions, not project source.

## Ordered milestones

| Milestone | Working slice | Gate / status |
| --- | --- | --- |
| A | Welcome, compact workbench navigation, theme-compatible design tokens, representative Learn layout | Implemented locally; four renderer cases plus real Monaco Undo/navigation and dirty-form protection verified. Native platforms pending |
| B | Direct built-in language selection, content settings, preserved imports and progress, Practice route within Learn | Pending A representative validation; no eager full-catalog payloads or destructive migration |
| C | Small reviewed Python/Java/C learning paths, graduated hints, actual exercise/test evidence | Pending; do not label reference material a complete course |
| D | Explicit bounded, authorized, cancellable offline Project Lens | Pending; no execution or automatic workspace scanning |
| E | Tutor and Lens AI with exact source-context review, revision checks, validated citations, cancellation | Pending; existing API keys stay in OS-backed vault; no unapproved live calls |
| F | Evidence-backed proposals reviewed/edited into existing roadmap model | Pending; no automatic execution or completion |
| G | Native Mac/Windows, accessibility, migration, visual and matched resource verification | Pending available authorization and safe environments |

Milestones are committed separately after applicable checks. Native checks that cannot run safely are recorded as unverified; headless browser renderer tests are useful visual evidence but do not replace Electron IPC, native OS, process or installer tests.

## Known foundation limits

The source-delivery CI passed ten jobs, failed Windows paired-benchmark fixture setup, and left two optional diagnostic jobs unselected. Historical Windows GCC latency remains unexplained. Do not increase timeouts or relabel those failures. Local Electron registration crashes remain uncharacterized; no local Electron GUI launch is allowed for this work. Fresh Windows CI requires a separately approved upload. The installed 0.9.8 app stays untouched.
