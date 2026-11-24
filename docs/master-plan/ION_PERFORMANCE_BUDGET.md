# Ion performance budget

## Measurement contract

Performance claims require an immutable source SHA, production build, platform/hardware details, OS build, power state, display scale, tool versions, profile state, project fixture, warmup, sample count, and raw artifact. Failed and slow samples remain in the data.

Report per-process and total process-tree values separately. On macOS, report attributed footprint and summed RSS; on Windows, working set and private bytes. Shared memory can make sums differ from OS-attributed totals. Neither is relabeled as “RAM usage” without its definition.

For latency, report median and p95; report p99 only with enough samples. Startup is app request to usable workbench. File open is user request to visible, interactive content. Typing measures input-to-paint or an explicitly labeled proxy. Idle starts only after a documented settle window.

## Provisional budgets

These are engineering gates, not promises. A missed target triggers investigation; safety is not removed to make a number green.

| Metric | Target | Regression gate |
| --- | ---: | ---: |
| Cold startup on reference hardware | < 1,000 ms | > 10% and > 50 ms slower than matched baseline |
| Warm startup | < 500 ms where feasible | > 10% and > 30 ms slower |
| First ordinary source file | < 300 ms | > 10% and > 20 ms slower |
| Typical tab switch | < 50 ms | > 15% and > 8 ms slower |
| Typing input p95 | no perceptible delay; target < 16.7 ms | > 4 ms regression or missed frames established by trace |
| Idle CPU after settling | near zero | sustained > 0.5% of one core without owned work |
| Idle background network | 0 bytes unless enabled/requested | any unexplained request |
| Closed terminal | no owned shell/helper | any live owned process after cleanup window |
| Closed notebook | no owned kernel | any live owned kernel after cleanup window |
| Closed semantic/debug/AI tool | no unnecessary owned process | any orphan or unexplained active process |
| Feature open/close memory | bounded and recoverable | monotonic retained growth across repeated cycles |
| Four-hour session | no unexplained sustained growth | positive trend that does not plateau/recover |

Absolute memory targets will be added only after matched measurements on reference 8 GB and 16 GB devices. Electron/Monaco fixed cost makes arbitrary marketing limits misleading.

## Current broad reference baseline

These results are historical native hosted measurements for the verified pre-Core `0.9.8` source, not the exact current Core candidate.

The installed comparison editor is Visual Studio Code `1.147.0` arm64, approximately 1.6 GiB on disk. This audit did not launch it or mutate its profile. A matched Ion/VS Code runtime comparison therefore remains pending and must use disposable profiles, equivalent extensions/features, identical visible geometry, and the same fixtures.

| Workload | macOS attributed footprint | macOS summed RSS | Windows working set | Windows private bytes |
| --- | ---: | ---: | ---: | ---: |
| Welcome | 125.20 MiB | 372.59 MiB | 301.02 MiB | not recorded |
| One C file | 189.45 MiB | 461.77 MiB | 361.45 MiB | 186.27 MiB |
| Ten source tabs | 198.64 MiB | not recorded | 380.14 MiB | not recorded |
| Medium workspace | 213.71 MiB | not recorded | 391.38 MiB | not recorded |
| Git opened then closed | 268.90 MiB | not recorded | 445.97 MiB | not recorded |

| Latency | macOS median | Windows median | Target status |
| --- | ---: | ---: | --- |
| Fresh startup | 892.50 ms | 550.13 ms | Mac/Windows historical samples meet provisional cold goal |
| Warm startup | 945.29 ms | 411.72 ms | Mac misses warm goal and regressed ~54 ms in its comparison |
| First file | 413.64 ms | 384.49 ms | Both miss provisional 300 ms goal |
| Typing proxy | 24.60 ms | 19.10 ms | Proxy, not a definitive input-to-paint trace |
| Scroll proxy | 40.24 ms | 35.06 ms | Proxy |
| Tab switch | 75.32 ms | 62.68 ms | Both miss provisional 50 ms goal |

## Mandatory workload suite

