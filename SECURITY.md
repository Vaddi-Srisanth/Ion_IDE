# Security policy

## Report a vulnerability

Use **Report a vulnerability** in the repository’s Security tab when private reporting is available. Share the affected Ion version and platform, the expected security boundary, a minimal reproduction, and the impact. Include synthetic files and redact credentials or personal data. [Private vulnerability report](https://github.com/Vaddi-Srisanth/Ion_IDE/security/advisories/new)

If the private form is unavailable, open an issue requesting a private contact method. Keep technical details and files for the private conversation. [Issue tracker](https://github.com/Vaddi-Srisanth/Ion_IDE/issues/new)

## Security boundaries

- The Electron workbench uses context isolation, a sandboxed renderer, a restrictive content security policy, and a narrow preload API. Main validates IPC and scopes file access to paths granted by the user.
- Local code, approved project tests, build scripts, and notebook kernels run with your account’s access to files and the network. Time, output, and process controls bound execution. Only run code and kernels you trust.
- Document and Markdown previews treat files as untrusted data. Document parsing still depends on the bundled parsers and, for macOS PPTX conversion, the installed LibreOffice version. Keep desktop tools current and report malformed inputs that break a boundary.
- Editing, local viewers, learning packs, and practice work offline. The optional online planner contacts the configured HTTPS provider after showing the text to send. Its API key uses OS-backed storage when available. GitHub update checks are user-initiated or enabled in Preferences and downloads are checked against their release checksum. The updater relies on the release account and distribution channel for authenticity.
- Profile exports may contain local paths and project test output. Keep them private. A recovery draft contains unsaved source text and lives in the local profile.
