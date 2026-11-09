# Windows feature comparison

Ion uses the same workbench and local data stores on both platforms. The table describes the 0.9.5 source candidate. [Release evidence](../../WINDOWS_RELEASE_READINESS.md) [Verification checklist](KNOWN_ISSUES.md)

| Area | macOS on Apple Silicon | Windows x64 preview |
| --- | --- | --- |
| Workbench | Editing, tabs, explorer, autosave, recovery, local themes, shortcuts, and workspace search | Same features, with Ctrl-based shortcuts and a native Windows menu |
| Standalone Run | C, C++, Java, Python, and JavaScript with local toolchains | Same language targets, with Windows tool discovery |
| Interactive input | Pseudo-terminal for ordinary character input and resize events | Windows ConPTY, with labeled line input when the helper or API is unavailable |
| General-purpose Terminal | The user's local shell in a separate bottom-panel tab | Command Prompt through ConPTY, with separate sessions and no automatic launch |
| Maven and Gradle | Ion can run supported projects from the local build-tool cache | Explicitly approved builds with a supported installed distribution and cached dependencies |
| Preview | Local web and Markdown, Jupyter, and read-only PDF, DOCX, XLSX, and CSV | Shared preview and notebook implementation. A local Python kernel is required for notebook execution |
| PowerPoint | Static slide preview with a compatible LibreOffice installation and the macOS converter restrictions | Opens the original in its associated desktop app |
| Learn, Projects, and Practice | Offline packs, local project specs and approved C tests, challenge catalog and solution history | Shared workspace features and data formats. Execution uses the installed Windows toolchains |
| Desktop integration | Finder Open With, Applications, Trash, and native full screen | Start menu, Recycle Bin, Settings uninstall, and native full screen. Setup registers Open With for supported files. The user chooses defaults |
| Updates | Checks GitHub for the macOS disk image when requested | Checks GitHub for the Windows installer when requested |

Programs using buffered stdout may need an explicit flush before reading input from the Windows console. For example, call `fflush(stdout)` after a C prompt or `std::flush` after a C++ prompt.
