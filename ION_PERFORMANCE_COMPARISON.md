# Next-generation performance evidence

Latest verified source:8c0ae1b / native run43702977386. See the final exact-candidate matched gate and active E/F sections at the end. Earlier sections deliberately retain historical samples, failures and pending states as they stood at those checkpoints. The current candidate has a measured Mac renderer-footprint increase; no lighter-than-baseline claim.

Baseline: `a108a01` / application source `42caf55`, Electron 45.2.3, Monaco 0.57.0, unchanged lockfile dependencies. The [previous native report](diagnostics/windows-gcc/FINAL_PERFORMANCE.md) is historical evidence only. Its values are not fresh feature-branch measurements.

Initial measurement availability before authorization (superseded by the dated native section below):

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

Changed historical benchmark aliases now declare `learning-content-settings-v1` or `direct-language-selection-v1`; they must not be treated as matched to the removed Marketplace cards/search workload. Native CI is prepared against exact reviewed0.9.8source a108a01, not the older tracing control 38cf7ff. Those checks subsequently ran; see the dated native A/B checkpoint below.


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


D foundation adds only on-demand metadata/manifest work and one≤128KiB snapshot per owner/renderer. It does not initialize on Code/Welcome. Full production renderer transfer and native resource impact must be measured; caps are architectural limits, not RAM measurements. No persistent-RAM claim is made from source inspection or tests.


## Balanced native C comparison — run43688556658

[All numeric samples](docs/performance/next-generation-C-balanced.json). Exact source0d2c738 vs a108a01; before D. Four trials/lane with alternating order, same1,000-file fixture/10tabs/7,000-line diff/Csuite. Both native performance jobs completed and all eight main-process exits/platform were clean. Windows fixture ownership controls passed on real Windows; this does not explain every historical bulk-add or GCC delay. The new practical integration fixture still failed independently and is not relabeled passed.

| Median | Baseline | C candidate |
|---|---:|---:|
| Mac fresh-profile startup |760.18ms|712.81ms|
| Mac warm startup |461.47ms|617.58ms|
| Mac first source opening |393.11ms|484.95ms|
| Mac Welcome footprint / RSS |126.52 /369.74MiB|125.30 /371.52MiB|
| Mac one-file footprint / RSS |194.94 /464.67MiB|194.21 /469.02MiB|
| Mac ten-tab footprint / RSS |196.04 /474.77MiB|203.86 /478.26MiB|
| Mac settled saved-config CPU (% logical core) |0.189|0.170|
| Mac typing proxy (keypress→second frame) |30.30ms|24.65ms|
| Windows fresh / warm startup |433.51 /386.90ms|447.40 /396.64ms|
| Windows first source opening |375.18ms|379.68ms|
| Windows one-file working set / private |364.03 /188.67MiB|362.22 /187.44MiB|
| Windows ten-tab working set / private |382.84 /205.24MiB|381.00 /204.10MiB|
| Windows typing proxy |19.30ms|19.45ms|

The earlier Mac one-file footprint gap does not persist in this run. Ten-tab renderer retention and Mac warm/file-open latency still warrant investigation; there is no established cause or blanket optimization claim. Four samples do not support stable p95/p99 claims. Hosted macOS reports7GiBRAM; this is not a physical8GB-laptop validation. Windows reports about16GiB. Full OS-cold launch, visible-screen latency, actual8GBhardware and four-hour sessions remain unverified.

## D payload fitting — measured Node-only correction

[Six paired samples and environment](docs/performance/project-lens-fitting.json). AppleM3/24GiB/darwin27.2.0/Node26.11.1, identical removed disposable500-file fixture, four64KiBmanifests, maximum884-byte relative path; warm filesystem, alternatingAB/BA/freshNode. Existing fitting serialized after every discarded entry; new bounded prefix search preserves priority/order/result limits. Regression failed before fix. Median external wall444.13→244.23ms, CPU465.50→265.00ms, serialization193.44→1.47ms/503→7calls. All12results101,221bytes, identical retained0file rows/2manifest rows/12framework entries/4entry references/2languages, explicit partial status.

