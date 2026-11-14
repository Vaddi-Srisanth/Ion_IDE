# Test coverage audit

## Final revision-qualified verification — 14 November 2026

Final local non-GUI Mac:276 total,250 pass,26 skip,0 fail. Hosted Mac complete workbench at `62b4140`:274 unit cases,249 pass/25 skip; actual Jupyter and packagedDMG checks pass. Complete nativeWindows at `bc90d00`:268 total,253 pass/15 skip/0 fail; three cold C cohorts and independent Git/LFS/shutdown supplement also pass. [Every skipped case and remaining gap](diagnostics/windows-gcc/TEST_VERIFICATION_MATRIX.md) · [Actual failed and passing workflow matrix](diagnostics/windows-gcc/RELEASE_VERIFICATION.md). No skipped or unavailable test is promoted to passing, and no installed-profile or physical 8 GiB claim is made.

The final stabilization suite records 195 unit cases, 183 passes, 12 skips and zero failures on macOS. Native Windows separately passed all ten scoped filesystem/conflict cases, 55 of 57 selected portable/Windows cases with two documented skips, four signing/evidence checks, five ConPTY cases and its production desktop suites. The Git suite has twenty cases, including deterministic racy-index and Windows source-path regressions. All skipped platform/tool requirements below remain explicit. The macOS fullscreen desktop test is deliberately skipped under background automation. The genuine Git LFS fixture was executed with a verified local 3.8.1 tool, and the native Windows workflow requires its installed Git LFS fixture. Missing tools fail that fixture with `UNAVAILABLE` rather than passing a substitute. [Stabilization evidence](ENGINEERING_AUDIT.md#stabilization-follow-up-from-9adcdea)

## Twelve skipped tests

The preceding macOS production regression recorded 164 unit tests, 152 passes, 12 skips, and zero failures. The eleven native Windows skips are expected on macOS. The Java launcher integration is opt-in because it needs separate tools and a populated dependency cache. The tests and skip gates are preserved.

| Skipped test | Location | Why skipped on macOS and what it leaves open | Required environment and CI |
| --- | --- | --- | --- |
| Windows Run Console stops the process tree | [test/line-console.test.ts](test/line-console.test.ts#L57) | Intentional Windows gate. The fallback line runner exists. This case exercises Windows descendant termination. | Windows x64 and Node.js. Run in the Windows unit step. |
| Windows preferences recover from a sharing lock and preserve the old file on a persistent lock | [test/preferences-windows.test.ts](test/preferences-windows.test.ts#L12) | Intentional Windows gate. It covers the native sharing-lock retry and final preservation path. | Windows x64, PowerShell, and a local filesystem. Run in the Windows unit step. |
| Installed Maven and Gradle JVM launchers compile a project and run its real entry point offline | [test/run-plans.test.ts](test/run-plans.test.ts#L172) | Intentional opt-in. The tested integration exists. The default suite leaves the installed-tool, plugin cache, and actual invocation path open. | JDK, Maven 3.9, Gradle 8.10–8.x or 9.x, and cached fixture dependencies. Windows CI sets `ION_TEST_WINDOWS_JAVA_BUILDS=1` and primes a disposable cache. The opt-in macOS launcher run also passed locally. |
| Windows Run Console uses ConPTY for TTY, resize, Unicode argv and interactive input | [test/windows-conpty.test.ts](test/windows-conpty.test.ts#L28) | Intentional Windows gate. This case verifies native terminal input and dimensions using the built helper. | Windows x64 with ConPTY, built Ion PTY helper, and Node.js. Run after the Windows production build. |
| Windows ConPTY forwards control input to the program | [test/windows-conpty.test.ts](test/windows-conpty.test.ts#L86) | Intentional Windows gate. It verifies delivery and handling of native Ctrl+C. | Windows x64 with ConPTY and the built PTY helper. Run after the Windows production build. |
| Windows ConPTY bounds busy program output and execution time | [test/windows-conpty.test.ts](test/windows-conpty.test.ts#L122) | Intentional Windows gate. It verifies the native output and timeout limits under a real workload. | Windows x64 with ConPTY and the built PTY helper. Run after the Windows production build. |
| Windows terminal launches in the workspace and explicit close cleans up a detached child | [test/windows-conpty.test.ts](test/windows-conpty.test.ts#L151) | Intentional Windows gate. It verifies the native working directory and cleanup of a detached descendant. | Windows x64 with ConPTY, the built PTY helper, and Command Prompt. Run after the Windows production build. |
| Windows Run Console falls back to line input if the installed helper is absent | [test/windows-conpty.test.ts](test/windows-conpty.test.ts#L213) | Intentional Windows gate. It exercises the Windows fallback when the optional helper is missing. | Windows x64 and Node.js. Run with the other ConPTY tests after the production build. |
| Windows workspace keeps canonical Unicode paths and confirms a case-alias Save As | [test/workspace-files-windows.test.ts](test/workspace-files-windows.test.ts#L53) | Intentional Windows gate. It exercises the case-insensitive path and explicit overwrite behavior. | Windows x64 and a case-insensitive local filesystem. Run in the Windows unit step. |
| Windows workspace denies junction escapes, case-variant roots, devices, and data streams | [test/workspace-files-windows.test.ts](test/workspace-files-windows.test.ts#L80) | Intentional Windows gate. It covers Windows-specific path boundaries and unsafe path forms. | Windows x64 on NTFS with junction support. Run in the Windows unit step. |
| Windows workspace reads and saves long paths with Unicode names | [test/workspace-files-windows.test.ts](test/workspace-files-windows.test.ts#L99) | Intentional Windows gate. It covers native long-path and Unicode handling. | Windows x64 with long-path support. Run in the Windows unit step. |
| Windows atomic saves recover from transient sharing locks and preserve external edits | [test/workspace-files-windows.test.ts](test/workspace-files-windows.test.ts#L110) | Intentional Windows gate. It verifies recovery from real write contention and preservation of an external edit. | Windows x64, PowerShell, and a local filesystem. Run in the Windows unit step. |

The macOS Windows-only skips are exercised in the separate native Windows job. The selected Windows unit suite skips the POSIX missing-runtime fixture and the active workspace-search cancellation fixture. Native ConPTY, line-input and shutdown tests cover their own Windows process-ownership cases, but do not replace direct coverage of that search cancellation path. Windows also lacks Ruff and Black for its Python formatter desktop cases; their installed-tool cases passed separately on macOS. The test names, unit filters, and native helper build order are in [Desktop verification](.github/workflows/desktop-build.yml). Configured jobs require a run on this revision before counting as evidence.

### Additional desktop skips

- **Native macOS fullscreen startup.** The test needs a visible macOS window because it verifies actual fullscreen transitions. Local verification uses hidden disposable windows. The macOS CI environment enables visible windows for this fixture. [Window startup test](scripts/test-window-startup.mjs)
- **Prettier fixtures.** The prior run verified the missing-tool message. Installing Prettier 3.6.2 in a temporary tool directory enabled the full JavaScript, TypeScript, HTML, CSS, JSON, Markdown, malformed input, and blocked plugin cases. They passed locally. Both CI jobs now install the same test tool outside the checkout. Prettier remains an optional runtime dependency. [Formatter test](scripts/test-format-code.mjs)
- **Installed Maven and Gradle launcher retest.** The opt-in macOS run passed both live subtests with Maven 3.9.11, Gradle 9.4.1, and JDK 25. The Maven test primes a disposable cache, then compiles and runs the fixture offline. This exercises the launcher logic on macOS. The separate Windows job exercises native Windows process and path handling. [Launcher test](test/run-plans.test.ts#L172)

```sh
npm test -- languages
ION_SHOW_TEST_WINDOWS=0 node scripts/test-language-capabilities.mjs
ION_SHOW_TEST_WINDOWS=0 npm run test:navigation
ION_SHOW_TEST_WINDOWS=0 npm run test:java-tools
ION_SHOW_TEST_WINDOWS=0 npm run test:format
ION_TEST_JAVA_LAUNCHERS=1 ION_TEST_PRIME_MAVEN=1 npm test -- run-plans
```

The desktop commands use an existing production build. The last command also needs `MAVEN_HOME`, `GRADLE_HOME`, a compatible `JAVA_HOME`, and the two tools on PATH. Priming downloads the pinned fixture dependencies before the offline build assertion.

## Language capabilities

The language registry distinguishes built-in editing and lesson data from executable tooling. The macOS production renderer passed a fixture checking actual token colors and language labels for all 23 entries. The Windows job runs the same fixture. Unit tests cross-check all advertised extensions, validate all 19 bundled packs, and compare the registry to the diagnostic and practice adapters. Native fixture evidence for runtime and semantic tools is listed after the table. [Language registry](src/shared/languages.ts) · [Registry tests](test/languages.test.ts) · [Desktop fixture](scripts/test-language-capabilities.mjs)

In the table, **Syntax** means colored source tokens. **Run**, **Format**, and **Smart** require separately installed tools. **Pack** means offline lesson data can be installed from Marketplace. **Practice** means the local sample-test adapter exists and requires the same runtime as Run. A dash means the corresponding integration is unavailable. Integrated debugging and quizzes are unavailable for all rows.

| Language | Syntax | Run Console | Format Document | Basic suggestions and optional semantic tools | Diagnostic lesson coverage | Pack | Practice |
| --- | --- | --- | --- | --- | --- | --- | --- |
| C | Yes | Clang or GCC for `.c` | `clang-format` | clangd definitions and references in the current translation unit | Source-linked Learning Lens for selected single-file GCC or Clang diagnostics | Yes | Yes |
| C++ | Yes | Clang++ or G++ for `.cc`, `.cpp`, `.cxx`, `.c++`, `.C` | `clang-format` | clangd definitions and references in the current translation unit | Reviewed Run Console diagnostic explanations in Learn | Yes | Yes |
| Java | Yes | JDK with `java` and `javac`. Optional Maven and Gradle builds need compatible local installations and cached dependencies. | `clang-format` or `google-java-format` | Built-in keywords and snippets. JDK 17+ for optional completion, signatures, definitions, references, and live diagnostics. | Reviewed Run Console diagnostic explanations in Learn | Yes | Yes |
| Python | Yes | Python 3 for `.py`, `.python` | Ruff or Black | — | Reviewed runtime and syntax explanations in Learn | Yes | Yes |
| JavaScript | Yes | Node.js for `.js`, `.mjs`, `.cjs` | Prettier and Node.js | — | Reviewed runtime and syntax explanations in Learn | Yes | Yes |
| TypeScript | Yes | — | Prettier and Node.js | — | — | Yes | — |
| HTML | Yes | — | Prettier and Node.js | — | — | Yes | — |
| CSS | Yes | — | Prettier and Node.js | — | — | Yes | — |
| SQL | Yes | — | — | — | — | SQLite | — |
| Go | Yes | — | — | — | — | Yes | — |
| Rust | Yes | — | — | — | — | Yes | — |
| C# | Yes | — | — | — | — | Yes | — |
| Kotlin | Yes | — | — | — | — | — | — |
| Swift | Yes | — | — | — | — | Yes | — |
| PHP | Yes | — | — | — | — | — | — |
| Ruby | Yes | — | — | — | — | Yes | — |
| Dart | Yes | — | — | — | — | — | — |
| Bash / Shell | Yes | — | — | — | — | Bash | — |
| Markdown | Yes | — | Prettier and Node.js | — | — | — | — |
| JSON | Yes | — | Prettier and Node.js for `.json` | — | — | Yes | — |
| YAML | Yes | — | — | — | — | Yes | — |
| Perl | Yes | — | — | — | — | Yes | — |
| XML | Yes | — | — | — | — | Yes | — |

HTML has a separate local web preview. Notebook source mode uses JSON highlighting. Notebook execution uses an optional Jupyter environment and its own permissions. Those features are separate from Run Console. Ordinary highlighting has no installed tool requirement. Java live diagnostics do not imply semantic hover support. Hovering a diagnostic shows the `javac` message.

### Evidence and limits

- The previous macOS production run executed C, C++, Java, Python, and JavaScript with real tools, including interactive input, reruns, and process cleanup. The current macOS launcher retest covered C/C++ compilation and Java compilation, entry-point selection, and the two optional build adapters. The Windows workflow has a separate native fixture for toolchains and interactive execution. [Run Console test](scripts/test-run-console.mjs) · [Windows native toolchains](scripts/verify-windows-run-console.mjs)
- Formatting was exercised on macOS for all claimed formatter families with Apple clang-format, Ruff, Black, and Prettier. Java formatting was exercised through clang-format. The alternative `google-java-format` installation path remains unverified on this host. Windows now runs its own formatter fixture. [Formatter test](scripts/test-format-code.mjs)
- Smart Java and Smart C/C++ were verified against JDK and clangd processes on macOS. The C/C++ fixture checks definition and reference locations, reuse, and cleanup. Java checks basic snippets, completion, signatures, navigation, live diagnostics, diagnostic hover, and workspace isolation. The Windows versions of these tests use Windows process accounting and require a successful Windows run. [Java integration test](scripts/test-java-tools.mjs) · [clangd integration test](scripts/test-project-navigation.mjs)
- Pack validation checks the shipped catalog for every registered pack. The Marketplace and Practice fixtures exercise installation, offline relaunch, reviewed diagnostics, and execution in supported adapters. Lesson metadata and sample exercises do not establish compiler support for every language in the catalog. [Marketplace integration test](scripts/test-learning-marketplace.mjs) · [Practice test](scripts/test-practice-catalog.mjs)
