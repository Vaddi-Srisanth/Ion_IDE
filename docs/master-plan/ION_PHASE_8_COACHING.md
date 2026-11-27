# Phase 8 — Offline practice guidance

Practice → Progress now suggests one next challenge. It first offers an unfinished submission or an existing attempt without a submission. Otherwise, it suggests a new challenge, favoring a relevant manageable topic when local records support it. Imported-only verdicts do not personalize the suggestion. Incomplete progress suppresses it. The recommendation uses the existing on-demand ledger scan and adds no background work or tracking data.

**View challenge** opens the existing preview. The user chooses a language and starts or resumes explicitly. Returning to Progress restores focus and uses the same summary. The suggestion explains which saved evidence informed it.

Seventeen focused backend tests and four offline headless journeys passed on macOS ARM64. The production Electron journey reopened saved progress, opened the suggested challenge and returned to the summary offline. Native Windows verification for the recommendation remains open.

## Binary search walkthrough

Practice → Browse includes an offline lesson that steps through binary search on a sorted example. Learners can choose a target that exists or one that does not, compare low, mid and high, and replay each eliminated range. Previous, next and reset support keyboard use. The walkthrough loads only when opened and sends no requests to the main process.

The headless Chromium check verified the lazy chunk, both search outcomes, transitions, controls and returning keyboard focus to the entry. The production Electron journey also followed the found case on macOS ARM64. The walkthrough uses a fixed example without executing or persisting learner code.

## Local topic focus signal — 27 November 2026

Local checkpoint: `d471127` on `codex/ion-phase-6-copilot` (not pushed).

Practice → Progress can identify a topic to strengthen when at least two different catalog challenges have locally judged, current-suite wrong-answer results and no later local accepted result. It links back to one of those challenges for review or another attempt. A later accepted result clears that challenge's unresolved signal. Imported/restored results and mismatched suite versions do not count. If progress contains unreadable records, Ion withholds the focus signal rather than drawing a conclusion from incomplete evidence.

This is a deterministic practice hint, not a skill score. It reads only the same on-demand metadata and local verdict ledgers as Progress; it stores no extra profile data and reads no source. The UI states which evidence triggered the suggestion.

The local macOS ARM64 increment passed type checking, production build, seven focused progress tests, 11 practice progress/submission tests, the offline headless Practice renderer journey and the production Electron Practice journey. The tests cover distinct-challenge counting, later acceptance, restored history exclusion, unreadable-history suppression, explicit preview, and keyboard focus returning to the topic-focus action. Native Windows verification remains open; no update to the broader coaching scope is claimed.

## Reviewed complexity tutor action — 27 November 2026

The optional Tutor now offers **Analyze time and space complexity**. It requires a nonempty code excerpt, and code remains unchecked by default. The user must select it, review the exact bounded request and choose Send before anything leaves the device. The provider guidance asks for an input-size definition, evidence for loops/recursion/data structures, separate time and auxiliary-space estimates, explicit assumptions and unknowns, citations, and no fabricated benchmark claims. The response remains labeled unverified and cannot edit or run code. Existing offline Practice and lessons continue to work without an AI provider.

Targeted macOS checks passed: 27 explanation context/provider/renderer tests, the offline browser journey for action gating and explicit excerpt selection, type checking and production build. No provider call or model-quality claim was made. Native Windows verification was not run. Phase 8 still lacks broader offline complexity lessons and adaptive coaching beyond its documented current scope.