Node endpointRSS29.58→25.32MiB; after forcedGC29.61→25.34MiB; retainedJSheap5.30→5.30MiB. These do not measure Ion RAM, natural memory recovery or leaks. Peak includes process/module startup and stays in the raw numeric report. Profiling predates the final own-property guard; final correctness tests rerun on that guard, while final-app profiling remains pending.

Review also moved Lens behind the existing main-process external-module boundary: startup bundle230,337→215,055bytes in local intermediate builds; optional session19,034bytes. This is a package/parse-boundary measurement, not RAM. A snapshot holds≤128KiB per owner; canceled I/O now retains ownership until cleanup, rejecting new requests while stopping rather than accumulating overlapping calls. Native final-D costs remain unverified.


### Pending startup-attribution measurement

The four-pair Mac slowdown is observed, not diagnosed. Warm startup here follows a Welcome-only session, not restoration after coding; learning/recovery-cache restoration cannot be claimed as its cause. A bounded opt-in **test-only** observer now partitions controller launch/firstWindow/Welcome observations and per-file click/tab/text waits, alongside independent renderer navigation/resource timings. Both lanes use the same observer/harness. Its post-startup inspection and retained numeric records introduce measurement overhead, so these instrumented results will be labeled separately. No production optimization or claim of recovered latency has been made.


## D native Mac remeasurement — run43693605190

[All four pairs, no excluded samples](docs/performance/next-generation-D-macos.json). Candidateb8132ec versus the samea108a01, native hosted AppleSilicon/macOS24.6.0/7GiB reportedRAM, alternatingAB/BA, uninstrumented. Both performance jobs are separate from the failing Lens root-change fixture. All eight measured Mac sessions exit0 without signals; this is the existing main-process-exit scope.

| Median | Baseline | D candidate |
|---|---:|---:|
| Fresh-profile startup |713.35ms|862.22ms|
| Warm startup |615.08ms|580.78ms|
| First source opening |368.90ms|560.17ms|
| Welcome footprint / summedRSS |127.39 /372.63MiB|125.24 /370.93MiB|
| One-file footprint / summedRSS |193.95 /466.02MiB|197.04 /465.05MiB|
| Ten-tab footprint / summedRSS |197.40 /476.12MiB|205.64 /478.37MiB|
| Settled saved-config CPU (%logicalcore) |0.170|0.133|
| Keypress→second frame proxy |28.00ms|22.40ms|

The initial baseline fresh launch3485.91ms and warm1020.01ms remain in the samples. Warm medians change direction versus the earlier run, demonstrating noise and inadequate causal attribution; first-file latency remains materially slower. Four pairs do not support stable tail percentiles. No startup fix or general speedup is claimed. This workload does not open Lens itself, so these figures measure the ordinary coding path with the optional module dormant, not active-analysis cost. Final instrumented traces and Windows completion are pending.


## D instrumented Mac comparison — run43694512103

[All four pairs and controller phases](docs/performance/next-generation-D-instrumented-macos.json). Warm median480.60→511.51ms; first file461.47→465.61ms. Controller launch resolution388.59→415.76ms accounts for most of the warm difference, while Welcome locator wait96.93→96.60ms and tab-observed→text-observed320.06→319.15ms are similar. Launch resolution includes Electron/inspection startup and cannot isolate the application's own initialization. Earlier larger file-opening gaps are not consistently reproduced. No root cause or latency fix is claimed; instrumentation is matched but adds overhead and uses independent clock origins.

One-file footprint187.06→196.38MiB, summedRSS464.11→466.48MiB; ten-tab footprint197.24→205.34MiB, summedRSS475.23→478.90MiB. Settled saved-config CPU0.288→0.161%logicalcore. Different footprint results across preserved runs require allocation evidence before a causal memory claim; the approximately8MiBten-tab gap remains visible. No long-session/real8GBhardware certification.

## Diagnostic normalization — function cost, not application RAM

[All sixAB/BApairs per case](docs/performance/diagnostic-normalization.json). Reproduce with `node scripts/benchmark-diagnostic-normalization.mjs`. Actual Node modules on local AppleSilicon/Node26.11.1,100calls/sample. Plain traceback median0.0021→0.0036ms/call; ConPTY envelope0.0014→0.0042ms while correcting the previously unclassified diagnostic;63KiBtext0.0107→0.3490ms with conservative validation; over-limit output abstains in0.0081ms. These are bounded failure-path costs, not improvements over the old incorrect result or Ion startup/idle/physical-display measurements.

