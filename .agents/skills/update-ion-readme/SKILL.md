---
name: update-ion-readme
description: Update the Ion IDE repository README with release-safe download links and clearer structure while preserving technical evidence, warnings, limitations, and license terms. Use for Ion README refreshes that must distinguish published GitHub releases from newer local source candidates.
---

# Update Ion README

Update `README.md` without turning an unpublished source version into a public download claim.

## Establish the release facts

1. Read `package.json`, `CHANGELOG.md`, and `RELEASE_CHECKLIST.md` from the working tree. Treat their highest version as a source candidate until publication is independently verified.
2. If `gh` is available, run `gh release view` for this repository and inspect the release's tag, draft/prerelease state, publication timestamp, and complete asset list. The newest non-draft published release is the only version eligible for direct download buttons.
3. Use the exact published tag, including its prefix, and exact asset filenames returned by GitHub. Do not infer whether the tag is `v<VERSION>` or `<VERSION>` and do not construct links for missing assets.
4. If publication or either required installer asset cannot be verified, do not add or advance direct-download buttons. Keep existing known-live buttons unchanged when appropriate, and clearly describe the verification gap.

## Update the README

- Put centered Shields.io download buttons immediately below `*Write code. Understand errors. Learn offline.*` and before `docs/screenshots/editor.webp`.
- Link the macOS button directly to the published Apple Silicon `.dmg` asset and label it **macOS (Apple Silicon)**.
- Link the Windows button directly to the published x64 setup `.exe` asset and label it **Windows (x64 Preview)**.
- Make the published version and any newer local candidate visibly distinct.
- Improve hierarchy, ordering, scannability, and concision, but preserve every factual technical detail, benchmark value, SHA-256 verification instruction, Gatekeeper and SmartScreen warning, limitation, and the full license meaning.
- Preserve valid existing documentation links and screenshot paths. Respect unrelated working-tree edits and make a narrow patch on top of them.

## Verify

Check all Markdown and HTML links and images in `README.md`:

- Local paths must exist, and local fragments must match a generated Markdown heading anchor or explicit HTML anchor.
- Remote links and image sources must return a successful response or a valid redirect. For direct release assets, prefer an HTTP request that does not download the full installer.
- Re-run `gh release view` when available and confirm each button URL exactly matches a listed asset URL.
- Review the diff to ensure no required facts, warnings, limitations, benchmark numbers, or license terms were lost.

Report the published release/tag, the unpublished source candidate, the README changes, and link/image validation results.
