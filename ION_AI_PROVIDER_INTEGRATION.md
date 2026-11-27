# Contextual explanations — implemented feature candidate

Source milestones E/F are committed at `ceb6b63` / `5489a3c`, on the authorized feature branch only. Native full regressions pass at5489a3c; the new E/F fixture exposed an accessible-field defect corrected at1432c8a. Native end-to-end/resource verification now passes on Mac/Windows at8c0ae1b, run43702977386. No live AI provider was called and no user AI credential was accessed; tests use synthetic AI credentials. Synthetic transport tests verify integration and permission boundaries, not provider connectivity or teaching quality.

## User flow

Learn offers Hint, Concept, Debug, Walkthrough, Review Attempt and Quiz. Project Lens offers Understand, Architecture, Health, Teach Project, Next Steps and Ask Codebase. These are explicitly requested remote explanations. Normal coding, execution, diagnostics, lessons, plans and practice remain offline without an API key. Minimal Mode disables these optional AI entry points.

All context inclusion starts unchecked. Users choose a question and optional current lesson, active unsaved code prefix, supplied diagnostic, bounded offline structure or up to four selected files from the current Lens snapshot. Review displays the exact outbound source text, labels, revisions, line ranges, provider/model, total body bytes and exclusions. Only Send submits the reviewed, expiring one-use payload, after native confirmation. No automatic project scan/upload or background AI request.

## Reused infrastructure and limits

The existing planner provider/vault is shared through a lazy factory, preserving `planning-provider-v1.json` and OS-backed Electron safeStorage. Key configuration is optional. Password input stays outside React state and clears before the asynchronous vault write. No credential is included in an export, source artifact or response log. Linux still requires an available secure storage backend.

The OpenAI-compatible chat endpoint must use HTTPS port443, no URL credentials and no redirects. Body construction is bounded to eight sources,8KiB/source,32KiB total context and a2KiB question; selected files are at most2MiB and only their bounded prefix is read. Responses are at most160KiB with a45s cancellation deadline and strict schema/citation/dependency checks. Arbitrary provider response bodies are not shown on errors. The configured endpoint is user-chosen, not a claim that every provider/model is compatible.

Main-process capability tokens bind the exact payload, workspace/panel owner, source revisions and provider configuration. Review performs no HTTP/decryption. Send revalidates before/after approval and before returning. Source, pane, selection or provider changes revoke work. Cancellation and shutdown await actual pending-operation cleanup; a canceled operation cannot open an overlapping request queue. No polling, permanent worker/process, embedding database or added runtime dependency.

## Output and roadmap boundary

Answers distinguish observed, inferred, unknown and suggested content. Exact returned citation IDs/ranges are validated against private current evidence; opening a citation reuses existing source navigation or shows the explicitly supplied excerpt. Model text never grants a filesystem permission. AI prose can still be wrong and source text can contain prompt injection: review and labels are defenses, not proof of model correctness.

Project suggestions are optional, unselected by default and editable in a separate review. Saving uses the existing Projects model, expected-revision conflict guard and schema validation. New milestones start Not Started; existing manual statuses, tests, approvals and verified evidence remain intact. Dependency closure is explicit. Suggestions never approve/run tests, execute commands, edit source or become proof of completion. Reload after a conflict preserves proposal edits.

## Verification boundary

Full local suite:370total,344passed,26explicit platform/tool skips,0failed; typecheck and production build pass. Context/provider/session tests use real disposable files and a synthetic HTTPS implementation; renderer tests use actual compiled React/Monaco with a test bridge. Native UI/preload/IPC/provider-vault and roadmap persistence tests pass on both disposable CI profiles:13checks/platform,20repeated review/send/close cycles, cancellation and held-request shutdown. Both runners used real OS-backed safeStorage for synthetic credentials. SafeStorage fallback in the native fixture is clearly labeled synthetic if runner crypto is unavailable; that fallback is test-only and is not an OS secure-storage pass.

Live provider interoperability, model answer usefulness, a human learning pilot and long-session resource behavior remain unverified. Repeated-cycle native resource measurements and20/60s natural recovery are recorded; they are short workload evidence, not an indefinite no-leak guarantee. See [security](ION_PROJECT_LENS_SECURITY.md), [test results](ION_TEST_RESULTS.md) and [performance](ION_PERFORMANCE_COMPARISON.md).
