# Performance

Paths under `performance-results/` refer to local benchmark outputs and logs. Reproduction commands are listed with the relevant workloads.

## Stabilization from 9adcdea

The preserved checkpoint and stabilized production builds ran on the same Apple M3, 24 GiB RAM, macOS 27.2.1 (26B131), Electron 45.2.3, battery power, hidden 1260 × 790 windows at 2× scale, and disposable Minimal Mode profiles. No thermal warning was recorded. OS caches and unrelated applications were preserved. The main-bundle hashes are `b4cca48d979b930ac389552a7da46b56ddc8b45654264eaec7db734355b72300` before and `d2cbdeda35cc757f4273a885017c13a8d41c7107bc257dc19d8c83a1e1be66dd` after. The main bundle grew from 193,007 to 201,127 bytes. No runtime dependency or persistent process was added. These before/after captures describe the configuration-isolation build before the later Windows rename, timestamp and navigation corrections. Exact build hashes identify the measured artifacts; final native release gates verify the later source separately.

Three sequential ordinary-workload trials per build used the same 1,000-file repository, ten tabs, 7,000-line diff and four approved C cases. They ran before and after implementation, with time and background-load variation between groups. The separate startup check alternated seven pairs and measured a fresh process and a same-profile relaunch in each pair.

| Measurement | Before | Stabilized |
| --- | ---: | ---: |
| Interleaved fresh launch, median of seven | 330.2 ms | 328.3 ms |
| Interleaved warm launch, median of seven | 335.8 ms | 338.0 ms |
| Welcome attributed footprint / summed RSS | 148.0 / 421.7 MiB | 152.9 / 422.8 MiB |
| One C file footprint / RSS | 256.6 / 520.4 MiB | 258.4 / 520.7 MiB |
| Ten tabs footprint / RSS | 250.8 / 530.5 MiB | 257.0 / 531.2 MiB |
| Medium project, Git closed, footprint / RSS | 270.4 / 547.7 MiB | 274.2 / 549.9 MiB |
| Welcome CPU, short sample, fraction of one core | 0.38% | 0.46% |
| First source open | 192.9 ms | 207.2 ms |
| Keydown to second animation callback | 20.1 ms | 16.9 ms |
| Tab switch to observed source | 49.6 ms | 49.8 ms |
| First Git panel / manual refresh | 931.9 / 70.2 ms | 981.2 / 77.3 ms |
| Large diff ready | 1,434.5 ms | 1,475.8 ms |
| Four-case suite, including intentional 3.6 s wait | 4,035.9 ms | 4,174.4 ms |

The first sequential startup series measured 306.3 → 378.4 ms fresh and 287.1 → 335.7 ms warm. The seven-pair interleaved recheck above did not reproduce that difference. The results support similar launch behavior and a small measured Git-operation cost for configuration capture. They do not establish a startup or typing speedup. Animation callbacks measure software readiness, not physical display presentation. Summed RSS can count shared pages repeatedly.

### Natural memory recovery

One complete run per build repeated 20 identical edit/undo/save, Git/diff open-close and approved native C test cycles, then sampled at 20, 120 and 300 seconds after the last test dialog closed. No collection was forced. Both reports record the same harness SHA-256 `a2919c40eaf60f2399e0c575098cdf27b1ace388038f4b170e7ca7be94b62a4d`, actual elapsed times, per-role memory, heap and DOM counters. The stable Monaco host, keyboard context and original saved undo history survived. All observed native children and app processes exited.

| Recovery point | Before footprint / RSS | Stabilized footprint / RSS |
| --- | ---: | ---: |
| 20 s | 235.4 / 596.8 MiB | 262.1 / 613.9 MiB |
| 120 s | 235.4 / 596.8 MiB | 263.8 / 508.4 MiB |
| 300 s | 237.2 / 492.4 MiB | 263.9 / 504.2 MiB |

At five minutes, renderer footprint was 131.7 → 156.9 MiB, GPU helper footprint 53.5 → 53.9 MiB, and main footprint 45.1 → 46.2 MiB. Renderer heap was 23.12 → 22.94 MiB. Both had two DOM documents, 1,789 nodes and 688 listeners at every recovery point. The 100-second idle CPU interval measured 0.061% → 0.057% of one core. The following 180-second interval measured 0.047% → 0.118%. These intervals include sparse diagnostic calls. Native children were absent during recovery.

The stabilized natural run retained 26.7 MiB more attributed memory and 11.8 MiB more summed RSS at five minutes. That single pair cannot establish an implementation-caused increase. A separate matched 12-cycle diagnostic pass with collection explicitly requested only after activity measured post-collection footprint 314.7 → 297.9 MiB, RSS 622.9 → 591.2 MiB and renderer heap 22.66 → 21.21 MiB. DOM and listener counts matched. Its immediate pre-collection RSS was 804.1 → 648.4 MiB. Timing and collection policy differ from the natural series, so the rows are separate. The varied native residency and stable live object counts support transient allocation and cache/allocator retention. They leave exact native allocation ownership open. Production never forces collection.

The earlier pilot reached 20/120/300-second points but failed a test assertion on `.monaco-editor`, which Monaco replaces during model switches. That incomplete run is retained locally. The corrected harness verifies the stable `.monaco-host`, its keybinding context and actual Undo. The successful natural runs above use that corrected, identical script.

### Reliability and packaging evidence

The final macOS unit run passed 183 of 195 cases with 12 documented platform/optional-tool skips and zero failures. The native Git suite now has twenty cases, including reftable, linked-worktree behavior and same-size racy-index detection. Genuine Git LFS passed six integrations. The macOS desktop regression and final Git/saved-suite desktop reruns passed. Baseline shutdown passed 24 cycles, with median 28.18 ms, p95 47.54 ms and maximum 49.92 ms. The stabilized 60-cycle run measured 28.81 ms median, 42.56 ms p95 and 438.69 ms maximum. Captured app/helper processes all exited. Recovery, canceled quits, a running terminal/program descendant and an active approved suite also passed. The historical shutdown workload error remains unavailable. The reproducible harness masking/disposed-process defects and a separate Git cancellation-owner gap were fixed.

The local Apple Silicon DMG built and verified with ad-hoc signing. Its SHA-256 is `c6d61acf78a17d9edf62db6fd7b4c809f5e999acf95541210b3c95cdc16d9898`. Later Windows checks exposed a ten-second bulk-fixture setup timeout outside the measured app intervals. Its setup-only Windows limit is now thirty seconds; candidate execution, responsiveness and performance thresholds are unchanged. Failed setups remain failed captures. The final native Windows and extended-session outcomes are recorded with the delivery gates. Physical 8 GiB hardware, visible display latency and a four-hour workload remain separate measurements. No RAM reduction is claimed from this stabilization work.

### Completed extended macOS run

The final production build (`e8f1cdd1c1202dcad92b217c6a1f00d73f687a0fcba183c09c7211ceef7d272f`) completed 900.001 seconds of editing: 180 tab/edit/save rounds and 45 genuine C executions, after opening and closing Markdown, notebook plots and PDF previews. No renderer error or unexpected network request was observed. The process exited normally with code 0, and the harness verified the captured app family was gone.

Summed RSS moved from 600.5 to 659.7 MiB, peaking at 661.3 MiB. Attributed footprint moved from 404.7 to 355.7 MiB, peaking at 408.6 MiB. Live renderer heap moved from 19.5 to 23.9 MiB while files and undo histories accumulated actual edits. Tab-switch median/p95/max was 59.0 / 62.4 / 67.2 ms. Insert-text observation median/p95/max was 13.2 / 13.8 / 15.0 ms. These software/automation timings do not measure physical display latency. No collection was forced. This finite session cannot prove that every longer workload is leak-free.

Earlier incomplete captures remain retained, including a client-interrupted 155-round attempt. They are not counted as completed runs. The successful capture is `session-release-stabilization-2026-11-11T19-22-51.693Z.json`; its sanitized summary and raw-input digest are in the [public capture](docs/benchmarks/stabilization-macos.json).

```sh
ION_SHOW_TEST_WINDOWS=0 node scripts/benchmark-session-lifecycle.mjs --target dist --label release-stabilization --soak-seconds 900 --interval-seconds 5
```

### Native Windows candidate

The completed native run at source `3d2998c75bc74901811812a34094eb40f8133203` passed all four verification jobs. Its Windows Server 2025 x64 VM used an AMD EPYC 7763 and 17,174,360,064 bytes of visible RAM. Measurements include the Electron process tree. Three ordinary trials measured Welcome at 297.8 MiB summed working set / 135.1 MiB private bytes and one C file at 357.7 / 184.3 MiB. Fresh/warm medians were 627.5 / 424.9 ms. A real C run reached output in 300.5 ms. These are the ordinary harness's own protocol, separate from development-workflow timings. [Native run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43086657774) · [Sanitized raw capture](docs/benchmarks/stabilization-windows.json)

| Development workflow, median of three | Working set / private bytes | Sample CPU |
| --- | ---: | ---: |
| Welcome | 300.5 / 137.2 MiB | 0.00% |
| One C file | 362.1 / 186.4 MiB | 0.00% |
| Ten tabs | 381.0 / 203.6 MiB | 0.00% |
| Medium repository, Git closed | 391.3 / 213.2 MiB | 0.00% |
| Git status open | 413.6 / 229.1 MiB | 0.00% |
| Large diff | 444.9 / 258.9 MiB | 0.00% |
| Completed suite, dialog closed | 422.1 / 236.9 MiB | 0.00% |

The development harness measured fresh/warm startup at 470.7 / 400.1 ms, first source at 392.9 ms, Git first-open/refresh at 593.5 / 138.0 ms, large diff at 1,530.0 ms and the four-case suite at 5,200.2 ms, including the deliberate 3.6-second wait. Zero CPU means no measurable increment at the sampling resolution. Private bytes include private committed memory that may be paged out. Working set can count shared pages repeatedly. Neither is interchangeable with macOS-attributed footprint.

The unmodified `9adcdea` Windows baseline cannot save under this workload. Its incomplete trial remains explicitly unavailable. All three candidate trials and the final one-minute soak must complete; no matched Windows improvement or regression can be inferred. The thirty-second Windows bulk-fixture preparation cap is outside app measurements. Physical 8 GiB laptops and manual retail Windows qualification remain open.

```sh
node scripts/test-git-configuration-race.mjs --source /path/to/9adcdea-source --expect-vulnerable --out before.json
npm run test:git-security
node scripts/test-git-lfs.mjs --toolpath /absolute/path/to/git-lfs
ION_SHOW_TEST_WINDOWS=0 npm run test:shutdown -- --cycles 60
ION_SHOW_TEST_WINDOWS=0 node scripts/benchmark-stabilization-startup.mjs --baseline /path/to/9adcdea-dist --trials 7
ION_SHOW_TEST_WINDOWS=0 node scripts/benchmark-stabilization-memory.mjs --baseline /path/to/9adcdea-dist --target dist --cycles 20 --checkpoints 20,120,300
ION_SHOW_TEST_WINDOWS=0 node scripts/benchmark-stabilization-memory.mjs --baseline /path/to/9adcdea-dist --cycles 12 --checkpoints 0 --diagnostic-gc
```