1. Welcome.
2. One ordinary C file.
3. Ten and fifty source tabs.
4. Large source file in safe edit and preview modes.
5. Medium project and large repository.
6. Terminal open, hidden, closed, and repeated create/close.
7. Git open/refresh/closed.
8. Language service cold/warm/idle/closed.
9. Debugger start/step/stop/closed.
10. Notebook open/kernel run/stop/closed.
11. PDF, DOCX, spreadsheet, CSV, and PPTX where supported.
12. Practice problem and repeated samples.
13. Backup UI closed/open, backup, restore staging, cancellation, and cleanup.
14. Repeated workspace, theme, panel, viewer, and tab lifecycle.
15. Four-hour mixed coding endurance.

## Phase 1 macOS regression investigation — 2026-11-24

The production comparison remains exact baseline `d67613a1e9b77c7d677bd304628d57c58542fa71` versus exact application candidate `c5306449445e16090c81d8396003b9885b710fd0`. The current branch changes after `c530644` are diagnostics, benchmark controls and CI environment corrections only; `src`, `package.json` and `package-lock.json` are byte-identical to `c530644`.

The initial result below was not a production regression. Its baseline build lived inside the repository checkout while the candidate build lived under the hosted runner's temporary filesystem. On hosted macOS, that asymmetric artifact placement changed filesystem/cache order and produced cold first-attempt outliers. [Corrected run 45213098671](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45213098671) copied both exact production artifacts to sibling directories under the same temporary root, alternated AB/BA order and retained every sample. The first instrumentation run and the failed `.map(resolve)` harness run remain preserved as [45210185589](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45210185589) and [45212659200](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45212659200).

| Metric, median of four attempts | macOS baseline | macOS candidate | Aggregate delta | Paired-median delta | Gate |
| --- | ---: | ---: | ---: | ---: | --- |
| Cold startup | 1,217.83 ms | 1,083.96 ms | -10.99% | -196.85 ms / -16.16% | PASS |
| Warm startup | 709.63 ms | 606.68 ms | -14.51% | -125.14 ms / -17.63% | PASS |
| First-file request to visible editor | 687.44 ms | 597.98 ms | -13.01% | -107.67 ms / -15.66% | PASS |
| Renderer click to source visible | 345.40 ms | 392.60 ms | +13.67% | +20.70 ms / +5.99% | PASS by paired gate; aggregate retained |
| One-file attributed footprint | 165.42 MiB | 166.23 MiB | +0.49% | — | PASS |
| One-file summed RSS | 446.02 MiB | 446.51 MiB | +0.11% | — | PASS |
| One-file idle CPU, one core | 1.44% | 1.42% | -0.02 pp | — | PASS |

Individual macOS cold-start samples were baseline `4281.19, 1137.10, 1200.62, 1235.04` ms and candidate `1330.81, 1145.78, 1019.81, 1022.14` ms. First-file samples were baseline `1689.38, 691.10, 570.67, 683.79` ms and candidate `611.44, 584.52, 461.90, 786.52` ms. The slow samples are retained; with four observations, the maximum is reported rather than mislabeled as a stable p95/p99 estimate.

High-resolution stage medians also contradict a production slowdown: main start to ready was 223.20 -> 171.30 ms, ready to window 221.36 -> 180.53 ms, window to loaded 374.30 -> 309.63 ms, loaded to UI-ready 137.06 -> 103.76 ms, load observation 792.99 -> 690.26 ms, CDP connection 82.56 -> 65.23 ms and the Settings-ready locator 54.15 -> 37.95 ms. The only small opposing observer stage was start observation, 256.63 -> 279.00 ms.

The candidate's pending-restore `lstat` samples were 28.52, 21.55, 14.01 and 13.21 ms. First-file open/read IPC and scoped filesystem work remained in the low single-digit milliseconds except one 10.00 ms open call. React/Monaco/paint work, not recovery or backup I/O, dominates the renderer portion. Removing safety checks could not explain or safely improve the original hundreds-of-milliseconds signal.

