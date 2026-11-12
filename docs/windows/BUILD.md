# Build the Windows x64 installer

Use Node.js 22.13 or later, npm, NSIS 3, and the Visual Studio x64 C++ build tools with a Windows SDK. Ion uses the Visual Studio tools to compile its terminal and file transaction helpers. Put `makensis` on `PATH`, or set `ION_MAKENSIS` to its absolute path. The first build downloads the pinned dependencies and Windows Electron archive. [NSIS downloads](https://nsis.sourceforge.io/Download)

From the source root on Windows x64:

```powershell
npm ci
npm run typecheck
npm test
npm run package:win
```

The versioned setup file lands in `release/`. `ION_WIN_OUTPUT_DIR` can select a different output folder. The script bundles a Windows x64 build of Electron and the pinned Windows ripgrep executable. The setup runs offline and installs for one user. Compilers, interpreters, and Office suites are separate.

For a Mac cross-build with NSIS 3 and `tar`, set `ION_WINDOWS_FILE_OPS_EXE` to the trusted, verified Windows x64 file helper built from this source revision. Set `ION_WINDOWS_UPDATE_EXE` to the verified updater helper from this same source revision and `ION_WINDOWS_PTY_EXE` for ConPTY support. Native Windows builds compile all helpers with Visual Studio C++ tools and the Windows SDK. Without the PTY helper, the cross-build offers Run Console line input. On macOS, the packager fetches and verifies the pinned Windows ripgrep variant. Run `npm run test:release:win` on a disposable Windows x64 machine without an Ion installation to verify the installer, offline editing, file registration, and uninstall. Set `ION_PREVIOUS_WINDOWS_INSTALLER` to the official, SHA-256-verified 0.9.6 setup file to include upgrade coverage. [Windows verification checklist](KNOWN_ISSUES.md)

Use `npm run build` followed by `npm start` for a local production run. `npm run dev` launches the Vite development server and desktop window. Restart it after main or preload changes. Desktop tests that need macOS tools or process accounting should run on macOS as documented in the [contribution guide](../../CONTRIBUTING.md).

On Windows, run `npm test -- windows-conpty workspace-files-windows file-mutation-races windows-java-build` after the production build. Run `node scripts/verify-windows-run-console.mjs`, `npm run test:source-control`, and `npm run test:project-suites` for native desktop workflows. [Performance protocol](../../WINDOWS_RELEASE_READINESS.md)

Run `node scripts/test-windows-updater.mjs` on a disposable Windows machine after packaging to verify natural-exit waiting, failed-Setup rollback and same-profile restart. Internet-zone approval of unsigned Setup remains an interactive OS check.
