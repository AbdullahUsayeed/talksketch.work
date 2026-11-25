# Code signing

The installer is unsigned today, which is why Windows shows **"Windows protected your PC"**
and why Smart App Control (when enabled) refuses to launch the app at all. Signing is the only
real fix; winget only avoids the *browser* download warning.

A signature is only trusted if the certificate chains to a CA that Windows already trusts.
A self-signed certificate produces `UntrustedRoot` and does **not** remove the warning.

## What you need

| Route | Cost | Notes |
| --- | --- | --- |
| **SignPath Foundation** | free for OSS | Cloud signing for open-source projects; needs an application + approval |
| **Certum Open Source Code Signing** | free for OSS | Public repo + OSI license required |
| **Azure Trusted Signing** | paid, monthly | Requires an Azure subscription and identity verification; check the supported-countries list first — it does not cover every region |
| **Commercial OV / EV certificate** | paid, yearly | OV builds SmartScreen reputation; EV is recognised immediately |

TalkSketch qualifies for the two free routes: the repository is public and Apache-2.0.

## How this repo signs

electron-builder's built-in signing downloads `winCodeSign`, whose archive contains macOS
symlinks that Windows can only extract with Developer Mode or an elevated shell. Instead,
`desktop/scripts/` calls `signtool.exe` directly:

- `after-pack.js` signs `TalkSketch.exe` **before** it is packed, so the installed app is signed.
- `after-all-artifact-build.js` signs `TalkSketch-Setup-<version>.exe` and the portable build.
- `sign-tool.js` locates `signtool` (PATH or Windows SDK), handles a PFX file *or* base64, and
  timestamps with RFC 3161.

No admin rights are needed because `winCodeSign` is never touched.

### Configure a certificate

```powershell
# PFX file
$env:TS_CSC_LINK = "C:\certs\talksketch.pfx"
$env:TS_CSC_PASSWORD = "..."

# or a certificate already in Cert:\CurrentUser\My (thumbprint)
$env:TS_CERT_THUMBPRINT = "ABCDEF..."

npm run dist
```

Then verify:

```powershell
Get-AuthenticodeSignature "dist\TalkSketch-Setup-0.1.0.exe" | Format-List Status, SignerCertificate, TimeStamperCertificate
```

`Status` must be `Valid`. With a self-signed test certificate it is `UnknownError`
(`UntrustedRoot`) even though the signature itself is present — that is expected and shipping it
would not help users.

### Why `TS_CSC_LINK` and not `CSC_LINK`

Setting `CSC_LINK` makes electron-builder sign the NSIS **uninstaller** as well, which pulls
`winCodeSign` back in and fails without elevation. `TS_CSC_LINK` keeps signing inside the hooks.
The trade-off: the uninstaller stays unsigned, so Windows may warn when someone runs
*Uninstall TalkSketch.exe*.

For full coverage (including the uninstaller), run from an elevated terminal with standard
electron-builder variables and `signAndEditExecutable: true`:

```powershell
$env:CSC_LINK = "C:\certs\talksketch.pfx"; $env:CSC_KEY_PASSWORD = "..."
npx electron-builder --win nsis portable -c.win.signAndEditExecutable=true
```

## After you sign

The installer bytes change, so:

1. Re-run `npm run publish:download` (also rewrites the `latest` alias).
2. Update `InstallerSha256` in `winget/manifests/.../TalkSketch.TalkSketch.installer.yaml`.
3. Run the **Publish to winget** workflow, or update the already-open PR branch.

`npm run publish:download` prints the new SHA-256 and refuses to upload an unsigned build when
`TS_REQUIRE_SIGNATURE=1`.
