# Final measured performance gate — 14 November 2026

Control: ordinary production build of `38cf7ff333d02be298a71c4b5315d317d57157c6`. Candidate production source first committed at `62b41407443c10a0f1d63649b8340e07734a7d0c`. Later observer/workflow commits do not change its production tree `374fea171ef92bf6a7a7e0045e0bd5816f631c17`. Both platforms independently produced baseline main SHA256 `93a8b5523236a9f4bd88833347d9cf26feec1236fadabcba3f6f2103c12921b6` and candidate `20541e080b94762f6b6215ebe32d890a9fc7e99a741d4faaa274f66b7ce9f265`; the n=20 control hashes match the n=3 workflows.

These are genuine hosted production-build measurements, not the user's installed app. macOS: Apple-silicon `macos-15`, macOS 15.8.2 / Darwin 24.6.0, image 20261104.0514.1, allocated 7 GiB RAM. Windows: x64 `windows-2025`, Server 2025 build 26100, image 20261103.298.1, about 16 GiB RAM. Node 24.22.2; Electron 45.2.3. Windows application tests used installed MinGW GCC/G++15.2.0. The separate three-host compiler experiment used Windows Server 2022 image 20261112.366.7 and GCC 14.2.0. These are not interchangeable test environments. Local non-GUI verification used the existing macOS 27.2.1 arm64 environment and Node 26.11.1.

## Startup investigation, not a speed-up claim

Three workflow trials gave an apparent Mac fresh median 783.00→948.15 ms (+21%), including a 3036.21 ms baseline outlier. Their median paired difference was only+18.65 ms. Twenty balanced pairs were therefore run independently on each platform, alternating which build starts first. All 160 app launches exited normally. Every attempted sample, including the 3444.88 ms Mac baseline maximum, remains in the receipts. OS caches were retained; “fresh” means a new process/profile, not an OS-cache-cold launch. Warm means a new process reusing that same profile, not startup after a coding session.

| Platform / n=20 workload | Baseline → candidate median | Difference | Change | Median paired difference | Baseline / candidate range |
| --- | ---: | ---: | ---: | ---: | --- |
| macOS, fresh process | 931.13 → 892.50 ms | -38.63 ms | -4.15% | -42.19 ms | 615.39–3,444.88 / 730.73–1,351.82 ms |
| macOS, same-profile warm process | 890.89 → 945.29 ms | +54.40 ms | +6.11% | +30.70 ms | 664.73–1,316.79 / 699.29–1,279.61 ms |
| Windows, fresh process | 602.08 → 550.13 ms | -51.95 ms | -8.63% | -52.04 ms | 400.64–1,588.27 / 416.44–643.62 ms |
| Windows, same-profile warm process | 404.61 → 411.72 ms | +7.10 ms | +1.76% | +5.09 ms | 391.26–458.70 / 394.44–466.28 ms |

The original 21% fresh-start difference was not reproduced. **The Mac warm median remains 54.40 ms (+6.11%) worse, with median paired+30.70 ms.** Ranges overlap substantially. Source causality is unestablished; do not erase this result or claim universal faster startup. The earlier after-coding code-cache trade-off is a different protocol and is not re-proved here. No further code-cache, GPU or editor changes were made to chase noisy timings.

## Interleaved ordinary workflows, n=3 per build

Same individual VM and locked dependencies for each pair, 1000-file workspace, ten tabs,7000-line diff, four approved C test cases and a 60-second final-trial coding soak. Same unmodified renderer assets, security boundaries and compiler deadlines. The fresh base hash check runs only on requested saves, with existing 2 MiB source /16 MiB notebook bounds. It adds a bounded read/hash; large-save peak cost was not independently profiled. No new runtime dependency, worker, service, polling or permanent cache was introduced. Tracing is dormant without its internal explicit sink.

### macOS: footprint and summed RSS remain separate

