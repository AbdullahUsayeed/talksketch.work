# winget package for TalkSketch

TalkSketch is published to the **Windows Package Manager** as:

```
winget install --id TalkSketch.TalkSketch -e
```

| Field | Value |
| --- | --- |
| Package identifier | `TalkSketch.TalkSketch` |
| Installer type | `nullsoft` (electron-builder NSIS) |
| Scope | `user` (no admin / no UAC) |
| Architecture | x64 |
| Installer URL | `https://api.talksketch.work/download/TalkSketch-Setup-<version>.exe` |
| Silent switches | `/S` |

## Layout

```
winget/manifests/t/TalkSketch/TalkSketch/<version>/
  TalkSketch.TalkSketch.yaml                  version manifest
  TalkSketch.TalkSketch.installer.yaml        installer + SHA256
  TalkSketch.TalkSketch.locale.en-US.yaml     display metadata
```

The path mirrors the `microsoft/winget-pkgs` repository layout on purpose, so the
folder can be copied straight into a fork.

## Why the installer URL is versioned

winget pins the installer by SHA-256. If a new build were uploaded over the same
versioned filename, every existing manifest would fail hash validation. The site and
the in-app updater use the floating alias instead:

```
https://api.talksketch.work/download/latest/TalkSketch-Setup.exe
```

That alias is a symlink on the server, repointed by `desktop/scripts/publish-download.mjs`.

## Validate locally

```powershell
winget validate --manifest .\winget\manifests\t\TalkSketch\TalkSketch\0.1.0
```

## First submission (one-time)

The initial version has to land in `microsoft/winget-pkgs` before `winget install`
resolves. Either path works:

**A. Manual PR (no tooling)**

1. Fork <https://github.com/microsoft/winget-pkgs>.
2. Copy `winget/manifests/t/TalkSketch/TalkSketch/0.1.0/` into
   `manifests/t/TalkSketch/TalkSketch/0.1.0/` in the fork.
3. Commit, push, open a PR against `master` titled `New package: TalkSketch.TalkSketch version 0.1.0`.
4. The validation bot checks the URL and hash automatically.

**B. wingetcreate**

```powershell
winget install Microsoft.WingetCreate
wingetcreate submit https://raw.githubusercontent.com/AbdullahUsayeed/talksketch.work/main/winget/manifests/t/TalkSketch/TalkSketch/0.1.0/TalkSketch.TalkSketch.yaml
```

## Later releases

1. Build: `npm run dist` in `desktop/`.
2. Upload: `npm run publish:download` (also repoints the `latest` alias).
3. Run the **Publish to winget** GitHub Action with the new version and URL, or locally:

```powershell
wingetcreate update TalkSketch.TalkSketch `
  -v 0.2.0 `
  -u https://api.talksketch.work/download/TalkSketch-Setup-0.2.0.exe `
  -s -t <github-token-with-public_repo-scope>
```

The action needs a `WINGET_TOKEN` repository secret: a classic PAT with `public_repo`.

## Notes

- The installer is **not code-signed** yet. winget installs it without the browser
  download warning, but Windows Smart App Control (if enabled) can still block it.
  Configure signing in `desktop/package.json` (see `desktop/README.md`) before the
  package is out of preview.
- `elevationProhibited` is intentional: the NSIS installer runs per user.