Initial profiler controls used VMglobals, which exaggerated hot-loop cost; their raw files are retained locally but not used as production estimates. The reproducible script now uses ordinary temporary Node modules, bounds iterations, removes temporary modules/files and stops its build service. A char-code ASCII fast path avoids per-character regex work; Unicode/control/ambiguity guards remain. No persistent formatter, worker, service, cache or new dependency is added to Ion.

## D instrumented Windows comparison — run43694512103

[All four matched pairs](docs/performance/next-generation-D-instrumented-windows.json), a108a01→df089aa, hosted Windowsx64/10.0.26100/~16GiB, alternating order and identical current harness. Fresh515.49→496.81ms; warm427.93→438.33ms; first source417.12→418.84ms. One-file working set363.31→363.40MiB/private188.12→189.28MiB; ten tabs381.88→382.60MiB/private204.76→206.44MiB. Settled saved-configCPU3.318→2.914%of one logical core over short identity-matched intervals. These are not final E/F or zero-idle-CPU claims. Native cleanup scopes and every slow sample remain in numeric evidence.

## E/F — final renderer and native measurement status

[Final four-case renderer evidence](docs/performance/next-generation-EF-renderer.json):20ContentSettings cycles/case, listeners564→564 and nodes828→822; forced-GC browser JS heap grows about0.07MiB over the short workload. Original source/model/widget/Undo preserved. BrowserJS is not whole-app RSS, macOS footprint, natural GC recovery or a no-leak proof. Synthetic HTTPS/bridge responses do not measure live-provider TLS/latency/buffering.

Native fixture adds opt-in bounded snapshots for Code, installed lesson, Tutor review/reply, Lens before/after analysis, selected evidence review/reply,20review/send/close cycles and Code recovery at20/60s. No forced GC; exact process identities, short-intervalCPU, models/editor ownership and post-shutdown zero-owned-process assertions. Mac footprint and summedRSS are separate; Windows working/private bytes separate. Five-minute fixture budget,24snapshots maximum, no permanent monitor or new product service.

First native E/F fixture run43700858841 failed in test setup before optional work; **no resource samples**. Nested setup corrected atc35371a; a subsequent API-module import error identified at resource line203 was corrected at2af7d82, again test-only. Final matched Code benchmarks and active E/F snapshots remain pending. No persistent-RAM improvement, peak memory, long-session no-leak or final performance acceptance is claimed.

## Final product-source Mac comparison — E/F5489a3c

[Four native matched pairs, including all samples](docs/performance/next-generation-EF-macos.json), run43700858841, samea108a01baseline, hostedAppleSilicon/macOS24.6.0/~7GiBreportedRAM. AlternatingAB/BA, identical test-only startup observer and disposable1,000-file workspace; optional Tutor/Lens dormant. c35371a/2af7d82 only change fixtures, not this product source. All eight measured sessions complete/exit cleanly under the stated main-process-exit scope.

| Median | Baseline | E/F candidate |
|---|---:|---:|
| Fresh-profile startup |1012.05ms|874.93ms|
| Warm startup |677.83ms|734.81ms|
| First source opening |570.81ms|568.36ms|
| Welcome footprint / summedRSS |128.64 /372.90MiB|126.40 /372.53MiB|
| One-file footprint / summedRSS |193.75 /464.75MiB|195.81 /465.80MiB|
| Ten-tab footprint / summedRSS |199.33 /476.38MiB|204.86 /480.31MiB|
| Settled saved-config footprint / summedRSS |257.71 /546.52MiB|264.16 /552.24MiB|
| Settled saved-configCPU (%one logicalcore) |0.352|0.121|

This is mixed evidence, not a RAM optimization claim: one-file footprint+2.06MiB, ten-tab+5.53MiB and warm+56.98ms; first-file difference is small in this run. Warm timing includes Electron inspection/automation; trial counts do not support stable p95/p99 or causal attribution. Earlier larger file-open deltas remain recorded. Footprint gaps need allocation/long-session evidence before calling them leaks or acceptable across hardware. No physical8GB-laptop,OS-cache-cold,screen-latency or peak-memory claim. Active AI/Lens resource profiling remains a separate incomplete gate.

