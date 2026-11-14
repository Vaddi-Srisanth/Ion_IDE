# Release checklist

## Current verified checkpoint — 14 November 2026

Authorization covers the diagnostic branch and hosted verification only. Historical no-push notes below describe earlier checkpoints; main/tags/installers/update feed/installed Ion remain unchanged.

- [x] Reproduce partial-list observer failure; compiled deterministic regression and 909 post-fix native attempts pass.
- [x] Reproduce and fix matching-metadata pre-save conflict before mutation; native Mac/Windows regressions pass.
- [x] Complete native editor/recovery/Undo/interactive code/terminal/Git/LFS/notebook and disposable installer gates with exact revision limits.
- [x] Preserve failed predecessors, correctPS 5/liveness/crash-test/benchmark boundaries and record exact skips.
- [x] Complete matched n=3 process-tree resources and n=20 balanced startup on bothOS. Mac warm median cost remains documented.
- [x] Review intended source/tests for credentials and scope; no runtime dependencies or unrequested features added.
- [ ] Explain historical 12.67 second GCC/READY→CLEAN delay; remains tracked, not automatically an indefinite release ban.
- [ ] Physical low-memory hardware, four-hour sessions and authenticated signing/notarization.
- [ ] Run a complete future final-tag publication gate and obtain explicit release authorization. Two earlier combined workflows remain FAIL; later scoped jobs do not relabel them.

[Exact gate matrix and conditional recommendation](diagnostics/windows-gcc/RELEASE_VERIFICATION.md) · [Measurements](diagnostics/windows-gcc/FINAL_PERFORMANCE.md).

## Current release procedure

For a source-only update, run the native CI gates from the intended branch. Confirm the exact commit in the macOS, Windows desktop, Windows installer, and Windows performance jobs. Keep installer and updater publication separate. The Git and saved test workflows require `npm run test:source-control` and `npm run test:project-suites` on both platforms. Review [the capability and skip audit](TEST_COVERAGE_AUDIT.md) and [the parity matrix](docs/windows/FEATURE_PARITY.md) before updating release claims.

