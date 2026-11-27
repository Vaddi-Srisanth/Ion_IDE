# Phase 8 — Offline practice guidance

Practice → Progress now suggests one next challenge. It first offers an unfinished submission or an existing attempt without a submission. Otherwise, it suggests a new challenge, favoring a relevant manageable topic when local records support it. Imported-only verdicts do not personalize the suggestion. Incomplete progress suppresses it. The recommendation uses the existing on-demand ledger scan and adds no background work or tracking data.

**View challenge** opens the existing preview. The user chooses a language and starts or resumes explicitly. Returning to Progress restores focus and uses the same summary. The suggestion explains which saved evidence informed it.

Seventeen focused backend tests and four offline headless journeys passed on macOS ARM64. The production Electron journey reopened saved progress, opened the suggested challenge and returned to the summary offline. Native Windows verification for the recommendation remains open.

## Binary search walkthrough

Practice → Browse includes an offline lesson that steps through binary search on a sorted example. Learners can choose a target that exists or one that does not, compare low, mid and high, and replay each eliminated range. Previous, next and reset support keyboard use. The walkthrough loads only when opened and sends no requests to the main process.

The headless Chromium check verified the lazy chunk, both search outcomes, transitions, controls and returning keyboard focus to the entry. The production Electron journey also followed the found case on macOS ARM64. The walkthrough uses a fixed example without executing or persisting learner code.

## Local topic focus signal — 27 November 2026

Practice → Progress can identify a topic to strengthen when at least two different catalog challenges have locally judged, current-suite wrong-answer results and no later local accepted result. It links back to one of those challenges for review or another attempt. A later accepted result clears that challenge's unresolved signal. Imported/restored results and mismatched suite versions do not count. If progress contains unreadable records, Ion withholds the focus signal rather than drawing a conclusion from incomplete evidence.

This is a deterministic practice hint, not a skill score. It reads only the same on-demand metadata and local verdict ledgers as Progress; it stores no extra profile data and reads no source. The UI states which evidence triggered the suggestion.

The local macOS ARM64 increment passed type checking, production build, seven focused progress tests, 11 practice progress/submission tests, the offline headless Practice renderer journey and the production Electron Practice journey. The tests cover distinct-challenge counting, later acceptance, restored history exclusion, unreadable-history suppression, explicit preview, and keyboard focus returning to the topic-focus action. Native Windows verification remains open; no update to the broader coaching scope is claimed.
