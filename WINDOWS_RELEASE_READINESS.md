# Ion IDE Windows release readiness

## 0.9.6 stabilization

The complete [native run at 3d2998c](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/43086657774) passed macOS, Windows desktop, Windows installer/upgrade and Windows process-tree performance jobs. Windows exercised ten scoped filesystem/conflict cases, 55 of 57 selected unit cases with two documented skips, four evidence/signing cases, five ConPTY cases, the Git configuration race, genuine Git LFS, crash recovery, shutdown cleanup, Source Control, saved C tests, C/C++ and Java navigation, formatting, themes, viewers, workspaces, Learning Lens, onboarding and the updater. The installer upgraded the actual public 0.9.5 package and preserved its test profile and unrelated files. Final release installers must come from the exact tag's separately successful verification run and attempt. [Coverage and skips](TEST_COVERAGE_AUDIT.md) · [Current measurements](PERFORMANCE.md#native-windows-candidate)

The old Windows checkpoint failed its save workload, so a matched full-workflow comparison is unavailable. The successful candidate measurements are labeled separately. Preview setup remains unsigned. Manual Windows 10/11 qualification, physical 8 GiB hardware and a four-hour session remain open.

## Historical 0.9.5 evidence

**Windows x64 test preview.** Version 0.9.5 uses the shared Electron app and local data stores. Hosted Windows verification and retail Windows qualification are separate; the manual checklist below remains open.

