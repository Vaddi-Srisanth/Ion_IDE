# Windows release signing

Ion's default Windows setup is an unsigned preview. The local 0.9.4 setup has an empty PE certificate table. A SHA-256 entry in `SHA256SUMS` can detect changed bytes when obtained from a trusted source. It does not establish a Windows publisher identity.

## Publisher identity

For Ion's current direct-download EXE, obtain a public-trust Authenticode code-signing certificate from a CA and use its approved hardware or managed key provider. Ion's signing path uses a provider that exposes the certificate and key through the signing account's Windows certificate store. Microsoft also offers Azure Artifact Signing with identity validation and regional eligibility. It uses a separate service integration and would need its own configuration before use with Ion. Microsoft Store signing for MSIX is another distribution path with different packaging requirements. [Microsoft code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)

Use a dedicated Windows x64 signing account or protected release runner. Provision the CA certificate in `CurrentUser\My` with the key available to that account through the provider. Keep key material in the hardware or managed provider. The variables below contain paths, a public certificate fingerprint, the publisher, and a public timestamp URL. There is no private key or certificate password input.

## Sign and verify a release candidate

1. Use the reviewed release revision and complete the [Windows build prerequisites](BUILD.md), including the Windows SDK SignTool. Connect or authenticate the approved key provider under the signing account.
2. In PowerShell, find the intended code-signing certificate and its exact simple publisher name. Check these against the CA's enrollment record.

   ```powershell
   Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
     Select-Object Thumbprint, HasPrivateKey, NotAfter, @{Name='Publisher';Expression={$_.GetNameInfo('SimpleName', $false)}}
   ```

3. Configure the values below with your actual SDK location, CA certificate, and CA's HTTPS RFC 3161 timestamp endpoint. Use a fresh output folder for the candidate.

   ```powershell
   $env:ION_WIN_SIGN = '1'
   $env:ION_WIN_SIGNTOOL = '<absolute path to Windows SDK signtool.exe>'
   $env:ION_WIN_SIGN_CERT_SHA1 = '<40-character certificate thumbprint>'
   $env:ION_WIN_SIGN_PUBLISHER = '<exact publisher name from the certificate>'
   $env:ION_WIN_TIMESTAMP_URL = '<HTTPS RFC 3161 timestamp URL>'
   $env:ION_WIN_OUTPUT_DIR = Join-Path $PWD ('release-signed-' + (Get-Date -Format yyyyMMddHHmmss))
   npm ci
   npm run package:win
   ```

   The SHA-1 thumbprint selects an exact certificate in the store. Both signing and timestamp requests use SHA-256. The packager applies Electron's security settings, signs and verifies `Ion IDE.exe`, embeds that executable in the NSIS package, then signs and verifies the setup executable. Each file must pass SignTool's Authenticode policy and timestamp checks. PowerShell independently checks the embedded signer thumbprint and timestamp certificate and compares the publisher's simple name with the binary's CompanyName. NSIS uses the same publisher for the uninstall entry. SignTool warnings fail the signed build. [Microsoft SignTool reference](https://learn.microsoft.com/en-us/windows/win32/seccrypto/signtool) · [Microsoft timestamp guidance](https://learn.microsoft.com/en-us/windows/win32/seccrypto/time-stamping-authenticode-signatures)

4. Run the [native Windows installer test](BUILD.md) with the signed candidate. In a separate clean test install, check the exact distributed setup and installed executable from PowerShell with the SDK path, publisher, and thumbprint configured. Verification needs no private key.

   ```powershell
   $setup = Resolve-Path (Join-Path $env:ION_WIN_OUTPUT_DIR 'Ion-IDE-<version>-windows-x64-setup.exe')
   $app = Join-Path $env:LOCALAPPDATA 'Programs\Ion IDE\App\Ion IDE.exe'
   node scripts/verify-windows-signatures.mjs $setup.Path $app
   Get-FileHash -Algorithm SHA256 $setup.Path
   ```

   Compute and publish release hashes after signing. NSIS's generated uninstaller and bundled third-party binaries are outside this signing step. The optional signature checks require native Windows. The macOS cross-package path continues to produce unsigned previews.

## SmartScreen and release status

A public-trust signature verifies publisher identity and integrity. SmartScreen also considers reputation and can warn about new files from a verified publisher. Windows 11 Smart App Control and managed enterprise policies may enforce different rules. Test a real download of the final signed installer on a clean Windows machine before claiming smooth installation. [Microsoft SmartScreen guidance](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

The signing code is prepared. Release signing still requires a provisioned public-trust certificate, its key provider, native Windows validation, and a successful clean-machine check of the final signed asset.
