# macOS signing and notarization

Ion builds a local preview with an ad-hoc app signature by default. This verifies the bundle's integrity. The existing preview disk image is unsigned and Gatekeeper rejects it under the default assessment. A trusted distribution requires a Developer ID Application identity and a notarized disk image. [Apple Developer ID](https://developer.apple.com/developer-id/)

## Prepare the signing Mac

1. Use a Mac with Xcode command-line tools that provide `codesign`, `notarytool`, and `stapler`. Leave Gatekeeper assessment enabled.
2. Obtain a **Developer ID Application** certificate through an authorized Apple Developer team. Install it with its private key in an unlocked Keychain. Find the full certificate name or SHA-1 fingerprint with `security find-identity -v -p codesigning`.
3. Store an Apple notary login in that Keychain. With an Apple ID, provide the app-specific password when the command prompts for it. Keep the password and signing private key out of the repository, command arguments, and logs.

```sh
xcrun notarytool store-credentials "ion-release" \
  --apple-id "your-developer-account@example.com" \
  --team-id "YOURTEAMID"
```

If using a separate signing Keychain, pass its path to `store-credentials --keychain` and set `ION_MAC_SIGN_KEYCHAIN` to the same path when packaging. A protected CI job can prepare an ephemeral Keychain and store the profile there. Keep signing credentials available only to the reviewed release job. [Apple notarization setup](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)

## Build a trusted disk image

Run this from the clean, tested release revision. A separate output directory keeps these files apart from the preview.

```sh
npm ci
export ION_MAC_SIGN_IDENTITY="Developer ID Application: Your Organization (YOURTEAMID)"
export ION_MAC_NOTARY_PROFILE="ion-release"
export ION_MAC_REQUIRE_NOTARIZATION=1
export ION_MAC_ARCH=arm64
export ION_MAC_OUTPUT_DIR="release/signed"
npm run package:dmg
```

The packager sets Electron fuses before signing nested code from the inside out. Electron app executables receive the JIT entitlement. Native helpers use hardened runtime without JIT or debugging entitlements. Verification checks the Developer ID certificate chain, team, timestamps, and runtime flags on Ion and its helper executables. The Developer ID signature also covers the outer disk image. With `ION_MAC_REQUIRE_NOTARIZATION=1`, missing signing inputs fail the build.

Only the signed DMG is submitted to Apple. The packaging command waits for acceptance, checks the submission log, staples and validates the DMG ticket, and runs Gatekeeper assessment for both the disk image and the app on a read-only mount. It publishes the finished image only after those checks and disk-image checksum validation. The separate `.app` in the output directory is an intermediate bundle. Distribute the checked DMG. [Apple distribution packaging](https://developer.apple.com/documentation/xcode/packaging-mac-software-for-distribution)

Review Apple's log for the displayed submission ID and test a quarantined copy on a clean Mac before release. A script run on the signing Mac is useful for checking the signatures and ticket. A clean Mac gives a separate first-launch check without cached trust state.

```sh
# Set IMAGE to the completed disk image path.
codesign --verify --strict --verbose=2 "$IMAGE"
xcrun stapler validate "$IMAGE"
spctl --assess --type open --context context:primary-signature --verbose=2 "$IMAGE"
node scripts/verify-mac-release.mjs "$IMAGE"
shasum -a 256 "$IMAGE"
```

The mounted installer smoke test checks the application and its helpers and exercises the installed bundle with a temporary profile. Compute the published SHA-256 checksum after signing and stapling.

## Verification status

This checkout has no valid Developer ID signing identity. The configuration tests cover the preview path, missing or ambiguous Developer ID inputs, and the hardened runtime options. An actual Developer ID signature, Apple submission, staple, and Gatekeeper acceptance require the certificate, Keychain profile, and native verification described above.