The corrected Windows control remained unaffected: cold startup 1,677.57 -> 1,568.97 ms (-6.47%), warm startup 1,536.48 -> 1,558.34 ms (+1.42%), first file 408.80 -> 406.23 ms (-0.63%), private bytes 177.16 -> 178.95 MiB (+1.01%) and working set 348.55 -> 346.90 MiB (-0.47%).

Instrumentation uses monotonic high-resolution timers, bounded event arrays and path-scope labels. It records no source text, file names, profile contents, environment variables or credentials. With backup closed, `backupLoaded` remained false, call/storage counters stayed at zero and no backup-owned process or polling work existed. The unused feature therefore adds no observed ongoing work.

## Historical initial Core backup measurement — `c530644`

[Run 45205283873](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45205283873) completed four serialized alternating baseline/candidate pairs on both native hosted platforms. It compared ordinary production builds of exact baseline `d67613a` and candidate `c530644`; every one of the 16 application attempts completed and left an empty owned process family.

The acceptance contract was evaluated as follows:

- backup UI closed before first use: the lazy backup chunk was not loaded and zero backup bridge calls were observed;
- backup UI open/closed: ten cycles preserved the same Monaco model, backend call/storage counters stopped changing after close, and no owned helper survived;
- common profile backup/restore: streamed operation with bounded peak memory, cancellable progress, no abandoned staging or handles;
- startup: Windows was effectively flat; macOS cold startup regressed materially and remains under investigation;
- repeated operations: no monotonic process-tree growth or orphaned children;
- exact source identity recorded for candidate and baseline.

| Metric (median, n=4 per build) | macOS baseline | macOS candidate | Windows baseline | Windows candidate |
| --- | ---: | ---: | ---: | ---: |
| Cold startup | 1,061.12 ms | **1,441.56 ms** | 1,149.27 ms | 1,152.82 ms |
| Warm startup | 760.29 ms | 758.56 ms | 1,117.77 ms | 1,147.28 ms |
| First C file | 678.52 ms | **1,401.06 ms** | 353.13 ms | 358.71 ms |
| One-file attributed footprint/private bytes | 163.95 MiB | 159.84 MiB | 179.62 MiB | 180.76 MiB |
| One-file summed RSS/working set | 445.29 MiB | 446.02 MiB | 350.02 MiB | 348.87 MiB |
| One-file CPU, percent of one core | 1.64% | 1.58% | 0.32% | 0.13% |

Candidate backup-open median was 444.72 ms on macOS and 832.51 ms on Windows. The post-cycle closed phase was bounded but, because the lazy code remains resident after first use, its memory cannot be compared to the never-loaded baseline as an idle-cost claim: macOS measured 170.85 MiB footprint / 477.39 MiB summed RSS and Windows 188.88 MiB private / 343.26 MiB working set. The meaningful unused-feature result is the ordinary one-file phase, where candidate memory was within approximately 1% of baseline and the chunk was not loaded.

The macOS cold-start delta was +380.44 ms (+35.85%) and first-file delta was +722.54 ms (+106.49%), both beyond the provisional regression gate. One candidate first-file sample was faster than baseline, but three were 1.389–1.516 seconds, so the result is not dismissed as a single outlier. No production change was made without a confirmed stage-level cause.

## Investigation order

1. Trace the candidate-only hosted macOS first-file slowdown into IPC read/validation, recovery/conflict checks, model creation, React commit, Monaco layout, and graphics allocation.
2. Separate the minimal pending-restore filesystem check from other cold-start work before changing cache policy.
3. Repeat the same four-pair protocol only after instrumentation or a justified correction; do not rerun until the result can answer a specific question.
4. Measure tab-switch input-to-paint and React/Monaco work; optimize only the confirmed dominant stage.
5. Add 50-tab, large-repository, energy, and four-hour coverage.
6. Measure each future language server/debugger/AI process as a separate optional budget.

## Evidence limitations

No physical 8 GB hardware, current-branch packaged endurance, energy trace, visible frame pacing, debugger, universal language service, or AI runtime measurement is currently available. Hosted runner results are useful regression evidence but are not consumer-hardware promises.
