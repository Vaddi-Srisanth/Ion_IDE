# Windows verification and known limits

Windows x64 is a preview target. Packaging on macOS does not exercise Windows dialogs, file semantics, process cleanup, or toolchains.

- The setup is unsigned. A publisher warning may appear on download or launch. Administrator-managed policies can prevent installation.
- Run uses line-based interactive input. Programs that depend on a terminal, raw keys, or resize notifications may need a separate terminal.
- Integrated Java Maven and Gradle builds, and in-app PowerPoint slide rendering, are macOS features. Windows has separate terminal and default application workflows.
- Windows ARM64 and Linux installers are outside this release.

## Native Windows release checklist

The repository’s [Windows CI job](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/workflows/desktop-build.yml) includes installer, offline editing, interactive JavaScript, and uninstall checks. The checklist below covers broader manual testing, including toolchains and features outside that smoke test.

- [ ] On Windows x64, download the final setup, check its checksum, install it as an ordinary user, launch from Start, and check that preferences remain intact after upgrading and uninstalling.
- [ ] Open and save a file in a path containing spaces and Unicode. Check external-edit protection, checkpoint recovery, session resume, and workspace search.
- [ ] Compile C and C++ and run standalone Java, Python, and JavaScript. Enter a line of input, trigger a compiler error, stop a waiting process, and check for leftover processes.
- [ ] Open Markdown and Jupyter tabs, preview PDF and Office fixtures, test PowerPoint’s default-app action, and verify theme and shortcut settings.
- [ ] Switch among Learn, Projects, and Practice with networking off. Run local samples where a toolchain is installed.

When reporting a bug, give the installer version, Windows version and architecture, and steps to reproduce it with a public example. [GitHub issues](https://github.com/Vaddi-Srisanth/Ion_IDE/issues)
