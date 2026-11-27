# Phase 7 — Ask Ion

In Full mode, open **Ask Ion** from the Code command palette. The dialog starts with an empty question. For a supported editor buffer, the user can choose to include its first 8 KiB. Ion prepares a local review and shows the exact excerpt, provider, model, and payload size. Send requires native confirmation. Main rejects project, lesson, diagnostic, and mismatched mode requests on the Ask path. Existing stale-context checks and one-use review tokens still apply.

Ask uses the same lazy response validator and provider vault as Tutor and Project Lens. It returns a read-only explanation and citations bounded to the excerpt. Opening Ask or reviewing a request sends nothing. Answers have no execution or edit capability.

Type checking, a production build, and 51 focused tests passed on macOS ARM64. The disposable production Electron journey used an offline provider fixture and real OS credential encryption. It verified both question-only and opt-in excerpt sends, approval counts, credential redaction, draft and file preservation, and provider cleanup. Live providers and the Windows desktop journey have yet to run for this increment. Edit and Agent modes remain open.
