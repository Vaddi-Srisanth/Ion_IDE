# Ion IDE Windows compatibility audit

Ion shares one Electron workbench, editor, renderer, and profile format across Windows and macOS. Windows uses native adapters for process execution, shell input, packaging, and process accounting. This audit covers the Windows x64 target. [Architecture](ARCHITECTURE.md) · [Release gate](WINDOWS_RELEASE_READINESS.md)

## Evidence and status

- **Public v0.9.4.** The `main` workflow passed on `88ecebd0`. The `v0.9.4` tag at the same commit failed when the installed app did not persist the update preference within the test deadline. The failure did not establish the underlying cause. [Main run](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42627190663) · [Tagged Windows job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42627857612/job/129196183102)
- **Release foundation.** Native hosted Windows x64 passed on `7767e311`. The evidence covers a silent per-user install, Start menu shortcut, installed ripgrep, offline file editing and search, JavaScript line input and Stop, a real sharing lock on preferences, both preference toggles in the installed app, and uninstall preservation. The GUI tests used automation and the Run test substituted the approval dialog. [Windows job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/42670896874/job/129346956517) · [Foundation report](docs/ADOPTION_READINESS.md)
- **Current Windows changes.** This audit describes the candidate source. Historical passes apply to the named revisions and workflows. See the release gate for results tied to the current candidate, installer checksums, and any later native test run. [Desktop workflow](.github/workflows/desktop-build.yml) · [Release gate](WINDOWS_RELEASE_READINESS.md)

“Verified on native Windows” below is qualified by the exact historical coverage above. “Implemented but unverified” means the feature has source or tests but lacks corresponding Windows runtime evidence here. “Partially working” identifies a concrete limitation alongside the working or implemented portion. “Broken” denotes an observed failure. “Unsupported by design” denotes a deliberate scope boundary. “Blocked by external requirements” needs credentials, hardware, a trusted integration, or another dependency beyond the current candidate.

## Editing, data, and Windows integration

| Feature | Windows status | Evidence and limits |
| --- | --- | --- |
| Welcome, open workspace, open file, edit, manual save, close and reopen tab | Verified on native Windows | Historical installed-app test used a prepared recent workspace and reopened the saved file from Explorer. The Windows file picker needs separate interaction testing. |
| Workspace search | Verified on native Windows | Historical installed-app test exercised bundled ripgrep and opening a matched line. |
| Create files and folders, rename, delete | Implemented but unverified | Main-process file operations and Recycle Bin handoff exist. Candidate coverage includes case-only rename and the trash handoff. The actual Recycle Bin and its behavior on network or removable volumes need native desktop checks. |
| Cross-directory Explorer moves | Unsupported by design | The integrated Explorer provides same-directory rename. Use File Explorer for moving entries between folders. |
| Space, Unicode, long and case-variant paths | Implemented but unverified | Candidate tests exercise spaces, Unicode, over-260-character local paths, and case aliases. The scoped Explorer uses canonical paths. Path behavior on SMB shares, exFAT, and per-directory case-sensitive NTFS needs its own verification. |
| Source saves while a file is locked | Implemented but unverified | The candidate retries transient replacement errors with bounded backoff and rechecks the disk revision before each attempt. Native tests hold a real Windows sharing lock, check conflict handling, and check temporary file cleanup. |
| Save As and external-edit protection | Implemented but unverified | An existing Windows case alias resolves to the actual selected file and still needs replacement consent. Revision checks catch external edits before replacement. |
| Autosave, unsaved-change protection, crash recovery | Implemented but unverified | The shared editor and checkpoint store support these flows. Native testing must include forced exit, restoration, and a newer external file. |
| Resume session, selections, scroll, undo and redo | Partially working | Session restore carries tabs, selections and scroll. Undo is bounded within a session and can reset after app restart, tab close, reload or disk changes. Windows recovery and in-session undo need native verification. |
| Shortcut remapping, command palette, Quick Open, Find and Replace, Go to Line | Implemented but unverified | Shared renderer and Windows Ctrl shortcuts exist. Windows keyboard-only navigation and shortcut conflicts need exercise. |
| Themes, light/dark system appearance, panel sizing | Implemented but unverified | Shared CSS and Monaco themes plus locally stored settings. Windows high-contrast mode, DPI scaling, and mixed-DPI display transitions need hands-on checks. |
| Default window controls, maximize, fullscreen, clipboard and dialogs | Implemented but unverified | The Windows workbench uses Electron’s window and clipboard APIs. The installed test checks clean window close. Verify native open/save and trust dialogs, clipboard behavior, multiple monitors, focus, and screen readers. |
| Start menu and taskbar | Partially working | The Start shortcut and launched window were exercised historically. Icon quality at different DPI, taskbar pinning, grouping and restore from minimized state need checks. |
| File association and Open With | Implemented but unverified | Setup registers per-user Open With entries without changing defaults. A packaged instance accepts absolute file arguments, including on a second launch. Verify the Explorer chooser and cold launches with Unicode paths. |
| File Explorer drag-and-drop | Implemented but unverified | The isolated preload accepts trusted file drops, with a bounded list and regular-file validation in the main process. It opens files as tabs. Folder drops are outside this candidate. |
| Local data export and migration | Implemented but unverified | Profile export covers settings, themes, installed packs, learning data and project metadata. Workspace code, drafts and practice attempts require their own backup. Verify export and import or profile migration on a disposable Windows profile. |
| Local preferences under a sharing lock | Verified on native Windows | The foundation Windows run exercised transient and persistent lock outcomes and update consent in the installed GUI. This is separate from candidate workspace-file lock coverage. |

