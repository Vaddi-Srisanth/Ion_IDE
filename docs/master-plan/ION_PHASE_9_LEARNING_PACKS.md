# Phase 9 — Declarative learning pack updates

When a local learning pack is updated through Content settings, the preview identifies added and changed lessons, gives the installed and incoming versions, and shows previous attribution when it changed. The review compares the validated lesson data, including content changes that leave a title unchanged.

Confirmation rechecks both the incoming pack and the installed baseline inside the existing serialized import. If either changed, Ion requests a fresh review before writing. A removed pack cannot be silently reinstalled with an earlier update token. The import continues to use the existing atomic registry switch and keeps learning evidence keyed to existing lesson IDs.

Nine focused pack tests passed, including concurrent-baseline changes and removal. The disposable production Electron journey verified visible change markers, source-change rejection and offline relaunch on macOS ARM64. The Phase 8–9 native lane [46069366644](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/46069366644) also passed the production learning-pack review/import journey on Windows x64, including update preview and relaunch. Executable extension isolation on a constrained host remains open; this phase only accepts declarative content packs.
