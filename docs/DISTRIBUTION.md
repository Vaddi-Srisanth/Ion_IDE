# Distribution and third-party notices

Ion IDE is a personal-project preview. Everyone is welcome to download it for testing and share feedback. The project has no license granting general reuse, modification, or redistribution of its source. Third-party components continue to carry their own licenses. [GitHub’s repository licensing guide](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository) · [Locked versions](../package-lock.json)

| Component | License in dependency metadata | Role |
| --- | --- | --- |
| Electron 45.2.3 | MIT with separate Chromium notices | Desktop runtime |
| React 19.3.1 and Monaco 0.57.0 | MIT with separate Monaco notices | Workbench and code editor |
| DOMPurify 3.4.17 | Apache-2.0 or MPL-2.0 upstream, with the Apache-2.0 text bundled | HTML sanitization in Monaco |
| xterm 6.0.0, Fit 0.11.0, and Search 0.16.0 | MIT | Terminal and Run Console |
| VS Code JSON-RPC 10.0.0 | MIT | On-demand clangd protocol transport |
| Marked 14.0.0 | MIT | Markdown parsing |
| PDF.js 6.5.438 | Apache-2.0 with separate notices for fonts and decoders | PDF viewer |
| csv-parse 7.0.3 and yauzl 3.4.0 | MIT | CSV parsing and archive reading |
| sax 1.6.1 | BlueOak-1.0.0 | Office document XML parsing |
| VS Code ripgrep package 1.18.0 | MIT package metadata, with bundled ripgrep and its notices | Workspace text search |

The production build generates `dist/renderer/THIRD-PARTY-LICENSES.md` and copies Monaco, DOMPurify, VS Code JSON-RPC, PDF resource, document parser, and ripgrep notices. Electron distributions also carry Electron and Chromium notices. Check the final artifacts for all required notices when updating a dependency or preparing a release. LibreOffice and language toolchains are installed separately. [Windows build](windows/BUILD.md) · [Release checklist](../RELEASE_CHECKLIST.md)

Ion’s bundled palettes are original. Optional adaptations of [Catppuccin](https://github.com/catppuccin/catppuccin/blob/main/LICENSE) or [Tokyo Night](https://github.com/folke/tokyonight.nvim/blob/main/LICENSE) can use the custom JSON theme format. Both upstream projects publish MIT license terms. Any bundled adaptation needs its upstream copyright and license notice, Ion contrast validation, and clear attribution.
