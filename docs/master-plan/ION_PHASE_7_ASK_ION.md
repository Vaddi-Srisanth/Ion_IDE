# Phase 7 — Ask Ion

In Full mode, open **Ask Ion** from the Code command palette. The dialog starts with an empty question. For a supported editor buffer, the user can choose to include its first 8 KiB. Ion prepares a local review and shows the exact excerpt, provider, model, and payload size. Send requires native confirmation. Main rejects project, lesson, diagnostic, and mismatched mode requests on the Ask path. Existing stale-context checks and one-use review tokens still apply.

Ask uses the same lazy response validator and provider vault as Tutor and Project Lens. It returns a read-only explanation and citations bounded to the excerpt. Opening Ask or reviewing a request sends nothing. Answers have no execution or edit capability.

Type checking, a production build, and 51 focused tests passed on macOS ARM64. The disposable production Electron journey used an offline provider fixture and real OS credential encryption. It verified both question-only and opt-in excerpt sends, approval counts, credential redaction, draft and file preservation, and provider cleanup. Live providers and the Windows desktop journey have yet to run for this increment. Edit and Agent modes remain open.

## Read-only code-guided actions — 28 November 2026

The online Tutor adds **Explain this file**, **Find a likely bug**, and **Design test cases**. Each action requires a nonempty code excerpt, which remains unchecked by default. The existing exact local request review, one-use native Send approval, source/citation validation, and credential vault apply unchanged. The action-specific prompt asks for evidence and uncertainty; bug investigation cannot claim confirmation or propose a patch, and test design cannot claim tests ran or modify files. These are read-only explanations, not AI Edit or Agent.

Targeted macOS checks passed: **29/29** explanation context/provider/renderer unit cases, TypeScript checking, production build, and the disposable production Electron journey. The journey used a synthetic offline provider and real OS-backed credential encryption, and verified each action stays dormant until the user selects the code excerpt, sends nothing during review, sends only that excerpt after approval, applies the matching action guidance, and leaves the source unchanged. No live provider/model-quality result was claimed. Windows UI verification remains open.

## Explain selected code — 28 November 2026

The Code command palette now offers **Explain Selected Code** when a nonempty selection of at most 8 KiB is active. The request is bound to that selection, is unchecked by default in the exact request review, and refreshes from the current selection if the user reviews again. The main context validator treats it as renderer-provided evidence, applies existing path/secret/size checks, and returns only a bounded editor excerpt. The Tutor response is read-only, cited, and explicitly calls out missing surrounding context.

Focused verification: **30/30** explanation context/provider/renderer tests and TypeScript checking pass. Existing production Electron and build checks from this current code lineage also pass; no additional provider call, file write, or source upload occurred during this change. AI Edit, Agent, and Windows UI verification remain open.