### Save and recovery boundaries

When Ion reports a disk conflict, preserve the editor buffer with **Save As** to a different path, or compare it with the disk version before reloading. A persistent sharing lock can block replacement until the other program closes its handle. Existing saves publish through a same-directory temporary file. Revision checks and publication are separate filesystem operations, so an unrelated writer can still race the final operation. Ordinary Node rename does not establish preservation of custom NTFS ACLs or alternate streams. Keep a separate backup for files that rely on either. [Workspace file service](src/main/files.ts) · [Windows sharing semantics](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew) · [Windows directory case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity)

## Code execution

| Feature | Windows status | Evidence and limits |
| --- | --- | --- |
| One-click JavaScript, line input, rerun, Stop | Verified on native Windows | Historical production GUI test used local Node, entered a line and stopped a waiting program. Native run approval and the candidate PTY path are separate. |
| C and C++ one-click Run | Implemented but unverified | Discovers installed GCC/Clang drivers, compiles, streams output and reports diagnostics. Test both compiler families, working directory, spaces/Unicode, compile failure, interactive input and Stop. |
| MSVC and clang-cl | Unsupported by design | Existing run plans target GCC-compatible drivers. Ion does not discover `cl.exe`, initialize its developer environment, or send it GCC flags. |
| Multi-source C and C++ | Implemented but unverified | Explicit `.ion/build.json` source lists build one executable. No automatic Make or CMake integration. |
| Python and Java standalone | Implemented but unverified | Local Python/Node/JDK detection is present. Verify real programs, buffered output, errors, working directories and startup from non-ASCII Windows paths. |
| Java packages, companion sources, main class and local JARs | Implemented but unverified | Shared Java runner supports these paths and candidate Windows discovery covers common installed JDKs. A real multi-file native test is required. |
| Maven and Gradle | Partially working | Candidate supports compatible installed distributions, explicit approval, offline flags and available local dependencies. No automatic wrapper download or execution. Builds can run trusted project scripts. Offline flags govern dependency resolution and do not isolate arbitrary plugin code from the network. |
| Integrated Terminal and genuine interactive Run | Implemented but unverified | Candidate uses ConPTY with native input and resize. The shell starts on demand, uses system PowerShell with no profile or falls back to cmd with AutoRun disabled. The Run Console retains a labeled line fallback. Test multiple sessions, hide/reopen, ANSI, raw keys, Ctrl+C and closing descendants. |
| Process limits and cleanup | Partially working | Historical Windows Stop reached the cancelled UI state. Candidate tests must establish real child/grandchild exit, natural leader exit, renderer/app loss, and time and output limits. A Windows Job Object manages the ConPTY process family. Neither the job nor the execution limits isolate trusted code from the user's files or network. |
| Integrated debugger | Unsupported by design | No debugger UI or debug adapter is part of this candidate. |

On systems without usable ConPTY, the Run Console uses line input. A standalone PowerShell, cmd or Windows Terminal session is the fallback for applications requiring raw keys or terminal dimensions. Microsoft's ConPTY API starts at Windows 10 version 1809. The installer’s version check alone does not qualify a retail Windows release or hardware combination. [Microsoft CreatePseudoConsole reference](https://learn.microsoft.com/en-us/windows/console/createpseudoconsole)

## Viewers and learning workspaces