The same final Mac comparison records median keypress→second-frame proxy21.20→24.50ms, per-trial median tab navigation79.50→71.96ms and scroll proxy41.72→36.30ms. These are automation proxies on a hosted machine, not physical typing/scrolling or robust tail latency. A faster tab proxy does not cancel the measured warm-start/footprint increases.

## Retained incomplete active-Windows sample

[All eight pre-failure checkpoints](docs/performance/next-generation-EF-native-partial-windows.json), run43701511606/artifact14156622681. One disposable session, before the accessible-field correction, synthetic HTTPS, one Monaco. Code one-file working set/private357.91/184.33MiB; installed lesson358.32/183.50; Tutor reply379.02/187.09; Lens analyzed387.10/195.35; selected-source AI reply395.24/197.23. ShortCPUintervals range0to1.69%of one logical core; zero is sample resolution, not a continuous-idle assertion.

This fixture later failed on a populated textarea accessible label and its old teardown masked the primary error; it does not establish successful final cleanup,20cycles or20/60srecovery. Both failure and all collected samples are retained. These sequential endpoint snapshots are neither a matched baseline comparison nor peak costs. Do not present them as final acceptance or exclude the failed run.

## E/F5489a3c matched Windows comparison

[All four pairs](docs/performance/next-generation-EF-windows.json), run43700858841, native hostedWindowsx64, same baseline/harness/workload and alternating order. Fresh335.18→324.95ms, warm291.25→285.70ms, first source268.05→256.53ms. One-file working set364.70→361.42MiB/private189.43→186.06MiB; ten tabs384.46→381.00MiB/private207.32→203.63MiB. Settled saved-config working/private453.63/268.70→454.46/269.72MiB. CPU at saved-config sample resolution0→0%; this is not continuous-CPU certification. Typingproxy22.70→22.80ms; per-trial median tabproxy53.79→57.15ms. All eight measured sessions complete under their recorded cleanup scope.

Windows and Mac have different machines/accounting and cannot be compared as a contest. Four pairs are insufficient for reliable tail latency or a causal3MiBoptimization claim. This source precedes only the three explicit accessible-label attributes in1432c8a; final exact-candidate native verification/resource profiles remain pending.

## Verified active E/F resources — exact8c0ae1b candidate

[All Mac snapshots](docs/performance/next-generation-EF-native-macos.json) · [All Windows snapshots](docs/performance/next-generation-EF-native-windows.json), run43702977386. One actual native session/platform with synthetic HTTPS and real OS-backed safeStorage; fixed content and viewport per lane (Mac1024×681@1×;Windows1008×655@1×). Process ownership includes renderer/GPU/utility/main and known descendants, not merely Electron's parent. No forcedGC. Endpoint snapshots are not peak memory or a matched old-build comparison.

| Checkpoint | Mac footprint / summedRSS | Windows working set / private |
|---|---:|---:|
| Code, one file |180.43 /457.25MiB|356.19 /184.11MiB|
| Installed lesson |197.72 /468.72MiB|357.56 /183.00MiB|
| Tutor reply |213.31 /485.33MiB|379.68 /186.68MiB|
| Offline Lens after Analyze |211.40 /499.47MiB|393.51 /195.51MiB|
| Project-source reply |216.65 /502.58MiB|395.68 /197.86MiB|
| Before20cycles, dialog closed |241.45 /528.28MiB|426.43 /225.86MiB|
| After20cycles, dialog closed |236.29 /527.02MiB|434.53 /236.17MiB|
| Back to Code +20s |178.93 /503.28MiB|367.78 /200.57MiB|
| Back to Code +60s |175.81 /501.88MiB|350.75 /200.68MiB|

Mac footprint falls after panel close but summedRSS remains44.63MiB above the initial Code snapshot; Windows private bytes remain16.58MiB higher, including the second legitimately open source/model and newly loaded modules. This is retained memory requiring longer-workload attribution, not proof of either a leak or perfect cleanup. Windows cycle private bytes rise initially then fluctuate rather than increasing every five cycles;20cycles cannot establish an indefinite bound. No samples were omitted.

