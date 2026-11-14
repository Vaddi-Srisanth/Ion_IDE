# Test verification and skipped-case matrix

Counts and revision boundaries are in [the final gate report](RELEASE_VERIFICATION.md). Skipped is not passed. No claim that failed combined runs were green follows from later successful scoped jobs.

## Final local Mac unit skips,276 total /250 passed /26 skipped

- ﹣ Windows Run Console stops the process tree (0.128166 ms) # SKIP
- ﹣ Windows preferences recover from a sharing lock and preserve the old file on a persistent lock (0.359791 ms) # SKIP
- ﹣ installed Maven and Gradle JVM launchers compile a project and run its real entry point offline (0.124916 ms) # SKIP
- ﹣ Windows Run Console uses ConPTY for TTY, resize, Unicode argv and interactive input (0.402291 ms) # SKIP
- ﹣ Windows ConPTY forwards control input to the program (0.058209 ms) # SKIP
- ﹣ Windows ConPTY bounds busy program output and execution time (0.04425 ms) # SKIP
- ﹣ Windows terminal launches in the workspace and explicit close cleans up a detached child (0.04625 ms) # SKIP
- ﹣ Windows Run Console falls back to line input if the installed helper is absent (0.055666 ms) # SKIP
- ﹣ native Windows PowerShell 5 deserializes scalar PID members before the first liveness API (0.115875 ms) # SKIP
- ﹣ Windows pipe supervisor preserves structured argv, input, separate output and real exit 125 (0.48175 ms) # SKIP
- ﹣ Windows pipe Job owns detached descendants after natural leader exit (0.064291 ms) # SKIP
- ﹣ Windows pipe Job cleans descendants on cancelled (0.050708 ms) # SKIP
- ﹣ Windows pipe Job cleans descendants on timeout (0.0435 ms) # SKIP
- ﹣ Windows pipe Job cleans descendants on output-limit (0.046125 ms) # SKIP
- ﹣ Windows pipe Job kills descendants when the native supervisor is terminated (0.037 ms) # SKIP
- ﹣ Windows pipe Job observes owner death without a persistent monitoring service (0.04525 ms) # SKIP
- ﹣ Windows pipe supervisor repeats clean executions and fails closed when missing (0.037042 ms) # SKIP
- ﹣ Windows pipe Stop waits for native Job drain and CLEAN acknowledgement (0.053875 ms) # SKIP
- ﹣ Windows runnable pipe commands keep the console hidden while preserving stdin, output, exit status and Job ownership (0.058459 ms) # SKIP
- ﹣ Windows runnable pipe handles fast native exits without losing READY, output or cleanup acknowledgement (0.022583 ms) # SKIP
- ﹣ Windows pipe Stop queued before READY observation drains the owned runnable command (0.015583 ms) # SKIP
- ﹣ Windows selected compiler and GCC diagnostics survive creation-time-owned runnable pipe launch (0.014916 ms) # SKIP
- ﹣ Windows workspace keeps canonical Unicode paths and confirms a case-alias Save As (0.374208 ms) # SKIP
- ﹣ Windows workspace denies junction escapes, case-variant roots, devices, and data streams (0.059083 ms) # SKIP
- ﹣ Windows workspace reads and saves long paths with Unicode names (0.046667 ms) # SKIP
- ﹣ Windows atomic saves recover from transient sharing locks and preserve external edits (0.04225 ms) # SKIP

These are Windows-only scopes plus the Windows JVM-build flag. Windows native CI separately exercises the supported equivalents, including actualPS 5 arrays, ConPTY, compiler, filesystem, Job cleanup and Maven/Gradle fixtures.

## Native Windows unit skips,268 total /253 passed /15 skipped

- ﹣ C runner compiles local C, handles stdin and diagnostics, and bounds repeated execution (0.4636 ms) # No local C compiler detected.
- ﹣ C runner separates output streams and releases pipes after its leader exits (0.1794 ms) # Requires a POSIX C toolchain.
- ﹣ macOS source saves preserve bounded xattrs, Finder tags, quarantine, ACL, owner, group and mode (0.9659 ms) # SKIP
- ﹣ macOS metadata read denial rejects before replacement and preserves the original source (0.125 ms) # SKIP
- ﹣ macOS replacement staging remains private before source metadata is transferred (0.1296 ms) # SKIP
- ﹣ native terminal streams output on demand and closes the shell job groups (0.8088 ms) # SKIP
- ﹣ native Run Console owns a real terminal and cleans up after a run (0.7836 ms) # SKIP
- ﹣ rejects workspace symlinks in a native manifest (0.2217 ms) # SKIP
- ﹣ practice samples execute a saved C solution through the real runner (0.609 ms) # No installed C compiler.
- ﹣ profile export refuses symbolic links in profile stores (0.2686 ms) # SKIP
- ﹣ recovery refuses a symlink as its storage directory (0.3619 ms) # SKIP
- ﹣ reports missing runtimes with actionable installation instructions (0.1276 ms) # SKIP
- ﹣ Unreadable permissions stay intact until an explicit reset (0.337 ms) # POSIX file-mode denial is not enforceable on Windows or as root.
- ﹣ saved-snapshot compilation uses checked bytes and revalidates before process launch (0.5023 ms) # No installed C compiler.
- ﹣ cancelling an active workspace search reaps its process (0.2637 ms) # SKIP

Mac metadata and shell tests pass on nativeMac. The three no-cwd compiler-discovery fixtures use the legacy detector without the workspace required by Windows discovery; their skip messages do not establish GCC is missing. Dedicated native Windows RunPlan, approved-source snapshot, C/C++ samples and lifecycle tests run separately. POSIX modes and some symlink fixtures are not portable substitutes for Windows ACL/junction testing; scoped Windows junction/sharing/Unicode cases have their own passing tests. The legacy missing-runtime and search-cancellation fixtures remain skipped; no blanket Windows parity claim follows.

## Other gaps

- GUI Python formatting: Ruff/Black absent, not passed. Core Pythoninput/real Jupyter execution pass.
- PowerPoint high-fidelity LibreOffice conversion not installed/required by this cohort; Windows default-application fallback is the advertised path. No complete Office compatibility claim.
- No onlineAI provider calls or remote practice submission, no production API keys. Offline workspaces are tested.
- No physical 8 GiB laptop, four-hour coding session, physical keyboard/display latency, VRAM measurement, authenticated Windows signing or Developer ID/notarization.
- No repeated local ElectronGUI launch on macOS 27, due prior registration-crash restriction. HostedmacOS 15 is isolated evidence, not proof that environment issue was repaired.
- `follow-up`, `git-checks` and `startup` deliberately skip other workflow jobs; these selection skips are not unit-test skips. Their matching production-source gates are linked in the report. Future release tag verification is unrun and unauthorized.