| Feature | Windows status | Evidence and limits |
| --- | --- | --- |
| Markdown, local images and live split | Implemented but unverified | Shared renderer and scoped asset paths. Verify unsaved edits, split, undo, relative links and external-resource blocking on Windows. |
| Local HTML/CSS/JS preview | Implemented but unverified | Shared local protocol with scoped workspace assets. Verify route and asset handling, window shortcuts and offline behavior. |
| PDF | Implemented but unverified | Shared paged PDF renderer. Test page navigation, text search, a large file and disposal after close. |
| DOCX | Implemented but unverified | Shared read-only parser and viewer. Test paragraphs, tables, images, malformed inputs and unchanged originals. |
| XLSX | Implemented but unverified | Shared worksheet selector and bounded grid. Verify a multi-sheet file, search, large-sheet behavior and cleanup. |
| CSV | Implemented but unverified | Shared quoted-field parser with delimiter and encoding support. Test quoted newlines, Windows-1252 and large files. |
| PPTX default-application action | Implemented but unverified | Ion can request the system-associated viewer. The action depends on an installed and associated application. |
| PPTX in-app slides, thumbnails and presentation mode | Blocked by external requirements | Candidate has no verified Windows converter confinement. PDF export through an external application is a way to preview slides beside code in Ion. |
| Jupyter notebook editing and execution | Implemented but unverified | Shared native notebook UI and local Python discovery. Execution requires a compatible local Python environment with the kernel dependencies installed. Verify cells, output, save, kernel stop and no idle kernel. |
| Learn and Marketplace | Implemented but unverified | The shared offline pack catalog, installation, Topics and diagnostic lessons need current Windows desktop verification. |
| Projects and Practice | Implemented but unverified | Shared local specifications, test approval, practice catalog and attempt history. Verify offline switching, one approved test, and saved progress. |
| Online AI planning | Blocked by external requirements | Optional user-provided key, network and provider/model availability. It is separate from offline workspaces. |
| Offline editor and saved workspace access | Verified on native Windows | The historical installed-app test blocked renderer network access and exercised search and save. Full-machine offline checks should also cover optional panels and confirm launch behavior with update checks disabled. |

### PowerPoint conversion

LibreOffice supports local conversion on Windows via its installed command-line launcher. Its headless flag suppresses the UI. The macOS route additionally denies network access and constrains filesystem writes, uses a disposable profile, disables macros, and enforces time and output limits. A Windows Job Object can supervise the process but cannot supply equivalent file or network isolation by itself. Running the converter directly would process untrusted slides with the user's access.

A viable Windows route is a dedicated AppContainer with no network capability, access limited to the runtime dependencies and a disposable conversion directory, macro and external-content blocking, and bounded execution. Native tests would need to show that the converter cannot access other user documents or reach the network, leaves no process after cancellation, and renders representative diagrams and charts. Ion currently offers **Open in Default Application**, with no background converter or Office bundle. [LibreOffice startup parameters](https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html) · [Microsoft AppContainer isolation](https://learn.microsoft.com/en-us/windows/win32/secauthz/appcontainer-isolation) · [Current converter](src/main/viewers/presentation.ts)

## Installer, updates, and performance

| Feature | Windows status | Evidence and limits |
| --- | --- | --- |
| Windows x64 per-user NSIS setup | Verified on native Windows | The foundation workflow built and ran the setup, checked its Start shortcut and ripgrep, and launched the installed app. Retail setup screens, icon, permissions and ordinary-user installation need manual checks on the candidate. |
| Uninstall and project/profile preservation | Verified on native Windows | The foundation native test removed owned binaries and the shortcut while retaining the workspace, preferences and an unknown file. Test Settings-driven uninstall and upgrade from an older real installation on the candidate. |
| Upgrade and published-update handoff | Implemented but unverified | Version discovery and checksum-verified downloads exist. Historical CI verified opt-in persistence. Full update through installer launch and profile preservation needs testing on the exact versioned artifact. |
| Public v0.9.4 tag gate | Broken | The historical tagged Windows run failed the installed preference check. A green branch run at the same SHA did not clear the tag gate. |
| Installer signatures and clean-machine trust | Blocked by external requirements | The SignTool path requires a provisioned public-trust signing identity and timestamping. An unsigned preview can show publisher or reputation warnings or be blocked by policy. |
| Native Windows ARM64 | Unsupported by design | Packaging and native helper verification target x64. |
| Windows runtime performance | Implemented but unverified | The candidate benchmark samples the full application tree, including child processes, using summed working set, private bytes and CPU-time deltas. A matched Windows baseline and candidate are needed before claiming a change. macOS RSS or attributed footprint cannot substitute. [Windows benchmark](scripts/benchmark-windows.mjs) · [Performance report](PERFORMANCE.md) |

## Verification order

1. Run the current candidate’s native Windows filesystem, process cleanup and interactive-terminal tests. Confirm manual save, external conflicts, forced-exit recovery and no orphan processes on a disposable profile.
2. Exercise the five toolchains and both offline Java build tools using real projects. Run viewer and workspace tests with networking disabled. Verify that the unavailable PowerPoint conversion produces its external-open fallback.
3. Install, upgrade and uninstall on retail Windows x64 under an ordinary account. Verify native prompts, Open With, DPI, keyboard and accessibility behavior with the exact installer intended for distribution.
4. Compare baseline and candidate on the same Windows machine and power plan. Record fresh-profile and warm startup, idle CPU and memory, one file, ten tabs, a medium project, terminal, run and preview overhead, cleanup and sustained use. A fresh profile does not flush the operating system’s file cache.
5. Tie the signed artifact or explicitly unsigned preview to its exact source revision, passing native run and checksum. [Release checklist](RELEASE_CHECKLIST.md)
