# Ion IDE on Windows

The Windows preview targets x64 PCs. Native Windows runtime verification is pending. See the [release assets](https://github.com/Vaddi-Srisanth/Ion_IDE/releases) when the release is available, or [build the installer](BUILD.md) from source.

1. Run `Ion-IDE-0.9.4-windows-x64-setup.exe` and open **Ion IDE** from Start. Setup installs for the current user and includes Electron and ripgrep.
2. Open a file or folder from Welcome. The editor, local previews, Learn, Projects, and the Practice catalog require no account or toolchain.
3. Install the compiler or runtime for languages you want to run. Restart Ion after changing `PATH` so it can see the new tool. [Toolchain setup](DEPENDENCIES.md)

The app is installed in `%LOCALAPPDATA%\Programs\Ion IDE`. Its profile is stored separately in `%APPDATA%\Ion IDE`. Windows **Settings → Apps → Installed apps → Ion IDE** removes the app. The uninstaller leaves the profile and source files in place. Quit Ion before installing an update or uninstalling it.

Use **Ctrl+,** or the gear icon to open Preferences. The View menu can toggle full screen. Source execution, document viewing, and system file integration have platform-specific behavior. [Feature comparison](FEATURE_PARITY.md) · [Known issues and verification](KNOWN_ISSUES.md)
