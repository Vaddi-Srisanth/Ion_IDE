# Ion IDE test plan

## Automated release gates

```sh
npm run typecheck
npm test
npm run build
npm run test:desktop
npm run test:onboarding
npm run test:java-tools
npm run test:format
npm run test:recovery
npm run test:integrity
npm run test:keyboard
npm run test:run-console
npm run test:workspaces
npm run test:profile-export
npm run test:resources
npm run test:themes
npm run test:viewers
node scripts/evaluate-project-plans.mjs
# After npm run package:dmg
node scripts/verify-mac-release.mjs
```

Run the production benchmarks in [PERFORMANCE.md](PERFORMANCE.md). Use disposable profiles and synthetic fixtures. Report the total IDE process tree and identify compiler and program subprocess costs separately. With LibreOffice available, run `node scripts/test-paged-viewer.mjs --require-powerpoint` to verify slide rendering as well as the default engine-availability path.

Run all default checks with `npm run test:regression`. An upgrade test uses `npm run test:workspaces -- --prepare-target <previous-dist> --target dist` with the previous release's production bundles. It creates and closes the old profile before the candidate reads it.

Local desktop checks use hidden Electron windows and disposable profiles. Checks that require a visible native window, including actual fullscreen transitions and packaged installer verification, require an explicit `ION_SHOW_TEST_WINDOWS=1` in a test session. CI can run visible checks on its dedicated runner.

The macOS Java desktop check uses an installed JDK and a temporary workspace. It covers Basic and Smart completion, snippets and undo, live javac markers and hover, Problems navigation, semantic queries, workspace file grants, and worker shutdown. Run it against the production build with `npm run test:java-tools`.

The formatting desktop check uses disposable workspaces and whichever local formatters are installed. Run with clang-format, Ruff, Black, and Prettier on PATH to cover all default language adapters. It exercises single Undo, encoding, project settings, remapping, read-only tabs, stale results, external changes, timeout, and process cleanup. The missing-tool path is also supported.

Onboarding uses fresh and existing disposable profiles. The desktop test covers timed playback, escape and skip, four workspace routes, first-run reduced motion, replay while editing, unavailable playback, and real C input/output. On macOS it also sends early and in-progress file-open events through Electron. The macOS installer check exercises replay from the mounted build. Check cold opening through Windows Explorer against an installed candidate on Windows.

## Student study

Recruit 5–8 students with some introductory C experience. Ask each participant to use the macOS build with a fresh profile and a locally installed compiler. Observe a short unscripted session followed by these tasks. Use a computer or a disposable VM with networking disabled for the offline portion.

1. Open Free Coding, create and save a C file, run it, then close and reopen Ion. Find the saved program and make a second edit.
2. Open Learn, install the C pack from Marketplace, and choose it explicitly. Introduce a missing semicolon, run the program, and locate its explanation. Correct the mistake without copying a solution. Repeat on an unchanged file and then after a distinct edit.
3. Create a manual project while offline. Edit a milestone, review an input/output test, run it after explicit approval, and explain the resulting evidence.
4. Enter a practice problem and notes, create an attempt, run a sample, and keep an earlier attempt while trying a second implementation.
5. Return to Free Coding and hide any panels that are in the way.

Record independent completion, time to first successful run, help requests, accessibility obstacles, confusing output, data-loss incidents, and whether the participant voluntarily returns to Learn after the assigned exercise. Keep participant files local and separate from raw observation notes.

A proposed release gate is at least 80% independent completion of the basic save/run/reopen workflow, zero lost saved changes in the study, and no confident misclassification in the reviewed fixture set. On study hardware, record median and slowest launch and first-file time. Treat the Mac benchmarks as a reference, with targets adjusted only after observing that hardware. There is no student preference result yet.