A [sanitized capture](docs/benchmarks/stabilization-macos.json) preserves the completed ordinary, natural-memory, alternating-startup and shutdown measurements without command lines or private paths. Full local reports and transcripts are under `performance-results/stabilization/`. The natural reports are `memory-before-final.json` and `memory-after-verified.json`, the separate collection pass is `memory-diagnostic.json`, the alternating launch report is `startup.json`, and ordinary workloads are `development-before.json` and `development-after.json`. [Engineering audit](ENGINEERING_AUDIT.md#stabilization-follow-up-from-9adcdea) · [Coverage and skips](TEST_COVERAGE_AUDIT.md)

## Git and saved Run Tests

These measurements compare the preserved 0.9.5 production build with the 0.9.6 development-workflow build before the filesystem and Git trust hardening. The same Apple M3 with 24 GiB RAM and macOS 27.2.1 ran three paired trials, alternating the builds. Each trial used a disposable Minimal Mode profile, offline renderer, hidden 1260 × 790 window at 2× scale, a 1,000-file Git project, and ten source tabs. Fresh launches leave OS filesystem caches intact. CPU is a fraction of one logical core. The GPU column measures the macOS-attributed memory of Chromium's GPU helper.

| Ordinary editor workload, median | Before attributed / RSS MiB | After attributed / RSS MiB | CPU before → after |
| --- | ---: | ---: | ---: |
| Welcome | 146.2 / 421.0 | 147.8 / 421.7 | 0.69% → 0.74% |
| One C file | 258.6 / 520.1 | 262.3 / 520.0 | 3.73% → 3.77% |
| Ten tabs | 252.5 / 528.9 | 254.6 / 530.5 | 1.40% → 1.50% |
| Medium project, Git panel closed | 272.2 / 545.9 | 275.0 / 548.0 | 3.77% → 3.68% |

Fresh startup was **323.9 → 285.7 ms**, warm startup **288.8 → 299.8 ms**, and first source open **185.7 → 191.2 ms**. A keydown-to-second-animation-callback proxy was **18.7 → 18.9 ms**, tab selection to observed source **49.7 → 49.7 ms**, and wheel to changed viewport **35.4 → 36.0 ms**. Startup results vary by trial and launch order. The separate common-workload resource comparison measured Welcome **122.1 → 122.8 MiB attributed** and **416.3 → 417.2 MiB RSS** with its longer settling protocol. Its eight-second idle CPU sample **0.25% → 0.79%** exceeded that harness's 0.5 percentage point allowance. The three paired trials above showed a smaller difference. These series do not establish a sustained idle CPU change.

| Development workflow, 0.9.6 pre-hardening median | Attributed MiB | RSS MiB | GPU helper MiB | CPU |
| --- | ---: | ---: | ---: | ---: |
| Git panel loaded | 293.4 | 576.8 | 110.8 | 1.32% |
| 7,000-line text diff | 346.6 | 609.7 | 125.9 | 8.06% |
| After six Git panel cycles and closing | 358.8 | 615.7 | 135.7 | 6.98% |
| Saved suite configured, dialog closed | 318.7 | 611.4 | 95.6 | 0.18% |
| Saved Run Tests dialog open | 333.9 | 614.4 | 106.4 | 0.48% |
| Native C test observed executing | 451.1 | 620.6 | 222.8 | 0.55% |
| After closing the completed suite | 305.8 | 589.2 | 118.9 | 8.02% |

These rows are sequential snapshots after different work. They cannot isolate the panel cost from Chromium settling and allocator reuse. First Git panel load took **838 ms**, manual refresh **75 ms**, and the large diff **1,459 ms** until navigation became available. Four saved cases took **4,038 ms** including a deliberate 3,600 ms program wait. No Git or test process remained after the work completed. Optional renderer assets were unloaded during normal editing before use.

The 90-second mixed stress run completed 46 rounds of typing, saving, tab switching, Git review, and native test execution. Whole-tree RSS rose from **602 to 703 MiB**. Renderer RSS rose from **271 to 367 MiB**, with renderer attributed footprint **145 to 194 MiB**. The GPU helper fell from **239 to 199 MiB attributed**. This run establishes a retained-memory symptom, with the allocator, compositor and object ownership still under investigation. It does not establish a leak or multi-hour stability. [Bottleneck report](BOTTLENECK_REPORT.md)

Reproduce with `ION_SHOW_TEST_WINDOWS=0 npm run bench:development -- --baseline /path/to/prior/dist --trials 3 --soak-seconds 90`. The native Windows workflow uses the public 0.9.5 source as its control and measures working set and private bytes. See [Windows parity and hardware protocol](docs/windows/FEATURE_PARITY.md). The macOS raw files are `performance-results/git-tests/matched-development.json` and the paired `resources-*.json` files in that directory.

### Final hardened production comparison

After the filesystem and Git commit safeguards, three alternating pairs repeated the same protocol on the same Mac. Each used the same 1,000-file fixture, window size, scale, ten tabs, offline disposable profile and 1.4-second CPU sampling interval. The final report completed all six workloads and their process exits.

| Median measurement | Preserved build | Hardened candidate |
| --- | ---: | ---: |
| Welcome attributed footprint / summed RSS | 146.9 / 421.4 MiB | 147.7 / 422.5 MiB |
| One C file attributed footprint / summed RSS | 257.5 / 519.9 MiB | 260.3 / 519.8 MiB |
| Ten tabs attributed footprint / summed RSS | 249.7 / 528.8 MiB | 254.8 / 530.2 MiB |
| Medium project, Git closed, footprint / RSS | 269.9 / 547.8 MiB | 274.6 / 548.8 MiB |
| Welcome CPU, fraction of one logical core | 0.82% | 0.91% |
| One-file CPU, same short sampling interval | 4.39% | 3.68% |
| Fresh process to Welcome | 300.4 ms | 276.3 ms |
| Same-profile warm launch | 287.0 ms | 277.4 ms |
| First source open | 177.9 ms | 176.9 ms |
| Keydown to second animation callback | 19.0 ms | 19.4 ms |
| Tab switch to observed source | 49.7 ms | 49.8 ms |

The changed build has similar summed RSS and slightly higher attributed memory in these workloads. Startup medians vary across the recorded series, and the short CPU windows include Chromium settling. These observations support the measured workload and leave sustained idle and physical display latency to separate tests. In the hardened candidate, Git first open took 964 ms, refresh 65 ms, the 7,000-line diff 1,426 ms, and the four-case suite 4,035 ms including its deliberate wait. No development child remained after suite completion.

The raw report is `performance-results/git-tests/hardened-development-final.json`. It includes the main-bundle SHA-256 hashes and per-process samples. An earlier attempted three-pair run failed at its last candidate shutdown after five completed workloads. The harness applied its eight-second exit limit. A complete one-pair retry and this final three-pair repeat passed. EA-16 retains the intermittent timeout for investigation. The benchmark writes `complete: false` checkpoints and logs any primary workload error before teardown. [Issue register](ENGINEERING_AUDIT.md#issue-register)

### Cost of preventing late save overwrites

The same Mac ran 30 saves per file size and build through the renderer's save IPC, with a disposable profile and renderer network access blocked. The candidate stages the new bytes through a checked directory handle and retains the displaced file until it verifies the old revision. The benchmark includes synchronized publication and the revision response. It excludes editor work and the autosave delay, and verifies the final bytes on disk.

| File size | Before median / p95 | Hardened median / p95 |
| --- | ---: | ---: |
| 256 bytes | 3.9 / 4.3 ms | 5.3 / 8.0 ms |
| 1.5 MiB | 6.0 / 7.0 ms | 8.8 / 9.7 ms |

The helper runs only during file mutations. The median save cost increased by 1.4 ms for the small file and 2.8 ms for the larger file. Native Windows save latency remains unmeasured. [Save logic](src/main/files.ts) · [Native adapter](src/main/file-mutations.ts) · [Save benchmark](scripts/benchmark-file-saves.mjs)

```sh
ION_SHOW_TEST_WINDOWS=0 node scripts/benchmark-file-saves.mjs \
  --baseline /path/to/prior/dist --target dist --trials 30
```

The pre-hardening and hardened Mac comparisons use the preserved working build with the earlier language and theme work already present. Its version string was 0.9.5. The released `v0.9.5` tag is the control for the separate Windows CI workflow.

## Language navigation and theme collection

The comparison used the preserved 0.9.5 production build from before the change and the updated production build on an Apple M3 with 24 GiB of RAM and arm64 macOS 27.2.1 (26B131). Windows measurements are pending. The app ran offline with hidden 1260 × 790 windows at 2× scale and disposable Minimal Mode profiles. The editor workload kept two tabs open. Each run switched 500 times, cycling through the imported themes. Counts exclude the five original and sixteen current built-in themes. There was one run per size and build. The old picker persisted each selection. The new picker previews the color and writes the preference only on Apply. The switch measurement ends two renderer animation callbacks after the selected palette appears.

| Imported themes | Idle attributed footprint, MiB | Idle summed RSS, MiB | GPU process at switch 500, attributed MiB | Preview p50 / p95, ms | Renderer heap after closing and diagnostic GC, MiB |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 183.7 → 182.7 | 509.3 → 507.6 | 242.6 → 228.6 | 32.0 / 32.6 | 15.97 |
| 20 | 183.6 → 181.8 | 508.6 → 507.8 | 241.2 → 228.3 | 32.2 / 32.5 | 15.99 |
| 50 | 183.5 → 183.3 | 508.5 → 507.2 | 241.8 → 229.6 | 32.2 / 32.5 | 15.99 |
| 100 | 183.2 → 182.4 | 507.9 → 511.4 | 241.2 → 232.1 | 32.2 / 32.5 | 15.99 |

Idle footprint differed by at most 1.8 MiB across the four paired catalog sizes. The 100-import run measured 183.2 → 182.4 MiB. Editor idle CPU sampled at 0.92–1.16% before and 1.06–1.50% after, as a fraction of one logical core. A single input-to-second-frame measurement per run ranged from 42.3–43.1 ms before and 40.4–42.8 ms after. Fresh process startup ranged from 327–521 ms before and 309–341 ms after. Warm launches ranged from 300–354 ms before and 282–315 ms after. OS caches remained intact. The sample count and sequential run order limit startup and CPU conclusions. No editor-only run started a native child.

| With 20 imported themes and 500 switches | Idle attributed footprint, MiB | GPU process at switch 500, attributed MiB | Preview p50 / p95, ms | Renderer heap after closing and diagnostic GC, MiB |
| --- | ---: | ---: | ---: | ---: |
| Integrated Terminal | 185.2 → 185.8 | 245.5 → 236.4 | 32.2 / 32.5 | 17.29 |
| Learning Lens | 215.3 → 215.5 | 327.2 → 262.0 | 32.2 / 32.4 | 17.75 |

The stress runs verified that the original Monaco editor, unsaved edit, and undo history survived. The terminal kept its original xterm element and the two terminal-owned processes exited when the session closed. The Learn run kept a real compiler explanation open. The candidate editor heap after diagnostic collection was within 0.02 MiB across the four catalog sizes. These short workloads do not establish multi-hour memory bounds. GPU figures are the macOS-attributed footprint of the GPU helper process, not GPU hardware utilization or dedicated VRAM.

The first picker design had nested scrolling and recolored its own controls on each preview. A targeted 100-switch layer trace with 20 imports sampled 10 content-drawing layers and 318.6 MiB in the GPU process. A single scrolling surface reduced that to eight layers and 275.8 MiB. Keeping the picker palette stable during the workbench preview reduced the GPU sample to 247.5 MiB. The final 500-switch runs above use both changes. Compositing layers and memory are separate measurements. The trace does not measure physical frame presentation.

The final C navigation fixture measured clangd at 19.50 MiB attributed and 35.06 MiB RSS. The process started on the first definition request, served references, and exited after the last smart source closed. It uses one translation unit at a time and leaves background indexing off. Two Smart Java trials with OpenJDK 26.0.2.1 measured the JVM separately at 62.4–62.8 MiB attributed and 91.9–92.3 MiB RSS. Neither service ran on Welcome or after its last source tab closed. Basic Java editing started no JVM. The unpackaged production payload increased by about 153 KiB, including approximately 12 KiB of extra palette JSON. Installer size was outside this source-build comparison.

The existing Marketplace benchmark also ran twice at zero and 100 installed synthetic learning packs on each build. In the updated build, idle summed RSS averaged 508.7 MiB with zero and 508.1 MiB with 100 packs. Both cases kept four app processes, and the Marketplace renderer code stayed unloaded during ordinary editing. Initial attributed-footprint samples varied from 228 to 332 MiB across these four trials. That variance prevents a precise per-pack footprint estimate.

Raw data and regressions are under `performance-results/language-theme-collection/`. The earlier 0.9.5 baseline can be rebuilt from `51452e3` in a separate checkout. Use the same output protocol for each build.

```sh
ION_SHOW_TEST_WINDOWS=0 npm run bench:themes -- --target /path/to/baseline/dist --legacy --out baseline.json
ION_SHOW_TEST_WINDOWS=0 npm run bench:themes -- --out candidate.json
ION_SHOW_TEST_WINDOWS=0 npm run bench:themes -- --sizes 20 --context terminal --out terminal.json
ION_SHOW_TEST_WINDOWS=0 npm run bench:themes -- --sizes 20 --context lens --out lens.json
ION_SHOW_TEST_WINDOWS=0 npm run test:navigation
ION_SHOW_TEST_WINDOWS=0 node scripts/benchmark-java-tools.mjs --baseline /path/to/baseline/dist --trials 2 --out java.json
ION_SHOW_TEST_WINDOWS=0 node scripts/benchmark-learning-marketplace.mjs --target /path/to/build/dist --runs 2 --sizes 0,100
```

## First launch and onboarding

Ion 0.9.5 was measured against its preserved pre-onboarding production build at `ad82e08`. The benchmark ran on Apple M3, 24 GiB RAM, macOS 27.2 (26B123), Electron 45.2.3, and battery power. The builds share the same Electron runtime. Tests use disposable profiles and retain OS caches. The renderer is offline.

The animation uses one 720×450 canvas and targets at most 30 paints per second. The canvas, frame loop, and listeners belong to the visible scene. Ordinary launches skip the scene and do not request its JavaScript or stylesheet. A static reduced-motion setup also skips both files. No dependencies, video decoder, workers, or additional windows were added.

The final playback comparison interleaved three baseline and three candidate trials. The baseline displays an idle Welcome while the candidate plays the intro. The ordinary editor comparison used three launches per build in a separate sequential workload. RAM is shown as summed process-tree RSS and macOS-attributed footprint. CPU is a percentage of one logical core.

| Workload or measurement | Before | After |
| --- | ---: | ---: |
| First process launch with existing preferences, median | 381.4 ms | 374.9 ms |
| Relaunch after the first-run workload, median | 416.3 ms | 383.0 ms |
| Existing-profile Learn panel open, median | 57.5 ms | 45.5 ms |
| Ordinary Welcome RSS / footprint | 425.3 / 195.9 MiB | 423.1 / 195.4 MiB |
| Ordinary Welcome CPU, 3 s window | 0.79% | 0.20% |
| One C file RSS / footprint | 510.6 / 345.3 MiB | 511.5 / 342.1 MiB |
| Ten tabs RSS / footprint | 525.4 / 368.2 MiB | 525.0 / 361.1 MiB |
| Medium project RSS / footprint | 554.6 / 402.1 MiB | 553.8 / 393.6 MiB |
| First file open / typing to second frame | 179.9 / 32.0 ms | 178.3 / 31.8 ms |
| Run to visible C output | 198.7 ms | 199.1 ms |
| First-launch idle vs. playback RSS / footprint | 433.8 / 141.2 MiB | 449.6 / 224.2 MiB |
| First-launch idle vs. playback CPU | 0.92% | 14.19% |
| First-launch idle vs. playback renderer heap | 3.21 MiB | 3.90 MiB |
| First-launch idle vs. playback GPU helper footprint | 53.1 MiB | 130.5 MiB |
| Process-tree members during first launch | 4 | 4 |
| Production payload before Electron packaging | 13,998,104 B | 14,011,407 B |

In the final set, the intro appeared after 422 ms and setup was ready after 8.46 s when playback completed. The median and 95th-percentile animation callback intervals were 16.7 and 17.1 ms. Callbacks measure renderer scheduling. The canvas draws at a lower capped rate. An earlier set measured 19.06% CPU during playback. Hardware GPU utilization, presented frame rate, and energy draw were unavailable. The GPU helper footprint is process memory, which can include surfaces and allocator caches.

The first dismissal sampled 458.0 MiB RSS and 163.8 MiB footprint after a 1.2-second settle and returned CPU to 0.39%. In a separate same-process check, footprint fell from 265.8 MiB during replay to 139.4 MiB after 18 seconds and was 140.1 MiB after five further replay-and-skip cycles. RSS was 442.5 MiB before the first replay, 464.2 MiB after it, and 467.8 MiB after the final settle. GPU helper footprint was 53.9, 41.9, and 43.6 MiB at those points. The canvas backing store was zeroed and no intro frame callbacks or loading timers remained after any skip. Each measured app tree exited on quit. Chromium retained some resident memory after replay in the same process.

The sequential editor pair had a slower first Welcome median of 347.1 → 473.5 ms and first Learn open of 59.4 → 106.0 ms. The interleaved repeats did not reproduce those increases. One candidate warm launch took 757.9 ms. Startup varies between runs, and the results do not establish a general speedup. The ordinary editor benchmark retained the existing provisional RSS targets, which both builds exceeded at Welcome and with one C file open.

The two lazy cinematic files total 5,329 bytes. The full production payload grew by 13,303 bytes. In separate local package builds, the Apple Silicon app grew from 277,542,292 to 277,556,131 logical bytes. The compressed disk image was 125,089,280 bytes before and 125,088,256 bytes after. The candidate passed the mounted offline smoke check, including replay. Raw comparisons are in `performance-results/master-onboarding/onboarding-final.json` and the `resources-onboarding-ordinary-*.json` reports. Windows desktop runtime, 8 GiB hardware, and multi-hour replay and editor behavior remain unmeasured for this milestone.

To reproduce, preserve `dist` from the baseline commit and build the candidate. Run the playback and ordinary-editor workloads separately.

```sh
npm run bench:onboarding -- --baseline /path/to/baseline-dist --target dist --trials 3 --cleanup
npm run bench:resources -- --target /path/to/baseline-dist --label onboarding-baseline \
  --idle-seconds 3 --settle-ms 650 --launches 3 --cycles 2 --executions 3
npm run bench:resources -- --target dist --label onboarding-candidate \
  --idle-seconds 3 --settle-ms 650 --launches 3 --cycles 2 --executions 3
```

## Format Document

Measured with hidden production Electron 45.2.3 on an Apple M3, 24 GiB RAM, arm64 macOS 27.2 (26B123), and battery power. The renderer was offline. The baseline was preserved before application changes. Five trials per build each started a fresh process with a seeded disposable profile, then quit and relaunched with that same profile. OS caches were retained. Each editor idle sample used one C file and two seconds of CPU observation after settling. Typing used 35 key-to-second-frame measurements and tab switching used 100 switches between two resident models.

| Idle or ordinary operation | Baseline | Format enabled in build, unused |
| --- | ---: | ---: |
| Fresh process to Welcome, median | 310.33 ms | 317.60 ms |
| Same-profile relaunch to Welcome, median | 300.52 ms | 297.46 ms |
| Welcome summed RSS / attributed footprint | 420.09 / 249.38 MiB | 420.28 / 249.58 MiB |
| Open the first C file | 184.64 ms | 186.18 ms |
| One C file summed RSS / attributed footprint | 500.36 / 213.99 MiB | 500.39 / 213.97 MiB |
| One C file idle CPU, percent of one logical core | 1.05% | 0.88% |
| Keydown to second renderer animation callback | 27.50 ms | 28.10 ms |
| Switch between two resident tabs | 16.57 ms | 16.69 ms |

The launch and CPU ranges overlap. Ordinary typing and tab timing are close, and the samples show no material idle memory increase. Ion loads the format adapter and starts external processes only on request. There are no new package dependencies. Visible compositor frame pacing, attributed GPU utilization, installer size, and Windows and Linux runtime performance were outside this hidden source-build benchmark.

### Formatting load and repeated edits

The active workload used Apple clang-format 21.0.0 with synthetic C sources. The files were opened cumulatively in three tabs. Latency is click to formatted text in the editor, median of five operations per size. Each group included a rapid 20-click burst and verified one result. Peak RSS and footprint are separate maxima among sampled snapshots. Short-lived process peaks can fall between samples. CPU includes Undo, browser work, and CPU charged for reaped formatter processes. One fully busy logical core is 100%.

| Input lines | Format median | Sampled peak RSS / footprint | After 900 ms RSS / footprint | Active CPU |
| ---: | ---: | ---: | ---: | ---: |
| 100 | 16.31 ms | 543.41 / 354.55 MiB | 543.41 / 309.74 MiB | 79.66% |
| 1,000 | 48.14 ms | 580.38 / 386.07 MiB | 575.83 / 343.82 MiB | 86.68% |
| 5,000 | 125.59 ms | 683.86 / 478.47 MiB | 634.75 / 400.24 MiB | 132.17% |

The first build's 100-round format/Undo burst rose from 631.80 to 757.86 MiB RSS in 20.05 seconds. A diagnostic repeat used identical three-tab operations and measured RSS, attributed footprint, and renderer heap after 20 seconds of natural idle. The tuned build repacks Monaco's backing text storage only after repeated successful formatting has accumulated substantially more storage than the active text. This keeps the same model, BOM, EOL, existing snapshots, and Undo/Redo history. Ion also reuses a verified Apple tool location after the first lookup.

| Diagnostic comparison, 100 rounds | Initial formatter build | Tuned formatter build |
| --- | ---: | ---: |
| Elapsed time | 20.01 s | 18.28 s |
| Burst checkpoint peak RSS / footprint | 769.31 / 523.69 MiB | 748.73 / 506.77 MiB |
| RSS / footprint after the 20-second idle | 596.86 / 222.01 MiB | 585.34 / 211.41 MiB |
| Live renderer JS heap after the idle | 29.92 MiB | 19.97 MiB |
| Live renderer JS heap after diagnostic GC | 29.73 MiB | 19.79 MiB |

All checkpoints were free of formatter children. The burst temporarily increases process residency, and both builds released much of that pressure naturally. The tuned build had a smaller settled renderer heap in this workload. In a final build check with 300 format/Undo rounds over 54.52 seconds, checkpoint peaks were 789.13 MiB RSS and 531.15 MiB footprint. The 20-second idle sample settled to 654.64 MiB RSS and 228.93 MiB footprint, compared with 637.11 MiB RSS and 400.52 MiB footprint at the start of the burst. The idle renderer heap was 23.95 MiB. These runs leave hours-long behavior unmeasured.

The desktop suite checks full Unicode and CRLF content after repeated 5,000-line Format, Undo, and Redo, as well as cancellations, timeouts, and disk conflicts with a deliberately delayed test tool.

Raw reports live under `performance-results/format-code/` as `baseline.json`, `candidate.json`, `initial-diagnostic.json`, `tuned.json`, and `extended.json`. Each records build hashes, process members, timings, and host details. To reproduce, preserve the pre-feature production `dist` and run the measurements serially.

```sh
npm run bench:format -- --target /path/to/baseline-dist --out performance-results/format-code/baseline.json
npm run bench:format -- --exercise --diagnose --out performance-results/format-code/tuned.json
npm run bench:format -- --trials 0 --exercise --rounds 300 --diagnose \
  --out performance-results/format-code/extended.json
```

## Smart Java

Measured on Apple M3, 24 GiB RAM, macOS 27.2 (26B123), Electron 45.2.3, and OpenJDK 26.0.2.1. The pre-feature production build includes onboarding. Each column is the median of three interleaved trials with fresh disposable profiles seeded with preferences, unchanged OS caches, and hidden Electron windows. The renderer was offline. One small Java file exercised live diagnostics and member completion. RSS sums the entire process tree and can count shared pages more than once. Footprint sums the macOS per-process ledger charges.

| Median | Before Java tooling | Basic Java | Smart Java, default JVM | Smart Java, tuned JVM |
| --- | ---: | ---: | ---: | ---: |
| Fresh profile process launch to Welcome | 325.9 ms | 360.1 ms | 336.1 ms | 331.3 ms |
| Open Java file | 182.6 ms | 197.0 ms | 197.3 ms | 184.8 ms |
| Typing to second animation callback | 28.5 ms | 28.2 ms | 28.0 ms | 27.5 ms |
| Welcome RSS / footprint | 432.7 / 251.1 MiB | 432.8 / 251.5 MiB | 433.3 / 251.3 MiB | 432.1 / 251.2 MiB |
| Java file open RSS / footprint | 509.9 / 216.2 MiB | 516.4 / 223.4 MiB | 623.7 / 289.3 MiB | 607.1 / 278.6 MiB |
| Java file open CPU, two-second idle window | 0.67% | 0.72% | 0.69% | 1.12% |
| After closing Java tab RSS | 524.6 MiB | 529.9 MiB | 534.9 MiB | 532.0 MiB |
| JDK-only RSS / footprint | — | — | 109.5 / 78.1 MiB | 92.0 / 62.5 MiB |
| First live diagnostic, including debounce and JDK startup | — | — | 1,065.0 ms | 958.2 ms |
| Warm member completion, JDK round trip | — | — | 20.8 ms | 16.5 ms |

Basic mode added 6.5 MiB RSS in this editor workload. The shared Monaco completion and navigation widgets add about 450 kB of uncompressed JavaScript to the lazy editor entry chunk. The Java provider and JDK worker load on demand. No JDK process appeared at Welcome or in Basic mode. The Smart Java builds differed only in the JVM’s tiered compilation flag. Limiting the JVM to its first compilation tier saved 17.5 MiB in the JDK process for this workload. The JDK exited on tab close in every Smart Java trial. Electron retained some RSS after closing the editor in all four modes.

These short trials measure one small file and use hidden rendering. Startup and CPU varied between samples. Longer sessions, large Java workspaces, Windows, and lower-memory hardware remain unmeasured. The benchmark preserves full per-process samples and build hashes in `performance-results/java-intelligence/java-tools-final.json`.

To reproduce, preserve the pre-feature production `dist`, then build the candidate. For the JVM comparison, make a separate copy of the candidate and remove the `-XX:TieredStopAtLevel=1` argument from its built `main/java/service.cjs`. Pass that copy as `--untuned`.

```sh
npm run bench:java-tools -- --baseline /path/to/baseline-dist --target dist \
  --untuned /path/to/default-jit-dist --trials 3
```

## Learning Lens

The baseline is the production worktree build immediately before Learning Lens. Both builds used Electron 45.2.3 on the same Apple M3 with 24 GiB RAM and macOS 27.2 (26B123). The benchmark interleaves three fresh-profile launches of each build. It installs and selects the C pack locally, opens one C file, verifies four real compiler failures per launch, opens the same explanation, types twelve characters, and closes Learn. The renderer runs offline and the script checks for outbound requests. Each memory sample follows a 500 ms settle and a 1.5-second CPU window. The OS file cache is left intact.

| Median | Before | Learning Lens |
| --- | ---: | ---: |
| Fresh profile to Welcome | 405.3 ms | 399.6 ms |
| Welcome process-tree RSS | 439.6 MiB | 436.7 MiB |
| Learn and editor open, before first run | 520.0 MiB | 517.0 MiB |
| Compiler error and explanation open | 540.1 MiB | 540.8 MiB |
| After closing Learn | 545.3 MiB | 547.1 MiB |
| CPU with explanation open, % of one logical core | 0.00% | 0.65% |
| Keydown to second animation callback, 36 keys per build | 32.0 ms | 31.5 ms |
| Run click to verified compiler feedback, 12 runs per build | 127.8 ms | 121.7 ms |
| Production payload before Electron packaging | 13,979,729 B | 13,998,088 B |

With the explanation open, the observed ranges were 539.0–542.7 MiB before and 539.7–542.3 MiB after. Typing ranged from 25.9–32.4 ms before and 20.0–32.4 ms after. These samples do not establish a speedup or long-session memory behavior. RSS sums the app and its helpers and can count shared pages more than once. The keyboard measurement is a Chromium frame-callback proxy. Native input-to-display latency, GPU utilization, OS-cache-cold and warm launches, and a native Windows before/after series are outside this run. The release job is configured to run the Windows desktop smoke.

No new dependencies or background services were added. Problems and marker updates use the bounded last compiler result. Source tokens are compared only after a recognized C compile failure when the compiled bytes still match. Lessons load on demand. The original editor model and undo stack remain in place.

```sh
npm run bench:learning-lens -- --compare <preserved-production-dist> --target dist --out performance-results/learning-lens/matched.json
```

Raw samples are in `performance-results/learning-lens/matched.json`. Use `npm run test:learning-lens` against a production build to exercise the native desktop workflow.

The macOS regression suite passed with 150 automated cases and 12 platform or opt-in skips. The Apple Silicon disk image was staged outside the synced workspace to avoid Finder metadata on the signed bundle. The delivered 125,091,328-byte image passed its checksum, strict signature verification, and mounted offline smoke test.

## Windows x64

Run `node scripts/benchmark-windows.mjs --label candidate --terminal` against a production build on Windows. The harness measures the actual Electron process tree, including native child processes, with separate working-set, private-byte, and CPU figures. It samples fresh and warm startup, one file, ten tabs, a medium project, PDF, Run Console, Terminal, and cleanup after repeated runs. The [Windows release report](WINDOWS_RELEASE_READINESS.md) records the native measurements, hardware, and protocol limits.

## Adoption changes

The baseline was a preserved production build with Marketplace 2.0 and Terminal already present. The final candidate added the durable update preference, explicit C/C++ project builds, and the reviewed C diagnostic rule. Both ran on Apple M3, 24 GiB, macOS 27.2 (26B123), Electron 45.2.3, and battery power. Each used five fresh and five warm launches, ten seconds of idle, the same saved source fixtures, six panel cycles, six native executions, and twelve mixed editing and run rounds. OS caches were left intact.

| Measure | Baseline | Final local build |
| --- | ---: | ---: |
| Fresh / warm Welcome, median ms | 388.30 / 380.79 | 393.58 / 414.77 |
| Welcome idle CPU, % of one core | 0.32 | 0.26 |
| Welcome idle RSS / footprint, MiB | 433.63 / 126.57 | 422.06 / 123.69 |
| One C file RSS / footprint, MiB | 518.30 / 334.50 | 507.30 / 333.15 |
| Ten tabs RSS / footprint, MiB | 534.55 / 366.77 | 522.67 / 363.83 |
| Medium project RSS / footprint, MiB | 563.31 / 390.08 | 551.55 / 392.74 |
| Typing to second animation callback, median ms | 31.85 | 31.75 |
| Rotating tab switch, median ms | 49.96 | 49.99 |
| Short C Run / Stop, median ms | 198.17 / 52.54 | 190.74 / 57.00 |
| Mixed workload CPU, % of one core | 38.67 | 36.46 |

All 32 enforced comparisons passed. Seven active-footprint comparisons remain advisory with one measured pair. Both builds reaped the app process tree and left zero native children at settled checkpoints. Median warm launch rose by 33.98 ms in this pair. An earlier short candidate attempt timed out on a fresh-process quit and completed on retry. Summed RSS can count shared mappings more than once. The measured differences describe these workloads and do not establish a durable memory reduction. Terminal overhead is measured separately below. The LLDB-DAP feasibility test introduced no debugger service to Ion.

In a separate Mac desktop test, warm Run-to-result medians over three correct executions were 177.47 ms for a standalone C file, 182.29 ms for two configured C sources, and 457.60 ms for two configured C++ sources. The timings include compilation, the approval flow with the native dialog stubbed, and output rendering. The C and C++ fixtures are different programs. The test also covered cleanup, changes during approval, and failure without launching an older executable.

```sh
npm run bench:resources -- --target "$ION_BUILD" --label adoption \
  --idle-seconds 10 --settle-ms 850 --launches 5 --cycles 6 --executions 6 --extended-rounds 12
npm run check:performance -- --baseline-report baseline.json --candidate-report candidate.json
npm run test:native-projects -- --measure
```

Baseline raw samples (`performance-results/resources-adoption-gate-baseline-2026-11-09T18-05-52.027Z.json`) · Final raw samples (`performance-results/resources-adoption-final-2026-11-09T18-10-56.899Z.json`) · Gate results (`performance-results/adoption-ci/final-performance-gate.log`)

## Integrated Terminal on macOS

Compared production builds before and after adding the integrated shell. Both used Electron 45.2.3 on an Apple M3 Mac with 24 GiB RAM and macOS 27.2 (26B123), on battery power. The benchmark ran three fresh disposable profiles per build with OS caches intact. It opened the same source file offline, then sampled the full process tree after a 1.2-second settle and again five seconds later. The candidate additionally opened one shell, opened a second, hid the panel, closed both, and ran eight more create-and-close cycles. The shells used isolated zsh startup files.

| Workload | Shell and PTY helper processes | Summed RSS (MiB) | macOS footprint (MiB) | CPU (% of one core) |
| --- | ---: | ---: | ---: | ---: |
| Previous build, editor only | 0 | 513.77 | 202.04 | 1.64 |
| Terminal build, before opening Terminal | 0 | 523.88 | 207.42 | 0.81 |
| One idle shell visible | 2 | 538.36 | 227.56 | 1.20 |
| Two idle shells, panel visible | 4 | 542.45 | 193.22 | 1.02 |
| Two idle shells, panel hidden | 4 | 543.17 | 203.95 | 0.08 |
| Both shells closed | 0 | 528.19 | 195.18 | 2.24 |
| After eight more create-and-close cycles | 0 | 536.66 | 199.44 | 0.12 |

Memory is the median of six samples per stage. Summed RSS can count shared mappings more than once. Footprint uses macOS per-process accounting. CPU is the median of three interval averages. The shell and PTY helper each used less than 0.01% of one core at every measured idle interval. The higher CPU reading just after closing both shells came from Electron processes.

The candidate showed its first shell prompt in **117.50 ms** median. Fresh-profile time to Welcome was **390.64 ms** before and **417.41 ms** after. Startup samples ranged from 326 to 527 ms before and 387 to 542 ms after. These runs establish that no shell or xterm code loaded before the first console request. They leave the cause of the startup and editor-memory differences unresolved.

Closing both sessions left **4.30 MiB** of median RSS above the candidate's initial editor idle reading. After eight additional cycles, closed RSS was **8.48 MiB** above the first closed stage and footprint was **4.27 MiB** above it. No shell or helper remained at either closed stage. These short runs measure process cleanup and remaining memory at the sampled points. Long-session memory behavior remains unmeasured.

```sh
npm run bench:terminal -- --mode baseline --target "$ION_BASELINE_BUILD"
npm run build
npm run bench:terminal -- --mode candidate
```

Raw baseline (`performance-results/terminal-baseline-2026-11-09T17-35-07.999Z.json`) · Raw candidate (`performance-results/terminal-candidate-2026-11-09T17-43-09.695Z.json`)

## Marketplace 2.0 library scaling

Measured on an Apple M3 Mac with 24 GiB RAM, macOS 27.2 (26B123), and Electron 45.2.3. The production benchmark launched a separate offline Ion session three times per library size. Each profile had the same 19 bundled listings and the stated number of installed synthetic packs, with 15 lessons per installed pack. Every session opened the same source file, measured it after one second of idle, opened Marketplace, searched for five packs, and closed Marketplace. The open sample settled for one second and the closed sample for three seconds. No network requests were observed.

| Installed packs | Editor idle RSS / footprint (MiB) | Marketplace open RSS / footprint (MiB) | After close RSS / footprint (MiB) | Open median (ms) | Search median (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 0 | 503.02 / 318.38 | 509.45 / 351.49 | 507.36 / 248.69 | 55.78 | 5.38 |
| 10 | 506.48 / 329.82 | 513.38 / 349.47 | 518.70 / 276.21 | 52.90 | 4.02 |
| 25 | 502.56 / 321.58 | 509.36 / 343.96 | 507.48 / 244.47 | 50.53 | 4.49 |
| 50 | 505.00 / 319.02 | 511.17 / 345.08 | 509.69 / 245.57 | 62.69 | 4.92 |
| 100 | 504.14 / 320.07 | 518.55 / 346.52 | 523.14 / 246.65 | 52.86 | 4.43 |

Memory values are medians across three runs, summed across the four-process Electron tree. RSS can count shared mappings more than once. Footprint uses the macOS process accounting API. The timing measures run from a sidebar click or input to the requested content appearing in the DOM. They include automation overhead. Search medians use 15 queries per size. The slowest observed open was 145.92 ms at 50 packs, and the slowest search was 67.02 ms at 100.

The 100-pack editor-only median was 1.12 MiB higher in RSS and 1.69 MiB higher in footprint than the zero-pack run. The Marketplace chunk was unloaded before the sidebar opened. At 25, 50, and 100 installed packs the list rendered only a window of rows. After closing at 100 packs, median footprint dropped by 99.87 MiB from the open sample, while median RSS stayed 19.00 MiB above the initial idle sample. The measurements show considerable run-to-run variation in footprint. One open and close per process cannot establish long-session leak behavior.

```sh
npm run build
npm run bench:marketplace -- --sizes 0,10,25,50,100
```

Raw macOS benchmark (`performance-results/learning-marketplace-2026-11-09T17-30-03.667Z.json`)

### Baseline for shared courses

The same host and three-trial protocol were used with the production build after Smart Java. Electron windows stayed hidden and the plain-text workload used only Electron's four processes. Each installed pack contained 15 synthetic lessons. The benchmark verified that the Marketplace bundle stayed unloaded until requested and that the renderer stayed offline.

| Installed packs | Editor idle RSS / footprint (MiB) | Marketplace open RSS / footprint (MiB) | After close RSS / footprint (MiB) | Open median (ms) | Search median (ms) |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 5 | 502.39 / 236.63 | 508.67 / 354.05 | 506.80 / 255.63 | 46.84 | 5.34 |
| 25 | 502.73 / 331.36 | 507.77 / 349.51 | 506.33 / 236.33 | 48.58 | 8.08 |
| 50 | 504.17 / 245.44 | 508.52 / 358.33 | 506.83 / 254.99 | 43.29 | 4.58 |
| 100 | 502.06 / 323.79 | 507.89 / 343.65 | 505.97 / 234.91 | 49.59 | 4.45 |

The idle RSS medians spanned 2.11 MiB across the four sizes. Footprint varied substantially between runs. Use this baseline for the before-and-after check when shared course navigation and storage land.

```sh
npm run bench:marketplace -- --sizes 5,25,50,100
```

Raw macOS benchmark (`performance-results/learning-marketplace-2026-11-10T15-04-21.373Z.json`)

## 0.9.4 public preview check

The final preview was compared with the earlier 0.9.4 editor build on the same Apple M3 Mac (24 GiB, macOS 27.2, Electron 45.2.3). Both use production bundles, three fresh-profile launches and three warm-profile launches, six seconds of idle sampling, ten C executions, and twelve mixed coding rounds. OS caches were left intact. Update checks were off. Two separate low-duty soak workloads were running during the final measurement. Treat small differences as variation, not a measured improvement attributable to a particular change.

| Measure | Earlier 0.9.4 | Final 0.9.4 |
| --- | ---: | ---: |
| Fresh / warm Welcome, median ms | 425.74 / 379.70 | 375.21 / 366.50 |
| Welcome idle CPU, % of one logical core | 0.34 | 0.29 |
| Welcome idle summed RSS / footprint, MiB | 422.73 / 122.49 | 418.59 / 123.00 |
| One C file summed RSS / footprint, MiB | 507.55 / 332.97 | 505.75 / 337.66 |
| Ten tabs summed RSS / footprint, MiB | 523.14 / 361.80 | 520.81 / 358.79 |
| Medium project summed RSS / footprint, MiB | 551.20 / 386.22 | 549.39 / 370.96 |
| Large source open summed RSS / footprint, MiB | 526.20 / 360.82 | 520.80 / 357.08 |
| Learn first open / close, median ms | 60.83 / 23.52 | 60.90 / 34.65 |
| Projects first open / close, median ms | 64.82 / 36.90 | 64.07 / 33.59 |
| Practice first open, median ms | 63.64 | 54.82 |
| Return to Welcome summed RSS / footprint, MiB | 612.25 / 410.60 | 607.23 / 400.36 |
| Typing to second animation callback, median ms | 31.65 | 31.50 |
| Rotating tab switch, median ms | 49.95 | 50.00 |
| Short C Run / Stop, median ms | 199.66 / 47.38 | 199.01 / 48.82 |
| Mixed coding rounds peak summed RSS, MiB | 605.44 | 603.61 |
| Mixed coding rounds summed RSS change after warm-up, MiB | −2.25 | −2.34 |

All 27 short comparison checks stayed within their tolerances. The full release gate, OS-cache-cold launch, longer session behavior, and performance on Windows or lower-memory hardware are separate checks. The 12-round sample does not establish leak-free operation. The RSS and macOS footprint figures are different measures of the same process family; RSS can count shared mappings more than once.

An intermediate check compared a macOS terminal-helper change with the previous build. Six short C runs per build measured a median of 232.25 ms before and 216.62 ms after. The baseline ran first, with a slower first sample; this small test checks for a large timing penalty and does not establish a speedup. All six interactive runs after that change returned their expected output, and no waiting CPU usage was measurable in the sample. The final build's timings are in the table above.

```sh
npm run bench:resources -- --target dist --label preview \
  --idle-seconds 6 --settle-ms 850 --launches 3 --cycles 2 --executions 10 --extended-rounds 12
```

## 0.9.4 editor reliability and workspace search

The preserved 0.9.3 production build was measured before the editor changes. Both short suites used disposable offline profiles, Electron 45.2.3 and Chromium 156.0.8078.80, an Apple M3 with 24 GiB RAM, and macOS 27.2 (26B123) on AC power. The resource harness ran three fresh-profile and three warm-profile launches per build, left OS caches intact, and sampled six seconds of Welcome idle. It then opened source files and a 1,000-file project, exercised optional panels, and ran 10 short C executions plus 12 mixed coding rounds. The study harness ran three consecutive Markdown, notebook and PDF preview cycles in one session per build with a one-second settle per stage. It recorded per-process counters and renderer heap without forced garbage collection. The low-duty baseline soak was also running during later short checks. These are local development-machine observations.

| Workload | 0.9.3 RSS / footprint, MiB | 0.9.4 RSS / footprint, MiB | Footprint change |
| --- | ---: | ---: | ---: |
| Welcome idle | 418.78 / 121.99 | 422.73 / 122.49 | +0.50 MiB (+0.4%) |
| One C file | 504.88 / 343.11 | 507.55 / 332.97 | −10.14 MiB (−3.0%) |
| Ten tabs | 520.28 / 364.85 | 523.14 / 361.80 | −3.05 MiB (−0.8%) |
| Medium project | 548.20 / 384.72 | 551.20 / 386.22 | +1.50 MiB (+0.4%) |
| Populated Practice | 607.78 / 451.19 | 612.45 / 460.76 | +9.56 MiB (+2.1%) |
| Markdown split | 610.75 / 524.41 | 615.97 / 506.32 | −18.10 MiB (−3.5%) |
| Notebook with saved plots | 646.34 / 503.10 | 648.11 / 500.33 | −2.77 MiB (−0.6%) |
| PDF beside code | 673.47 / 590.21 | 666.48 / 571.69 | −18.52 MiB (−3.1%) |
| Study workload sampled peak | 695.53 / 622.02 | 699.09 / 579.82 | −42.20 MiB (−6.8%) |
| All previews closed, ten seconds idle | 584.25 / 250.11 | 595.55 / 255.97 | +5.86 MiB (+2.3%) |
| Mixed edit/run sampled peak | 603.94 / 427.26 | 605.44 / 431.65 | +4.39 MiB (+1.0%) |

Summed RSS can count shared mappings more than once. Attributed footprint sums the macOS `phys_footprint` charges of the same process family. The three open-preview rows use medians within each cumulative study session. Footprint and RSS peaks may occur at different samples. The mixed coding peak footprint is the largest sampled settled footprint across its 12 rounds.

| Timing or CPU measure | 0.9.3 | 0.9.4 | Change |
| --- | ---: | ---: | ---: |
| Fresh-profile Welcome, median ms | 412.85 | 425.74 | +12.89 ms (+3.1%) |
| Warm-profile Welcome, median ms | 391.76 | 379.70 | −12.06 ms (−3.1%) |
| Idle CPU, % of one logical core | 0.44 | 0.34 | −0.10 percentage points |
| Mixed edit/run CPU, % of one logical core | 40.09 | 39.76 | −0.32 percentage points |
| First source file, ms | 179.05 | 180.80 | +1.75 ms (+1.0%) |
| Typing to second animation callback, median ms | 31.50 | 31.65 | +0.15 ms (+0.5%) |
| Rotating tab switch, median ms | 49.94 | 49.95 | +0.01 ms |
| Short C Run Console execution, median ms | 199.39 | 199.66 | +0.26 ms (+0.1%) |
| Markdown split readiness, median ms | 108.66 | 75.67 | −32.99 ms (−30.4%) |
| Notebook saved-plot readiness, median ms | 75.58 | 76.64 | +1.06 ms (+1.4%) |
| PDF beside code readiness, median ms | 215.99 | 220.20 | +4.21 ms (+1.9%) |

All 27 comparisons in the short resource harness were within its tolerances. The larger formal gate requires a longer protocol and was outside this run. Startup results differ in direction and the small CPU window is sensitive to background work. The timing proxy does not measure physical presentation latency or frame pacing. OS-cache-cold startup, attributable GPU utilization and presented FPS remain unmeasured.

The graphics process was the largest measured contributor in the active study sequence. With PDF beside code its median footprint was 341.39 → 325.47 MiB (−15.92 MiB, −4.7%), while the renderer JS heap was 21.66 → 21.59 MiB. Rendering only intersecting pages reduced the median canvas count from two to one at the tested split and kept the existing resolution and paging. Notebook raster decoding now creates a byte array directly, keeping image validation and cleanup. The matching notebook heap and load time do not show a dependable end-to-end reduction. Graphics allocations varied substantially after switching previews. After individual closures, PDF workers and canvases, mounted notebook cells, and Markdown images all returned to zero. Short repeated runs left no native program children, and both process trees exited at the end. The short checks establish resource teardown and leave longer-term native residency open.

Source models still cap at three live instances. Undo deltas for evicted tabs may occupy up to 20 MiB in Monaco's bounded detached cache. The short tab rotations showed essentially the same latency with session checkpoints active. The active Practice footprint rose 9.56 MiB in the measured sequence, and its source, selected challenge and sample data remain lazy. There is no persistent search index, filesystem watcher, language server, or online planner process in the normal edit path. No feature modules were removed.

Search in Files is new. On 1,016 eligible files with three matching lines in two files, the first query took 811 ms and the four repeat queries took 288–290 ms from input to grouped results, including the 160 ms debounce. Cancellation feedback took 29 ms. A separate test reaped the active child after cancellation. The 2.2 MiB oversized fixture displayed its first read-only page in 59 ms in the release regression. The previous build rejected that fixture, so it has no comparable preview latency.

The verified Apple Silicon bundle grew from 272,504,658 to 277,040,186 logical bytes (+4.33 MiB, +1.7%). The disk image grew from 123,120,640 to 124,949,504 bytes (+1.74 MiB, +1.5%). Most of the change is the signed ripgrep executable, which is launched on demand. Type checking, the production build, 117 unit tests, the complete desktop regression, and the mounted installer passed. The viewer regression exercised the missing-LibreOffice fallback. Windows and Intel Mac execution were outside this release's verification.

Core baseline (`performance-results/resources-reliability-093-baseline-2026-11-09T12-19-20.376Z.json`) · Core candidate (`performance-results/resources-reliability-094-candidate-2026-11-09T12-33-15.797Z.json`) · Study baseline (`performance-results/session-reliability-093-baseline-study-2026-11-09T12-21-13.402Z.json`) · Study candidate (`performance-results/session-reliability-094-candidate-study-2026-11-09T12-34-08.004Z.json`) · Regression (`performance-results/reliability-094-regression.log`) · Packaged check (`performance-results/reliability-094-release-check.log`)

To repeat the core and study workloads, use each preserved production directory with the same options:

```sh
npm run bench:resources -- --target "$ION_BUILD" --label "$ION_LABEL" --idle-seconds 6 --settle-ms 850 --launches 3 --cycles 2 --executions 10 --extended-rounds 12
npm run bench:session -- --target "$ION_BUILD" --label "$ION_LABEL-study"
```

### Two-hour editing runs

The soak rotates ten tabs and writes a verified edit every 30 seconds. Every fourth round runs a local C program and checks for leftover native children. Each sample records process-tree RSS, attributed footprint, per-process counters, renderer heap, DOM counters, switch time, and edit time. The report is replaced atomically after each round so samples survive an interruption. A successful full run records at least 7,200 seconds, the final process tree drains, and the report sets `complete` to `true`. The two local runs use separate disposable profiles and overlap for much of their duration, so their numbers describe observed lifecycle behavior under that load. They cannot isolate small performance differences.

```sh
/usr/bin/caffeinate -i node scripts/benchmark-session-lifecycle.mjs --target "$ION_BUILD" --label "$ION_LABEL-soak" --soak-only --soak-seconds 7200 --interval-seconds 30
```

Baseline soak samples (`performance-results/session-reliability-093-baseline-soak-2026-11-09T12-21-57.987Z.json`) · Candidate soak samples (`performance-results/session-reliability-094-candidate-soak-2026-11-09T12-35-28.631Z.json`)

Once both complete, `scripts/summarize-session-soak.mjs` writes `performance-results/reliability-094-soak-comparison.md` with sampled peaks, final memory, and latency comparisons.

The completed short checks support the release. Until both soak reports record completion, there is no verified two-hour leak or stability result. Next priorities are to evaluate the completed soak, repeat on an 8 GB Mac, and investigate Chromium's retained graphics allocation during mixed notebook and document use before changing broader renderer policy.

## 0.9.0 Guided Practice

The 27-challenge catalog contains 108 sample inputs and expected outputs. It is loaded with the optional Practice service. The editor and Welcome load no catalog or practice panel on startup.

The same Apple M3 Mac with 24 GiB RAM, macOS 27.2, and Electron 45.2.3 ran the preserved 0.8.1 build and 0.9.0. Each run used three fresh-profile and three warm-profile launches, a six-second idle window, and disposable files.

| Measurement | 0.8.1 | 0.9.0 |
| --- | ---: | ---: |
| Fresh-profile startup, median ms | 368.4 | 375.2 |
| Warm-profile startup, median ms | 387.5 | 371.8 |
| Welcome idle RSS / attributed footprint, MiB | 420.33 / 122.38 | 420.50 / 122.25 |
| Welcome idle CPU, % of one logical core | 0.51 | 0.53 |
| Typing to second animation callback, median ms | 32.00 | 31.85 |
| Populated Practice RSS / attributed footprint, MiB | 601.52 / 475.02 | 605.48 / 475.97 |

The baseline Practice stage contains a manually entered problem. The 0.9.0 stage contains a supplied problem, its sample definitions, and an open Python starter. The automated difficulty selection took 6 ms to show matches, and clicking Start took 68 ms through opening the starter. These are single interactive measurements from before the final Practice styling adjustment. The desktop suite also ran all four sample cases of one challenge in all five supported languages and verified an offline relaunch. 0.8.1 samples (`performance-results/resources-guided-practice-baseline-2026-11-09T10-27-40.591Z.json`) · 0.9.0 samples (`performance-results/resources-guided-practice-release-2026-11-09T10-40-57.283Z.json`)

The mounted 0.9.0 build passed the offline Practice and release checks. Type checking and all 102 unit tests passed. The interactive console suite stopped twice during the combined run and passed when run separately. The remaining regression suites passed. Release check (`performance-results/practice-090-release.log`)

## 0.8.0 Learning Marketplace

The catalog contains 11 packs and 73 lessons in 99,597 bytes of JSON. Ion loads Marketplace and Learn on demand. The application sends only catalog metadata, the active pack's topic titles, and the requested lesson to the renderer. The native resource test confirmed that plain code editing loads neither panel.

The comparison used the preserved 0.7.1 production build and 0.8.0 on the same Apple M3 Mac with 24 GiB RAM, macOS 27.2 (26B123), and Electron 45.2.3. It includes three fresh-profile and warm-profile launches per build, a six-second Welcome idle window, and a matched code-editing workload. OS file caches were left intact.

| Measurement | 0.7.1 | 0.8.0 |
| --- | ---: | ---: |
| Fresh-profile startup, median ms | 415.5 | 390.7 |
| Warm-profile startup, median ms | 363.1 | 369.5 |
| Welcome idle RSS / attributed footprint, MiB | 420.50 / 122.58 | 420.83 / 123.08 |
| Welcome idle CPU, % of one logical core | 0.29 | 0.50 |
| One C file RSS / attributed footprint, MiB | 507.03 / 339.57 | 507.30 / 330.63 |
| Typing to second animation callback, median ms | 31.80 | 31.90 |
| Populated Learn RSS / attributed footprint, MiB | 588.27 / 455.32 | 597.02 / 482.27 |

The measurements show similar core editing costs in this run. The populated Learn samples represent different content, with the old C explanation on 0.7.1 and a selected pack lesson on 0.8.0. The new run also opened Marketplace first. Marketplace alongside Learn used 593.42 MiB summed RSS and 468.01 MiB attributed footprint after the earlier editor and runner stages. Installing the bundled C pack took 45 ms and opening the first lesson took 64 ms in that run. 0.7.1 samples (`performance-results/resources-learning-marketplace-baseline-2026-11-09T10-05-45.407Z.json`) · 0.8.0 samples (`performance-results/resources-learning-marketplace-release-2026-11-09T10-12-26.461Z.json`)

The first Marketplace implementation took a median 302.8 ms from a renderer click to the first catalog button appearing in the DOM. Replacing the suspense reveal with an explicit asynchronous load brought the median to 4.3 ms across three fresh sessions with Learn already open. The metric measures DOM readiness and excludes display latency. Before (`performance-results/marketplace-080-first-open-probe.json`) · After (`performance-results/marketplace-080-first-open-final.json`)

The Apple Silicon bundle grew by 133,947 logical bytes and the disk image grew by 46,592 bytes compared with 0.7.1. Type checking, the production build, all 92 unit tests, the full desktop regression suite, and the offline Marketplace install and lesson check from the mounted disk image passed. Release check (`performance-results/marketplace-080-release.log`)

## 0.7.1 Offline Markdown preview

Ion keeps the source tab’s Monaco model and editor while switching between Markdown views. The preview loads on first use. Split View reads the live buffer after a 100 ms debounce. Source mode suspends preview updates and releases image URLs. The active tab keeps one bounded rendered document for fast toggles and releases it on tab switch or close. Code blocks reuse Monaco grammars without adding editor instances.

The comparison uses the preserved 0.7.0 production build and the 0.7.1 candidate on an Apple M3 with 24 GiB RAM, macOS 27.2 (26B123), and Electron 45.2.3. It matches idle, C source, and Markdown source workloads. The older build has no rendered Markdown mode. The candidate trials also measure Preview and Split View using a 16 kB Markdown file with a 640 × 400 local image, followed by repeated opening and closing. All fixtures and profiles are disposable. Whole-tree RSS can count shared pages more than once. macOS attributed footprint and renderer JavaScript heap are recorded separately.

```sh
npm run bench:markdown -- --baseline performance-results/ion-0.7.0-before-markdown-preview-dist \
  --candidate dist --trials 3 --cycles 32 --settle-ms 250 --idle-ms 5000
npm run bench:markdown -- --baseline performance-results/ion-0.7.0-before-markdown-preview-dist \
  --candidate dist --trials 1 --cycles 100 --settle-ms 250 --idle-ms 30000
```

| Workload | 0.7.0 RSS / footprint (MiB) | 0.7.1 RSS / footprint (MiB) |
| --- | ---: | ---: |
| Welcome idle | 438.33 / 159.43 | 438.53 / 158.52 |
| C source open | 511.50 / 342.90 | 511.88 / 332.54 |
| Markdown in Source mode | 521.83 / 353.47 | 522.75 / 342.36 |
| Preview open | — | 547.59 / 384.51 |
| Split View open | — | 558.56 / 410.58 |

Median fresh-profile startup was 376 ms before and 387 ms after. Welcome used 1.21% and 1.01% of one logical core in a 1.5-second sample. These short samples describe this test run. The first preview appeared in 89 ms, including local image decoding. Repeated openings took 59 ms for Preview and 81 ms for Split View, down from 79 ms and 114 ms in the first implementation. Returning to Source took 35 ms in both modes.

| Repeated toggling | Rebuilt on each toggle | Reused active preview |
| --- | ---: | ---: |
| Whole-tree RSS after 32 cycles and five seconds idle, MiB | 642.09 | 592.09 |
| macOS attributed footprint at the same point, MiB | 398.57 | 352.83 |
| Renderer heap at the same point, MiB | 34.57 | 17.58 |
| Highest RSS sampled immediately after a cycle, MiB | 676.08 | 623.14 |
| Median RSS change from cycles 4 and 8 to cycles 28 and 32, MiB | +60.00 | +17.76 |

Every sampled return to Source kept one Monaco instance and released all rendered images. The first implementation recreated thousands of DOM nodes on each toggle. In the shipped build, the renderer held 5,525–6,547 DOM nodes after the five-second settle, down from 39,776–59,319. A separate diagnostic garbage collection converged to 5,525 nodes and 14.98 MiB median renderer heap. Switching to C removed the preview pane.

During rapid toggles, the median late-cycle macOS footprint still grew by 43.11 MiB from the early-cycle sample. Per-process samples showed 30–37 MiB of late-cycle growth in GPU footprint. The GPU footprint fell by 127–133 MiB during the five-second idle period. The test observed no buildup of live preview panes, images, or editor instances over 96 cycles across three sessions. Native allocations remained elevated in the short window. First implementation samples (`performance-results/markdown-preview-2026-11-09T09-47-52.865Z.json`) · Matched release samples (`performance-results/markdown-preview-2026-11-09T09-53-04.322Z.json`)

The final production bundle adds a guard against observer callbacks queued before cleanup. A single session on that exact bundle ran 100 cycles with a 30-second natural settle. Peak sampled RSS was 636.30 MiB. Between cycles 80 and 100, RSS increased from 622.69 to 635.53 MiB and footprint increased from 555.38 to 585.15 MiB. After 30 seconds idle, RSS fell to 580.22 MiB and footprint fell to 216.41 MiB. The source-only 0.7.0 run settled at 506.61 MiB RSS and 155.66 MiB footprint. Renderer heap settled at 15.56 MiB with 5,525 DOM nodes. A subsequent diagnostic collection freed 0.16 MiB of heap. Every sampled return to Source had one editor and zero preview images, and switching to C released the preview. Native memory grew during the burst and receded during idle. The test observed no accumulating live preview resources. Final production 100-cycle report (`performance-results/markdown-preview-2026-11-09T09-56-36.699Z.json`)

The production build emits a 9.57 kB JavaScript preview chunk and 3.18 kB stylesheet before compression. It reuses the existing Marked dependency and Monaco grammars. The native test confirms that ordinary code editing and Markdown Source mode leave the preview chunk unloaded until the first preview. The same test uses a byte-for-byte copy of `Coupling.md` and verifies that the original bytes stay intact.

The Apple Silicon app bundle grew by 25,111 logical bytes and the disk image grew by 2,048 bytes compared with 0.7.0. Type checking, the production build, all 88 unit tests, the desktop regression suite, and an offline smoke test from the mounted disk image passed. Release check (`performance-results/markdown-071-release-check.log`)

## 0.7.0 macOS offline notebook support

The notebook renderer loads when an `.ipynb` tab first opens. Its viewport mounts only nearby cells and releases decoded image previews as cells leave that range. Cell editing creates one Monaco widget for the selected cell. A Python broker and its kernel start after the user approves a run, and both belong to the application’s measured process tree. The default policy releases them when the notebook tab closes.

The comparison uses preserved 0.6.4 and 0.7.0 production bundles on an Apple M3 Mac with 24 GiB RAM, macOS 27.2 (26B123), and Electron 45.2.3. The 0.6.4 build opens small notebooks as raw JSON and rejects the large plot fixture at its source editor limit. Viewing plots and running a kernel are new workloads, so those rows have no equivalent baseline. All runs use synthetic files and disposable profiles with the renderer offline. The table reports medians across three trials per build. RSS sums resident pages across the process tree and can count shared pages multiple times. The second memory number is the sum of macOS `phys_footprint` charges for those processes.

| Workload | 0.6.4 RSS / footprint (MiB) | 0.7.0 RSS / footprint (MiB) |
| --- | ---: | ---: |
| Welcome idle | 443.30 / 144.93 | 438.55 / 143.43 |
| C source tab open before any notebook | 514.34 / 326.00 | 514.83 / 318.05 |
| Small notebook, 6 cells and 6.7 kB | 521.75 / 337.71 | 537.61 / 375.33 |
| Notebook with 100 cells, 16.4 kB | 525.38 / 345.82 | 545.61 / 386.94 |
| After closing the 100-cell notebook | 532.23 / 312.93 | 548.03 / 311.41 |
| Three saved 960 × 560 plots, 5.8 MB notebook, peak while viewing | File exceeded source limit | 609.53 / 441.11 |
| After closing the plot notebook | No comparable view | 606.55 / 388.47 |
| After ten 100-cell notebook open and close cycles and two seconds idle | 551.22 / 246.16 | 573.22 / 273.04 |

Welcome appeared at 396 ms on 0.6.4 and 398 ms on 0.7.0. The 1.5-second Welcome CPU sample was 8.65% and 3.65% of one core. The short window is sensitive to startup activity. Opening the small notebook took 45 ms as JSON and 87 ms in the notebook view. The 100-cell file took 37 ms as JSON and 60 ms in the notebook view. The first large plot appeared after 96 ms. Opening time covers the click through visible content or the first decoded plot.

The follow-up scroll probe observed movement on all ten wheel inputs per build. Median wheel-to-movement plus one animation callback was 32.70 ms in the raw Monaco editor and 18.25 ms in the native 100-cell view. These are timing proxies for the tested viewport and input, with neither display latency nor frame rate included. Scroll report (`performance-results/notebook-scroll-confirmation/notebooks-2026-11-09T09-26-43.914Z.json`)

A basic Anaconda kernel started and executed its first cell in 797 ms. The broker and kernel processes accounted for 124.28 MiB RSS and 89.85 MiB attributed footprint. The paired change in the full tree was 128.06 MiB RSS and 84.41 MiB footprint. Whole-tree RSS measured 525.00 MiB before the run, 649.41 MiB while the kernel was running, and 525.84 MiB after Stop. No kernel descendants remained after Stop.

The first trial also reopened the large plot notebook ten times. The closed-tab RSS samples rose from 616.80 to 693.77 MiB, and the attributed footprint rose from 441.90 to 512.94 MiB. The renderer accounted for most of the rise. Every close left zero mounted notebook cells or decoded image elements. The short-interval snapshots show retained memory after tab closure, and do not establish its lifetime. Matched benchmark report (`performance-results/notebooks-2026-11-09T09-23-46.671Z.json`)

A separate 20-cycle diagnostic reopened the same plot notebook with 450 ms settles. Whole-tree RSS and attributed footprint measured 516.23 / 320.32 MiB before opening, peaked at 713.59 / 609.61 MiB, and ended at 699.98 / 560.82 MiB after close 20. After 6.5 seconds of natural idle they fell to 649.09 / 381.94 MiB. An explicit renderer GC used only by the diagnostic reduced them to 621.39 / 335.68 MiB. Renderer JS heap use was 13.37 MiB before the first open, 32.37 MiB after natural idle, and 13.16 MiB after that GC. Zero notebook cells or image elements remained at every close. This run found collectible renderer allocations and memory the process tree still held. It leaves the length of that residency and behavior over longer sessions open. Diagnostic data (`performance-results/notebook-plot-residency-2026-11-09T09-30-12.416Z.json`) · Diagnostic script (`performance-results/notebook-plot-residency.mjs`)

```sh
npm run bench:notebooks -- --baseline performance-results/ion-0.6.4-before-notebooks-dist --candidate dist \
  --trials 3 --cycles 10 --settle 450 --kernel-python /path/to/python
```

The desktop notebook checks cover safe saved output, 240-cell virtualization, source fallback, save conflicts, detached recovery after a renderer crash, actual Python state between cells, live Pandas and Matplotlib output, tab switching during execution, and kernel cleanup. The full IDE regression passed on rerun after an initial Run Console input timeout. The packaged Apple Silicon app passed its mounted smoke test, including opening a notebook offline. The DMG grew from 123,003,904 to 123,047,936 bytes. Notebook tests (`performance-results/notebook-070-final-desktop.log`) · Full regression (`performance-results/notebook-070-regression-retry.log`) · Mounted release check (`performance-results/notebook-070-release-check.log`)

## 0.6.4 macOS large-file reopen memory

Monaco was starting a full syntax pass as soon as a large source tab became active. A quick open and close paid for most of that pass and repeatedly allocated tokens that were immediately discarded. The renderer eventually collected the detached DOM and heap objects, but normal collection left a high resident-memory peak during the burst.

Ion now starts the default whole-file background syntax pass after a model with at least 1,048,576 UTF-16 code units has been attached for 500 ms. Closing or switching away cancels pending work. Visible lines and explicit tokenization still use Monaco's ordinary path. If the file stays open, Monaco computes full syntax state in its usual idle slices. A separate change skips full-file line projection requests when simple word wrap is off and there is no injected text. Wrapped lines, folding, and injected text still use the existing editor behavior. Both changes are scoped to the pinned Monaco build and use source checks to flag dependency changes.

The comparison used production bundles with identical Electron 45.2.3 and Chromium 156.0.8078.80 on an Apple M3 with 24 GiB RAM and macOS 27.2 (26B123). Each trial used a fresh disposable profile, an offline renderer, a small C file left open, and synthetic 1,573,807-byte C files with 28,002 lines. The default workload held each file open for 200 ms after visible text appeared and settled for 200 ms after close. Peak figures are the highest sampled values within the workload, summarized across fresh trials. RSS sums the resident sets of the full app process tree and can count shared mappings multiple times. The macOS kernel's attributed footprint is reported separately. The benchmark samples natural idle before its separate diagnostic GC. The release uses normal garbage collection.

The original benchmark reproduced the reported spike in three runs at 688.84–695.77 MiB after the eighth close. For the matched eight-cycle comparison, these are medians of three independent trials per build and workload.

| Eight rapid open/close cycles | Same file 0.6.3 | Same file 0.6.4 | Distinct files 0.6.3 | Distinct files 0.6.4 |
| --- | ---: | ---: | ---: | ---: |
| Peak process-tree RSS, MiB | 689.63 | 584.02 | 692.78 | 580.94 |
| Peak renderer RSS, MiB | 335.48 | 229.97 | 335.98 | 226.94 |
| Peak attributed footprint, MiB | 473.21 | 375.86 | 511.11 | 398.15 |
| Process-tree RSS after ten seconds idle, MiB | 684.38 | 579.19 | 687.31 | 575.83 |
| Attributed footprint after ten seconds idle, MiB | 320.80 | 230.68 | 320.58 | 228.46 |
| CPU time for the eight cycles, ms | 2,025.98 | 521.42 | 2,004.12 | 533.35 |
| Idle CPU, % of one logical core | 1.33 | 1.31 | 1.38 | 1.29 |
| First large source open, ms | 69.25 | 45.76 | 63.54 | 38.76 |
| Median large source open / close, ms | 37.34 / 27.42 | 35.58 / 29.87 | 32.85 / 27.03 | 33.12 / 27.97 |

The view-projection change alone cut some opening work but still peaked at 695–697 MiB. The cancellable syntax pass was needed for the memory reduction.

In one 24-cycle comparison with distinct files, peak process-tree RSS fell from **769.27 to 615.25 MiB**, attributed footprint fell from **583.24 to 422.40 MiB**, and CPU time fell from 5.42 to 1.48 seconds. The candidate measured 615.25 MiB at close 16 and 612.59 MiB at close 24. It still grew from 584.50 MiB at close 8. This run covers one short burst and cannot establish a long-session memory bound.

Holding each distinct file open for one second allowed whole-file syntax work. In two trials per build, peak RSS fell from 686.32 to 675.91 MiB and attributed footprint fell from 495.24 to 479.53 MiB. CPU time rose from 2.19 to 2.43 seconds across eight cycles, mainly in the renderer. Median click-to-visible latency was 34.43 to 32.37 ms. The larger savings apply to short visits that can cancel syntax work.

| Raw trials | 0.6.3 | 0.6.4 |
| --- | --- | --- |
| Eight rapid reopens of one file | Before (`performance-results/editor-residency-before-063-final-same-2026-11-09T08-20-40.786Z.json`) | After (`performance-results/editor-residency-after-064-final-same-2026-11-09T08-21-29.458Z.json`) |
| Eight distinct files | Before (`performance-results/editor-residency-before-063-final-distinct-2026-11-09T08-22-18.981Z.json`) | After (`performance-results/editor-residency-after-064-final-distinct-2026-11-09T08-23-07.401Z.json`) |
| Eight distinct files held open for one second | Before (`performance-results/editor-residency-before-063-longer-distinct-2026-11-09T08-23-56.338Z.json`) | After (`performance-results/editor-residency-after-064-longer-distinct-2026-11-09T08-24-26.215Z.json`) |
| 24 distinct files | Before (`performance-results/editor-residency-before-063-extended-distinct-2026-11-09T08-24-55.972Z.json`) | After (`performance-results/editor-residency-after-064-extended-distinct-2026-11-09T08-25-13.661Z.json`) |

```sh
npm run build
for mode in same distinct; do
  npm run bench:editor-residency -- --target /path/to/preserved-0.6.3-dist --label before-063 --mode "$mode" --trials 3
  npm run bench:editor-residency -- --target dist --label after-064 --mode "$mode" --trials 3
done
```

Use `--open-ms 1000` to keep the syntax pass eligible to finish before each close. Use `--rounds 24` to check a longer rapid-reopen burst. Run builds and benchmarks sequentially on the same machine.

The production regression passed all 76 automated tests and the desktop suites. The large-file test covers visible and deep multiline syntax colors, folding, wrapping, Find/Replace, undo/redo, exact disk saves, and reopening an external revision. Separate runs verified PowerPoint through local LibreOffice and the upgrade of a disposable 0.6.3 profile. The Apple Silicon disk image passed checksum and signature verification, and the mounted copy passed offline viewer, terminal, theme, and crash recovery checks. The packaged main and renderer entries match the benchmarked production bundle. Regression log (`performance-results/large-file-064-regression.log`) · PowerPoint log (`performance-results/large-file-064-powerpoint.log`) · Upgrade log (`performance-results/large-file-064-upgrade.log`) · Packaging log (`performance-results/large-file-064-package.log`)

## 0.6.3 macOS editor and viewer memory

### First launch from a fresh signed copy

In the 0.6.2 diagnostic, the parent returned from spawn in 1.81 ms, the local inspection port appeared at 2,486.76 ms, and Welcome appeared at 2,714.55 ms. The unified log places 2.280 s between AMFI's first assessment of Ion's ad-hoc-signed executable and its first validation of Electron Framework, with repeated notarization checks in between. Two earlier copies showed the same sequence. This accounts for most of the delay in the fresh-copy experiment. Ordinary Finder timing and the cost for a notarized build remain unverified.

Ion preserves strict bundle validation, renderer sandboxing, context isolation, and the offline request policy. This Mac had no valid signing identity for a Developer ID comparison. A separately signed build with a stapled notarization ticket can test that distribution path while preserving Gatekeeper checks and offline availability of the ticket. [Apple macOS distribution guidance](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)

The startup timing is in `performance-results/packaged-runtime-2026-11-09T07-51-13.180Z.json`. The correlated redacted trace is `performance-results/launch-policy-0.6.2-2026-11-09T07-51-13.180Z.log`.

### Changes and matched production workload

Monaco no longer requests separate compositor layers for editor lines and the gutter. Chromium can still composite them when needed, and hardware acceleration stays enabled. When a document is shown without a split, the source editor detaches its model from the hidden widget. It keeps the bounded model cache, undo data, and parked view state for return to source or a split. The release uses the same offline workflows, runtime dependencies, and data formats.

The matched pair used an Apple M3 with 24 GiB RAM, arm64 macOS 27.2 (26B123), Electron 45.2.3 / Chromium 156.0.8078.80, and battery power. It measured five fresh and five warm starts per build, a 15-second idle window, 1.5-second settles, and 15 mixed coding rounds. The baseline was copied before app changes. Summed RSS includes shared mappings that can appear in several processes. Attributed footprint is the sum of macOS process-ledger charges and includes graphics allocations.

| Metric | 0.6.2 | 0.6.3 |
| --- | ---: | ---: |
| Fresh-profile / warm-profile Welcome, median ms | 406.38 / 388.19 | 379.62 / 381.28 |
| Welcome idle RSS / attributed footprint, MiB | 420.42 / 118.88 | 418.43 / 119.59 |
| Welcome idle CPU, % of one logical core | 0.59 | 0.32 |
| One C file RSS / attributed footprint, MiB | 505.25 / 245.80 | 504.59 / 230.69 |
| Ten tabs RSS / attributed footprint, MiB | 523.27 / 318.86 | 520.91 / 267.36 |
| 1,000-file project RSS / attributed footprint, MiB | 544.17 / 318.97 | 542.20 / 256.43 |
| Project GPU-helper attributed footprint, MiB | 147.00 | 85.19 |
| 1.50 MiB source open RSS / attributed footprint, MiB | 526.38 / 365.96 | 526.98 / 368.02 |
| First source open / cached tab switch, median ms | 179.51 / 49.79 | 179.21 / 49.83 |
| Keydown to second animation callback, median ms | 31.75 | 31.80 |
| Short C Run / Stop through process exit, median ms | 240.47 / 48.41 | 229.40 / 49.03 |
| Mixed coding peak summed RSS, MiB | 681.63 | 683.03 |
| Mixed coding CPU including native child work, % of one core | 39.45 | 40.21 |

The initial project snapshot dropped 62.55 MiB in attributed footprint, with 61.81 MiB from the GPU process. Ten-tab footprint dropped 51.50 MiB, with 48.84 MiB from the GPU process. Whole-tree RSS changed by only a few MiB. The larger source workload and the mixed coding peak retained essentially the same RSS. Startup above describes the unpackaged production harness and includes normal run-to-run variation.

The shorter repeat used the same source, tab, project and 1.5-second settling steps, with one startup pair, a five-second idle window, and no extended coding rounds. One-file footprint moved **247.77 → 232.08 MiB**, ten tabs **312.27 → 257.16 MiB**, and the project **314.97 → 248.69 MiB**. The project GPU helper moved **147.33 → 84.89 MiB**. Project summed RSS moved **545.61 → 541.09 MiB**. The repeat supports a lower graphics footprint during code editing, with a much smaller change in whole-tree RSS. These reports are `performance-results/resources-mac-memory-repeat-baseline-2026-11-09T08-05-17.282Z.json` and `performance-results/resources-mac-memory-repeat-candidate-2026-11-09T08-05-53.103Z.json`.

A separate compositor diagnostic found **12 → 9 layers** and **5 → 2 drawing layers**. The two 2× Retina screenshots were byte-identical at 2520 × 1580. Twelve wheel inputs moved the editor in both builds, with median scroll-to-animation-callback proxy latency of 33.20 → 33.05 ms. The probe does not measure presented FPS, compositor frame pacing, or GPU utilization. Compositor JSON (`performance-results/editor-compositor-2026-11-09T07-56-27.831Z/result.json`)

Raw matched reports are `performance-results/resources-mac-performance-baseline-2026-11-09T07-48-59.815Z.json` and `performance-results/resources-mac-performance-candidate-2026-11-09T07-55-00.329Z.json`. All 32 enforced comparisons passed. The initial pair's active footprint checks were advisory under the gate's two-observation rule. Gate output is `performance-results/mac-performance-gate.log`.

```sh
node scripts/benchmark-resources.mjs --target performance-results/ion-0.6.2-before-mac-performance-dist \
  --label mac-performance-baseline --idle-seconds 15 --settle-ms 1500 --launches 5 --cycles 6 --executions 4 --extended-rounds 15
node scripts/benchmark-resources.mjs --target dist \
  --label mac-performance-candidate --idle-seconds 15 --settle-ms 1500 --launches 5 --cycles 6 --executions 4 --extended-rounds 15
node scripts/benchmark-editor-compositor.mjs --baseline performance-results/ion-0.6.2-before-mac-performance-dist --candidate dist
```

Type checking, the production build, all 76 automated tests, and the desktop file, recovery, keyboard, five-language runner, workspace, export, lifecycle, theme and viewer checks passed. The viewer checks were rerun after changing the CSV split assertion to target the retained editor host and updating the DOCX test's pointer/focus setup. This tests the intended Monaco view detachment while preserving folds, selection, and undo. PowerPoint passed with the local LibreOffice engine. The mounted Apple Silicon installer passed checksum, strict code-signature, PTY, offline preview, palette, theme, and recovery checks. Intel macOS and other operating systems were outside this run.

The verified 0.6.3 bundle is **272,140,991 logical bytes** versus 272,140,830 for 0.6.2. The DMG is **123,003,904 bytes** versus 123,002,880. The previous local installer is available for rollback, and the release uses the same profile and data formats.

### Signed bundle and document checks

Both release bundles were copied to disposable directories, checked with strict code-signature verification, and launched with isolated profiles. This protocol uses a 5-second settle before each idle window and a tiny C fixture. Three fresh-profile and three same-profile launches were collected per build. The first row is the first run from each newly copied bundle.

| Signed app metric | 0.6.2 | 0.6.3 |
| --- | ---: | ---: |
| First launch to visible Welcome, s | 2.679 | 2.444 |
| First launch to local inspection port, s | 2.469 | 2.225 |
| Later fresh-profile launches to Welcome, range ms | 359–368 | 377–379 |
| Same-profile relaunch to Welcome, median ms | 351 | 405 |
| Welcome idle RSS / attributed footprint, MiB | 408.63 / 118.07 | 408.63 / 119.68 |
| Welcome idle CPU over about 30 s, % of one core | 0.31 | 0.24 |
| One tiny C file idle RSS / attributed footprint, MiB | 478.99 / 169.15 | 476.88 / 160.82 |
| One tiny C file idle CPU over about 15 s, % of one core | 1.66 | 1.64 |

The candidate still incurs the fresh-copy assessment delay. The inspection port appeared 244 ms sooner in this single pair, while port-to-Welcome took 210 → 219 ms. That difference gives no evidence of a source-level first-launch fix. Idle Welcome was effectively unchanged in memory. The signed tiny-file case saved 8.33 MiB of attributed footprint after settling. Raw reports are `performance-results/packaged-runtime-2026-11-09T07-53-12.558Z.json` and `performance-results/packaged-runtime-2026-11-09T08-03-52.749Z.json`. Reproduce with `node scripts/benchmark-packaged-runtime.mjs --target <app-bundle>`.

The offline 160-page PDF test used three view/open/split/close cycles per build. In 0.6.3 the source editor was parked in all three document-only samples. Document-only medians were **639.77 → 641.50 MiB RSS** and **416.97 → 423.27 MiB footprint**. Split-view medians were **594.06 → 595.73 MiB RSS** and **435.86 → 433.61 MiB footprint**. These samples show similar whole-tree usage. They do not establish a viewer memory improvement. Each close removed the PDF worker and canvases. Raw reports are `performance-results/viewer-pdf-2026-11-09T07-54-14.849Z.json` and `performance-results/viewer-pdf-2026-11-09T08-04-54.966Z.json`. Reproduce with `node scripts/benchmark-viewers.mjs --target <production-dist> --cycles 3`.

The separate editor residency diagnostic opened and closed a synthetic 1.5 MiB source eight times. After the last close, whole-tree RSS was **693.61 → 694.77 MiB** and renderer JS heap in use was **42.64 → 42.89 MiB**. An explicit diagnostic GC returned both renderers to **13.05 MiB** of used JS heap and **399** DOM nodes. Process-tree RSS fell to **598.38 → 599.72 MiB**. This shows that much of the renderer churn in this sample was collectible and that the change does not reduce the large-file peak. The application uses Chromium's normal GC policy. Raw reports are `performance-results/editor-residency-2026-11-09T08-06-28.535Z.json` and `performance-results/editor-residency-2026-11-09T08-06-34.692Z.json`.

## 0.6.2 release gate

Use the previous release's preserved production bundles as the baseline. Run both workloads on the same hardware, macOS version, Electron/Chromium version, Node version, and power source. Use a quiet desktop, allow each run to exit, and retain the JSON reports. Fresh-profile startup means a new process and disposable profile with OS caches intact.

```sh
npm run bench:resources -- --target performance-results/ion-0.6.1-before-readiness-dist \
  --label readiness-extended-baseline --idle-seconds 10 --settle-ms 500 --launches 5 \
  --cycles 6 --executions 4 --extended-rounds 20
npm run bench:resources -- --target dist \
  --label readiness-extended-candidate --idle-seconds 10 --settle-ms 500 --launches 5 \
  --cycles 6 --executions 4 --extended-rounds 20
npm run check:performance -- --baseline-report "$ion_baseline_report" --candidate-report "$ion_candidate_report"
```

The gate compares completed reports with matching protocols and at least five startup pairs, six panel cycles in total, four short C runs, and eleven editing rounds. The 0.6.2 release workload sampled two close/reopen cycles for each of Learn, Projects, and Practice. Each extended round switches tabs, edits and saves a note, completes a C run, and stops a waiting program. The first five rounds also reopen a 1.50 MiB C source. Stop timing includes reaping the program and its PTY helper. Benchmark profiles and workspace files are disposable. The extended process tree CPU metric includes reaped child CPU time for short-lived native work.

Thresholds are relative to the measured baseline. The gate adds the largest of an absolute noise floor, a relative allowance, or twice the spread of the supplied baseline observations. Examples include 50 ms or 12% for startup, 12 MiB or 3% for idle RSS, 0.5 percentage points for idle CPU, and 55 ms or 25% for Stop. The active footprint readings include volatile Chromium GPU allocations. They are advisory from a single pair, and the gate requires two or more observations per build plus a repeated exceedance to flag them. [Gate implementation](scripts/check-performance-regression.mjs)

### Measured release comparison

Apple M3, 24 GiB RAM, macOS 27.2 (26B123), Electron 45.2.3, Chromium 156.0.8078.80, and Node 26.11.1. Both runs were on battery power and reported no thermal or performance warning. The measured family includes Electron's main process, renderer, GPU and utility helpers, and owned native processes. RSS can count shared pages multiple times. Attributed footprint uses macOS kernel charges and includes graphics allocations that can fluctuate. The active snapshots here use a shorter settle interval than the previous release's headline table.

| Workload | 0.6.1 baseline | 0.6.2 |
| --- | ---: | ---: |
| Fresh / warm startup, median ms | 368.51 / 357.40 | 384.35 / 381.00 |
| Idle summed RSS / footprint, MiB | 417.89 / 121.54 | 421.86 / 122.30 |
| Idle CPU, % of one logical core | 0.38 | 0.65 |
| One C file / ten tabs / project, summed RSS MiB | 506.52 / 523.25 / 547.20 | 507.72 / 524.41 / 549.86 |
| First open / reopen of 1.50 MiB source, ms | 176.68 / 40.39 | 177.39 / 52.72 |
| Rotating / cached tab switch, ms | 50.02 / 49.91 | 49.95 / 49.91 |
| Short C Run / Stop including process exit, median ms | 215.59 / 47.74 | 190.68 / 51.88 |
| Reopen Learn / Projects / Practice, median ms | 51.63 / 54.20 / 52.73 | 53.42 / 58.18 / 54.46 |
| Close Learn / Projects / Practice, median ms | 39.86 / 27.97 / 35.65 | 37.92 / 34.06 / 39.97 |
| Extended 20-round duration, s | 28.24 | 27.33 |
| Extended peak summed RSS, MiB | 683.14 | 678.88 |
| Extended late minus post-warmup RSS, MiB | −8.39 | −8.50 |
| Extended CPU including reaped child work, % of one logical core | 39.40 | 39.98 |
| App bundle, logical bytes | 272,114,317 | 272,140,830 |
| Compressed DMG, bytes | 122,979,328 | 123,002,880 |

All 32 enforced comparisons passed. Seven active footprint comparisons were advisory. The candidate was slower on the sampled launches and large-file reopen and used about 4 MiB more idle summed RSS. The higher 10-second idle CPU average was concentrated in the first five seconds after a 500 ms settle. Over the last five seconds, the measurements were about 0.09% and 0.06% of one core. The data do not establish a speed or memory improvement. Extended RSS rose during the large-file warmup and ended below the post-warmup median. Every Stop reaped the PTY helper and its program, and both app process trees exited after closing their last window. The 27-second session leaves hours-long behavior unverified. GPU utilization, presented frame pacing, Intel Mac, Windows, Linux, and lower-memory hardware were outside the measured scope.

Raw reports are `performance-results/resources-readiness-extended-baseline-2026-11-09T07-14-22.281Z.json` and `performance-results/resources-readiness-extended-final-2026-11-09T07-22-49.982Z.json`. Use these paths for the two shell variables in the gate command. The complete gate table is in `performance-results/readiness-performance-gate.log`. The previous installer remains available for rollback. Use a copy of your profile when checking an older build.

### Signed-bundle spot check

`node scripts/benchmark-packaged-runtime.mjs` verified a copy of the signed 0.6.2 bundle with a disposable profile. Two observations on the same M3 used a 5-second settle, about 30 seconds idle at Welcome, and about 15 seconds idle with a tiny C file open. At Welcome they sampled 408.67–410.16 MiB summed RSS, 118.30–118.80 MiB attributed footprint, and 0.28–0.30% CPU of one core. One-file idle sampled 478.37–480.37 MiB RSS, 168.12–172.91 MiB footprint, and 1.60–2.04% CPU. Each memory figure is a range of two session medians.

The two resource checks and a separate `--startup-only` check saw 2.55–2.76 seconds to Welcome on the first launch of each new bundle copy. The subsequent fresh-profile starts took 351–438 ms and the same-profile restarts took 336–387 ms. In the diagnostic the inspection port appeared at 2.50 seconds on the slow launch and at about 145–147 ms in later launches. The cause is unverified. The package-check protocol differs from the matched gate. Full methods and raw report names are in [ION_IDE_ANALYSIS.md](ION_IDE_ANALYSIS.md).

## 0.6.1 stabilization

Measured on an Apple M3 with 24 GiB RAM, macOS 27.2 (26B123), Electron 45.2.3 and Chromium 156.0.8078.80, Node 26.11.1 for the harness, and Apple Clang 21.0.0. Both builds used the same runtime, battery power, normal macOS scheduling, and a 1260 × 790 logical-pixel window. No thermal or performance warning was reported. The comparison uses production bundles and disposable Minimal Mode profiles. Welcome timings include Playwright launching the process. Fresh-profile timings leave the macOS file and runtime caches intact.

The resource probe sums main, renderer, GPU, utility, and owned subprocesses. **RSS** sums resident pages and can count shared pages more than once. **Attributed footprint** sums macOS `phys_footprint` charges for that same family. Those charges can include GPU and other memory outside ordinary process RSS. The 25-second idle observation starts after launch settles. The project fixture has 1,000 files across 40 folders, six of which are expanded in the measured workload. Active memory rows are settled snapshots. Startup uses five fresh and five warm launches, while the editor and project rows use one workload per build.

| Metric | 0.6.0 baseline | 0.6.1 final |
| --- | ---: | ---: |
| Fresh-profile Welcome, median ms | 382.5 | 378.3 |
| Warm-profile Welcome, median ms | 382.9 | 363.9 |
| Idle attributed footprint, MiB | 117.23 | 117.83 |
| Idle summed RSS, MiB | 417.93 | 417.99 |
| Idle CPU, % of one logical core | 0.08 | 0.13 |
| One C file footprint / RSS, MiB | 244.36 / 504.83 | 248.33 / 505.28 |
| Ten tabs footprint / RSS, MiB | 310.79 / 521.72 | 315.82 / 522.16 |
| 1,000-file project footprint / RSS, MiB | 286.83 / 543.36 | 315.54 / 543.50 |
| First file open, ms | 179.5 | 164.2 |
| Subsequent file opens, median ms | 50.1 | 49.9 |
| Keydown to second animation frame, median ms | 31.8 | 31.9 |
| Short C run to verified output, median of three, ms | 248.7 | 199.7 |
| Minimal last-window close to app exit, ms | 212.4 | 213.0 |

The **300 / 400 / 600 MB** goals all pass by attributed footprint at **124 / 260 / 331 MB**. Summed RSS is **438 / 530 / 570 MB**, so the first two goals are still missed by that accounting. Five launches and three short runs support an observed result on this Mac. Timing ranges overlap across the repeated startup series. A smaller installer or faster run on other machines is unverified.

The first final project snapshot tripped the footprint comparison by 0.02 MiB beyond its 28.68 MiB allowance. GPU-helper footprint rose from 117.74 to 147.42 MiB, the renderer's fell from 116.00 to 114.27 MiB, and total RSS moved by 0.14 MiB. A fresh matched repeat of the same artifacts measured 282.58 to 286.58 MiB project footprint, with GPU-helper charges of 112.20 and 117.67 MiB. The repeat did not reproduce the flagged regression. Its short C medians were 198.8 and 199.0 ms, so the first pair's 49 ms difference is insufficient evidence of a C speedup. Final repeat idle CPU was 0.19% of one logical core. Attributable GPU utilization, presented frame pacing, OS-cache-cold boot, and lower-memory hardware were outside the measured scope.

There were no owned native children after the runs or app exit. Across three cycles per optional panel, the final closed samples showed no growth over their preceding closed samples. The lifecycle suite separately checks that normal editing leaves the optional panes, document engines, and terminal unloaded. The recovery journal reads small headers at startup, checkpoints only edited buffers, and bounds each write. The live terminal no longer retains a second full program transcript or returns streamed compiler text across IPC. C Learn retains enough context for its bounded diagnostic excerpt. The short fixture does not isolate the memory savings of streaming large output.

### Tab and run lifecycle

A separate matched scenario closed ten tabs, performed 12 open-and-close rounds of three tabs each, and timed 12 successful C runs after two warm-up runs. The harness observes the new run phase before verifying output, and reads the duration displayed by the current Run Console.

| Single lifecycle scenario per build | 0.6.0 | 0.6.1 |
| --- | ---: | ---: |
| RSS with ten tabs, MiB | 518.09 | 518.50 |
| RSS after closing those tabs, MiB | 565.06 | 565.41 |
| RSS change across 12 subsequent tab rounds, MiB | +7.89 | +8.20 |
| Renderer heap after forced GC following the tab rounds, MiB | 14.92 | 14.94 |
| RSS before → after 12 runs, MiB | 558.38 → 568.36 | 559.03 → 568.95 |
| Median warm C run, ms | 199.0 | 209.1 |
| CPU during automated typing, % of one logical core | 35.5 | 37.5 |

The scenario includes opening a larger tree before closing the ten tabs, so those two rows also reflect the intermediate explorer and rendering work. RSS fluctuated during the tab rounds and stayed elevated after closing. The warm C run RSS rose in both builds during the short sample. These observations and the post-GC heap snapshots show similar behavior across the two versions. Raw samples are in `performance-results/desktop-2026-11-09T07-06-21.167Z.json`.

A separate 100-run interactive C diagnostic verified a new program PID, prompt, keyboard input, and result on every run, then checked that the program and helper exited. Median Run-to-prompt was 212.5 ms and Enter-to-output was 21.3 ms. The waiting program and helper accumulated no measurable CPU time during the three-second wait sample. Total RSS was 510.22 MiB before the first run, 537.55 MiB after run 100, and 526.50 MiB after closing the console. Attributed footprint was 244.79, 332.68, and 216.99 MiB at those points. Renderer heap after forced GC rose from 12.24 MiB after the first run to 12.97 MiB at run 20 and 13.30 MiB at run 100. Open-console DOM and listener counts stayed constant at 636 and 317 at the checkpoints, dropping to 547 and 274 after closing. These observations cover one short session and leave longer-run memory behavior unverified. Raw samples are in `performance-results/run-console-2026-11-09T07-09-00.165Z.json`.

The ad-hoc-signed Apple Silicon app is **272,114,317 logical bytes**, up 8,561 bytes from 0.6.0. The verified DMG is **122,979,328 bytes**, down 5,120 bytes. The mounted app launched, used its bundled signed PTY, opened offline previews, and restored a real unsaved editor draft after the test terminated its disposable process.

```sh
npm run bench:resources -- --target performance-results/ion-0.6.0-before-stability-dist \
  --label stability-baseline --idle-seconds 25 --launches 5 --cycles 3 --executions 3
npm run bench:resources -- --target dist --label stability-final \
  --compare-report performance-results/resources-stability-baseline-2026-11-09T06-47-38.381Z.json \
  --idle-seconds 25 --launches 5 --cycles 3 --executions 3
npm run bench:desktop -- --compare performance-results/ion-0.6.0-before-stability-dist \
  --target dist --trials 1 --scenarios 1 --idle-seconds 8 --tab-cycles 13 --executions 12
npm run bench:run-console -- --runs 100 --gc-diagnostic
```

The preserved 0.6.0 production bundle was copied before this pass. The matched raw reports are `performance-results/resources-stability-baseline-2026-11-09T06-47-38.381Z.json` and `performance-results/resources-stability-final-2026-11-09T07-01-18.046Z.json`. The repeats are `performance-results/resources-stability-baseline-confirm-2026-11-09T07-04-17.210Z.json` and `performance-results/resources-stability-final-confirm-2026-11-09T07-05-19.629Z.json`. These reports include process membership, metric definitions, per-launch timings, and SHA-256 build identities. The final main bundle SHA-256 is `d1e7f15037cb74da2cec2d4a1238d37b1e154b7c1b5ac73f89183d89b283a464`.

## Initial baseline

The repository was empty at the start of Phase 1. There was no prior application to launch or profile. All pre-implementation measurements are unavailable. The implementation comparison uses two builds of the same application on the same runtime, with eager versus on-demand editor loading as the intervention.

The target is macOS. Windows and Linux performance are outside the Phase 1 validation scope.

## Reproduce on macOS

```sh
npm ci
npm run build:baseline
npm run build
npm run test:desktop -- --screenshots performance-results/screenshots
npm run bench:desktop -- --compare dist-baseline --target dist
```

Both builds use the production renderer and the same installed Electron binary. The comparison loads the Monaco module before Welcome renders. The default build loads it when the editor is needed. The harness uses disposable profiles and code fixtures and replaces only the native dialog responses via Playwright. The production application has no benchmark-specific IPC. Desktop tests cover Monaco and the renderer-to-main workflow with simulated native dialog choices. Run the packaged app separately to check the native dialog presentation and Finder launch behavior.

The benchmark alternates the two builds, launches each with a fresh profile, then relaunches it with that same profile. It measures readiness at the visible Welcome DOM marker. This measures process and app-profile startup, with OS caches left as they were. The default protocol collects five fresh and five warm starts and three active scenarios per build. Change the repetition count with `--trials` and `--scenarios`. Raw samples and setup parameters are written locally under `performance-results/`. A complete 40-folder, 1,000-file fixture is prepared before each measured scenario, along with ten 650-line editor files. The explorer expansion workload reveals six folders incrementally.

Memory is the sum of macOS resident-set measurements for the main process, descendants, and helpers identified by the disposable profile. Shared pages can appear in multiple processes. CPU is the process-family CPU-time delta normalized so 100% represents one logical CPU. Short-lived subprocesses can exit between samples. Idle settling is three seconds, followed by one sample per second for eight seconds by default. Memory after closing tabs and after repeated execution is sampled after a short settle. These timings catch gross drift under a short workload. A longer repeated-run sample is available by increasing `--executions`. The typing metric starts at a verified Chromium keydown and ends after the second animation callback. It does not measure OS input or compositor presentation latency.

For packaged size, pass the DMG with `--target-installer` and record the corresponding app bundle separately. The packaged app disables inspector arguments, so the automated runtime benchmarks use the production bundles before packaging.

For a renderer CPU profile, run `npm run bench:desktop -- --trials 1 --scenarios 1 --renderer-profile` and load the resulting `.cpuprofile` in Chromium DevTools. Compare timings from separate runs with profiling disabled.

## Eager versus on-demand Monaco

This comparison measures the initial startup optimization with React Suspense present in both builds. The on-demand build improved fresh-profile Welcome readiness by 23%, warm Welcome readiness by 21%, and Welcome RSS by 45.79 MiB (10%). The three observed idle windows per build had the same median CPU use. Each observed idle process family contained one main, one renderer, one GPU and one Chromium utility process. The process family had exited before every warm relaunch.

The active results show a different tradeoff. The on-demand build sampled about 6 MiB more with one tab and about 10 MiB more with the medium tree than the eager build in this series. The sample is small, and the startup change has no demonstrated active-memory benefit. Both variants took about 380 ms to open the first file and about 50 ms for subsequent files. The editor's first reveal was then investigated separately.

Environment was an Apple M3 with 24 GiB RAM, macOS 27.2 build 26B123, arm64, Electron 45.2.3, Chromium 156.0.8078.80, Node.js 26.11.1 for the harness, and Apple Clang 21.0.0. The machine was on battery power and macOS reported no thermal or performance warning. The 1260 × 790 logical-pixel window ran on the local desktop under normal system load. Figures are medians with observed ranges in brackets.

| Metric | Eager | On demand | Samples per build |
| --- | ---: | ---: | ---: |
| Fresh process and profile to Welcome, ms | 481.84 [467.65–556.30] | 369.08 [348.62–397.32] | 7 |
| Warm profile to Welcome, ms | 464.82 [448.99–552.21] | 367.13 [352.87–377.79] | 7 |
| Welcome idle RSS, MiB | 463.92 [461.81–464.59] | 418.13 [417.31–419.20] | 3 windows |
| Welcome idle CPU, % of one core | 0.12 [0.12–0.24] | 0.12 [0.00–0.24] | 3 windows |
| RSS with one file, MiB | 503.86 [503.45–504.41] | 509.58 [507.83–510.05] | 3 |
| RSS with ten tabs, MiB | 525.86 [525.19–527.27] | 528.47 [527.17–529.27] | 3 |
| RSS with 1,000-file project and six folders expanded, MiB | 542.64 [542.02–545.84] | 552.25 [546.88–552.66] | 3 |
| RSS after closing all ten tabs, MiB | 569.27 [568.94–570.14] | 568.70 [567.00–569.23] | 3 |
| Folder open to explorer entries, ms | 64.77 [63.08–66.84] | 54.43 [50.27–67.09] | 3 |
| First file open to verified editor text, ms | 381.43 [379.71–403.87] | 382.70 [379.70–397.33] | 3 |
| Subsequent file open to verified editor text, ms | 49.76 [25.86–83.17] | 49.96 [33.48–63.60] | 27 |
| Expand six folders, ms | 380.46 [345.69–404.39] | 374.84 [326.66–398.64] | 3 |
| Typing to second animation frame, ms | 31.70 [21.30–32.40] | 31.90 [22.80–32.50] | 90 |
| App CPU during automated typing, % of one core | 34.75 [32.33–38.78] | 30.18 [28.17–36.60] | 3 windows |
| C compile and execution to verified output, ms | 165.77 [148.05–366.28] | 166.34 [136.37–233.55] | 36 |
| RSS before → after 12 C runs, MiB | 571.16 → 572.06 | 570.98 → 572.02 | 3 series |
| Paired RSS change across 12 C runs, MiB | +0.91 [+0.86 to +1.08] | +1.03 [−0.19 to +3.38] | 3 series |
| App code and assets, logical bytes excluding Electron | 3,609,862 | 3,609,853 | 1 build |

Each C execution series was observed for about 3.6–3.8 seconds after two warmup runs, including a 1.5-second settle. The before and after snapshots measure retained app memory. A compiler or program that exited between samples was outside that snapshot. The checked renderer requested no remote resources during the observed workflows. Reproducible release-build evidence is in `performance-results/desktop-2026-11-09T04-26-24.532Z.json`. The original binaries were retained locally under `performance-results/eager-suspense-dist` and `performance-results/suspense-dist`. To repeat the historical comparison with those binaries, pass them as `--compare` and `--target` respectively and use `--trials 7`.

OS-cache-cold launch, native presented FPS, GPU utilization, and long-duration memory behavior were not measured. These numbers are from one machine. In particular, the near-zero idle CPU readings are subject to the macOS process CPU-time sampling resolution.

## Desktop verification

The production smoke test passed on macOS for folder and individual file opening, real Monaco edits, autosave, tab changes, find and replace, external-write conflict recovery, saving a draft through the toolbar and save dialog, and creating and renaming files and folders on disk. It also passed the execution approval gate, local compilation and output, compiler failure, stdin, Stop, panel resizing and collapse, persistent theme and recent items, and layout at 820 × 600. Playwright simulated native dialog responses. The smoke test exercised Monaco keyboard shortcuts and the toolbar Save path. The native macOS Save accelerator was outside that automated check.

### Short tab lifecycle diagnostic

A separate on-demand build run opened and closed ten files eight times, verifying all 80 opens. After each cycle it sampled with all tabs closed and the medium tree still expanded. Across about 14.9 seconds between the first and last post-close samples, summed RSS rose from 574.91 to 633.61 MiB. Renderer V8 heap use varied from 16.22 to 39.23 MiB and ended at 17.64 MiB. A one-off forced renderer garbage collection then brought RSS to 562.91 MiB and V8 heap use to 15.14 MiB. The observed growth was reclaimable in this diagnostic. Longer automatic reclamation behavior remains unmeasured.

```sh
npm run bench:desktop -- --target performance-results/suspense-dist --trials 1 --scenarios 1 --idle-seconds 3 --executions 6 --tab-cycles 8 --renderer-profile
```

Evidence is `performance-results/desktop-2026-11-09T04-29-25.136Z.json` and `performance-results/production-1-2026-11-09T04-29-25.136Z.cpuprofile`. Profiling and forced collection were isolated from the paired comparison.

## First-file reveal optimization

The initial measurements showed a similar delay on the first file in both builds, even when Monaco had already loaded. The final build replaces the Suspense fallback with explicit loading state. It keeps the same on-demand import and starts the editor when that import resolves. The first-file median fell by 222.52 ms (55%). Subsequent opens and typing held steady. The fresh-profile launch median was higher in this smaller series, with overlapping observed ranges. Warm startup, Welcome memory, and idle CPU were similar.

```sh
npm run bench:desktop -- --compare performance-results/suspense-dist --target dist \
  --trials 4 --scenarios 3 --idle-seconds 3 --executions 6 \
  --target-installer release/Ion-IDE-0.1.0-mac-arm64.dmg
```

| Metric | On demand with Suspense | Final on demand | Samples per build |
| --- | ---: | ---: | ---: |
| Fresh process and profile to Welcome, ms | 358.01 [352.29–364.29] | 390.76 [359.57–478.41] | 4 |
| Warm profile to Welcome, ms | 365.36 [337.39–399.46] | 367.01 [350.92–385.28] | 4 |
| Welcome idle RSS, MiB | 414.23 [413.92–414.48] | 414.58 [413.98–427.93] | 3 windows |
| Welcome idle CPU, % of one core | 0.31 [0.00–0.63] | 0.31 [0.00–0.63] | 3 windows |
| RSS with one file, MiB | 509.17 [508.77–510.63] | 509.83 [508.67–523.00] | 3 |
| RSS with ten tabs, MiB | 527.39 [527.36–528.97] | 522.91 [522.63–535.30] | 3 |
| RSS with 1,000-file project and six folders expanded, MiB | 545.58 [545.17–546.63] | 549.83 [549.25–562.39] | 3 |
| RSS after closing all ten tabs, MiB | 564.67 [564.30–565.55] | 563.16 [558.73–571.27] | 3 |
| Folder open to explorer entries, ms | 58.80 [58.77–66.79] | 58.97 [53.02–59.35] | 3 |
| First file open to verified editor text, ms | 403.74 [397.20–406.12] | 181.22 [180.31–181.25] | 3 |
| Subsequent file open to verified editor text, ms | 49.91 [23.33–50.49] | 49.96 [23.76–50.33] | 27 |
| Typing to second animation frame, ms | 31.80 [21.30–32.60] | 31.85 [18.60–32.80] | 90 |
| App CPU during automated typing, % of one core | 38.61 [36.49–40.39] | 38.47 [36.65–39.42] | 3 windows |
| C compile and execution to verified output, ms | 166.60 [149.60–231.74] | 166.46 [148.02–183.23] | 18 |
| RSS before → after six C runs, MiB | 570.72 → 571.41 | 569.48 → 570.03 | 3 series |
| Paired RSS change across six C runs, MiB | +0.69 [+0.61 to +1.03] | +0.55 [−3.87 to +0.66] | 3 series |

Raw samples are in `performance-results/desktop-2026-11-09T04-31-04.686Z.json`. Short-lived compiler processes may fall between memory samples. The historical binaries are retained for reproduction on this machine. The normal `build:baseline` command uses the final renderer with eager Monaco loading for future startup comparisons.

## Packaged macOS verification

`npm run package:dmg` produced the Apple Silicon app and a compressed disk image. The app bundle contains 267,091,126 logical bytes (254.72 MiB), including Electron. The disk image is 120,679,936 bytes (115.09 MiB). Installer sizes for the historical unpackaged comparisons are not applicable.

The final disk image passed `hdiutil verify`, mounted read-only, and contained the app and its Applications link. A copy from the image passed `codesign --verify --deep --strict` and launched its packaged Welcome and Monaco editor. A new C buffer accepted text in that packaged run. The binary is arm64 and ad-hoc signed for local use. The production settings disable Node CLI inspection and require an integrity-checked ASAR. Tests of file and runner workflows ran in the production renderer with the same Electron version before packaging.

The final `npm run typecheck`, `npm test` (nine tests), `npm audit`, `npm run build:baseline`, `npm run package:dmg`, and `npm run test:desktop` (ten workflow groups) all passed. Windows, Linux, and Intel Mac runtime verification were outside this phase.

## Follow-up audit baseline

The pre-change production artifact is preserved at `performance-results/phase1-baseline`. The longer protocol adds 120 seconds of idle observation, 30 open files, 30 repeated tab cycles, and separate process-tree accounting for C subprocesses. The prior release measurements above remain historical. The longer protocol uses the retained build as its before condition.

The follow-up runs use the same Apple M3, 24 GiB, macOS 27.2 (26B123) arm64 host, on battery power, with Electron 45.2.3 and Chromium 156.0.8078.80. Both use production bundles. The retained release from before the follow-up is 0.1.0. Its original disk image is preserved separately. The user profile was untouched.

Use the same workload on each target. Replace the target and corresponding installer argument to reproduce the other side.

```sh
npm run bench:desktop -- --target performance-results/phase1-baseline \
  --trials 7 --scenarios 1 --idle-seconds 120 --open-files 30 --tab-cycles 30 --executions 12 \
  --target-installer performance-results/phase1-baseline.dmg
npm run bench:desktop -- --target dist \
  --trials 7 --scenarios 1 --idle-seconds 120 --open-files 30 --tab-cycles 30 --executions 12 \
  --target-installer release/Ion-IDE-0.2.0-mac-arm64.dmg
```

A full active scenario is run once on each build. It opens 30 files of 650 lines, records the first, tenth, and thirtieth points, and expands six folders in a 1,000-file project. The initial close of 30 tabs is followed by 29 three-file open/close cycles and a separate renderer GC sample. The 120-second idle interval starts after a three-second settle. Native toolchain processes are sampled separately from Electron during a C run with a 350 ms program delay. The compiler is Apple Clang. The timing suite leaves OS caches intact. The two launch series have seven fresh and seven warm starts each.

### Free Coding before and after

| Metric | 0.1.0 before | 0.2.0 after | Absolute and relative change |
| --- | ---: | ---: | ---: |
| Fresh-profile process startup, ms | 394.26 | 400.75 | +6.49 (+1.6%) |
| Warm-profile startup, ms | 381.38 | 404.34 | +22.96 (+6.0%) |
| Median Welcome RSS, MiB | 417.13 | 415.22 | -1.91 (-0.5%) |
| Welcome RSS after 120 seconds, MiB | 416.50 | 415.41 | -1.09 (-0.3%) |
| Idle CPU, percentage of one core | 0.16 | 0.09 | -0.07 (-43.8%) |
| RSS with one file, MiB | 513.11 | 511.94 | -1.17 (-0.2%) |
| RSS with ten files, MiB | 520.78 | 520.45 | -0.33 (-0.1%) |
| RSS with 30 files, MiB | 555.08 | 559.05 | +3.97 (+0.7%) |
| RSS with medium project expanded, MiB | 566.45 | 565.59 | -0.86 (-0.2%) |
| RSS after initially closing all tabs, MiB | 590.73 | 590.75 | +0.02 (+0.0%) |
| First file open, ms | 186.87 | 183.07 | -3.80 (-2.0%) |
| Subsequent file open, ms | 49.99 | 50.06 | +0.07 (+0.1%) |
| Typing to second animation frame, ms | 31.70 | 31.60 | -0.10 (-0.3%) |
| App CPU during automated typing, percentage of one core | 38.72 | 38.64 | -0.08 (-0.2%) |
| Open folder to visible explorer entries, ms | 74.53 | 51.65 | -22.88 (-30.7%) |
| Expand six folders, ms | 403.91 | 391.74 | -12.17 (-3.0%) |
| C compile/run click to verified output, ms | 149.97 | 166.66 | +16.69 (+11.1%) |
| Sampled C run peak IDE RSS, MiB | 571.56 | 574.20 | +2.64 (+0.5%) |
| Sampled C run peak native child RSS, MiB | 29.86 | 38.67 | +8.81 (+29.5%) |
| Retained RSS change across 12 C runs, MiB | 6.83 | 5.73 | -1.10 (-16.1%) |
| Settled RSS growth across 30 tab cycles, MiB | 20.59 | 23.80 | +3.21 (+15.6%) |
| Renderer heap after forced GC, MiB | 15.09 | 15.09 | +0.00 (+0.0%) |
| App assets excluding Electron, bytes | 3,610,301 | 3,721,644 | +111,343 (+3.1%) |
| Disk image, bytes | 120,679,936 | 120,714,752 | +34,816 (+0.0%) |
| Sampled C run runner duration, ms | 713 | 730 | +17 (+2.4%) |
| Peak sampled RSS during 30 tab cycles, MiB | 611.34 | 614.53 | +3.19 (+0.5%) |
| App RSS after forced renderer GC, MiB | 558.70 | 562.19 | +3.48 (+0.6%) |

For the CPU rows, the absolute change is in percentage points. Startup ranges were 360–487 ms before and 373–552 ms after. Warm ranges were 366–394 ms and 375–499 ms. The new warm median and single-file C median were higher, with overlapping ranges. The C run includes Clang, linking, executable launch, and process cleanup. The sampled run includes the deliberate 350 ms delay. These data do not isolate pure IDE overhead or establish a consistent slowdown from the changes.

The 30-cycle sample retained more RSS in the final run. The renderer heap after the diagnostic forced collection was identical to two decimals, and the release does not force collection. One active scenario per build cannot establish either a sustained leak or leak freedom. The native child peak is a sampled value and can miss very short-lived processes. Both idle process families contained one main, one renderer, one GPU helper, and one Chromium utility helper. No app-owned helper was left over from a fresh-profile launch.

Raw data is in `performance-results/desktop-2026-11-09T04-36-14.071Z.json` and `performance-results/desktop-2026-11-09T04-54-44.233Z.json`. The earlier candidate is retained at `performance-results/desktop-2026-11-09T04-45-49.332Z.json`. OS-cache-cold startup, native presented FPS, GPU utilization, and Windows or Intel Mac runtime were outside this measurement.

### Practice sample batching

A separate production test compared the retained pre-batch build against the release build with the same saved C program and eight distinct input/output checks. Each variant ran one warmup followed by five measured batches. Each measurement included the renderer-to-main request, compilation, executions, and persistence. The harness required eight current, passing results on every run.

| Eight samples | Compile per sample | Compile once per batch | Change |
| --- | ---: | ---: | ---: |
| Median elapsed | 988.9 ms | 706.0 ms | −282.9 ms (−28.6%) |
| Observed range | 949.5–1,217.0 ms | 647.6–748.1 ms | |

The executable is reused only within a single approved batch. Each sample has a separate process, an executable copy, and a private temporary directory. Source revision checks, stdout and stderr separation, timeouts, output caps, and cancellation still apply. A deliberately detached process can evade process-group termination and the runner is not a full sandbox. Raw data is `performance-results/practice-2026-11-09T04-54-43.777Z.json`.

```sh
node scripts/benchmark-practice.mjs --compare performance-results/pre-batch-dist --target dist
```

### What changed and what still costs most

The editor retains a single workbench shell while its tabs are closed, disposes the document models, and skips a redundant detach when switching between cached models. The existing three-model limit and its undo behavior were preserved. Saved evicted buffers release their staged text. The end-to-end tab and typing samples did not establish a material improvement from these changes. Learning, Projects, and Practice are separately bundled in the renderer and main process and load on demand. No production dependencies or idle workers were added. A per-profile native lock protects local records against concurrent instances, and bounded pipe draining prevents an exited process leader from blocking the IDE indefinitely.

Remaining costs, ordered by observed impact on this Mac:

1. **Electron and Chromium residency.** Welcome uses about 415 MiB of summed RSS across four processes, with shared pages counted more than once. These measurements do not imply 415 MiB of private memory. No security setting was relaxed to reduce that footprint.
2. **Editor session high-water memory.** This run reached about 615 MiB summed RSS after repeated tab churn. Much of the renderer heap was reclaimable. Sustained reclamation under a full day of mixed work remains unmeasured.
3. **Native C toolchain and process launches.** An individual C run still invokes Clang and links a new executable. In Practice, copying each compiled executable into its own sample directory adds work but prevents one sample from accidentally changing the binary used by another. Batching delivered the observed improvement.
4. **Large explorer interaction and startup variance.** Expanding six groups took about 392 ms including desktop automation and UI waits. Large folders are bounded and scanned on demand, with no watcher or background index. Warm launch showed the largest startup variation in this series.

The retained pre-change and pre-batch binaries are separate copies. You can rerun the same synthetic workload against either without changing installed user data.

### Release artifact checks

The Apple Silicon 0.2.0 app has 267,208,225 logical bytes (about 254.83 MiB), including Electron, up 117,099 bytes from the previous app. The compressed disk image has 120,714,752 bytes (about 115.12 MiB). It is ad-hoc signed for local use. The image passed checksum verification and the copied app passed strict signature verification. The packaged smoke loads each lazy main service, opens the learning pane, and types into Monaco with the browser context offline.

The release passed strict type checking, 29 unit tests, both production desktop suites on a clean rerun, the offline planning rubric, the package build, and `npm audit`. Intel, Windows, Linux, OS-cache-cold startup, live provider metrics, and real student usability are still unverified. See [PRODUCT_AUDIT.md](PRODUCT_AUDIT.md) for the initial shutdown timeout and remaining product limits.

## Resource architecture follow-up baseline

The 0.2.0 production bundle and disk image were copied before source changes to `performance-results/phase2-resource-baseline` and `performance-results/phase2-resource-baseline.dmg`. Its main bundle SHA-256 is `badc34206fb32240c97c876b1f1bb1ff3c4a1d057f64bd35be16edf3557f44fa`. The existing 0.2.0 run measured 415.41 MiB summed RSS after 120 seconds at Welcome, 511.94 MiB with one file, 520.45 MiB with ten files, and 565.59 MiB with the medium tree expanded. Idle CPU was 0.09% of one logical core. This historical baseline did not sample platform-attributed footprint or optional-panel cycles. The preserved build is the control for the expanded resource protocol.

### Resource protocol

The expanded runs use production bundles on Apple M3, 24 GiB RAM, arm64 macOS 27.2 (26B123), Electron 45.2.3. A five-pair launch series uses fresh and then reused disposable profiles. Each candidate has one long workload with 75 seconds at Welcome, one C file, ten open tabs, a 1,000-file fixture with six subfolders expanded, six compiler executions, and twelve panel close/reopen cycles. Candidate core measurements use Minimal. Optional-panel measurements use Full with automatic tests off. The preserved baseline uses the same workflows in its original profile. Benchmark dialogs use disposable fixtures and synthetic choices. The packaged verification separately checks the signed app, local resources and offline editor.

The harness reports both process-family RSS and macOS kernel `phys_footprint` ledger charges. Neither counter is a de-duplicated measurement of all physical memory. Compiler and executable children are identified separately, and main-process reaped child CPU is also captured. A CPU-spin check against Node's process CPU counter calibrated the host's Mach tick conversion. Original baseline evidence remains intact, and the comparison uses a normalized copy. Launch measurements leave OS caches intact. Typing is keydown to the second Chromium animation callback. Presented FPS and GPU utilization were not measured.

```sh
npm run bench:resources -- --target performance-results/phase2-resource-baseline \
  --label baseline --idle-seconds 75 --launches 5 --cycles 12
npm run bench:resources -- --target dist --label candidate \
  --idle-seconds 75 --launches 5 --cycles 12 --compare-report performance-results/resources-baseline-2026-11-09T05-05-05.607Z-cpu-normalized.json
```

The comparison reports regressions beyond its configured allowance. Examples are the greater of 15% or 30 ms for launch, 20% or 5 ms for typing, 10% or 20 MiB for memory, and 0.5 percentage points for idle CPU. `--strict-targets` fails if either memory metric exceeds its provisional budget or if a comparison crosses a regression threshold. Those targets are decimal MB and are shown for both memory metrics. Longer idle and cycle runs can be requested explicitly.

The 0.3.0 Apple Silicon bundle is 267,218,752 logical bytes, up 10,527 bytes from 0.2.0. The disk image is 120,711,168 bytes, down 3,584 bytes. Both include the same Electron runtime. The app remains ad-hoc signed for local use. The 0.3.0 disk image passed its checksum, mounted read-only, and produced a copy that passed strict signature verification and loaded the packaged services and Monaco offline.

Type checking, 34 unit tests, the dependency audit, the package build, and all three desktop suites passed. The desktop harness now keeps the inspector attached while requesting Quit and waits for real process exit. A prior run timed out during automation teardown after its workflow assertions. The native last-window test passed independently.

### Production before and after

| Workload and metric | 0.2.0 | 0.3.0 | Change |
| --- | ---: | ---: | ---: |
| Fresh-profile launch to Welcome, ms | 371.5 | 369.8 | -1.7 (-0.4%) |
| Warm launch to Welcome, ms | 363.6 | 378.5 | +14.9 (+4.1%) |
| 75-second idle CPU, % of one logical core | 0.230 | 0.159 | -0.071 (-30.8%) |
| First C file, ms | 181.6 | 185.4 | +3.7 (+2.0%) |
| Subsequent files, ms | 50.1 | 50.3 | +0.2 (+0.4%) |
| Typing to second animation frame, ms | 31.95 | 31.70 | -0.25 (-0.8%) |
| C run to output, ms | 157.6 | 168.3 | +10.7 (+6.8%) |
| Reaped child CPU for sampled run, ms | 82.88 | 82.50 | -0.39 (-0.5%) |
| Welcome idle summed RSS, MB | 437.5 | 435.2 | -2.2 (-0.5%) |
| Welcome idle attributed footprint, MB | 119.0 | 117.9 | -1.1 (-0.9%) |
| One C file summed RSS, MB | 531.7 | 530.5 | -1.2 (-0.2%) |
| One C file attributed footprint, MB | 256.4 | 253.6 | -2.8 (-1.1%) |
| Ten tabs summed RSS, MB | 551.0 | 551.2 | +0.2 (+0.0%) |
| Ten tabs attributed footprint, MB | 306.3 | 325.9 | +19.6 (+6.4%) |
| Medium project summed RSS, MB | 559.1 | 557.9 | -1.2 (-0.2%) |
| Medium project attributed footprint, MB | 280.3 | 277.8 | -2.5 (-0.9%) |
| Learn open summed RSS, MB | 581.9 | 586.8 | +4.9 (+0.9%) |
| Learn open attributed footprint, MB | 271.0 | 295.2 | +24.2 (+8.9%) |
| Projects open summed RSS, MB | 585.6 | 590.4 | +4.8 (+0.8%) |
| Projects open attributed footprint, MB | 279.3 | 277.2 | -2.1 (-0.7%) |
| Practice open summed RSS, MB | 586.8 | 591.5 | +4.7 (+0.8%) |
| Practice open attributed footprint, MB | 295.8 | 313.8 | +18.1 (+6.1%) |
| Return to Welcome after optional work summed RSS, MB | 591.8 | 589.9 | -1.9 (-0.3%) |
| Return to Welcome after optional work attributed footprint, MB | 270.8 | 262.3 | -8.5 (-3.1%) |
| Learn first open, ms | 815.9 | 63.5 | -752.4 (-92.2%) |
| Learn reopen, ms | 27.8 | 54.8 | +27.0 (+97.2%) |
| Projects first open, ms | 821.7 | 64.5 | -757.1 (-92.1%) |
| Projects reopen, ms | 32.0 | 52.4 | +20.4 (+63.9%) |
| Practice first open, ms | 827.4 | 64.7 | -762.7 (-92.2%) |
| Practice reopen, ms | 31.4 | 55.6 | +24.2 (+77.1%) |

The 0.3.0 thresholds flagged **zero of 27** comparisons. First opening of all three optional panes fell about 92%. Reopening an already loaded pane added roughly 20–27 ms, as the new lifecycle re-establishes the panel and reloads releasable state. The 75-second Welcome CPU window fell by 0.071 percentage points. The small startup and memory differences each come from one workstation, and the active memory stages have one cumulative run per version. In particular, the ten-tab, Learn and Practice footprint samples increased. GPU ledger charges varied substantially. These samples do not establish a leak or a universal memory improvement.

All three provisional budgets passed for attributed footprint on this workload. Summed RSS exceeded the 300 MB idle and 400 MB one-file targets and stayed under 600 MB for the medium project. No metric was substituted for another. Native child RSS peaks varied with sampling of short-lived processes (39.0 versus 14.6 MiB). Sampled native footprint was 1.03 MiB in both runs. Reaped CPU was essentially unchanged, and no native children remained after the runs. The benchmark measured no renderer requests to remote origins.

Across four close/reopen cycles per pane, the candidate's first-to-last hidden footprint rose by 2.5 MB in Learn, 0.2 MB in Projects and 2.8 MB in Practice. Its summed-RSS deltas were +0.5, +0.2 and +1.0 MB respectively. These are short-cycle observations. A loaded module's code remains in the renderer cache, and this test cannot establish leak freedom over hours.

A separate matched clean-Welcome last-window check left three Electron processes after 1.5 seconds in 0.2.0, totaling 321.9 MiB summed RSS and 98.3 MB attributed footprint. Minimal Mode in 0.3.0 left zero owned processes and zero measured app memory after the same settling period. Window close took 205.0 and 204.6 ms respectively. The 0.3.0 workload's final close also left no process family.

Raw files are `performance-results/resources-baseline-2026-11-09T05-05-05.607Z-cpu-normalized.json` and `performance-results/resources-candidate-2026-11-09T05-12-31.742Z.json`. The close-only files are `resources-baseline-window-2026-11-09T05-07-05.955Z.json` and `resources-candidate-window-2026-11-09T05-12-29.136Z.json` in the same directory. See [the architecture audit](ARCHITECTURE_PERFORMANCE_AUDIT.md) for the runtime alternatives and next investigation steps.

### Repeated file opens and closes

A separate matched run used the existing editor churn protocol, one active scenario per version. It opened and closed ten tabs, then opened and closed three files in each of eleven further cycles. The 0.3.0 scenario used Minimal Mode and disposed the editor at the last tab. Starting RSS after the ten-tab close was 560.47 MiB before and 560.09 MiB after. The first-to-last settled RSS increase was 25.25 versus 24.81 MiB, a 0.44 MiB difference, over 17.13 and 17.23 seconds respectively. Renderer heap after diagnostic GC was 14.67 versus 14.73 MiB. The samples do not show a material improvement in retained renderer memory from disposing the widget, and they do not establish long-session bounds. The lifecycle smoke independently verified the Minimal editor widget was detached and no editor worker remained when no models were open.

```sh
npm run bench:desktop -- --target dist --compare performance-results/phase2-resource-baseline \
  --trials 2 --scenarios 1 --idle-seconds 3 --open-files 10 --tab-cycles 12 --executions 3
```

Raw samples are `performance-results/desktop-2026-11-09T05-14-52.056Z.json`. Retaining the warm widget in Full is a user choice. Closing the last Minimal window remains the verified way to release the whole runtime process family. Further meaningful open-window footprint reductions are likely to require runtime work. The parity-first migration plan is in [ARCHITECTURE_PERFORMANCE_AUDIT.md](ARCHITECTURE_PERFORMANCE_AUDIT.md).

## Offline themes

Ion 0.4.0 stores the five built-in palettes separately. Together they occupy 5,585 bytes of JSON. Installed custom palettes stay on disk until selected. Preferences reads a registry of IDs, names, appearance, and source and drops it when Preferences closes. Creating a custom theme keeps a temporary palette draft while the builder is open. The workbench applies the selected colors through CSS variables, and Monaco replaces the definition in one named slot. Theme switching creates no editor, model, worker, or process. Automatic uses a media-query listener only while selected.

```sh
npm run package:dmg
npm run test:themes
node scripts/benchmark-themes.mjs --baseline 'release/Ion IDE-0.3.0-darwin-arm64/Ion IDE.app'
```

The benchmark runs signed production app bundles on Apple Silicon. Each catalog size starts with a fresh disposable profile and an active Dark palette, then relaunches with the same profile. OS caches are left intact. Startup includes attaching local browser automation and waiting for visible Welcome and the active theme. The old two-theme release has a Welcome marker only. Each warm run opens the same C file and measures the idle app with Preferences closed. Custom definitions are installed through the real validation and persistence path to prepare fixtures ahead of the measured launches.

Switch latency starts at the captured click or selection event and ends two animation callbacks after the workbench reports the selected palette. It is a paint proxy. The runs use 100 switches per profile and exercise every installed palette. The harness checks that the original editor element, unsaved text, and its undo history survive. It samples process-family RSS, kernel-attributed footprint, renderer heap, and DOM node counts at every 20 switches. The comparison uses the same active palette at the start and end. Diagnostic renderer GC runs outside the latency measurements. RSS can count shared pages repeatedly, and attributed footprint can vary as Chromium allocates and reclaims native memory.

The host was an Apple M3 with 24 GiB RAM, macOS 27.2 (26B123), Electron 45.2.3, Monaco 0.57.0, and Node 26.11.1 for the harness. It was on AC power with no macOS thermal or performance warning. The visible window was 1260 × 790 logical pixels at 2× scale. Figures are medians across three runs per condition, with 300 switch measurements per condition.

| Metric | 0.3.0, 2 themes | 0.4.0, 5 themes | 0.4.0, 20 themes | 0.4.0, 100 themes |
| --- | ---: | ---: | ---: | ---: |
| Fresh-profile launch, ms | 441.0 | 442.0 | 408.4 | 374.3 |
| Warm-profile launch, ms | 373.4 | 401.8 | 435.0 | 418.4 |
| Open C file from Welcome, ms | 258.6 | 223.1 | 223.3 | 225.1 |
| Open theme catalog, ms | — | 47.3 | 47.3 | 47.3 |
| One-file idle RSS, MiB | 498.23 | 497.67 | 497.70 | 497.94 |
| One-file idle attributed footprint, MiB | 217.80 | 218.27 | 218.24 | 217.90 |
| One-file idle CPU, % of one logical core over 1.2 s | 1.42 | 1.54 | 1.40 | 1.53 |
| Switch latency p50 / p95, ms | 30.4 / 31.6 | 30.5 / 48.1 | 30.4 / 47.7 | 30.4 / 31.4 |
| Catalog-open RSS before / after 100 switches, MiB | 512.39 / 524.41 | 513.28 / 534.38 | 513.17 / 538.75 | 513.13 / 541.61 |
| Catalog-open renderer heap after GC before / after 100 switches, MiB | 11.83 / 13.19 | 11.96 / 13.39 | 11.96 / 13.41 | 12.00 / 13.42 |
| Renderer heap after closing Preferences and collecting, MiB | 13.27 | 13.49 | 13.49 | 13.48 |

With Preferences closed, the 5- and 100-theme medians differ by +0.27 MiB RSS and −0.38 MiB attributed footprint. Those differences fall within the measured run-to-run variation. The catalog-open DOM has about 580 additional nodes at 100 themes compared with five. All three catalog sizes return to 406 nodes after closing Preferences. Launch samples are noisy, including one 2,733 ms 0.3.0 outlier. Warm medians are higher in 0.4.0, and the endpoint also includes loading the selected palette. These runs do not establish a startup improvement.

The 100-theme renderer heap after diagnostic GC was 12.00, 12.88, 13.07, 13.21, 13.35, and 13.42 MiB at 0 through 100 switches. The prior release grew by a similar amount over the same switch count. The full process family retained more RSS than it did at the start. The biggest attributed footprint movements came from Chromium's GPU helper while Preferences was open. For the 100-theme catalog, median attributed footprint was 350.41 MiB before switching, peaked at 431.13 MiB at the first checkpoint, fell to 381.57 MiB at 100, and was 353.38 MiB after closing Preferences. Presented FPS, attributable GPU utilization, and OS-cache-cold launch were outside this protocol.

The Apple Silicon app grew by 25,474 logical bytes to 267,244,226 bytes including Electron. The compressed disk image grew by 24,064 bytes to 120,735,232 bytes. Dependencies and the desktop runtime are unchanged. The mounted installer passed strict verification of the ad-hoc signature and ran the packaged offline editor and theme checks. Type checking, 37 unit tests, the focused desktop theme suite, and the editing, workspace, and resource lifecycle suites passed on Apple Silicon. Intel macOS, Windows, and Linux were outside this release's runtime checks.

Raw samples and build hashes are in `performance-results/themes-2026-11-09T05-25-15.091Z.json`.

### 1,000-switch soak

```sh
node scripts/benchmark-themes.mjs --sizes 100 --runs 1 --switches 1000 --checkpoint 100 \
  --baseline 'release/Ion IDE-0.3.0-darwin-arm64/Ion IDE.app'
```

The 100-theme switching workload took 41.4 seconds, including checkpoint pauses. Post-GC renderer heap started at 12.03 MiB, reached 14.62 MiB by switch 700, and finished at 14.66 MiB. The last 300 switches added 0.04 MiB. The DOM count stayed at 1,425 from switch 100 through 1,000, and returned to 406 after Preferences closed. The original editor, unsaved edit, and undo history all survived. The two-theme baseline ended at 14.35 MiB of post-GC heap after 73.7 seconds. Legacy button clicks have additional automation overhead, so total workload duration is useful for context. The per-switch paint-proxy medians were 30.4 ms for 100 themes and 30.5 ms for the baseline.

The 100-theme run's summed RSS rose from 514.67 MiB to 602.69 MiB at switch 200 and ranged from 592.25 to 606.23 MiB across subsequent checkpoints. Attributed footprint rose from 352.40 MiB to 471.18 MiB at switch 1,000 and fell to 395.21 MiB after closing Preferences, compared with 345.43 MiB for the baseline after closing. Both renderer and GPU helper charges contributed to that difference. The retained heap and DOM counts leveled off during this run. Native memory stayed elevated and varied between samples. Longer sessions remain unmeasured.

Raw samples are in `performance-results/themes-2026-11-09T05-31-49.546Z.json`.

## Offline document viewers

The 0.4.0 production build was copied before the viewer changes to `performance-results/ion-0.4.0-before-viewers-dist`. Both builds use the same Electron 45.2.3 runtime on an Apple M3 with 24 GiB RAM, macOS 27.2 (26B123), arm64, and AC power. The comparison uses three fresh and three reused disposable profiles per build, leaves OS caches intact, and samples a 20-second settled Welcome idle window. The code-only workload opens the same C file and project in both builds. Memory counters cover the Electron process family, and CPU is normalized to one logical core.

```sh
npm run bench:resources -- --target performance-results/ion-0.4.0-before-viewers-dist \
  --label viewer-baseline --idle-seconds 20 --launches 3 --cycles 3 --executions 2
npm run bench:resources -- --target dist --label viewer-candidate --idle-seconds 20 \
  --launches 3 --cycles 3 --executions 2 --compare-report performance-results/resources-viewer-baseline-2026-11-09T05-36-19.193Z.json
npm run bench:viewers
```

Only the document entry points and tab layout are part of the regular workbench. PDF.js and its local font and decoder assets, the table renderer, and the Word renderer load on demand. PDF starts a dedicated browser worker. Word and tables use a disposable Node worker with a bounded heap. PowerPoint starts LibreOffice only for the conversion and reuses the PDF viewer after it exits. Unselected document tabs retain tab metadata.

| Metric | 0.4.0 before viewers | 0.5.0 with viewers closed |
| --- | ---: | ---: |
| Fresh-profile launch to Welcome, ms | 406.6 | 366.5 |
| Warm-profile launch to Welcome, ms | 383.9 | 362.9 |
| Welcome idle attributed footprint, MiB | 117.55 | 117.79 |
| Welcome idle summed RSS, MiB | 419.41 | 418.14 |
| Welcome idle CPU, % of one logical core | 0.14 | 0.42 |
| One C file attributed footprint, MiB | 246.88 | 243.21 |
| One C file summed RSS, MiB | 507.19 | 503.09 |
| First C file to visible editor, ms | 165.6 | 178.2 |
| Typing to second animation callback, ms | 32.0 | 31.7 |

All 27 comparisons stayed within the existing harness tolerances. The candidate's idle CPU was higher by 0.28 percentage points in the final window, with 0.21% observed in a separate candidate run. The same four Electron process roles were present, and viewer work had not started. The short series does not establish a startup speedup or a stable idle CPU difference. Raw samples are in `performance-results/resources-viewer-baseline-2026-11-09T05-36-19.193Z.json` and `performance-results/resources-viewer-candidate-2026-11-09T06-16-55.078Z.json`. The earlier candidate window is in `performance-results/resources-viewer-candidate-2026-11-09T06-05-04.469Z.json`.

### PDF open and close

The five-cycle production workload opened a 160-page, 1.32 MiB synthetic PDF beside one C file and jumped to pages 90 through 94. Median time from opening the PDF tab to the first rendered canvas was 205.6 ms (93.8–233.8 ms). The split view had one parser worker and three or four canvases. Each close returned both counts to zero.

| Sample | Attributed footprint, MiB | Summed RSS, MiB |
| --- | ---: | ---: |
| Code only, before opening the first preview | 293.41 | 512.97 |
| PDF and code visible, five-sample range | 454.83–506.11 | 595.33–607.66 |
| Code only, 1.5 seconds after each close | 330.15–366.76 | 549.95–559.25 |
| Code only, 6.5 seconds after the last close | 198.29 | 552.27 |

Chromium's GPU helper accounted for the largest footprint movement. It sampled at 154.97 MiB before the preview, 277.89–307.17 MiB with the split view visible, and 48.89 MiB at the final settled sample. The renderer's attributed footprint ended at 93.25 MiB versus 77.00 MiB before the preview. Summed RSS remained above its starting value. This short workload verifies viewer resource teardown and shows native allocation variability after closing. It does not establish long-session memory bounds. Active Office conversion CPU, presented FPS, attributable GPU utilization, and OS-cache-cold launch were outside this protocol. Raw samples are in `performance-results/viewer-pdf-2026-11-09T06-17-49.215Z.json`.

The Apple Silicon app bundle is 271,651,012 logical bytes, up 4,406,786 bytes (4.20 MiB) from 0.4.0. The disk image is 122,877,952 bytes, up 2,142,720 bytes (2.04 MiB). The bundle contains the PDF parser, worker, fonts, CMaps, local decoders, structured file parsers, and their license notices. LibreOffice is a separate installation. The disk image checksum passed, and the mounted copy passed strict verification of its ad-hoc signature and rendered PDF and CSV previews with networking disabled.

Type checking, 48 unit tests, and the production editor, workspaces, resource lifecycle, themes, and document viewer suites passed. The document cases include a 160-page PDF, a 25,001-row CSV, a multi-sheet XLSX, a DOCX with a table and a decoded image, malformed and oversized files, and byte-identical originals after preview. The PPTX test checked diagram and chart pixels from the local LibreOfficeDev 26.8.0.0.alpha0 engine, thumbnails, zoom and fit, native full-screen entry, Escape, and exit controls. A separate launch verified the missing-engine setup message and external-open fallback. Intel macOS, Windows, and Linux were outside the native test scope.

## Interactive Run Console

The baseline is the pre-change 0.5.0 production build copied to `performance-results/ion-0.5.0-before-run-console-dist`. The comparison uses the same Electron 45.2.3 on an Apple M3 with 24 GiB RAM and macOS 27.2 (26B123). Each build ran three fresh-profile and three warm launches, a 20-second Welcome idle window, and the same C project and code-only workflow. The previous UI fed pre-entered input through a pipe. The 0.6.0 app starts its terminal renderer and native helper on demand. Compiler and deterministic workspace test execution still use the bounded process executor.

```sh
npm run bench:resources -- --target performance-results/ion-0.5.0-before-run-console-dist \
  --label runner-baseline --idle-seconds 20 --launches 3 --cycles 2 --executions 3
npm run bench:resources -- --target dist --label runner-candidate --idle-seconds 20 \
  --launches 3 --cycles 2 --executions 3 --compare-report performance-results/resources-runner-baseline-2026-11-09T06-22-13.967Z.json
npm run bench:run-console -- --baseline performance-results/ion-0.5.0-before-run-console-dist
npm run bench:run-console -- --runs 100 --gc-diagnostic
```

| Metric | 0.5.0 pipe output | 0.6.0 interactive console |
| --- | ---: | ---: |
| Fresh-profile startup to Welcome, ms | 412.7 | 373.9 |
| Warm-profile startup to Welcome, ms | 389.0 | 348.1 |
| Welcome idle attributed footprint, MiB | 117.55 | 117.43 |
| Welcome idle summed RSS, MiB | 417.41 | 418.25 |
| Welcome idle CPU, % of one logical core | 0.21 | 0.27 |
| One C file attributed footprint, MiB | 244.75 | 245.82 |
| Typing to second animation callback, ms | 31.85 | 31.45 |
| Short C run to verified output, 19 warm runs, ms | 182.9 | 199.6 |

The three-run resource harness flagged C run latency at 166.1 ms before and 214.8 ms after. A follow-up used the same short C program in each build and verified a new program PID in the visible output every time. Excluding the first run of each of those two sessions, the medians differed by 16.7 ms, with ranges of 165.3–367.8 ms and 182.1–316.9 ms. The native PTY and terminal rendering add work to the interactive path. Startup samples cover only three pairs per build and leave OS caches intact. The data show similar idle resource use under this workload and do not establish a startup speedup. Raw core samples are in `performance-results/resources-runner-baseline-2026-11-09T06-22-13.967Z.json` and `performance-results/resources-runner-candidate-2026-11-09T06-39-51.709Z.json`.

### Interactive input and cleanup

The 20-run comparison also compiled an interactive C fixture that printed its PID before waiting for input. Median Run-to-prompt time was 212.7 ms (179.3–279.1 ms). Median Enter-to-verified-output time was 21.7 ms (5.6–34.6 ms), including browser automation. The helper and program used 3.17–3.19 MiB summed RSS and 2.14–2.16 MiB attributed footprint while waiting for input. Neither accumulated measurable CPU time during the sampled three-second wait. The terminal bundle was absent before the first run. Each of the 20 helper and program pairs exited and the process list contained no child after the console closed.

The full app measured 513.08 MiB summed RSS and 296.58 MiB attributed footprint before opening the console. While waiting for input, sampled totals were 528.78–555.58 MiB RSS and 345.01–361.32 MiB attributed footprint. Four seconds after closing the console, the totals were 549.02 MiB and 245.40 MiB. Chromium's native allocations and the already-loaded renderer code affect these figures. Raw samples are in `performance-results/run-console-2026-11-09T06-42-59.865Z.json`.

The separate diagnostic ran 100 interactive cycles in 36.8 seconds, with explicit renderer garbage collection after the first run and every 20 runs. Post-GC heap was 10.86 MiB before opening the terminal, 12.24 MiB after one run, 12.95 MiB at run 20, and 13.28 MiB at run 100. DOM nodes and JavaScript listener counts stayed at 636 and 317 at the open-console checkpoints. After closing, they fell to 547 and 274, and the heap measured 13.02 MiB. All native helpers and program PIDs exited. These are short lifecycle observations, and the module code remains loaded for the session. Raw diagnostic samples are in `performance-results/run-console-2026-11-09T06-44-31.045Z.json`.

The app bundle is 272,105,756 logical bytes, up 454,744 bytes (0.43 MiB). The disk image is 122,984,448 bytes, up 106,496 bytes (0.10 MiB). The signed native helper occupies 51,136 bytes. The installer passed checksum and signature verification, and its bundled helper passed a real terminal input and output round trip. The mounted app also passed the offline document, theme, and editing smoke test.

Type checking, 58 unit tests, the interactive desktop suite, and the editor, workspace, lifecycle, theme, and document regressions passed on Apple Silicon. The language checks included real offline Maven 3.9.11 and Gradle 9.4.1 builds using prepared local caches and a Java compile failure that did not launch stale output. The other native checks covered terminal resize, stdout and stderr, control sequences, input echo, child reaping, timeouts, output caps, and parent pipe closure. Intel macOS, Linux, Windows, presented FPS, and GPU utilization were outside this verification scope.
