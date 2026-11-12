# Windows feature comparison

Ion uses the same workbench and local data stores on both platforms. The 0.9.6 stabilization passed native Windows and macOS verification at source 3d2998c. Historical 0.9.5 evidence and the final exact-tag installer gate are identified separately. Hosted Windows tests are separate from testing on retail hardware. [Release evidence](../../WINDOWS_RELEASE_READINESS.md) · [Verification checklist](KNOWN_ISSUES.md)

| Area | macOS on Apple Silicon | Windows x64 preview |
| --- | --- | --- |
| Workbench | Editing, tabs, explorer, autosave, recovery, local themes, shortcuts, and workspace search | Same features, with Ctrl-based shortcuts and a native Windows menu |
| Source navigation | Breadcrumbs and Back/Forward verified. Real Smart Java and optional clangd navigation tested in the development build | Shared implementation. Native Java and clangd verification is a CI gate |
| Source Control | Real Git fixtures verify status, text diffs, staging, unstaging, commits, and worktrees | Shared implementation using Git for Windows. Native desktop and repository fixtures passed the stabilization run |
| Saved Run Tests | Real compiler and program fixtures cover saved approval, result comparison, cancellation, and persisted evidence | Shared test adapter uses the native C runner. Native desktop verification is a CI gate |
| Standalone Run | C, C++, Java, Python, and JavaScript with local toolchains | Same language targets, with Windows tool discovery |
| Interactive input | Pseudo-terminal for ordinary character input and resize events | Windows ConPTY, with labeled line input when the helper or API is unavailable |
| General-purpose Terminal | The user's local shell in a separate bottom-panel tab | Command Prompt through ConPTY, with separate sessions and no automatic launch |
| Maven and Gradle | Ion can run supported projects from the local build-tool cache | Explicitly approved builds with a supported installed distribution and cached dependencies |
| Preview | Local web and Markdown, Jupyter, and read-only PDF, DOCX, XLSX, and CSV | Shared preview and notebook implementation. A local Python kernel is required for notebook execution |
| PowerPoint | Static slide preview with a compatible LibreOffice installation and the macOS converter restrictions | Opens the original in its associated desktop app |
| Learn, Projects, and Practice | Offline packs, local project specs and approved C tests, challenge catalog and solution history | Shared workspace features and data formats. Execution uses the installed Windows toolchains |
| Learning Lens | Local source-linked C explanations, resolution history, and optional lesson pane | Native Windows Lens regression passed. Other language packs offer reviewed explanations for selected diagnostics |
| Theme picker | Built-in and imported themes, live preview, accessibility variants, and undo preservation verified in the development build | Shared picker. Native theme suite runs in Windows CI |
| AI Mentor | Future milestone. The optional online project planner is a separate feature | Same scope |
| Desktop integration | Finder Open With, Applications, Trash, and native full screen | Start menu, Recycle Bin, Settings uninstall, and native full screen. Setup registers Open With for supported files. The user chooses defaults |
| Updates | Verified download, explicit in-place Install and Restart, atomic bundle exchange and rollback ZIP | Verified download, explicit in-place Install and Restart, per-user Setup and failed-install rollback |

Programs using buffered stdout may need an explicit flush before reading input from the Windows console. For example, call `fflush(stdout)` after a C prompt or `std::flush` after a C++ prompt.

### 8 GiB and 16 GiB laptop verification

Use a native x64 Windows machine or VM at each memory size and record Windows build, CPU, RAM, pagefile, display scaling, and power mode. Run the two production builds on the same host with the same Chromium acceleration and security settings. Record available memory in Task Manager before starting. Run the controlled script first. Then repeat with the same browser tabs open, a medium repository, a C build and saved suite, a large Git diff, Learning Lens, a PDF or Markdown note, and Command Prompt input. Record any typing, scroll, or tab-switch stalls, available memory, and committed memory while the workspace is active. Close the diff, test runner, and shell and record the process tree again. Use `--soak-seconds 1800` for a 30-minute automated editing and development workload.

```powershell
npm run bench:development -- --baseline C:\ion-baseline\dist --trials 3 --soak-seconds 1800
node scripts/benchmark-windows.mjs --label laptop --terminal --trials 3 --soak-ms 60000
```

Store the JSON reports for each memory size. Compare private bytes with private bytes and working set with working set. The hosted Windows Server run represents its own machine, OS, and workload. Retail 8 GiB and 16 GiB hardware sessions remain open.
