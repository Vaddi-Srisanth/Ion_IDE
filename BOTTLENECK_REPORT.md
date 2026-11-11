# Ion IDE bottleneck report

## Stabilization follow-up

The follow-up changed the Git execution boundary, index publication and test cleanup. It preserves the existing renderer and Monaco architecture. Seven alternating startup pairs measured fresh medians of 330.2 → 328.3 ms and warm medians of 335.8 → 338.0 ms. This recheck did not reproduce the earlier slower sequential launch group. The configuration snapshot added a measured 7.1 ms to median Git refresh in the three-trial workload. No permanent service was introduced. [Measurements and commands](PERFORMANCE.md#stabilization-from-9adcdea)

Two natural five-minute runs kept live heap and DOM counts stable after 20 mixed cycles. RSS recovered from 596.8 to 492.4 MiB in the checkpoint and 613.9 to 504.2 MiB in the stabilized build. The stabilized five-minute renderer footprint was 25.2 MiB higher. In a separate matched diagnostic collection, renderer heap and whole-tree memory were lower in the candidate. These observations leave native allocation ownership open and do not justify forcing production collection, discarding undo, or replacing the editor. The raw reports preserve the larger temporary RSS values and the incomplete model-view assertion pilot.

Repeated shutdown verified real program and shell descendants, drafts and active suites. The old eight-second report could hide a workload failure when an open modal declined quit. The exact historical primary error remains unavailable. The harness now retains the actual process handle and captures prevented close events and active resource types. Git writes now retain their cancellation owner, and private index publication protects the real lock during a killed filter. [Shutdown fixture](scripts/test-shutdown-stability.mjs) · [Index transaction](src/main/source-control/index-transaction.ts)

## Measurement protocol

The preserved 0.9.5 baseline and 0.9.6 pre-hardening build ran production Electron and Monaco on Apple M3, 24 GiB RAM, macOS 27.2.1. Both runs used offline disposable Minimal Mode profiles and hidden 1260 × 790 windows at 2× scale. The input benchmark verifies a changed model viewport or observable UI state before sampling the next Chromium animation callback. It measures software scheduling and rendering readiness. Physical keyboard-to-display latency, native presented frames, GPU utilization and battery energy were outside this experiment.

Timing and diagnostic passes ran separately. Timing used 80 observations for typing and Backspace and 20 for each other action. Separate traced passes marked 80 actions per build and captured renderer event dispatch, function calls, style, layout, paint, and 28,416 → 28,310 V8 CPU samples. Production stacks include minified function names. Source owners below come from the traced asset and the application entry point. The trace measures overlapping renderer work and cannot attribute OS scheduling, compiler time, or all worker CPU to an individual UI event. Heap snapshots are point samples rather than allocation peaks.

```sh
ION_SHOW_TEST_WINDOWS=0 node scripts/profile-editor-interactions.mjs \
  --baseline /path/to/preserved/dist --candidate dist \
  --out performance-results/editor-interactions
```

Raw inputs, percentile calculations, model and frame markers, heap samples, traces, and CPU profiles are stored under `performance-results/editor-interactions/`. Build hashes are in `result.json`. [Profiler](scripts/profile-editor-interactions.mjs) · [Platform and resource measurements](PERFORMANCE.md#git-and-saved-run-tests)

## Editor actions ranked by measured candidate p95

All durations are milliseconds. Before and after use the same workload. The last column comes from the separate diagnostic pass. With 20 observations, p99 is close to the observed maximum and is a limited estimate of tail behavior.

| Operation and source owner | Before median / p95 | After median / p95 / p99 / max | Longest traced renderer task |
| --- | ---: | ---: | ---: |
| Workspace search via [WorkspaceSearch](src/renderer/WorkspaceSearch.tsx), `searchWorkspaceText` | 239.2 / 240.5 | 238.8 / 240.3 / 241.0 / 241.0 | 3.69 |
| Continuous typing in [MonacoSurface](src/renderer/MonacoSurface.tsx) | 46.8 / 48.7 | 46.5 / 48.7 / 49.8 / 49.8 | 4.53 |
| Repeated Backspace in the same source | 43.5 / 48.7 | 47.0 / 48.6 / 49.1 / 49.1 | 3.86 |
| Open a source through [Explorer](src/renderer/Explorer.tsx) and `Documents.open` | 47.5 / 48.4 | 47.8 / 48.2 / 48.8 / 48.8 | 3.59 |
| Close a source and restore the previous editor view | 47.3 / 48.3 | 47.4 / 48.0 / 48.5 / 48.5 | 4.92 |
| Switch between opened source tabs | 46.8 / 47.7 | 47.1 / 47.9 / 48.0 / 48.0 | 6.01 |
| Undo one source edit | 46.4 / 47.1 | 46.3 / 47.3 / 47.4 / 47.4 | 2.95 |
| Replace All across 1,200 tokens through Monaco Find | 46.4 / 48.1 | 45.7 / 46.5 / 46.9 / 46.9 | 10.51 |
| Wheel input on a long source | 33.0 / 33.3 | 33.2 / 33.3 / 33.3 / 33.3 | 5.17 |
| Paste 100 lines through the editor clipboard handler | 27.5 / 28.7 | 27.7 / 28.5 / 28.6 / 28.6 | 4.83 |
| Select the entire source model | 26.8 / 27.6 | 27.1 / 27.9 / 28.8 / 28.8 | 5.03 |
| Find 1,200 occurrences in Monaco | 25.7 / 27.0 | 25.4 / 27.2 / 31.1 / 31.1 | 6.47 |
| Redo a reverted operation | 25.6 / 26.1 | 26.0 / 26.7 / 27.1 / 27.1 | 2.43 |
| Paste 5,000 lines through the editor clipboard handler | 25.3 / 26.3 | 25.4 / 26.4 / 26.6 / 26.6 | 7.46 |

Neither trace had a renderer task longer than 50 ms during a measured action. Over the full interaction workloads, main / GPU / renderer CPU time was **3.89 / 3.60 / 15.59 s → 3.80 / 3.54 / 15.63 s**. Monaco's own markers measured median key handler **0.035 → 0.046 ms**, input processing **0.530 → 0.610 ms**, render **0.721 → 0.762 ms**, and total **11.66 → 13.05 ms**. Its native renderer total p95 was **16.69 → 16.68 ms**. There were 15 such matched samples per build. The extra delay in the table includes the observation and frame boundary. These results do not justify replacing the editor input path.

## Findings and priorities

| Cost and frequency | Trace or measurement | Mechanism and action |
| --- | --- | --- |
| Workspace search runs on each settled query while the search dialog is open | About 239 ms median with a 3.69 ms maximum renderer task | The renderer waits 160 ms for typing to settle before invoking asynchronous ripgrep. Keep cancellation and debounce. A shorter delay would trade responsiveness for more scans. Measure on large projects before changing it. [Debounce](src/renderer/WorkspaceSearch.tsx) · [Process ownership](src/main/workspace-search.ts) |
| Replace All and large paste happen on explicit edits | Replace All peaked at a 10.51 ms renderer task. Large paste peaked at 7.46 ms. Diagnostic paste heap points were 25.6 → 37.5 MiB in the candidate and 25.8 → 37.4 MiB in the baseline | Monaco trace stacks include tokenization, piece-tree edits, and decorations. The samples do not establish duplicate work or retained per-operation bytes. Preserve undo and defer changes until a larger or more representative file reproduces a stall. [Editor surface](src/renderer/MonacoSurface.tsx) |
| Large Git diff opens on demand | 1,459 ms to usable change navigation for 7,000 lines. The process tree moved from 576.8 MiB RSS with status to 609.7 MiB with the diff | Git reads bounded original and changed versions. Monaco creates two read-only models and limits diff computation to one second. They dispose on close. The measured wall duration is material. Profile the diff worker and model allocation before changing the algorithm. [Diff fetch](src/main/source-control/index.ts) · [Model lifecycle](src/renderer/source-control/SourceControlDiffView.tsx) |
| Git status runs on open, manual refresh, and targeted saves while visible | 838 ms first panel load and 75 ms manual refresh in the pre-hardening build | Cold load includes renderer and service imports, tool discovery, and the initial status scan. No periodic status scan ran. Retain the on-demand approach. [Panel](src/renderer/source-control/SourceControlPanel.tsx) · [Command adapter](src/main/source-control/repository.ts) |
| C suite runs on explicit selection | 4,038 ms for four cases with an intentional 3,600 ms program wait. The process tree sampled 0.55% CPU while a real program was waiting | The shared adapter batches adjacent compatible cases and compiles their source once. The remainder includes compilation, disk checks, other cases and result rendering. Keep the timeout and cancellation checks. [Suite adapter](src/main/projects/suite.ts) · [Runner](src/main/runner.ts) |
| Repeated editing and optional dialogs | 602 → 703 MiB summed RSS in 46 mixed cycles over 90 seconds. Renderer RSS moved 271 → 367 MiB and attributed memory 145 → 194 MiB | Native RSS includes allocator and DOM retention. GPU helper footprint fell over the same period. This is a measurable release risk, with lifetime and allocation source still under investigation. [Reproducer](scripts/benchmark-development-workflows.mjs) |

The interaction workload sampled renderer RSS **401.0 → 414.7 MiB** one second after activity and tree RSS **732.3 → 750.5 MiB**. It includes repeated large pastes and editor opens. With one paired interaction run, the endpoint does not identify a retained object or establish a leak. See the [engineering issue register](ENGINEERING_AUDIT.md#issue-register) for durability, security, and UX priorities.

## Renderer residency isolation

Six fresh production sessions used the same 1,000-file fixture and 12 cycles. Each did the same edit and tab actions, with different optional operations added. A 1.2-second normal settle preceded a diagnostic collection. The GC was requested through DevTools only for attribution. Production uses Chromium's normal collection policy.

| Mode | Tree RSS before / settled / post-GC, MiB | Renderer footprint before / settled / post-GC, MiB |
| --- | ---: | ---: |
| 0.9.5 editor | 555.6 / 627.0 / 575.0 | 107.6 / 168.4 / 106.8 |
| 0.9.6 editor | 551.0 / 617.5 / 566.3 | 103.5 / 159.5 / 107.5 |
| 0.9.6 Git panel | 557.9 / 633.9 / 577.6 | 109.3 / 171.8 / 110.2 |
| 0.9.6 test dialog without running | 558.0 / 658.2 / 587.3 | 109.5 / 193.2 / 112.8 |
| 0.9.6 saved tests | 561.3 / 604.2 / 568.0 | 107.3 / 148.1 / 107.2 |
| 0.9.6 mixed | 564.8 / 633.7 / 581.3 | 108.8 / 169.6 / 112.7 |

After collection, DOM counts returned exactly to the initial values in all six sessions and JavaScript event-listener counts returned or decreased. Renderer footprint was within 4 MiB of its starting point, and V8 heap retained an additional 1.5–2.0 MiB. No native child remained. Large short-term allocation already occurs in the original editor. The dialog-only sequence had the largest transient RSS rise in this run. The mixed sequence was close to baseline editing. Longer ordinary GC and memory-pressure behavior remain open. Avoid changing disposal or forcing collection based on this experiment alone.

```sh
ION_SHOW_TEST_WINDOWS=0 node scripts/diagnose-development-soak.mjs \
  --target dist --baseline /path/to/preserved/dist \
  --cycles 12 --pace-ms 850 --settle-ms 1200
```

Raw evidence is under `performance-results/git-tests/audit/development-soak-isolation.json`. [Isolation harness](scripts/diagnose-development-soak.mjs)

## Matched workspace compositor probe

The same 650-line C file opened standalone and from its workspace. The window, Explorer visibility, theme, 2× scale, and 976 × 658 editor viewport matched. Two short trials per route used alternating order. One long trial per route included 120 seconds. Sampling started when the real editor source became available.

| Checkpoint | Standalone GPU helper, attributed MiB | Workspace GPU helper, attributed MiB |
| --- | ---: | ---: |
| Immediately, range across three launches | 182.6–185.4 | 183.3–183.3 |
| 1 s, range | 182.5–185.3 | 89.2–183.3 |
| 5 s, range | 69.9–70.2 | 37.8–38.6 |
| 30 s, range | 37.7–38.1 | 37.8–38.6 |
| 120 s, one launch each | 36.7 | 36.8 |

The long runs finished with **142.7 versus 146.3 MiB** of attributed whole-tree memory and **497.5 versus 498.3 MiB** summed RSS. Chromium reported 8 layers and 3 drawing layers for standalone versus 9 and 2 for workspace. Both had a 2520 × 1580 drawing surface. The hidden-window series reproduced temporary GPU allocations in both routes. It did not reproduce a sustained 130 MiB route difference. Actual GPU hardware allocations, visible windows, and native fullscreen remain independent measurements. [Probe](scripts/benchmark-workspace-gpu.mjs)

```sh
ION_SHOW_TEST_WINDOWS=0 node scripts/benchmark-workspace-gpu.mjs --trials 2 --checkpoints 0,1,5,30
ION_SHOW_TEST_WINDOWS=0 node scripts/benchmark-workspace-gpu.mjs --trials 1
```

The separate raw outputs are `performance-results/git-tests/workspace-gpu-short.json` and `workspace-gpu-120.json` in that directory.

## Remaining measurements

The Windows runner must independently measure working set and private bytes. Physical Windows laptop tests, native scaling and assistive-technology verification, visible and fullscreen compositor tracing, and a four-hour soak remain separate gates. GPU and optional-workflow isolation reports use the same disposable profiles. Debugger latency cannot be measured until a debugger is integrated.