| Measurement | Baseline median | Candidate median | Difference | Change | Baseline / candidate ranges |
| --- | ---: | ---: | ---: | ---: | --- |
| Welcome footprint (MiB) | 127.95 | 125.20 | -2.75 | -2.15% | 124.93–129.04 / 122.48–128.78 |
| Welcome summed RSS (MiB) | 377.64 | 372.59 | -5.05 | -1.34% | 370.08–383.09 / 370.09–373.39 |
| One C file footprint (MiB) | 194.11 | 189.45 | -4.66 | -2.40% | 187.06–195.79 / 184.37–189.96 |
| One C file summed RSS (MiB) | 469.17 | 461.77 | -7.41 | -1.58% | 463.62–473.94 / 461.61–468.66 |
| Ten tabs footprint (MiB) | 196.36 | 198.64 | +2.28 | +1.16% | 195.14–204.48 / 195.62–198.79 |
| Medium workspace footprint (MiB) | 215.23 | 213.71 | -1.52 | -0.70% | 210.57–219.45 / 213.04–214.61 |
| Git repeatedly closed footprint (MiB) | 272.48 | 268.90 | -3.58 | -1.31% | 269.48–294.08 / 268.86–279.65 |
| One-file short-window CPU (% of one core) | 1.38 | 1.85 | +0.48 | +34.55% | 1.05–2.72 / 1.15–2.58 |
| First file opens (ms) | 512.63 | 413.64 | -98.98 | -19.31% | 454.14–951.68 / 398.99–437.36 |
| Typing proxy (ms) | 46.60 | 24.60 | -22.00 | -47.21% | 29.60–62.60 / 24.30–33.20 |
| Scroll-to-content proxy (ms) | 33.75 | 40.24 | +6.48 | +19.21% | 31.72–50.00 / 35.69–54.81 |

### Windows: working set and private bytes remain separate

| Measurement | Baseline median | Candidate median | Difference | Change | Baseline / candidate ranges |
| --- | ---: | ---: | ---: | ---: | --- |
| Welcome working set (MiB) | 302.45 | 301.02 | -1.43 | -0.47% | 299.47–305.91 / 300.34–302.04 |
| One C file working set (MiB) | 363.21 | 361.45 | -1.76 | -0.48% | 360.74–366.62 / 361.45–363.03 |
| One C file private bytes (MiB) | 187.45 | 186.27 | -1.19 | -0.63% | 185.91–190.71 / 185.01–187.76 |
| Ten tabs working set (MiB) | 381.82 | 380.14 | -1.68 | -0.44% | 378.77–385.18 / 379.97–381.80 |
| Medium workspace working set (MiB) | 391.16 | 391.38 | +0.22 | +0.06% | 389.62–394.87 / 389.30–397.23 |
| Git repeatedly closed working set (MiB) | 448.88 | 445.97 | -2.90 | -0.65% | 441.05–453.86 / 443.51–450.88 |
| One-file short-window CPU (% of one core) | 0.00 | 0.85 | +0.85 | n/a | 0.00–0.00 / 0.00–0.85 |
| First file opens (ms) | 378.12 | 384.49 | +6.38 | +1.69% | 375.96–429.83 / 380.69–410.05 |
| Typing proxy (ms) | 19.20 | 19.10 | -0.10 | -0.52% | 19.10–30.60 / 18.50–19.40 |
| Scroll-to-content proxy (ms) | 35.58 | 35.06 | -0.52 | -1.46% | 35.20–35.77 / 34.23–36.24 |

The table preserves less favorable results, including Mac scroll proxy and the short Windows CPU window. Three trials do not establish p 95/p 99 input latency, causal speed gains or leak absence. The typing measure is a synthetic key event to a second animation callback; scrolling/tab measures observe content, not physical screen presentation. Median tab-switch proxy was Mac 72.79→75.32 ms and Windows 61.06→62.68 ms. Short CPU samples use a fraction of one logical core and omit processes that exit between probes. Windows zero readings reflect counter resolution and the chosen window, not proof of zero CPU activity. A separate settled Windows 3-second one-file sample measured 0.445→0.450% of one core.

No persistent RAM optimization is established. Mac one-file ranges overlap; Windows one-file working set is effectively flat. Small positive ten-tab/medium-project differences remain in the numeric data. There is no justification here for changing frameworks or disabling GPU acceleration.

