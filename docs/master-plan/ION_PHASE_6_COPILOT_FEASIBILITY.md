# Phase 6 — Copilot integration feasibility

GitHub documents third-party inline suggestions through its Copilot Language Server. The protocol includes explicit sign-in and sign-out, document synchronization, requesting a suggestion, and notifying the server when a user sees or accepts it. This corrects the earlier architecture assumption that an official inline API was unavailable. [GitHub announcement](https://github.blog/changelog/2025-02-10-copilot-language-server-sdk-is-now-available/) · [Official editor integration protocol](https://github.com/github/copilot-language-server-release#inline-completions)

The separate Copilot SDK provides chat and agent capabilities. Its tool availability and approval handler require their own review before any integration with a real workspace. [Official agent SDK](https://github.com/microsoft/copilot-sdk)

## Native probe

The native test uses the platform-specific `@github/copilot-language-server-*` 1.575.0 package from npm on disposable GitHub-hosted runners. Each tarball is pinned by SHA-512 before extraction. Only the matching native executable and package manifest are extracted. No Ion installer includes the server. Its package reports 163,684,645 unpacked bytes for macOS ARM64 and 161,334,422 bytes for Windows x64. Those are package sizes, not application memory measurements. [macOS package](https://registry.npmjs.org/@github/copilot-language-server-darwin-arm64/1.575.0) · [Windows package](https://registry.npmjs.org/@github/copilot-language-server-win32-x64/1.575.0)

The probe uses a temporary home and workspace, a sanitized child environment, no signed-in user, and no document. The runner downloads the package before starting the isolated executable. macOS denies network access to the test process, and Windows blocks outbound connections from that executable. The test does not request completions or launch a sign-in browser.

## Distribution and acceptance

The language-server license carries notice obligations; the npm wrapper can also pull components with their own distribution terms. Any distribution decision must identify exactly which artifacts ship. The probe exercises the native package only. [Language-server license](https://github.com/github/copilot-language-server-release/blob/main/LICENSE) · [Copilot CLI license](https://github.com/github/copilot-cli/blob/main/LICENSE.md) · [Service terms](https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)

Editor consent, signed-in completion, inline display and acceptance with Undo, cancellation when the document changes, revocation, and account entitlement remain separate acceptance gates. No Copilot capability is advertised in the installed or released Ion application by this probe.

At the requested pause the local macOS ARM64 synthetic server completed initialization, returned signed-out status, and shut down with an empty process group. The hosted probe was prepared locally and was never dispatched. Neither the official binary nor an account was exercised. The Windows Job Object path awaits native verification.

## Official macOS signed-out result

The Apple Silicon probe now also accepts the pinned official npm archive via `node scripts/test-copilot-availability.mjs --local-macos <absolute-package-path>`. It bounds and hashes a private copy before extracting the named executable and manifest. The executable runs with a disposable profile. The local sandbox denies networking, Mach service lookup, reads under standard user, library, volume and temporary locations outside its scratch tree, writes outside scratch, and execution of other programs. This profile is for the signed-out probe.

Official version 1.575.0 initialized, advertised incremental document sync and inline completion, returned `NotSignedIn`, and shut down with an empty macOS process group. The signed-out error status notification was observed. The probe opened zero documents and requested neither sign-in nor completion. An invalid archive was rejected at hash verification. The status call follows GitHub's own editor integration. [Official package](https://registry.npmjs.org/@github/copilot-language-server-darwin-arm64/1.575.0) · [GitHub's signed-out status call](https://github.com/github/copilot.vim/blob/release/autoload/copilot.vim)

Authenticated completion, the consent and integration UI, and a native Windows probe remain open.
