# Release checklist

## Current release procedure

1. On a target Mac, install Node.js and npm, Xcode Command Line Tools, a JDK, Python 3, and Node.js for the language matrix. Run `npm ci`, then `npm run test:regression`. Retain the console results. With LibreOffice available, run `node scripts/test-paged-viewer.mjs --require-powerpoint`.
2. Preserve the previous release's production bundles. Run `npm run test:workspaces -- --prepare-target <previous-dist> --target dist` to create a disposable profile with the older build and reopen it with the candidate. Check settings, recents, source files, learning history, practice attempts, and roadmap evidence.
3. Run the matched extended process-tree benchmarks in [PERFORMANCE.md](PERFORMANCE.md) on the same Mac and power source. Use `npm run check:performance` with the report pair. Investigate a repeatable failure before packaging.
4. Run `npm run package:dmg` and `node scripts/verify-mac-release.mjs`. Check app version, architecture, signing, disk image checksum, mounted launch, PTY, and recovery. Keep the previous installer available.
5. Cross-build Windows setup with `npm run package:win`, then install and exercise the exact installer on a Windows x64 machine. [Native Windows checklist](docs/windows/KNOWN_ISSUES.md)
6. Confirm the preview’s no-project-license terms, dependency notices, secret scan of the staged source and history, and CI status before publishing. Keep user profiles, logs, and installers out of Git history. Publish installer assets and checksums through GitHub Releases after the distribution checks. [Distribution notes](docs/DISTRIBUTION.md)
7. Test the final artifacts on their target operating systems and document the signing status. The preview uses an ad-hoc-signed, unnotarized Mac build and unsigned Windows setup. For a signed production release, use Developer ID signing and Apple notarization on macOS and a publisher certificate for Windows.

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
