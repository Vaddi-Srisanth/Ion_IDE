# Ion IDE 0.9.5 Windows release readiness

**Windows x64 test preview.** Hold the public 0.9.5 release while the integrated PowerShell command path and retail Windows checklist are open. The public download remains 0.9.4. This candidate uses the shared Electron app and local data stores.

## Windows evidence

| Workflow | Evidence |
| --- | --- |
| Toolchains | Hosted Windows x64 compiled and ran real C and C++ with MinGW-w64. A JDK compiled packaged Java, multiple source files and a local JAR. Windows Maven and Gradle compiled and launched real applications in offline mode using local caches. CI populated the Maven cache before the offline run. [Native toolchain run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674160987) |
| Workspace files | Native Windows tests covered Unicode, case-only rename, case-alias Save As with confirmation, paths longer than 260 characters, junction escapes, device names, alternate streams, and concurrent sharing locks. Both transient retries and external changes were exercised. [Native filesystem run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674160987) |
| Run Console and Terminal | The published foundation passed line-based JavaScript input, rerun, and Stop. The candidate adds on-demand ConPTY with a Windows Job Object and retains a labeled fallback when ConPTY is unavailable. The first ConPTY suite exposed interactive input and output failures. After correcting inherited console handles, native Ctrl+C, output and time limits, detached-child cleanup, and labeled fallback passed. Input and Unicode arguments also reached the program. A subsequent native run passed all five ConPTY tests, including native resize, Unicode arguments, raw input, processed Ctrl+C, limits and child cleanup. The integrated PowerShell GUI still failed to display a command result after Enter reached the process. [ConPTY evidence](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42678474698/job/129366200087) [Revised helper run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42676915651) [Published foundation run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42670896874) · [Initial ConPTY run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674798317) |
| Editing and recovery | The native Windows desktop passed external conflict protection, autosave, retained dirty edits, renderer crash, forced application exit, detached draft recovery, and deliberate discard. The installed app passed workspace search, editing, saving and reopening. [Native candidate tests](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677488853) |
| Viewers and workspaces | The production desktop smoke covers PDF search and split view, DOCX tables, quoted CSV, XLSX sheet selection, Markdown, saved Jupyter content, the PowerPoint external-open route, and Learn and Projects with the renderer offline. This passed on native Windows. The same suite verified a trusted Unicode file drop and rejection of a page-generated drop. [Native candidate tests](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677488853) |
| Installation and upgrade | Native Windows passed setup, upgrading from the actual published 0.9.4 installer, Start shortcut, version metadata, included PTY, Open With registration, opening a Unicode file in the existing instance, offline edit/save, and uninstall with preserved preferences and files. [Installer job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677488853/job/129362703856) |
| macOS regression | Hosted Apple Silicon passed the full desktop regression and mounted disk-image smoke, including bundled PTY, local search, offline viewers and crash recovery. [macOS job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677488853/job/129362703898) |
| Signing | No Authenticode signing identity was available for this preview. Windows may show a publisher or reputation warning or block it under policy. The build supports signing and verifying the app, setup and its first-party PTY helper when an appropriate identity is provisioned. [Signing guide](docs/windows/SIGNING.md) |

Native Windows desktop automation verified all five one-click toolchains, including real C compiler errors, packaged Java sources and interactive Node and Python input. The same run exercised PowerShell process launch. Its keyboard-submission check remains open. Hosted tests are separate from manual retail verification. [Windows desktop job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677488853/job/129362703248)

## Native Windows performance

The comparison reference is the 0.9.4 foundation at `7767e311`. Three fresh and three warm production launches ran on each Windows Server 2025 x64 VM, build 26100, with about 16 GiB visible RAM. The baseline VM used an AMD EPYC 9V45 and the candidate VM used an AMD EPYC 7763. Differences in startup, file opening, and execution latency can reflect the host. The fixture used one C source and nine text tabs, a 1,000-file tree expanded six folders, a two-page PDF, and a waiting Node process. The candidate also sampled an idle PowerShell session. [Baseline raw samples](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674502931) · [Candidate raw samples](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677995551)

