# Phase 8 — Offline practice guidance

Practice → Progress now suggests one next challenge. It first offers an unfinished submission or an existing attempt without a submission. Otherwise, it suggests a new challenge, favoring a relevant manageable topic when local records support it. Imported-only verdicts do not personalize the suggestion. Incomplete progress suppresses it. The recommendation uses the existing on-demand ledger scan and adds no background work or tracking data.

**View challenge** opens the existing preview. The user chooses a language and starts or resumes explicitly. Returning to Progress restores focus and uses the same summary. The suggestion explains which saved evidence informed it.

Seventeen focused backend tests and four offline headless journeys passed on macOS ARM64. The production Electron journey reopened saved progress, opened the suggested challenge and returned to the summary offline. Native Windows verification for the recommendation remains open.

## Binary search walkthrough

Practice → Browse includes an offline lesson that steps through binary search on a sorted example. Learners can choose a target that exists or one that does not, compare low, mid and high, and replay each eliminated range. Previous, next and reset support keyboard use. The walkthrough loads only when opened and sends no requests to the main process.

The headless Chromium check verified the lazy chunk, both search outcomes, transitions, controls, complexity assumptions and returning keyboard focus to the entry. The production Electron journey also followed the found case on macOS ARM64. The walkthrough uses a fixed example without executing or persisting learner code.

It also gives an offline analysis for `n` already sorted values: O(log n) comparisons because each step halves the candidate range, and O(1) auxiliary space for this iterative implementation, excluding storage for the input. It labels these as analytical bounds, not measured timings.

## Breadth-first search walkthrough

Practice → Browse also includes a lazy-loaded, offline BFS walkthrough over a small directed adjacency-list graph. Learners can choose a start node and step backward or forward through the first-in, first-out queue, discovered nodes, processed nodes and traversal-tree edges. The example marks nodes as discovered when enqueued, showing why F is not enqueued twice when both C and E lead to it. It covers a reachable subgraph and isolated start cases without running learner code or making network requests.

The walkthrough explains O(V + E) time and O(V) auxiliary space under the adjacency-list assumption; these are analytical bounds, not measured timings. A focused offline headless-browser check verified queue order, duplicate discovery, the alternate start, completion/reset, bounded controls, no extra bridge calls, lazy chunk loading, narrow viewport fit and keyboard focus return. The binary-search walkthrough regression check, type checking and production build also passed on macOS. Native Windows verification remains open.

## Depth-first search walkthrough

Practice → Browse now also offers a lazy, offline DFS walkthrough over the same directed adjacency-list graph. It steps through a last-in, first-out stack, discovered and processed nodes, and traversal-tree edges. Neighbors are pushed in reverse listed order so the first listed neighbor is visited first; nodes are marked when pushed, and the C step shows why F is not added again after E discovers it. Learners can choose A, C or F as the start, step backward or forward, reset, and return focus to the entry button. It does not run learner code or make network requests.

The lesson explains O(V + E) time and O(V) algorithm working space under the adjacency-list assumption, and clarifies that the interactive replay retains step snapshots. These are analytical bounds, not measured timings. Targeted macOS checks passed for stack order, discovery order, duplicate suppression, alternate and isolated starts, completion/reset, complexity wording, lazy loading, no extra bridge calls, 250 px viewport fit, keyboard focus return and no browser errors or external requests. The BFS regression journey, type checking and production build passed. Native Windows verification remains open.

## Local topic focus signal — 27 November 2026

Local checkpoint: `d471127` on `codex/ion-phase-6-copilot` (not pushed).

Practice → Progress can identify a topic to strengthen when at least two different catalog challenges have locally judged, current-suite wrong-answer results and no later local accepted result. It links back to one of those challenges for review or another attempt. A later accepted result clears that challenge's unresolved signal. Imported/restored results and mismatched suite versions do not count. If progress contains unreadable records, Ion withholds the focus signal rather than drawing a conclusion from incomplete evidence.

This is a deterministic practice hint, not a skill score. It reads only the same on-demand metadata and local verdict ledgers as Progress; it stores no extra profile data and reads no source. The UI states which evidence triggered the suggestion.

The local macOS ARM64 increment passed type checking, production build, seven focused progress tests, 11 practice progress/submission tests, the offline headless Practice renderer journey and the production Electron Practice journey. The tests cover distinct-challenge counting, later acceptance, restored history exclusion, unreadable-history suppression, explicit preview, and keyboard focus returning to the topic-focus action. Native Windows verification remains open; no update to the broader coaching scope is claimed.

## Reviewed complexity tutor action — 27 November 2026

The optional Tutor now offers **Analyze time and space complexity**. It requires a nonempty code excerpt, and code remains unchecked by default. The user must select it, review the exact bounded request and choose Send before anything leaves the device. The provider guidance asks for an input-size definition, evidence for loops/recursion/data structures, separate time and auxiliary-space estimates, explicit assumptions and unknowns, citations, and no fabricated benchmark claims. The response remains labeled unverified and cannot edit or run code. Existing offline Practice and lessons continue to work without an AI provider.

Targeted macOS checks passed: 27 explanation context/provider/renderer tests, the offline browser journey for action gating and explicit excerpt selection, type checking and production build. No provider call or model-quality claim was made. Native Windows verification was not run. Phase 8 still lacks broader offline complexity lessons and adaptive coaching beyond its documented current scope.
