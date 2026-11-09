# Contributing to Ion IDE

Ion is a personal project. Everyone is welcome to test the public preview and share feedback. Start with a reproducible problem or focused proposal, and discuss code contributions with the maintainer. The preview carries no project license granting general reuse. [Open an issue](https://github.com/Vaddi-Srisanth/Ion_IDE/issues/new) · [Distribution notes](docs/DISTRIBUTION.md)

## Development setup

Install Node.js 22.13 or later and npm. For the macOS desktop regression, install Xcode Command Line Tools, a JDK, and Python 3. Use a disposable profile when testing file recovery, settings migration, or local code execution. Keep your own projects and credentials outside test fixtures. [Windows build guide](docs/windows/BUILD.md)

```sh
npm ci
npm run dev
```

## Where things live

| Path | Responsibility |
| --- | --- |
| `src/renderer/` | React workbench, Monaco, terminal, optional workspace panes, and viewers |
| `src/main/` | Filesystem access, persistence, process execution, IPC validation, and platform integrations |
| `src/preload/` | Typed bridge between the workbench and main process |
| `src/shared/` | Contracts and domain rules shared across processes |
| `scripts/` | Build, package, desktop integration checks, and benchmarks |
| `test/` | Automated tests and synthetic fixtures |

Keep changes focused. Follow the local TypeScript style and reuse existing IPC validation and process controls. Prefer bounded, on-demand work. Add a regression test for the failure or behavior the change addresses. Use simulated provider replies in tests. [Architecture](ARCHITECTURE.md)

## Verify the change

```sh
npm run typecheck
npm test
npm run build
npm run test:desktop
```

Run `npm run test:regression` on macOS for release changes. Use `node scripts/test-paged-viewer.mjs --require-powerpoint` with LibreOffice installed to cover real slide conversion. Changes to kernel execution also need a Python environment with `jupyter_client` and `ipykernel`. [Test plan](TEST_PLAN.md)

For changes that affect startup, editor state, process lifetime, or optional features, compare the same production workload before and after on the same host. Report startup latency, whole-process-tree RSS, idle CPU, and affected interactions. On macOS, report attributed footprint separately. Preserve enough context to repeat the measurement and note any limitations. [Benchmark protocol](PERFORMANCE.md)

## Report a bug or propose a change

Include the Ion version, OS version and architecture, reproduction steps, expected behavior, and actual behavior. A synthetic file or minimal code example is easier to share and debug than a personal workspace. For a proposed change, describe the workflow and what success looks like. For suspected vulnerabilities, use the private reporting instructions. [Issues](https://github.com/Vaddi-Srisanth/Ion_IDE/issues) · [Security policy](SECURITY.md)
