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

The matched browser scenarios use the same Chrome157.0.8103.51, production renderer, loopback/no external requests, viewport/theme pairs and deterministic bridge. Each case has one capture, not a statistically adequate native startup or latency benchmark. Baseline Welcome transferred370,785JS bytes; first A capture370,895 (+110bytes). Optional learning/roadmap/practice/terminal modules were absent on Welcome in both builds. Real code editing used one Monaco widget; navigating Learn/Code preserved its identity and one-step Undo. Renderer JS heap snapshots vary and are not process-tree RSS, attributed footprint or evidence of a leak/improvement. No new dependency, service, scan, worker or animation was added.

Raw reports remain in ignored `performance-results/ui-baseline-retry`, `ui-A`, and `ui-A-verified`. A full-unit run initially had two theme failures; corrected palettes pass all six theme/shortcut cases. The subsequent complete working-tree run passed257/283 with26platform skips; it includes the separately pending direct-selection backend tests. Native Mac/Windows and repeated long-session memory remain unverified for the feature.