The development branch adds native Source Control, saved C suites, language verification, and matched Windows development-workflow measurements to the hosted gates. The historical evidence below describes published 0.9.5. See the [platform matrix and laptop protocol](docs/windows/FEATURE_PARITY.md) and the [development measurements](PERFORMANCE.md#git-and-saved-run-tests) for the newer source.

## Windows evidence

The exact final source passed all four native CI jobs. The Windows desktop job passed 27 selected automated cases with two platform skips, four signing and evidence tests, all five ConPTY cases, and the production GUI suites. The macOS job passed 144 automated cases with 12 platform or opt-in skips, its desktop regression, and mounted-installer checks. Dependency audit reported zero vulnerabilities. [Final verification run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42680933021)

| Workflow | Evidence |
| --- | --- |
| Toolchains | Hosted Windows x64 compiled and ran real C and C++ with MinGW-w64. A JDK compiled packaged Java, multiple source files and a local JAR. Windows Maven and Gradle compiled and launched real applications in offline mode using local caches. CI populated the Maven cache before the offline run. [Native toolchain run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674160987) |
| Workspace files | Native Windows tests covered Unicode, case-only rename, case-alias Save As with confirmation, paths longer than 260 characters, junction escapes, device names, alternate streams, and concurrent sharing locks. Both transient retries and external changes were exercised. [Native filesystem run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674160987) |
| Run Console and Terminal | The published foundation passed line-based JavaScript input, rerun, and Stop. The candidate adds on-demand ConPTY with a Windows Job Object and retains a labeled fallback when ConPTY is unavailable. The first ConPTY suite exposed interactive input and output failures. After correcting inherited console handles, native Ctrl+C, output and time limits, detached-child cleanup, and labeled fallback passed. Input and Unicode arguments also reached the program. A subsequent native run passed all five ConPTY tests, including native resize, Unicode arguments, raw input, processed Ctrl+C, limits and child cleanup. Windows PowerShell 5.1 accepted keyboard input but stalled during an ordinary pipeline, including in a native test without the UI. The verified preview uses system Command Prompt with AutoRun disabled. Use Windows Terminal separately for PowerShell workflows. [ConPTY evidence](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42678474698/job/129366200087) [Revised helper run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42676915651) [Published foundation run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42670896874) · [Initial ConPTY run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42674798317) |
| Editing and recovery | The native Windows desktop passed external conflict protection, autosave, retained dirty edits, renderer crash, forced application exit, detached draft recovery, and deliberate discard. The installed app passed workspace search, editing, saving and reopening. [Native candidate tests](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677488853) |
| Viewers and workspaces | The production desktop smoke covers PDF search and split view, DOCX tables, quoted CSV, XLSX sheet selection, Markdown, saved Jupyter content, the PowerPoint external-open route, and Learn and Projects with the renderer offline. This passed on native Windows. The same suite verified a trusted Unicode file drop and rejection of a page-generated drop. [Native candidate tests](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677488853) |
| Installation and upgrade | Native Windows passed setup, upgrading from the actual published 0.9.4 installer, Start shortcut, version metadata, included PTY, Open With registration, opening a Unicode file in the existing instance, offline edit/save, and uninstall with preserved preferences and files. [Installer job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42680933021/job/129374934717) |
| macOS regression | Hosted Apple Silicon passed the full desktop regression and mounted disk-image smoke, including bundled PTY, local search, offline viewers and crash recovery. [macOS job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42680933021/job/129374934225) |
| Signing | No Authenticode signing identity was available for this preview. Windows may show a publisher or reputation warning or block it under policy. The build supports signing and verifying the app, setup and its first-party PTY helper when an appropriate identity is provisioned. [Signing guide](docs/windows/SIGNING.md) |

Native Windows desktop automation verified all five one-click toolchains, including real C compiler errors, packaged Java sources and interactive Node and Python input. The final Windows desktop run verified real Command Prompt keyboard input, directory listing, two independent sessions, commands after hiding and reopening the panel, and process cleanup after both sessions closed. [Final Windows desktop run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42680933021/job/129374934647) Hosted tests are separate from manual retail verification. [Windows desktop job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677488853/job/129362703248)

## Native Windows performance

The matched comparison ran both production builds on the same GitHub-hosted Windows Server 2025 x64 VM, build 26100, with an Intel Xeon Platinum 8370C and about 16 GiB visible RAM. The baseline was the 0.9.4 foundation at `7767e311`. The Command Prompt candidate used the same application and test source as the verified installer. Each build had three fresh-profile and three warm launches. The candidate ran first. Fresh-profile launch includes automation and retains OS filesystem caches. The workload used one C source and nine text tabs, a 1,000-file tree expanded six folders, a two-page PDF, a waiting Node process, and the new shell. [Matched run and raw samples](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42680939270)

| Stage, median | 0.9.4 working set / private bytes | 0.9.5 working set / private bytes | CPU, baseline → candidate |
| --- | ---: | ---: | ---: |
| Idle Welcome | 299.1 / 134.9 MiB | 301.1 / 137.5 MiB | 0.00% → 0.00% |
| One C file | 352.1 / 178.1 MiB | 346.6 / 171.8 MiB | 0.00% → 0.45% |
| Ten tabs | 362.4 / 183.9 MiB | 364.4 / 188.1 MiB | 0.90% → 0.45% |
| Medium project | 377.9 / 201.7 MiB | 380.4 / 204.9 MiB | 0.00% → 0.00% |
| PDF open | 430.9 / 234.7 MiB | 432.0 / 236.2 MiB | 0.00% → 0.00% |
| Run Console with waiting Node process | 470.5 / 254.4 MiB | 474.1 / 255.9 MiB | 0.00% → 0.00% |
| Command Prompt after its first prompt | — | 431.0 / 237.2 MiB | 0.00% candidate |
| After closing Command Prompt | — | 392.5 / 210.2 MiB | 4.09% candidate |

| Latency, median | 0.9.4 | 0.9.5 |
| --- | ---: | ---: |
| Fresh profile to Welcome | 496 ms | 536 ms |
| Warm profile to Welcome | 416 ms | 412 ms |
| First source file | 365 ms | 384 ms |
| Compile C to visible output | 274 ms | 318 ms |

Fresh-profile startup was 40 ms slower and warm launch was essentially unchanged. One candidate C run took 2.43 seconds, compared with a 0.36-second maximum in the baseline. The three-trial sample and run order limit what can be attributed to the application. A separate exact-source candidate run measured 455 ms fresh, 313 ms warm, and 408.3 MiB working set with Command Prompt on a different hosted VM. [Independent candidate run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42680933021/job/129374934420)

The candidate completed 28 mixed tab and C-run cycles in 61 seconds. Private bytes ranged from 219.7 to 239.3 MiB and ended at 238.5 MiB. The baseline completed 29 cycles in 62 seconds, ranged from 216.7 to 251.3 MiB, and ended at 233.6 MiB. All observed compiler and program processes exited after their runs. Closing the Terminal removed Command Prompt, the helper, and its console host in all three trials. The short soak can catch obvious growth. A multi-hour retail test is still needed.

Profiling the first candidate exposed a second console host for the native transport, about 6.7 MiB working set and 1.2 MiB private bytes. The optimized helper uses a Windows subsystem executable because Ion supplies its transport streams. The matched runs confirmed one console host per live session instead of two. The final Command Prompt shell and its native processes together used 16.4 MiB working set and 7.0 MiB private bytes. The earlier PowerShell variant's shell and native processes used 83.3 MiB working set and 58.7 MiB private bytes in a different hosted run. [Native transport experiment](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42678965800) · [Original extra-console evidence](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42677995551)

Summed working set can count shared resident pages more than once. Private bytes count private committed virtual memory, some of which can be outside RAM. CPU is a process-time delta as a percentage of one logical core over a roughly three-second window. Zero is below that window’s resolution. The Command Prompt closing sample includes cleanup activity. The shell figures were collected after opening the source and PDF and using Run Console, so xterm had already loaded.

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

The checksum-verified 0.9.5 test setup from source `fd98104cf5d245ead2773ba1a13bc19d736eb503` is **119,629,413 bytes**. Its SHA-256 is `3147a7c2119473ff3f3dc16f7040bd1a72198c8fe02ec95c5a5fffcf20929040`. It passed native setup, upgrade, and uninstall on the exact tested run. [Windows installer artifact and manifest](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42680933021)

## Manual retail Windows release gate

The hosted installer test checked per-user destinations and installation without an elevation prompt in the runner. A normal retail Windows account, laptop hardware, and the end-user download experience still need direct testing.

1. On a Windows 11 x64 laptop using an ordinary non-administrator account, install from the exact checksum-verified artifact. Check SmartScreen, icon quality, Start and taskbar shortcuts, uninstall through Settings, and persistence of a real 0.9.4 profile and workspace.
2. With a real Explorer window, use Open With both from a cold launch and with Ion already open. Drag a file onto Ion. Exercise the native Open, Save, and Run approval dialogs, Windows clipboard, full screen and maximize, keyboard-only controls, and Narrator.
3. Move Ion between 100%, 150%, and 200% DPI displays. Check splitter controls, focus, taskbar, light/dark and high-contrast appearance.
4. Disable network access at the OS level. Edit, save, recover, reopen a workspace, run trusted cached projects, browse Learn and Projects, and view local materials. Exercise a local notebook kernel if installed. Check the default PowerPoint application on that machine.
5. Verify LLVM Clang with its configured linker. Exercise Windows paths with characters outside the system code page, network and removable volumes, and local permissions under a restricted account.
6. Run a multi-hour soak on a lower-memory retail laptop. Record process-tree memory, CPU, and remaining PIDs after closing terminals, notebook kernels, viewers and Ion. Review the final signed or clearly labeled unsigned build before public distribution.
