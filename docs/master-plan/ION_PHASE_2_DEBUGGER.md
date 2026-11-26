# Ion Phase 2 debugger acceptance

## Accepted candidate

Production application source: `bcd2d5560510492b7dae8c69c97a925b2c7db787`<br>
Verification-only workflow source: `041a5b02c886bcbe7255e58b0fb711aeac6e69ac`<br>
Branch: `codex/ion-core-excellence-phase-2-dap`

The verification SHA differs only by the four-line Windows workflow correction that places the pinned LLVM directory on `PATH`. Production Ion deliberately ignores test-only executable overrides and discovers trusted installed tools through its normal path policy. No production source changed between these two SHAs.

## Implemented scope

- On-demand C and C++ debugging through the standard Debug Adapter Protocol and an installed `lldb-dap`.
- Lazy Run and Debug panel, Debug Console, gutter breakpoints, call stack, scopes, variables, watch expressions, evaluate, continue, pause, step over, step into, step out, restart and stop.
- Configurable debugger shortcuts and explicit UI actions; opening the panel alone does not discover tools, compile code, or start a process.
- Main-process ownership of compiler, adapter, scratch executable and debuggee lifecycle. Only one session per window is accepted and closing/stopping drains owned resources.
- Saved-source binding using canonical workspace membership, a stable file revision and SHA-256 content hash. Same-size rapid rewrites cannot reuse a stale approval.
- Bounded DAP headers, frames, messages, pending requests, output, stack frames, scopes, variables, expressions and breakpoints. Malformed, oversized, mismatched and unsolicited reverse requests fail closed.
- Explicit trusted discovery. Workspace-controlled compilers/adapters and arbitrary executable paths are not accepted.
- The existing Run Console, terminal, LSP, editor models, undo history, recovery and workspace grants remain separate.

The accepted scope is deliberately one reliable C/C++ adapter. Python and Java debugging, conditional/log/data breakpoints, attach-to-process, remote debugging, disassembly and memory views are not claimed.

## Native acceptance

| Gate | macOS 15 ARM64 | Windows Server 2025 x64 |
| --- | --- | --- |
| Run | [45876230321 / job 140103900405](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45876230321/job/140103900405) | [45877000977 / job 140106512467](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45877000977/job/140106512467) |
| Production application source | `bcd2d5560510492b7dae8c69c97a925b2c7db787` | Same production tree; workflow-only SHA `041a5b02c886bcbe7255e58b0fb711aeac6e69ac` |
| Toolchain | Apple clang 17.0.0, Xcode 16.4 `lldb-dap` | LLVM clang/lldb-dap 23.1.6, x86_64 |
| Full unit/security suite | 481 total: 455 pass, 26 explicit platform skips, 0 fail | 471 total: 454 pass, 17 explicit platform skips, 0 fail |
| Bounded fake-DAP lifecycle | PASS | PASS |
| Production Electron journey | PASS | PASS |
| Native breakpoint/stack/scopes/variables/step/continue | PASS | PASS |
| Owned adapter/debuggee cleanup | PASS | PASS |

The macOS job passed the exact production implementation. The Windows job passed the same production implementation after the workflow-only PATH correction. Its artifact records `desktop_result=success` and `native_result=success`; the production Electron journey and native lifecycle both completed with owned cleanup.

## Preserved failures and corrections

| Run | Evidence | Classification and correction |
| --- | --- | --- |
| [45873546987](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45873546987) | Windows caught a same-size rapid rewrite whose stat revision could collide; the obsolete macOS leg was cancelled only to free CI capacity. | Product integrity defect. Bind launch approval to a stable SHA-256 content hash and revalidate before and after compilation. Added deterministic collision coverage. |
| [45874935926](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45874935926) | Native adapters passed, but both packaged journeys had no breakpoint because stored editor breakpoints were not copied into the lazily created controller. | Product UI-state defect. Synchronize stored active-file breakpoints when the lazy controller exists and no session is active. |
| [45876230321](https://github.com/Vaddi-Srisanth/Ion_IDE/actions/runs/45876230321) | macOS passed. Windows native acceptance passed, while packaged Ion selected the hosted runner's preinstalled crash-prone adapter instead of the pinned one. | Acceptance-environment mismatch. Put the pinned LLVM 23.1.6 directory on the trusted `PATH`, matching production discovery. No test timeout or production security boundary changed. |

No failing sample was hidden and no unchanged SHA was rerun as a substitute for diagnosis.

## Resource and lifecycle statement

The debugger renderer remains a separate lazy chunk (approximately 16.3 kB JavaScript and 5.54 kB CSS in the accepted production build). Ordinary editing does not import it, discover a debugger, or start a compiler/adapter. Opening the panel imports the UI only; process work begins only after the explicit Start Debugging action.

Native acceptance proves bounded start/stop behavior and zero retained owned adapter/debuggee processes after the tested journey. It does not establish a four-hour debugging endurance result or a consumer-hardware energy claim. Active `lldb-dap` memory and long-session heap growth remain future performance measurements and must not be inferred from the cleanup result.

## Verdict

**Milestone 2.4 — DAP: PASS for the defined C/C++ scope.**

This is an engineering acceptance checkpoint, not publication authorization. `main`, releases, installers, the update feed, the installed Ion application and the live profile were not changed.