The stabilization follow-up has a deterministic reproduction of the 9adcdea Git configuration race and a passing macOS fix, including genuine LFS and cancellation tests. Final native Windows, packaging and matched performance gates govern delivery. Source verification and installer release publication have separate evidence. [Stabilization audit](ENGINEERING_AUDIT.md#stabilization-follow-up-from-9adcdea)

1. On a target Mac, install Node.js and npm, Xcode Command Line Tools, a JDK, Python 3, and Node.js for the language matrix. Run `npm ci`, then `npm run test:regression`. Retain the console results. With LibreOffice available, run `node scripts/test-paged-viewer.mjs --require-powerpoint`.
2. Preserve the previous release's production bundles. Run `npm run test:workspaces -- --prepare-target <previous-dist> --target dist` to create a disposable profile with the older build and reopen it with the candidate. Check settings, recents, source files, learning history, practice attempts, and roadmap evidence.
3. Run the matched extended process-tree benchmarks in [PERFORMANCE.md](PERFORMANCE.md) on the same Mac and power source. Use `npm run check:performance` with the report pair. Investigate a repeatable failure before packaging.
4. Run `npm run package:dmg` and `node scripts/verify-mac-release.mjs`. Check app version, architecture, signing, disk image checksum, mounted launch, PTY, and recovery. Use the Developer ID and notarization gate for trusted distribution. [Mac signing](docs/macos/SIGNING.md)
5. Complete the [Windows release gate](WINDOWS_RELEASE_READINESS.md). Run the Windows desktop and process-tree checks, and test the exact installer with an ordinary Windows account, including upgrade and uninstall. For a signed release, verify the installed executable, the native PTY helper, and the exact setup program. [Windows signing](docs/windows/SIGNING.md)
6. Confirm the preview’s no-project-license terms, dependency notices, and a secret scan of the candidate source and reachable history. Keep user profiles, logs, and installers out of Git history. [Distribution notes](docs/DISTRIBUTION.md)
7. Create the version tag from the tested commit. Require all desktop, installer, and benchmark jobs to pass for that exact tag and SHA, then download the two installer artifacts and their JSON evidence from the same successful Actions run and attempt. A failed tag run remains a release blocker even if a branch run at the same commit passed.
8. Verify the downloaded installers against the manifests before uploading. For example, from the repository with the matching tag available, substitute the tag and paths for the new release.

   ```sh
   tag=v0.9.6
   commit=$(git rev-parse --verify "$tag^{commit}")
   node scripts/release-evidence.mjs verify "$tag" "$commit" \
     path/to/macos-installer.dmg.json path/to/windows-installer.exe.json > SHA256SUMS
   ```

   Each JSON file belongs beside its installer. Verify the run and attempt against the GitHub run page. Publish those exact bytes and the generated checksums through GitHub Releases, then confirm the published digests. For a correction, use a new version and tag so installed copies and the updater can identify it.

## 0.9.6 stabilization record

- [x] Reproduced the Git configuration race on 9adcdea and verified the fixed launch boundary on native macOS and Windows, including real Git LFS.
- [x] Passed all four native branch jobs at 3d2998c: macOS, Windows desktop, Windows installer/upgrade and Windows performance.
- [x] Passed final type checking, 183/195 local unit cases with 12 documented skips, four signing/evidence cases and the source-history sensitive-data scan.
- [x] Completed 60 local startup/shutdown cycles, recovery and active-child cases, plus a fifteen-minute session with 180 editing rounds and 45 C executions.
- [x] Retained matched five-minute memory recovery and separate Windows candidate measurements, without claiming a RAM reduction or a valid failed-baseline comparison.
- [x] Exact-tag [run 43089559300, attempt 1](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43089559300) passed all four jobs at 18a5eea. Both downloaded installers matched their manifests and the public GitHub asset digests. [Published 0.9.6](https://github.com/Vaddi-Srisanth/Ion_IDE/releases/tag/v0.9.6).
- [ ] Physical 8 GiB hardware, four-hour sessions, retail Windows qualification and trusted platform signing remain separate preview limitations.

## 0.6.2 verification record

- [x] Type check, production build, 76 automated tests, and all production desktop regression suites.
- [x] Recover named and untitled drafts after renderer or app loss. Confirm failed saves and canceled Save As operations keep the buffer and external disk versions.
- [x] Upgrade a real disposable 0.6.1 profile and reopen a separate portable export in 0.6.2.
- [x] Verify keyboard navigation, shortcut conflicts and persistence, and keyboard operation of the document split.
- [x] Verify C, C++, Java, Python, and JavaScript, plus offline document workflows including PowerPoint through LibreOffice.
- [x] Build, mount, verify, and launch the Apple Silicon disk image. Verify its signed PTY and packaged crash recovery.
- [x] Run the matched 0.6.1 and 0.6.2 process-tree suite. All 32 enforced metrics passed. Seven active footprint comparisons remain advisory for a single measured pair.
- [ ] Validate a Developer ID-signed, notarized build and measure a longer session on lower-memory hardware before a wider release.

- [x] Validate type checking, unit tests, native desktop smoke, and production builds.
- [x] Reopen a saved source and confirm conflict handling preserves externally edited files.
- [x] Confirm Free Coding and all three optional workspaces work with outbound renderer requests blocked.
- [x] Review classifier fixture accuracy, uncertain fallbacks, and local history deletion.
- [x] Verify the online consent path in code and provider fixtures. Confirm local tests require separate approval in desktop smoke.
- [x] Verify timeout, output, cancellation, and process cleanup cases.
- [x] Run the same production benchmark before and after and save the raw measurements.
- [x] Mount the Apple Silicon disk image, check signing, and launch the packaged app.
- [x] Record any live provider or hardware coverage still outstanding.
- [ ] Run the student study before making adoption or preference claims.

## 0.3.0 resource checks

- [x] Confirm Minimal and Full switching preserves an unsaved editor buffer.
- [x] Verify Minimal starts without optional renderer assets, disposes the closed editor, and quits with no owned processes after its last window.
- [x] Verify native automatic-test consent, a qualifying save, and cancellation on Projects deactivation and profile downgrade.
- [x] Build, verify, mount, and launch the 0.3.0 disk image on Apple Silicon.

## 0.6.1 stabilization checks

- [x] Restore named and untitled edits after renderer loss and forced app exit. Verify Save As, explicit discard, and preservation of a newer external file revision.
- [x] Exercise simple runs, same-console input, errors, reruns, Stop, and Unicode paths with spaces across the five supported runner languages.
- [x] Verify that a crashed renderer stops its running program and a clean coding session leaves document engines unloaded.
- [x] Mount and verify the Apple Silicon installer. Check the signed PTY, offline workbench, and restoration after forcing the packaged app to exit.
- [ ] Verify Developer ID signing and Apple notarization before public distribution.
