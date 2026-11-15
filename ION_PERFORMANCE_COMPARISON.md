# Next-generation performance evidence

Baseline: `a108a01` / application source `42caf55`, Electron 45.2.3, Monaco 0.57.0, unchanged lockfile dependencies. The [previous native report](diagnostics/windows-gcc/FINAL_PERFORMANCE.md) is historical evidence only. Its values are not fresh feature-branch measurements.

| Scope | Before | After | Status |
| --- | --- | --- | --- |
| Native macOS startup, process-family footprint/RSS/CPU, typing and tab latency | Historical report available | Not measured | Local Electron registration constraint; no safe new native baseline |
| Native Windows startup, memory/CPU, typing and display scaling | Historical report available; latest paired fixture failed | Not measured | No Windows host; no upload authorized |
| Real renderer screenshots, transferred assets, dormant modules, browser resource proxies | Capture before production edits | Pending | Isolated headless Chrome; not Electron whole-app RAM |
| Bundle/module bytes, source hashes, new dependencies | Record immutable baseline | Pending | Reproducible build comparison; bytes are not RAM |
| Learning on disk, selected-pack reads, migration retention | Existing bounded store | Pending focused disk tests | No eager full-pack loading is permitted |

Full OS-cold startup, physical input/display latency, hardware GPU utilization, battery and four-hour soak are not measured. No RAM reduction or universal performance improvement is claimed. Optional panels must stay lazy, free of hidden scans/AI calls, and bounded when active. Reuse existing measurement scripts after the feature candidate is safe and a native test environment is authorized.

## Milestone A observations

The matched browser scenarios use the same Chrome157.0.8103.51, production renderer, loopback/no external requests, viewport/theme pairs and deterministic bridge. Each case has one capture, not a statistically adequate native startup or latency benchmark. Baseline Welcome transferred370,785 JS bytes; first A capture 370,895 (+110 bytes). Optional learning/roadmap/practice/terminal modules were absent on Welcome in both builds. Real code editing used one Monaco widget; navigating Learn/Code preserved its identity and one-step Undo. Renderer JS heap snapshots vary and are not process-tree RSS, attributed footprint or evidence of a leak/improvement. No new dependency, service, scan, worker or animation was added.

Raw reports remain in ignored `performance-results/ui-baseline-retry`, `ui-A`, and `ui-A-verified`. A full-unit run initially had two theme failures; corrected palettes pass all six theme/shortcut cases. The subsequent complete working-tree run passed 257/283 with 26 platform skips; it includes the separately pending direct-selection backend tests. Native Mac/Windows and repeated long-session memory remain unverified for the feature.

## Milestone B observations

Welcome JS transferred370,420 bytes in all four 1× and all four 2× renderer cases versus370,785 baseline (-365bytes). This small transport-size difference is not an Electron RAM improvement. Learn and Content settings stay dormant on Welcome; the old Marketplace component/CSS have no runtime imports and were removed after call-site verification. No dependency was added.

Twenty Content settings cycles per size/theme case (80 total), with explicit test-only CDP GC at baseline/every 5 cycles, retained one editor and unchanged source. JS heap final-minus-initial was119,236/114,944/109,752/113,680bytes; listeners 559 throughout and DOM nodes 803→797. Smaller late increments suggest warm retained data, but no cause or long-run leak conclusion is established. Browser counters are not whole-app RSS/footprint, native CPU, natural post-close recovery or GPU presentation. The final report preserves these limits and the raw lifecycle report.

Changed historical benchmark aliases now declare `learning-content-settings-v1` or `direct-language-selection-v1`; they must not be treated as matched to the removed Marketplace cards/search workload. Native CI is prepared against exact reviewed0.9.8source a108a01, not the older tracing control 38cf7ff. It has not run for this branch.


## Actual native A/B checkpoint — 15 November 2026

Approved feature-branch run [43683773521](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43683773521) tested `80f89c5` against exact reviewed baseline `a108a01`. These measurements **predate C/D**. All three samples per lane are preserved in [numeric evidence](docs/performance/next-generation-AB.json); complete sanitized artifacts remain attached to the run. No installers were uploaded (artifact inventory checked).