## Terminal and optional-resource measurements

Both terminal builds run the same workload; the historical `--mode baseline` alone skipped shell work and must not be used as a matched terminal control. Use `--matched-terminal-workload`. Baseline and candidate each complete three trials, two concurrent shells, hiding without termination, explicit close and three create/close cycles per trial. Observed native shell/helper counts return to zero after explicit close. Main exit is checked separately; independent complete-family cleanup is exercised by the native shutdown fixtures.

| macOS terminal state, n=3 | Baseline footprint / RSS | Candidate footprint / RSS |
| --- | ---: | ---: |
| Editor, no shell | 176.93 / 456.66 MiB | 177.73 / 458.44 MiB |
| One shell | 184.90 / 472.25 MiB | 185.75 / 472.78 MiB |
| Two shells | 172.89 / 473.97 MiB | 171.19 / 474.48 MiB |
| Panel hidden, shells kept | 175.06 / 475.25 MiB | 174.96 / 475.44 MiB |
| Explicitly closed | 172.63 / 470.66 MiB | 172.21 / 470.86 MiB |
| After three create/close cycles | 180.39 / 477.30 MiB | 178.88 / 477.27 MiB |

These after-close snapshots cannot establish the absence of a long-term leak; allocator caches need not return to launch memory. They show bounded short-workload behavior, not a four-hour soak. Windows' separate ordinary benchmark includes the additional modules below; “running” includes the user's waiting program process, not only editor overhead.

| Windows standalone n=3 state | Baseline working set / private | Candidate working set / private |
| --- | ---: | ---: |
| Welcome | 300.99 / 137.64 MiB | 301.25 / 137.27 MiB |
| One C file | 359.67 / 186.35 MiB | 359.82 / 185.21 MiB |
| Ten tabs | 368.34 / 191.17 MiB | 370.17 / 192.98 MiB |
| Medium project | 384.41 / 209.55 MiB | 385.20 / 209.82 MiB |
| PDF open | 437.92 / 241.10 MiB | 436.07 / 239.72 MiB |
| Waiting user program | 477.83 / 254.54 MiB | 476.49 / 255.41 MiB |
| Terminal open | 415.95 / 218.96 MiB | 412.61 / 217.90 MiB |
| Terminal closed | 395.83 / 213.49 MiB | 393.39 / 210.89 MiB |

### One-file resource ownership

Mac columns are footprint / summed RSS; Windows columns are working set / private bytes. Medians of individual roles need not sum exactly to a median total.

| Platform / one-file role | Baseline median | Candidate median |
| --- | ---: | ---: |
| macOS / main | 53.83 / 164.34 MiB | 54.49 / 164.66 MiB |
| macOS / gpu-process | 43.25 / 79.52 MiB | 40.56 / 72.23 MiB |
| macOS / utility | 7.08 / 36.58 MiB | 7.13 / 36.64 MiB |
| macOS / renderer | 87.46 / 189.12 MiB | 87.08 / 188.66 MiB |
| Windows / main | 109.44 / 76.62 MiB | 109.49 / 76.75 MiB |
| Windows / utility | 44.56 / 10.81 MiB | 44.52 / 10.79 MiB |
| Windows / gpu-process | 66.04 / 17.71 MiB | 66.29 / 17.73 MiB |
| Windows / renderer | 143.22 / 82.64 MiB | 141.07 / 80.32 MiB |

## Evidence and limits

[Final n=3 and terminal run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43609270122) · [Balanced n=20 startup run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43610901658) · [Machine-readable medians, ranges, paired differences and build hashes](sanitized-results/final-measurements.json).

The earlier failed/partial cohorts remain preserved. No continuous peak tracing, VRAM utilization, physical typing/display latency, battery test, physical 8 GiB college laptop, final-build 20/120/300-second churn protocol, or four-hour session is claimed. A 7 GiB hosted Mac VM is useful constrained-memory evidence, not an 8 GiB physical-hardware certification. The user's installed Mac app/live profile were not measured or modified. The local macOS 27 development registration-crash conditions remain uncharacterized; successful hosted macOS 15 runs do not establish their resolution.
