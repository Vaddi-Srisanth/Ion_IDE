# Updates and a single installation

## Using updates

Ion contacts GitHub only for requested update operations or the opt-in launch check. A compatible newer stable release shows **Update available** at the top. Clicking it streams the official installer to a private local cache, checks the expected byte count and SHA-256, then offers **Install and Restart**. A saved receipt lets you finish a downloaded update offline.

Installation is explicit. Ion prepares and validates the replacement, then uses the existing Save / Keep Drafts / Cancel close workflow. Cancel keeps the editor and current application intact. No installer process runs while ordinary editing is idle. Closing a window during preparation waits for owned preparation/disposal; duplicate installation requests are rejected.

Versions through 0.9.6 have a download-only updater. They cannot install new updater code into themselves. Bootstrap 0.9.7 once into the existing Applications location, or run Windows Setup. Later updates use the new flow.

## macOS

The running executable determines the destination. Supported destinations are `/Applications/Ion IDE.app` and `~/Applications/Ion IDE.app`; a read-only image, translocated or portable copy is refused with setup guidance. The developer installation command reuses an existing location and refuses ambiguous dual installations.

Preparation mounts the checksum-verified image read-only, validates the bundle ID, exact version, architecture and strict code signature, and copies it into private same-volume `.noindex` staging. Quarantine is retained. A small native helper acknowledges validation, waits for the exact parent’s natural exit using a kernel process-exit event, and revalidates original and candidate identities and signing hashes. Atomic same-volume exchange keeps the application path present throughout replacement. It reopens the same profile and retains one local rollback ZIP. If making that archive fails, the previous app remains in hidden staging instead of being deleted.

The helper also requires the new bundle to retain the installed developer team when one exists. Current previews are ad-hoc signed, so there is no independent publisher certificate or notarization. A valid signature and GitHub checksum do not create one. OS launch denial leaves the verified update and rollback copy available so the user can follow macOS security guidance; Ion does not strip quarantine or disable Gatekeeper.

## Windows

The native helper supports the actual per-user installed target, `%LOCALAPPDATA%\Programs\Ion IDE\App\Ion IDE.exe`. Portable/custom copies are refused. It holds the parent process handle to prevent PID reuse, holds the verified installer open denying writes/deletion, and checks its native version before acknowledging readiness. After normal exit, it makes a bounded rollback copy and invokes Setup through Windows Shell so OS security handling remains in the path. Successful Setup restarts the same profile; failed Setup restores and reopens the prior application. The helper and completed cache are cleaned on subsequent update access/launch when Windows no longer locks their executable files.

These operations are not an operating-system sandbox. Setup and programs run with the user’s permissions. No elevation, services, shell command strings or security bypass is added. Internet-zone approval of the unsigned preview can require user interaction.

## Local data and recovery

The `updates` folder inside Ion’s local profile contains at most the retained current installer cache, `ready.json`, a small result receipt, and the Mac rollback archive. Only update-owned folders are pruned; source projects, recovery drafts and settings are separate. Unreadable receipts never block normal editing. Preferences → Updates shows the prior install outcome without a startup popup.

If a Mac update cannot open, follow [Apple’s Gatekeeper guidance](https://support.apple.com/en-us/102445). For rollback, quit Ion, verify/extract `updates/rollback.zip` into a temporary folder and replace the app at the same installation path. Keep your profile untouched. If rollback archiving failed, retain the reported hidden staging folder until the prior bundle is recovered. On Windows, a failed install’s receipt describes whether automatic rollback succeeded or a backup was preserved beside the installation.

## Why a narrow native adapter

Electron’s built-in updater expects supported packaging such as Squirrel or MSIX; automatic macOS Squirrel updates require signing. Ion currently ships a DMG and NSIS per-user preview. This change keeps those formats and uses small on-demand platform helpers instead of adding a resident service or a second updater framework. [Electron updater requirements](https://www.electronjs.org/docs/latest/api/auto-updater)