Apple Silicon hosted macOS 24.6.0, 7 GiB reported RAM, three trials per lane, baseline then candidate each pair. Fresh profile is not OS-cache-cold boot. Full-process RSS and summed per-process macOS-attributed footprint are separate measures. Small sample count and fixed order limit causal conclusions.

| Metric (median) | Baseline | A/B candidate |
|---|---:|---:|
| Fresh-profile startup | 739.86 ms | 678.68 ms |
| Warm startup | 474.93 ms | 629.13 ms |
| First source opening | 419.04 ms | 461.60 ms |
| Welcome footprint / RSS | 126.68 / 370.02 MiB | 132.21 / 376.08 MiB |
| One-file footprint / RSS | 187.56 / 461.52 MiB | 205.59 / 468.95 MiB |
| Ten-tab footprint / RSS | 197.86 / 474.89 MiB | 205.29 / 479.64 MiB |
| Settled saved-config CPU (% one logical core) | 0.119 | 0.160 |
| Typing proxy, keypress→second frame | 24.40 ms | 28.90 ms |

**Observed regression, not an optimization claim:** one-file renderer footprint increases about 7.52 MiB, GPU about 10.78 MiB; main is essentially unchanged and four processes remain. GPU difference falls to about 0.45 MiB by ten tabs; renderer difference remains about 6.75 MiB. Allocation stacks are unavailable. Visual geometry/font/cache effects are possibilities, not a proven root cause. Warm-start and file-open increases need order-balanced remeasurement; three samples cannot establish p95/p99 or broad hardware claims. All six application sessions shut down with exit code 0 and no signal; this harness marks main-process exit, not independently proven whole-tree cleanup.

Native Windows x64 standalone comparison: fresh startup 466.67→442.60 ms, warm 425.41→416.07 ms, first source 373.86→416.28 ms; one-file working set 362.36→361.28 MiB and private bytes 187.30→187.82 MiB. Windows private bytes are not macOS footprint. **The paired Windows development benchmark FAILED before launch:** baseline fixture Git bulk-add exceeded the existing 30-second deadline, followed by EBUSY scratch cleanup. Do not substitute standalone measurements for that missing matched workload or call this gate green.

A/B native verification: 10 jobs passed, one benchmark job failed, two optional jobs unselected. Both desktop/installer verifiers passed; feature-branch installer upload was disabled. No local Electron GUI was launched, and the installed app/profile remain untouched.

## Practical learning C — renderer evidence only

Actual compiled renderer in headless Chrome 157.0.8103.51, four 960×700/1440×900 light/dark cases at device scale 2: `performance-results/ui-C-final/report.json`. Welcome transfers 370,530 JS bytes versus B's 370,420 (+110); opening Learn transfers 406,064 cumulative versus 395,875 (+10,189). These are transfer sizes, **not RAM**. Optional lesson/results modules remain absent on Welcome. No dependency or resident service was added.

Twenty Content Settings open/close cycles in each C scenario retained 139,740–151,060 bytes of browser JS heap between forced collections; final listener count 561 equals the initial 561. One temporary intermediate count was 552. This is bounded short-run renderer evidence, not proof of no leak, native memory recovery or natural GC. C practical UI also checks graduated hints, real Monaco preservation, Stop-before-preflight and narrow cancellation on lesson unmount. Displayed sample statuses in this browser transport are explicit fixtures; native execution is verified separately. New native C journeys are prepared for both CI platforms; no C native result is claimed yet.


### Benchmark setup ownership correction (test infrastructure only)

The pre-launch Git fixture used raw execFile timeout with no descendant owner. A deterministic owned control reproduces the surviving grandchild; the corrected fixture adapter uses the existing process runner/Windows Job helper and verifies cleanup before scratch removal. Three focused Node checks pass (EOF/bounded output, timeout ownership, actual 1,000-file Unicode Git fixture), no skips. Windows still needs native verification. This corrects ownership, **not** the unexplained 30-second bulk-add delay. Command deadlines remain10sMac/30sWindows, no retries. Failure reports retain bounded lifecycle traces.

New benchmark protocol `ion-fixture-process-v2-owned` records process setup separately from app timings. The next production comparison requests four trials with alternating baseline-first/candidate-first order, against the same a108a01 baseline. Do not silently pool these runs with historical fixed-order trials.
