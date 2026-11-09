# Ion IDE adoption readiness

## Release evidence

Public `main` and `v0.9.4` resolve to `88ecebd044518862a2fd515a41f07bef6307d133`. The repository has 283 tracked files, including 159 under `src`, and contains the implementation, tests, lockfile, packaging scripts, and workflow. The local Marketplace 2.0 and integrated Terminal changes are newer than that tag. The release-verification branch started from the public revision so it could test the release fixes independently. [Public source](https://github.com/Vaddi-Srisanth/Ion_IDE/tree/v0.9.4)

The successful `main` run and failed tag run used the same commit and Windows runner image. Both passed clean dependency installation, the Windows unit suite, build, interactive Run Console, and x64 packaging. On the tag, the installed-app test timed out waiting for the update opt-in to reach `preferences.json`. The job log establishes the failed save assertion and contains no underlying filesystem error. The Mac job on the tag passed. [Successful main workflow](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42627190663) · [Failed tagged Windows job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42627857612/job/129196183102)

Ion previously changed the update checkbox optimistically, so a rejected write left it displaying a choice that had never been saved. It now shows the committed value, indicates a pending save, reports errors in Preferences, and drains in-flight preference mutations before quitting. Windows preferences retry bounded sharing-related errors while keeping the existing atomic replacement. A native file-lock test demonstrates recovery after a transient lock and verifies that a persistent lock leaves the old file intact. This establishes a real failure mode in the old write path. The exact cause of the intermittent historical failure remains unresolved because the old job did not capture it.

The first candidate Windows job passed the lock test, update opt-in and opt-out in the installed executable, offline editing, interactive Run Console, and uninstall preservation. Its Mac peer exposed a test race where Stop could read a PID from the previous transcript during repaint. The test now takes the PID from the new run's own streamed events and still checks that xterm displayed it and the process exited. [First candidate Windows job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42669452686/job/129341773461) · [Mac failure log](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42669452686/job/129341773914) · [Follow-up workflow](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42670233013)

The final release-foundation run passed both jobs on `7767e3116002adf0390caf37122c43937632db8f`. Windows passed the native lock test, both preference writes in the installed app, offline edit and save, Run Console, and uninstall preservation. macOS passed the desktop regression, preference failure handling, and the mounted DMG smoke test. Both artifact archives matched GitHub's SHA-256 digests. The two extracted installers matched their same-run manifests and produced the checksums below. [Green workflow](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42670896874) · [Windows job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42670896874/job/129346956517) · [macOS job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42670896874/job/129346957257)

| Verified CI candidate | SHA-256 |
| --- | --- |
| Apple Silicon DMG | `ab865942c71380851aabdcbd0fb47702b953ad9f48b620ffc63aa8253d305ae3` |
| Windows x64 setup | `0d3996648b989a9e1f9aa25bb4c933428c1ae5a5f6b6edb3d5fe718545b75920` |

The workflow pins the Node and NSIS versions used in verification, checks the checkout SHA and tag version, and records installer hashes and sizes only after native checks pass. A release requires both installer manifests from the same successful run and attempt. The manifest comparison rejects mixed attempts, wrong commits, and modified bytes. The existing v0.9.4 public installer sizes and SHA-256 hashes match GitHub's release asset metadata and the local checksum file. A candidate installer uses the preview version for validation only. Publish a correction under a new version and tag. [Checklist](../RELEASE_CHECKLIST.md) · [Current release assets](https://github.com/Vaddi-Srisanth/Ion_IDE/releases/tag/v0.9.4)

## Installation trust and security

| Platform | Existing public preview | Prepared trust path | Evidence still needed |
| --- | --- | --- | --- |
| macOS Apple Silicon | Ad-hoc-signed app and unsigned disk image. Gatekeeper rejected the preview image with no usable signature. | Developer ID signs nested code with hardened runtime, applies narrowly scoped JIT entitlements, submits the image through `notarytool`, staples the ticket, and checks the resulting image and app. | A real Developer ID identity and notarization credentials, then successful signature, ticket, Gatekeeper, and clean-machine checks. |
| Windows x64 | Unsigned setup. Native install, execution, and uninstall work on the tested CI runner. | Opt-in SignTool signs the app and setup with a provisioned publisher key and RFC 3161 timestamp. Verification pins the signer, publisher metadata, and signature validity. | A public-trust signing identity and clean-machine signature verification. SmartScreen reputation is separate from signature validity. |

Both unsigned packaging paths were exercised. The Mac disk image mounted and the packaged app passed the offline smoke test. The Windows x64 cross-build is build evidence. The GitHub Windows job provides native install evidence. [Mac signing](macos/SIGNING.md) · [Windows signing](windows/SIGNING.md)

The audit covered the eight reachable commits, 315 distinct historical blobs, and the pending Marketplace and Terminal source. The scan found no known credential patterns or tracked local profiles, build logs, keys, or installers. The tracked PowerPoint file is a reviewed test fixture. The release branch was also scanned with Gitleaks before each push. Existing Git author metadata includes non-noreply addresses. The audit is limited to the files and patterns inspected. No history rewrite or visibility change was used.

## Feature verification

| Capability | Public v0.9.4 | Current local evidence |
| --- | --- | --- |
| Editor, autosave, conflict protection, session recovery | Implemented | Production desktop regressions for save, external changes, drafts, and session reopening. |
| One-click Run Console | C, C++, Java, Python, JavaScript | Real toolchains, stdin, Stop, and process reaping on Mac. Native Windows line input and Stop exercised for JavaScript. |
| General-purpose Terminal | Later local work | Real zsh, multiple PTYs, interactive input, ANSI, resize, Ctrl+C, hidden output, and cleanup exercised on Mac. Linux backend awaits runtime verification. |
| C/C++ project build | One translation unit through Run | Explicit `.ion/build.json` source lists build one C or C++ executable. Native Mac tests cover two-source runs, approval, dirty companion saves, unsafe paths, changes during approval, and stale executable prevention. Windows runtime validation of this local increment and automatic Make or CMake integration remain pending. |
| Debugger | No integrated debugger | A standalone Apple LLDB-DAP probe verified a C source breakpoint, variable inspection, step over, step into, continue, and stop with process cleanup. |
| Offline learning and Practice | Implemented | The current Marketplace has 19 packs and 162 lessons. Current fixtures cover reviewed compiler and runtime categories across five languages. The desktop test followed a real Python error into a lesson and ran the associated Practice samples offline. |

Ion now maps reviewed C `printf` and `scanf` format-argument type diagnostics to the local lesson on program entry, types, and output. Six Apple Clang and GCC cases mapped correctly, and four nearby cases with different causes abstained. The full 50-case C fixture corpus had 35 correct high-confidence results and 15 abstentions. Warning-only runs stay out of repeated-error history.

The final local build passed type checking, 142 unit tests, seven release and signing configuration checks, and the Mac desktop suites across the combined run and focused retries. Two Windows-only unit tests were skipped locally. The editor-session suite twice reported a quit timeout. Instrumented current and baseline runs and the final unmodified retry both passed. The timeout remains intermittent. The production performance pair passed all 32 enforced comparisons, with seven active-footprint observations advisory. [Performance details](../PERFORMANCE.md)

Start an integrated debugger with one C program and an installed `lldb-dap` launched over stdio on demand. Use the existing source grants and runner to build a fresh `-g -O0` executable in a private directory. Keep v1 to breakpoints, stack frames, read-only variables, stepping, continue, and stop. Require explicit launch consent, limit protocol frames and pending requests, ignore unapproved adapter requests, and terminate the adapter and debuggee together. The feasibility probe used Apple LLDB 2103.0.34.407 and a disposable fixture. Ion has no startup debugger process. [LLVM adapter](https://lldb.llvm.org/use/lldbdap.html) · [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/overview.html)

## Student evidence

The reproducible crossover protocol compares Ion Learn with each student's usual offline workflow. It measures time to a correct repair, final correctness, explanation quality, delayed transfer, avoidable interactions, and an optional return choice. All four starter diagnostics mapped to the intended Ion categories, and all 16 reference-output cases passed on Apple Clang. Participant sessions and outcomes remain to be collected. Any claim that students learn faster or prefer Ion requires that evidence. [Protocol, fixtures, and scoring](study/STUDENT_USABILITY.md)

## Readiness verdict

The release-foundation branch passed native CI, and its installer artifacts are verified engineering candidates. A signed public release still needs provisioned signing identities, notarization and clean-machine verification, and a new version tag at the intended tested source revision. The newer local developer features need their own release verification. The currently published build remains a personal preview. The [performance report](../PERFORMANCE.md) records startup, editing, terminal, C/C++ project, and cleanup measurements. Student outcomes are still open.