One Monaco editor throughout; one model initially, two after actual citation navigation; repeated cycles preserve that count. No unexpected native child; normal shutdown leaves zero observed owned processes on both platforms. Final60sCPU0.067%of one logical core on Mac, Windows0at sample resolution. Short interval CPU includes probe overhead and misses short-lived exited process CPU. No continuous-idle certification.

Synthetic review/send/close cycle latency,20samples: Macmedian373.58ms/descriptivep95472.44ms/max500.75ms; Windowsmedian294.73ms/p95310.93ms/max311.71ms. p95is the19th ordered sample; this small set does not establish stable tail latency. Profile elapsed100.95/106.10s. Live provider network/TLS/inference cost is excluded.

## Final exact-candidate matched gate —8c0ae1b /43702977386

**Selected automated gates pass; this is not a general optimization or release declaration.** [Mac four pairs](docs/performance/next-generation-final-macos.json) · [Windows four pairs](docs/performance/next-generation-final-windows.json). Same a108a01 control, dependencies/harness/production build, alternating order, disposable1,000-file workspace, existing tool/panel workload. All16measured sessions complete; original slower/failed earlier runs remain above. Main source buildSHA256b45fa7e563af7cc83db65898478da5d5537537f687b4470aa7c3c150226bc268; no installed application mutation.

| Median | Mac baseline | Mac candidate | Windows baseline | Windows candidate |
|---|---:|---:|---:|---:|
| Fresh-profile startup |1009.97ms|733.26ms|434.01ms|392.71ms|
| Warm startup |707.96ms|562.08ms|323.83ms|322.35ms|
| First source opening |507.05ms|457.85ms|323.40ms|323.79ms|
| One-file attributed footprint |188.22MiB|194.19MiB|n/a|n/a|
| One-file summedRSS |463.34MiB|465.44MiB|n/a|n/a|
| One-file working set / private |n/a|n/a|361.25 /185.85MiB|361.64 /187.23MiB|
| Ten-tab footprint / summedRSS |197.01 /476.65MiB|203.79 /478.48MiB|n/a|n/a|
| Ten-tab working set / private |n/a|n/a|380.92 /203.35MiB|380.72 /203.71MiB|
| Settled saved-configCPU (%logicalcore) |0.130|0.272|0at resolution|0at resolution|
| Keypress→second-frame proxy |26.35ms|20.30ms|21.15ms|21.40ms|
| Per-trial median tabproxy |72.32ms|73.62ms|59.64ms|58.73ms|

Mac fresh/warm/file medians improve in this set, but earlier matched runs changed direction; four pairs and hosted-runner variability cannot establish a causal product startup improvement or reliable p95/p99. Windows first-file/typing changes are small; no universal responsiveness win. ShortCPUwindows are not sustained-idle certification. Instrumentation includes inspection attachment/actionability and uses distinct clock origins; fresh profile is not a true OS-cache-cold launch.

**Remaining observed resource cost:** Mac one-file footprint+5.97MiB and ten-tab+6.78MiB. Per-process median one-file renderer87.60→94.47MiB (+6.88), main53.78→53.04, GPU39.74→39.30, utility7.11→7.02; ten-tab renderer104.03→110.33 (+6.30), GPU39.85→40.93 (+1.09). Medians of components do not necessarily sum to median totals. This run attributes most of the measured gap to the renderer, without identifying allocations. It does not reproduce the historical130MiBGPU workflow gap. No GPU disabling, safety removal or speculative rewrite was performed. Allocation/long-session investigation remains open; **the feature candidate is not claimed lighter than baseline**.

Matched current source now has completed Mac/Windows regressions, installers, units, dependency security, Git/shutdown and cold-C diagnostic controls, plus the separate active E/F checks. No installer was uploaded or release/update feed changed. Physical8GBhardware, four-hour sessions, native scaling/screen-reader evaluation and live AI usefulness remain unavailable/unverified. The original rare WindowsGCCdelay remains unexplained; unselected909attempt/independentstartup jobs are not passes.
