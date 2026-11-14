# Windows verification and known limits

## Current diagnostic checkpoint — 14 November 2026

The historical 12.67 second GCC wait remains unexplained. A new 909 attempt Windows 2022/GCC 14.2 cohort has zero timeouts/observer errors; native Windows 2025/GCC 15.2 app units, C/ConPTY lifecycle, recovery and installer upgrade/rollback have separate evidence. Neither is retail-laptop certification or proof of no intermittent delay. The observer partial-list and pre-save hash-preflight defects are corrected; the earlier PID-access, PS5-array and crash-reopen fixtures are now verified with explicit native checks. One older intro-phase miss and one LFS preflight failure remain unclassified historical events; new diagnostic fields preserve a recurrence. [Final matrix, all skipped cases and known limits](../../diagnostics/windows-gcc/RELEASE_VERIFICATION.md). Unsigned preview, macOS 27 local registration conditions and physical-device/signing limits remain explicit. No installer was published by this work.

Windows x64 is a preview target. Packaging on macOS does not exercise Windows dialogs, file semantics, process cleanup, or toolchains.

- The setup is unsigned. A publisher warning may appear on download or launch. Administrator-managed policies can prevent installation.
- On systems without usable ConPTY, Run Console shows its line-input fallback. Use an external terminal for programs that require raw keys or terminal dimensions in that environment.
- The integrated Windows shell defaults to Command Prompt. Use Windows Terminal separately for PowerShell.
- Windows PPTX opens in the system-associated application. Ion does not yet have an isolated Windows LibreOffice conversion path.
- C and C++ Run uses GCC-compatible compiler drivers. Use an external developer shell for MSVC projects.
- Windows ARM64 and Linux installers are outside this release.

## Native Windows release checklist

The [candidate readiness report](../../WINDOWS_RELEASE_READINESS.md) records native CI results and the checks still needed on retail Windows.

- [ ] On Windows x64, download the final setup, check its checksum, install it as an ordinary user, launch from Start, and check that preferences remain intact after upgrading and uninstalling.
- [ ] Open and save a file in a path containing spaces and Unicode. Check external-edit protection, checkpoint recovery, session resume, and workspace search.
- [ ] Compile C and C++ and run standalone Java, Python, and JavaScript. Enter a line of input, trigger a compiler error, stop a waiting process, and check for leftover processes.
- [ ] Open Markdown and Jupyter tabs, preview PDF and Office fixtures, test PowerPoint’s default-app action, and verify theme and shortcut settings.
- [ ] Switch among Learn, Projects, and Practice with networking off. Run local samples where a toolchain is installed.

When reporting a bug, give the installer version, Windows version and architecture, and steps to reproduce it with a public example. [GitHub issues](https://github.com/Vaddi-Srisanth/Ion_IDE/issues)
