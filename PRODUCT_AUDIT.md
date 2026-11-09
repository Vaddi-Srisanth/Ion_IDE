# Ion IDE product audit

## Scope and starting point

Phase 1 shipped Free Coding with a Monaco editor, local saves and C execution. The old production build and its benchmark evidence were retained. Its compiler output was raw, and Learn, Projects, and Practice were placeholder entries. The Phase 1 smoke suite verified local file and C workflows. The expanded desktop suite covers the new workspace paths separately.

## Findings by priority

| Priority | Finding | Response |
| --- | --- | --- |
| P0 | Stale staged text from an evicted model could be retained after a successful save. A later open could show the old buffer rather than newer disk contents. | Release staged text when that exact edit is saved. Keep existing revision checks and cover the eviction path with a regression test. |
| P0 | An exited C process leader could leave Electron waiting on pipes held by a detached descendant. | Bound post-exit pipe draining, keep process-group termination, and add a native fork regression test. Incomplete output cannot verify a test. Stop also cancels the whole practice batch between samples. The runner still executes with the user's permissions. |
| P1 | Compiler output gave beginners no local explanation or record of repeated problems. | Add opt-in, source-aware C diagnostic learning with confidence and original output. |
| P1 | There was no local project specification or evidence workflow. | Add versioned editable plans, explicit test review and approval, and separate manual and test-based statuses. |
| P1 | There was no practice attempt or sample workflow. | Add local problems, notes, samples, and independent C source files for attempts. |
| P1 | Closing the last tab repeatedly rebuilt the Monaco shell. | Reuse the shell while the workspace is open, dispose closed document models, and compare the result with a 30-cycle production benchmark. |
| P1 | The initial Practice implementation compiled again for each sample. | Compile once per batch. Preserve source-revision checks, isolated temporary files, separate output streams, and cancellation between cases. |
| P0 | Two instances could race writes to the same profile. | The current release acquires Electron’s per-profile single-instance lock and focuses the original window. |
| P2 | The workspace options led only to Free Coding. | Make each workspace discoverable from Welcome with a collapsible, keyboard-resizable panel. |

## Everyday-use limits

- The IDE targets single-file C workflows. Multi-file build configuration and an interactive shell or debugger are separate work.
- Revision conflicts are handled explicitly. Unsaved buffers and in-progress panel drafts are session state and can be lost if the OS kills the app. Normal close warns about unsaved changes.
- Compilation and behavioral tests can verify an observed outcome under configured inputs. Their results do not measure concept mastery or prove all application behavior.
- C binaries run with user permissions. Timeouts, bounded output, and process groups contain common mistakes. A process that deliberately detaches can outlive those controls.
- Project evidence tracks the chosen source and approved test revision. Rerun after changes to headers or other inputs outside that check. Practice uses the same limits.
- Real college-student usability and long-term use on lower-memory Macs have not been measured. See [TEST_PLAN.md](TEST_PLAN.md) for the proposed study and [PERFORMANCE.md](PERFORMANCE.md) for observed measurements.

## Evidence from this release

- The offline desktop suite exercised all four workspaces with the Chromium context set offline. It used synthetic native-dialog selections, real files, and the installed compiler. It covered project evidence becoming stale after an external source edit, reopening the local records, and clearing learning history. The usual Free Coding suite separately covers keyboard find/replace, save conflicts, resizing, and C Stop.
- A reviewed corpus contains 40 recorded Apple Clang 21.0.0 and Homebrew GCC 16.2.0 diagnostics. The classifier returned 29 correct high-confidence labels and no false high-confidence labels. It abstained on 11, including ten deliberately ambiguous or unknown cases and GCC's terse `invalid initializer` case. Coverage among the 30 cases with a reviewed specific category was 29/30. These are corpus results.
- Four human-authored reference plans passed the offline validator and rubric. Live planning results and the student study are pending. [Planning evaluation](PLANNING_EVALUATION.md)
- The first core smoke attempt hit an eight-second shutdown timeout after its assertions. The repeat, including both clean quits, passed. The cause of that single timeout was not reproduced.
