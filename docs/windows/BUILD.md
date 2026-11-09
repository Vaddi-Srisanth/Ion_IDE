# Build the Windows x64 installer

Use Node.js 22.13 or later, npm, NSIS 3, and the Visual Studio x64 C++ build tools with a Windows SDK. Ion uses the Visual Studio tools to compile its small terminal helper. Put `makensis` on `PATH`, or set `ION_MAKENSIS` to its absolute path. The first build downloads the pinned dependencies and Windows Electron archive. [NSIS downloads](https://nsis.sourceforge.io/Download)

From the source root on Windows x64:

```powershell
npm ci
npm run typecheck
npm test
npm run package:win
```

The versioned setup file lands in `release/`. `ION_WIN_OUTPUT_DIR` can select a different output folder. The script bundles a Windows x64 build of Electron and the pinned Windows ripgrep executable. The setup runs offline and installs for one user. Compilers, interpreters, and Office suites are separate.

The same command cross-builds from a Mac with NSIS 3 and `tar`. To include ConPTY support in a cross-build, set `ION_WINDOWS_PTY_EXE` to a trusted x64 helper built from this source revision. Without it, the cross-build offers Run Console line input. On macOS, npm installs the host ripgrep binary, so the packager fetches the pinned Windows variant and checks the package against `package-lock.json`. Cross-building verifies packaging. Run `npm run test:release:win` on a disposable Windows x64 machine with no existing Ion installation to verify the installer, offline editing, file registration, and uninstall. Set `ION_PREVIOUS_WINDOWS_INSTALLER` to the official, SHA-256-verified 0.9.4 setup file to include upgrade coverage. [Windows verification checklist](KNOWN_ISSUES.md)

Use `npm run build` followed by `npm start` for a local production run. `npm run dev` launches the Vite development server and desktop window. Restart it after main or preload changes. Desktop tests that need macOS tools or process accounting should run on macOS as documented in the [contribution guide](../../CONTRIBUTING.md).

On Windows, run `npm test -- windows-conpty workspace-files-windows windows-java-build` after the production build. Run `node scripts/verify-windows-run-console.mjs` and `node scripts/test-windows-native.mjs` for native desktop workflows. [Performance protocol](../../WINDOWS_RELEASE_READINESS.md)
