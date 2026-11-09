# Ion IDE 0.9.5 Windows release readiness

**Verdict: Windows x64 preview. Hold the public 0.9.5 release until the native candidate and the retail Windows checklist pass.** The public download remains 0.9.4. This candidate uses the shared Electron app and local data stores.

## Windows evidence

| Workflow | Evidence |
| --- | --- |
| Toolchains | Hosted Windows x64 compiled and ran real C and C++ with MinGW-w64. A JDK compiled packaged Java, multiple source files and a local JAR. Windows Maven and Gradle compiled and launched real applications in offline mode using local caches. CI populated the Maven cache before the offline run. [Native toolchain run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674160987) |
| Workspace files | Native Windows tests covered Unicode, case-only rename, case-alias Save As with confirmation, paths longer than 260 characters, junction escapes, device names, alternate streams, and concurrent sharing locks. Both transient retries and external changes were exercised. [Native filesystem run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674160987) |
| Run Console and Terminal | The published foundation passed line-based JavaScript input, rerun, and Stop. The candidate adds on-demand ConPTY with a Windows Job Object and retains a labeled fallback when ConPTY is unavailable. The first ConPTY suite exposed interactive input and output failures. The revised helper must pass before the candidate is cleared. [Published foundation run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42670896874) · [Initial ConPTY run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674798317) |
| Editing and recovery | The historical installed-app test exercised workspace search, editing, save and reopen. The candidate suite also exercises external conflicts, forced exit, detached drafts, and deliberate discard. [Compatibility audit](WINDOWS_COMPATIBILITY_AUDIT.md) |
| Viewers and workspaces | The production desktop smoke covers PDF search and split view, DOCX tables, quoted CSV, XLSX sheet selection, Markdown, saved Jupyter content, the PowerPoint external-open route, and Learn and Projects with the renderer offline. Native Windows verification of this new suite is part of the candidate gate. |
| Installation and upgrade | The foundation verified per-user setup, Start menu shortcut, offline editing, and uninstall. The candidate suite additionally checks upgrading the real 0.9.4 installer, version metadata, preserved preferences and workspace files, Open With registration, and Unicode file opening into an existing instance. |
| Signing | No Authenticode signing identity was available for this preview. Windows may show a publisher or reputation warning or block it under policy. The build supports signing and verifying the app, setup and its first-party PTY helper when an appropriate identity is provisioned. [Signing guide](docs/windows/SIGNING.md) |

## Native Windows performance

The comparison reference is the 0.9.4 foundation at `7767e311` with the same benchmark harness. It ran on GitHub’s Windows Server 2025 x64 image, build 26100, an AMD EPYC 9V45 host with about 16 GiB of visible RAM. Each sample series used three production launches with distinct profiles, three warm launches reusing those profiles, and roughly three-second CPU windows per stage. The fixture has one C source and nine text tabs, a 1,000-file tree expanded six folders, a two-page PDF, and a waiting Node process. Fresh-profile startup includes automation and retains OS filesystem caches. [Baseline logs and raw samples](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674502931)

| Stage, median | 0.9.4 summed working set | 0.9.4 private bytes | 0.9.4 CPU, % of one core |
| --- | ---: | ---: | ---: |
| Idle Welcome | 298.7 MiB | 135.4 MiB | 0.00% |
| One C file | 354.0 MiB | 180.8 MiB | 0.00% |
| Ten tabs | 361.5 MiB | 184.2 MiB | 0.00% |
| Medium project | 376.8 MiB | 201.8 MiB | 0.00% |
| PDF open | 425.7 MiB | 232.1 MiB | 0.00% |
| Run Console with waiting Node process | 466.9 MiB | 247.5 MiB | 0.00% |

Baseline launch medians were **403 ms fresh-profile** and **265 ms warm**. Opening the first source took **237 ms**, and compiling C through visible output took **224 ms**. The baseline completed 35 iterations in 61 seconds, switching source tabs and building and running C each time. Private bytes after cleanup went from **226.9 to 231.7 MiB** over those samples.

Summed working set can count shared resident pages more than once. Private bytes count private committed virtual memory, some of which can be outside RAM. CPU is process CPU-time delta as a percentage of one logical core. A reported zero is below the resolution of the short sample. Windows measurements use the actual Electron PID, all discoverable descendants, and profile-owned helper processes. They cannot be equated with macOS RSS or attributed footprint. The short soak checks process reaping and catches obvious growth. It cannot establish memory bounds for a multi-hour session.

The first candidate run stalled at visible C output, so its benchmark did not complete. No before/after resource improvement is claimed from that run. [Initial candidate benchmark](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674719290)

To reproduce against a production build on Windows:

```powershell
npm ci
npm run build
node scripts/benchmark-windows.mjs --label candidate --terminal --trials 3 --idle-ms 3000 --soak-ms 60000
```

Use `--target` to point to another production build directory. Omit `--terminal` for the 0.9.4 foundation. For machine-specific release thresholds, repeat both builds on the same physical machine and power plan.

## Security and known limits

- ConPTY uses Windows Job Objects to bound ownership and reap the session’s descendants. Run timeouts and output limits still apply. Approved programs, shell commands, and project scripts execute with the current user’s permissions.
- The file-drop bridge requires a trusted native event in the isolated preload. The main process validates regular files and path scope. Explorer drops open files as tabs. Folder drops and cross-directory moves use the normal file picker or Explorer.
- Ion uses same-directory atomic publication where available and rechecks disk revisions before replacement. Concurrent writes can still race the final system call. Custom NTFS ACLs and alternate streams have no preservation guarantee. Keep recovery drafts and the workspace on separate backups when they matter.
- Windows PowerPoint uses **Open in Default Application**. Headless LibreOffice does not isolate untrusted input from local files or the network. An isolated Windows converter requires a separate implementation and native escape tests. [Compatibility audit](WINDOWS_COMPATIBILITY_AUDIT.md)
- One-click C/C++ expects a GCC-compatible compiler. MSVC and clang-cl projects require a separately configured developer shell. Some Windows GCC and JDK distributions have path-encoding limitations. Linux and native Windows ARM64 installers are outside this gate.
- The installer checks for x64 Windows 10 or later. ConPTY requires Windows 10 version 1809 or later. The automated evidence is for Windows Server 2025 x64. Retail Windows 11 x64 and any Windows 10 release are separate qualification targets. [Microsoft ConPTY requirements](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)

## Manual retail Windows release gate

1. On a Windows 11 x64 laptop using an ordinary non-administrator account, install from the exact checksum-verified artifact. Check SmartScreen, icon quality, Start and taskbar shortcuts, uninstall through Settings, and persistence of a real 0.9.4 profile and workspace.
2. With a real Explorer window, use Open With both from a cold launch and with Ion already open. Drag a file onto Ion. Exercise the native Open, Save, and Run approval dialogs, Windows clipboard, full screen and maximize, keyboard-only controls, and Narrator.
3. Move Ion between 100%, 150%, and 200% DPI displays. Check splitter controls, focus, taskbar, light/dark and high-contrast appearance.
4. Disable network access at the OS level. Edit, save, recover, reopen a workspace, run trusted cached projects, browse Learn and Projects, and view local materials. Exercise a local notebook kernel if installed. Check the default PowerPoint application on that machine.
5. Verify LLVM Clang with its configured linker. Exercise Windows paths with characters outside the system code page, network and removable volumes, and local permissions under a restricted account.
6. Run a multi-hour soak on a lower-memory retail laptop. Record process-tree memory, CPU, and remaining PIDs after closing terminals, notebook kernels, viewers and Ion. Review the final signed or clearly labeled unsigned build before public distribution.
