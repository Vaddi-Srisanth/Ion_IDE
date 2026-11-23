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

## Core backup acceptance budget

The exact current candidate has no native backup resource result because the last approved jobs failed before the resource lane. The focused workflow is already designed to compare the exact candidate to `d67613a` using production builds and disposable profiles.

Acceptance requires:

- backup UI closed: no backup service import, operation, timer, worker, file handle, or continuing CPU attributable to backup;
- backup UI open: bounded renderer/main delta and zero work after close;
- common profile backup/restore: streamed operation with bounded peak memory, cancellable progress, no abandoned staging or handles;
- startup: only the minimal pending-restore check, with measured delta;
- repeated operations: no monotonic process-tree growth or orphaned children;
- exact source identity recorded for candidate and baseline.

## Investigation order

1. Finish the exact Core native gate; do not optimize against incomplete samples.
2. Trace first-file latency into IPC read/validation, recovery/conflict checks, model creation, React commit, Monaco layout, and graphics allocation.
3. Trace warm macOS startup regression before changing cache policy.
4. Measure tab-switch input-to-paint and React/Monaco work; optimize only the confirmed dominant stage.
5. Add 50-tab, large-repository, energy, and four-hour coverage.
6. Measure each future language server/debugger/AI process as a separate optional budget.

## Evidence limitations

No physical 8 GB hardware, current-branch packaged endurance, energy trace, visible frame pacing, debugger, universal language service, or AI runtime measurement is currently available. Hosted runner results are useful regression evidence but are not consumer-hardware promises.
