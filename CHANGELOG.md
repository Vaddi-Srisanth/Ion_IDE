# Changelog

## 0.9.5 source candidate

- Added Learning Lens for recognized C compiler errors. Open an explanation from Problems, jump to the corresponding source highlight, revisit the explanation after a meaningful retry, and see when a successful compile resolves the error. Ion keeps the original compiler message and lets you turn the Lens off. [Candidate notes](docs/releases/0.9.5.md) · [Performance measurements](PERFORMANCE.md#learning-lens)
- Expanded the offline Learning Marketplace to 19 packs and 162 lessons. Added practice exercises with sample tests for supported languages and refined reviewed diagnostic explanations for C, C++, Java, Python, and JavaScript. [Learning packs](docs/LEARNING_PACKS.md)
- Added a general-purpose Terminal alongside the Run Console. Verified zsh on macOS and Command Prompt on hosted Windows x64 before Learning Lens. Shell sessions start on demand and keep running when you hide the panel. [Terminal measurements](PERFORMANCE.md#integrated-terminal-on-macos)
- Added explicit multi-file C and C++ builds and launchers for offline Windows Maven and Gradle projects with local toolchains and dependencies. Hardened Windows file saves, recovery, and Open With handling. [Windows verification](WINDOWS_RELEASE_READINESS.md)

## 0.9.4 public preview

- Added a Windows x64 installer target and Windows-specific toolchain discovery, line input, and process cleanup. [Platform comparison](docs/windows/FEATURE_PARITY.md) · [Native CI](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/workflows/desktop-build.yml)
- Hardened the macOS terminal helper against losing unread output when a short program exits.
- Added an Updates panel for checking GitHub Releases, verifying installer downloads, and revealing the downloaded file. Checking at launch is opt-in.
- Updated the bundled DOMPurify sanitizer to 3.4.17 and included the Monaco and DOMPurify notices in production builds.
- Updated Welcome to describe the local runner accurately. Added installer, development, testing, and security reporting instructions. [Public release and downloads](https://github.com/Vaddi-Srisanth/Ion_IDE/releases/tag/v0.9.4) · [Release notes](docs/releases/0.9.4.md)

## 0.9.4 editor reliability

- Added on-demand Search in Files with grouped matches, jump to line, and cancellation.
- Added a paged read-only view for large UTF-8 source files and strengthened Save As and local profile handling.
- Reduced measured peak macOS attributed footprint in the mixed document workload while retaining the bounded editor model cache. Whole-process-tree summed RSS rose in the same peak workload. [Measurements](PERFORMANCE.md#094-editor-reliability-and-workspace-search)

## 0.9.0 guided practice

- Added a filterable catalog of 27 offline challenges, with statements, examples, and 108 sample tests. Users can start or resume solutions in five languages and save separate attempts. [Implementation and measurements](PERFORMANCE.md#090-guided-practice)

## 0.8.0 Learning Marketplace

- Added 11 individually installable offline language packs and validated imports. Learn opens on Topics and allows the user to select an installed language. [Implementation and measurements](PERFORMANCE.md#080-learning-marketplace)

## 0.7.1 Markdown preview

- Added Source, Preview, and resizable live Split View for Markdown. Preview reads the current buffer and resolves approved workspace images and links. [Implementation and measurements](PERFORMANCE.md#071-offline-markdown-preview)

## 0.7.0 Jupyter notebooks

- Added local notebook tabs, cell editing, saved outputs, metadata, and optional execution through a local Python kernel. [Implementation and measurements](PERFORMANCE.md#070-macos-offline-notebook-support)

## 0.6.4 editor residency

- Bounded live Monaco models and measured repeated large-file opens and closes on macOS. [Implementation and measurements](PERFORMANCE.md#064-macos-large-file-reopen-memory)

## 0.6.3 macOS startup and memory

- Investigated slow first launch and compared active editor and viewer memory in packaged macOS builds. [Measurements](PERFORMANCE.md#063-macos-editor-and-viewer-memory)

## 0.6.2 and 0.6.1 stabilization

- Verified local recovery and file conflict handling, editor keyboard navigation, interactive runs in five languages, and mounted Apple Silicon packages. [Release evidence](RELEASE_CHECKLIST.md)

## Earlier milestones

- Built the local editing and C runner foundation, C learning and diagnostics, project plans and verification, theme customization, read-only document viewers, and the interactive Run Console. [Roadmap](ROADMAP.md) · [Performance history](PERFORMANCE.md)
