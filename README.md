# Ion IDE

**An offline-first desktop IDE for learning by coding.**

*Write code. Understand errors. Learn offline.*

Ion is a personal project by Vaddi Srisanth for students and developers who want to run their own code and understand what went wrong. Free Coding is a regular editor. Learn, Projects, and Practice open beside it when you need them. Your source files, lessons, notes, and progress stay local. The Electron workbench loads the editor and optional tools on demand. You can use the IDE without an account or API key. [Architecture](ARCHITECTURE.md)

[Download](#download-and-install) · [Quick start](#quick-start) · [Features](#features) · [Screenshots](#screenshots) · [Performance](#performance) · [Contributing](#contributing)

![Ion IDE editing a C program with the workspace explorer, syntax highlighting, and editor tabs](docs/screenshots/editor.webp)

## Download and install

Get the installers and SHA-256 checksums from the [latest GitHub release](https://github.com/Vaddi-Srisanth/Ion_IDE/releases/latest). The feature guide follows [version 0.9.5](docs/releases/0.9.5.md).

| Platform | Installer | Install |
| --- | --- | --- |
| macOS 13 or later, Apple Silicon | `Ion-IDE-<version>-mac-arm64.dmg` | Open the disk image, drag **Ion IDE** into **Applications**, then launch it there. |
| Windows x64 preview | `Ion-IDE-<version>-windows-x64-setup.exe` | Run setup, then open **Ion IDE** from Start. |

The macOS disk image is ad-hoc signed and unnotarized. Gatekeeper may block it on first open. Windows setup is unsigned and can trigger SmartScreen or organizational policy. Compare the installer’s SHA-256 with `SHA256SUMS` from the same release before opening it. Windows x64 automation runs on Windows Server 2025. Manual Windows 10/11 coverage remains open. [Apple Gatekeeper guidance](https://support.apple.com/en-us/102445) · [Windows readiness](WINDOWS_RELEASE_READINESS.md)

Editing, previews, bundled lessons, local plans, and practice work offline. Install the language toolchain you want to run separately. The optional online planner and update checks use the network.

| To run | Install separately |
| --- | --- |
| C or C++ | Apple Clang via `xcode-select --install` on macOS, or a compatible Clang/GCC toolchain. On Windows, use GNU-compatible GCC or Clang. |
| Java | A JDK with `java` and `javac`. |
| Python or JavaScript | Python 3 or Node.js, respectively. |
| Jupyter cells or PowerPoint previews | A Python environment with `jupyter_client` and `ipykernel` for cell execution. On macOS, LibreOffice for static PowerPoint previews. |

[macOS setup](docs/USAGE.md#macos-setup) · [Windows toolchains](docs/windows/DEPENDENCIES.md)

### Build from source

Install Git, Node.js 22.13 or later, and npm. The initial dependency downloads require internet access.

```sh
git clone https://github.com/Vaddi-Srisanth/Ion_IDE.git
cd Ion_IDE
npm ci
npm run build
npm start
```

[Development and packaging](docs/USAGE.md#build-from-source) · [Windows build prerequisites](docs/windows/BUILD.md) · [macOS signing](docs/macos/SIGNING.md)

## Quick start

1. Install Ion and a C compiler, then launch Ion.
2. Choose **Open Folder** for your code folder or **New File**. Save the file as `hello.c`.
3. Write a small program that asks for input.

   ```c
   #include <stdio.h>

   int main(void) {
       char name[80];

       fputs("What's your name? ", stdout);
       fflush(stdout);
       if (fgets(name, sizeof name, stdin)) {
           printf("Hello, %s", name);
       }
       return 0;
   }
   ```

4. Click **Run** or press **F5**. Review the local execution prompt.
5. In **Run Console**, type your name and press **Enter**. Look for the greeting and the exit status.
6. Remove the semicolon after `fflush(stdout)`, save, and run again. Read the compiler message in Run Console.
7. Install the C pack from **Marketplace** and select it in **Learn**. Rerun the broken file. In v0.9.4, check **Latest run** for an available explanation. In the source preview, choose **Explain** in **Problems**. Restore the semicolon and run again.

[Run Console guide](docs/USAGE.md#write-and-run-code) · [Keyboard shortcuts](docs/USAGE.md#keyboard-navigation)

## Features

### Learning Lens

For supported C compiler errors, Ion connects the source location, the original diagnostic in **Problems**, and an installed offline lesson. The explanation card shows a short example. **Explain Again** appears if the issue recurs after a meaningful edit. A successful recompilation can record the issue as resolved in local history. That event describes the compiler result. Ambiguous diagnostics keep their original message and tell you when a reliable explanation is unavailable. Toggle the Lens in **Preferences → Run Console**. [Learning Lens guide](docs/USAGE.md#learning-lens)

### Run, learn, and verify

| Capability | Coverage in v0.9.5 source |
| --- | --- |
| **One-click Run** | C, C++, Java, Python, and JavaScript via Node.js. Run Console handles live output and stdin, compiler messages, Stop, Rerun, and exit status. |
| **Smart Java** | Local Java snippets and optional JDK-backed semantic completion, live diagnostics, signatures, and navigation. [Java editing guide](docs/USAGE.md#java-suggestions-and-diagnostics) |
| **Bundled learning packs** | 162 lessons across 19 packs. Core syntax, common APIs, examples, exercises, and selected mini-projects. Install or import packs offline. |
| **Diagnostic explanations** | C with GCC or Clang has the Learning Lens workflow. Reviewed subsets for C++, Java, Python, and JavaScript also link to relevant installed lessons. |
| **Project verification** | Review and approve C tests that compare program input, output, and exit status. Track manual milestones separately from test evidence. Approved tests can run on save in Full Mode. |
| **Practice** | Pick a topic, language, and difficulty for 27 built-in challenges with sample tests. Save notes, results, and multiple attempts. Run samples in the five languages listed above. |

The catalog covers C, C++, Java, Python, JavaScript, TypeScript, Go, Rust, Swift, C#, Bash, Ruby, Perl, HTML, CSS, SQLite, JSON, XML, and YAML. A pack provides lessons. Executing its examples depends on the installed toolchain and Ion's Run coverage. [Pack catalog and authoring](docs/LEARNING_PACKS.md)

### Everyday coding

- **Get started offline.** New profiles can watch the first-launch intro or skip straight to Welcome. Setup offers a language starter and the four workspaces. Reduced motion uses the static setup.
- **Edit and navigate.** Monaco, starter files, multiple tabs, command palette, Quick Open, saved-file workspace search, configurable shortcuts, and resizable panels.
- **Format source.** Use the status bar or a shortcut to format the current buffer with an installed local tool. Changes apply as one undoable edit. [Formatting guide](docs/USAGE.md#format-a-source-file)
- **Protect work.** Autosave, revision-aware saves, external-change prompts, crash recovery, session reopening, and local export for settings, themes, learning history, and project metadata.
- **Use a shell.** The integrated Terminal opens on demand, with multiple sessions, search, and bounded scrollback. It uses your configured shell on macOS and Command Prompt via ConPTY on Windows. Run Console stays separate.
- **Read beside code.** Live Markdown split preview, local web preview, editable Jupyter notebooks with optional local execution, and read-only PDF, DOCX, XLSX, CSV, and compatible macOS PowerPoint previews.
- **Make it yours.** Five built-in themes, system appearance, local JSON theme import and export, and Minimal or Full resource profiles.
- **Plan locally or online.** Write a plan offline or request a reviewable specification through an optional HTTPS OpenAI-compatible provider with your own key. Ion asks before sending the project description. The planner proposes milestones and test definitions for review. You write the code.
- **Update when you choose.** Check in Preferences → Updates, or opt in to checks on launch. When a compatible GitHub release is available, the title bar offers a checksum-verified installer download that you can open yourself.

[Usage guide](docs/USAGE.md) · [Resource profiles](RESOURCE_PROFILES.md) · [Local profile export](PORTABLE_PROFILE.md)

## Screenshots

Captured in the v0.9.5 production app using sample workspaces.

![Learning Lens links an actual C compiler diagnostic to the highlighted line and the relevant offline concept](docs/screenshots/learning-lens.webp)

<details>
<summary>Run Console, Marketplace, Projects, Markdown, and Practice</summary>

**Run Console** with input and output from a locally compiled C program.

![Run Console showing three entered readings and the calculated average](docs/screenshots/run-console.webp)

**Marketplace** with an installed Python learning pack.

![Offline Learning Marketplace showing the Python pack, lesson count, and topic filters](docs/screenshots/marketplace.webp)

**Projects** with a locally verified C test.

![Project roadmap showing milestone status and a passed greeting test alongside source](docs/screenshots/projects.webp)

**Markdown** in a live source and preview split.

![Markdown source beside a rendered guide with a table and checklist](docs/screenshots/markdown-preview.webp)

**Practice** with a challenge and the Python sample-test interface.

![Practice challenge with its statement and sample tests beside a Python attempt](docs/screenshots/practice.webp)

</details>

## Performance

Production-build measurements include the Electron process tree. CPU is a percentage of one logical core during the indicated workload. Startup measures time to Welcome with the OS file cache intact.

| Ion version | Host | Measured workload | Memory metric | CPU | Fresh / warm startup |
| --- | --- | --- | --- | --- | --- |
| 0.9.4 public preview | Apple M3, 24 GiB, macOS 27.2 | Welcome, six-second idle sample | 418.59 MiB summed RSS, 123.00 MiB macOS-attributed footprint | 0.29% | 375.21 / 366.50 ms |
| 0.9.5 with Learning Lens | Apple M3, 24 GiB, macOS 27.2 (26B123) | C compiler error and explanation open, 1.5-second CPU sample | 540.8 MiB summed RSS | 0.65% | 399.6 ms fresh profile |
| 0.9.5 before Learning Lens | Xeon Platinum 8370C, ~16 GiB, Windows Server 2025 x64 (26100) | Welcome, roughly three-second idle sample | 301.1 MiB summed working set, 137.5 MiB private bytes | 0.00% at sample resolution | 536 / 412 ms |

Summed RSS and working set can count shared resident pages more than once. macOS-attributed footprint and Windows private bytes use different accounting. Each row describes its own host and workload. [macOS methodology](PERFORMANCE.md) · [Windows methodology](WINDOWS_RELEASE_READINESS.md#native-windows-performance)

## Limitations

- **Debugging and builds.** Ion has no integrated debugger. One-click multi-file C/C++ builds require an explicit source list for one executable and one language. Use a shell for Make, CMake, MSVC, and custom build pipelines. Java Maven and Gradle integration relies on supported local tools, cached dependencies, and standard project layouts.
- **Learning and tests.** Diagnostic coverage is curated and depends on the compiler, language, and message. Project verification supports approved C console tests. Practice checks samples locally. Official submissions happen on the original practice site.
- **Notebooks and documents.** Notebook execution requires a local Python kernel. Preview supports static outputs, with limitations for widgets, rich math, and `input()`. Office previews have layout limits. macOS PowerPoint uses LibreOffice for static slides. Windows opens PowerPoint externally.
- **Platforms and signing.** Packaged targets are Apple Silicon macOS and Windows x64 preview. Intel Mac and Linux installers are unavailable. On Windows, the source preview uses Command Prompt for its integrated Terminal. Use Windows Terminal for PowerShell. See the installer section for signing and OS coverage.
- **Recovery.** Crash recovery restores the last saved checkpoint, which can miss recent keystrokes. Undo history does not survive relaunch. Revision checks protect against detected changes, but an independent writer can race a save. Profile export excludes source workspaces, practice attempts, and recovery drafts.
- **Execution.** Programs and build scripts run with your account's permissions. Timeouts, output limits, and process cleanup bound the runner. Treat code, shell commands, and project builds as trusted before running them.

[Windows known issues](docs/windows/KNOWN_ISSUES.md) · [Release checklist](RELEASE_CHECKLIST.md) · [Roadmap](ROADMAP.md)

## Contributing

Ion is a personal project, and everyone is welcome to test the preview. Use the issue templates to report bugs or propose features. For learning packs, share an example, expected result, or a proposed correction. Documentation and translation proposals are welcome. Discuss source changes with the maintainer before opening a focused pull request with relevant test results. Report suspected vulnerabilities privately. [Open an issue](https://github.com/Vaddi-Srisanth/Ion_IDE/issues/new/choose) · [Contribution guide](CONTRIBUTING.md) · [Pack guide](docs/LEARNING_PACKS.md) · [Security policy](SECURITY.md) · [Changelog](CHANGELOG.md)

## License

Ion IDE is a public preview by [Vaddi Srisanth](https://github.com/Vaddi-Srisanth). The project has no license granting general reuse, modification, or redistribution of its source. Third-party components retain their licenses and attribution. [Distribution and third-party notices](docs/DISTRIBUTION.md)