| Stage, median | 0.9.4 working set / private bytes | 0.9.5 working set / private bytes | CPU, baseline → candidate |
| --- | ---: | ---: | ---: |
| Idle Welcome | 298.7 / 135.4 MiB | 299.8 / 136.9 MiB | 0.00% → 0.38% |
| One C file | 354.0 / 180.8 MiB | 347.4 / 174.3 MiB | 0.00% → 0.92% |
| Ten tabs | 361.5 / 184.2 MiB | 362.8 / 185.9 MiB | 0.00% → 0.46% |
| Medium project | 376.8 / 201.8 MiB | 378.4 / 202.9 MiB | 0.00% → 0.00% |
| PDF open | 425.7 / 232.1 MiB | 429.4 / 234.3 MiB | 0.00% → 0.00% |
| Run Console with waiting Node process | 466.9 / 247.5 MiB | 481.8 / 254.7 MiB | 0.00% → 0.00% |
| Idle integrated PowerShell | — | 499.2 / 285.3 MiB | 0.00% candidate |
| After closing PowerShell | — | 390.4 / 207.4 MiB | 2.29% candidate, sampled during cleanup |

| Latency, median | 0.9.4 | 0.9.5 |
| --- | ---: | ---: |
| Fresh profile to Welcome | 403 ms | 473 ms |
| Warm profile to Welcome | 265 ms | 381 ms |
| First source file | 237 ms | 343 ms |
| Compile C to visible output | 224 ms | 283 ms |

The baseline completed 35 tab-switching and C execution cycles in 61 seconds. Private bytes after cleanup went from 226.9 to 231.7 MiB. The candidate completed 29 cycles in 61 seconds and went from 218.1 to 233.4 MiB. Both reaped every observed compiler and program process. Terminal close reaped the shell, helper and console-host processes. The short soak can catch obvious growth. It cannot establish memory bounds for multi-hour sessions.

Summed working set can count shared resident pages more than once. Private bytes count private committed virtual memory, some of which can be outside RAM. CPU is process CPU-time delta as a percentage of one logical core over a roughly three-second sample. Zero is below the resolution of that window. The measurements use the actual Electron PID and include discoverable descendants and profile-owned helpers. Fresh-profile startup includes automation and retains OS filesystem caches.

The initial 0.9.5 benchmark measured two Windows console hosts under the native helper. One host belonged to the helper transport itself, using about 6.7 MiB working set and 1.2 MiB private bytes. The candidate build now links the transport as a Windows subsystem executable because Ion supplies its standard streams. A matched rerun measures the resulting tree. [Benchmark sources](scripts/benchmark-windows.mjs)

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

## Installer evidence

The checksum-verified 0.9.5 test setup from source `81b9bf91c19c69bc358cf0669e659ca3ce9597b0` is **119,593,134 bytes**. Its SHA-256 is `eef24e7a324f607857d84be8011539701c5c84533502af0a621121ed328d1ae1`. This artifact predates the transport subsystem change. [Native installer artifact and manifest](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677488853)

## Manual retail Windows release gate

1. On a Windows 11 x64 laptop using an ordinary non-administrator account, install from the exact checksum-verified artifact. Check SmartScreen, icon quality, Start and taskbar shortcuts, uninstall through Settings, and persistence of a real 0.9.4 profile and workspace.
2. With a real Explorer window, use Open With both from a cold launch and with Ion already open. Drag a file onto Ion. Exercise the native Open, Save, and Run approval dialogs, Windows clipboard, full screen and maximize, keyboard-only controls, and Narrator.
3. Move Ion between 100%, 150%, and 200% DPI displays. Check splitter controls, focus, taskbar, light/dark and high-contrast appearance.
4. Disable network access at the OS level. Edit, save, recover, reopen a workspace, run trusted cached projects, browse Learn and Projects, and view local materials. Exercise a local notebook kernel if installed. Check the default PowerPoint application on that machine.
5. Verify LLVM Clang with its configured linker. Exercise Windows paths with characters outside the system code page, network and removable volumes, and local permissions under a restricted account.
6. Run a multi-hour soak on a lower-memory retail laptop. Record process-tree memory, CPU, and remaining PIDs after closing terminals, notebook kernels, viewers and Ion. Review the final signed or clearly labeled unsigned build before public distribution.
