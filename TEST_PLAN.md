# Ion IDE test plan

## Automated release gates

```sh
npm run typecheck
npm test
npm run build
npm run test:desktop
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

## Student study

Recruit 5–8 students with some introductory C experience. Ask each participant to use the macOS build with a fresh profile and a locally installed compiler. Observe a short unscripted session followed by these tasks. Use a computer or a disposable VM with networking disabled for the offline portion.

1. Open Free Coding, create and save a C file, run it, then close and reopen Ion. Find the saved program and make a second edit.
2. Open Learn, install the C pack from Marketplace, and choose it explicitly. Introduce a missing semicolon, run the program, and locate its explanation. Correct the mistake without copying a solution. Repeat on an unchanged file and then after a distinct edit.
3. Create a manual project while offline. Edit a milestone, review an input/output test, run it after explicit approval, and explain the resulting evidence.
4. Enter a practice problem and notes, create an attempt, run a sample, and keep an earlier attempt while trying a second implementation.
5. Return to Free Coding and hide any panels that are in the way.

Record independent completion, time to first successful run, help requests, accessibility obstacles, confusing output, data-loss incidents, and whether the participant voluntarily returns to Learn after the assigned exercise. Keep participant files local and separate from raw observation notes.

A proposed release gate is at least 80% independent completion of the basic save/run/reopen workflow, zero lost saved changes in the study, and no confident misclassification in the reviewed fixture set. On study hardware, record median and slowest launch and first-file time. Treat the Mac benchmarks as a reference, with targets adjusted only after observing that hardware. There is no student preference result yet.
