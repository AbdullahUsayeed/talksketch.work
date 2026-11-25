'use strict';
/**
 * Authenticode signing for the Windows build.
 *
 * electron-builder's built-in signing needs winCodeSign, whose archive contains
 * macOS symlinks that Windows only extracts with Developer Mode or an elevated
 * shell. These helpers call signtool directly instead, so signing works from a
 * normal shell.
 *
 * Configure one of:
 *   TS_CSC_LINK=/path/to/cert.pfx  TS_CSC_PASSWORD=secret  (PFX file or base64)
 *   TS_CERT_THUMBPRINT=<sha1 thumbprint>                    (cert in CurrentUser\My)
 *
 * TS_CSC_LINK is intentionally separate from electron-builder's CSC_LINK: when
 * CSC_LINK is set, electron-builder also signs the NSIS uninstaller and pulls in
 * winCodeSign, which cannot be extracted without an elevated shell. Set CSC_LINK
 * instead (and run elevated) only if you also want the uninstaller signed.
 *
 * Optional:
 *   TS_SIGNTOOL      explicit signtool.exe path
 *   TS_TIMESTAMP     RFC3161 URL (default http://timestamp.digicert.com)
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TIMESTAMP_URL = process.env.TS_TIMESTAMP || 'http://timestamp.digicert.com';

function isSigningConfigured() {
  return Boolean(
    process.env.TS_CSC_LINK || process.env.TS_CERT_THUMBPRINT || process.env.CSC_LINK,
  );
}

function compareVersionsDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

function findSigntool() {
  if (process.env.TS_SIGNTOOL) {
    if (!fs.existsSync(process.env.TS_SIGNTOOL)) {
      throw new Error(`TS_SIGNTOOL does not exist: ${process.env.TS_SIGNTOOL}`);
    }
    return process.env.TS_SIGNTOOL;
  }

  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'signtool.exe');
    if (fs.existsSync(candidate)) return candidate;
  }

  const kits = 'C:\\Program Files (x86)\\Windows Kits\\10\\bin';
  if (fs.existsSync(kits)) {
    const versions = fs
      .readdirSync(kits)
      .filter((name) => /^10\.\d/.test(name))
      .sort(compareVersionsDesc);
    for (const version of versions) {
      const candidate = path.join(kits, version, 'x64', 'signtool.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  throw new Error('signtool.exe not found. Install the Windows SDK or set TS_SIGNTOOL.');
}

/** CSC_LINK may be a file path or a base64-encoded PFX (electron-builder convention). */
function materializePfx(link) {
  if (fs.existsSync(link)) return { file: link, cleanup: () => {} };

  const decoded = Buffer.from(link, 'base64');
  if (decoded.length < 2 || decoded[0] !== 0x30) {
    throw new Error('CSC_LINK is neither an existing file nor a base64-encoded PFX.');
  }
  const file = path.join(os.tmpdir(), `talksketch-${process.pid}-${Date.now()}.pfx`);
  fs.writeFileSync(file, decoded, { mode: 0o600 });
  return { file, cleanup: () => fs.rmSync(file, { force: true }) };
}

function signFile(file) {
  if (!isSigningConfigured() || !file || !fs.existsSync(file)) return false;

  const signtool = findSigntool();
  const args = [
    'sign',
    '/fd', 'sha256',
    '/tr', TIMESTAMP_URL,
    '/td', 'sha256',
    '/d', 'TalkSketch',
    '/du', 'https://talksketch.work',
  ];

  let pfx = null;
  try {
    if (process.env.TS_CERT_THUMBPRINT) {
      args.push('/sha1', process.env.TS_CERT_THUMBPRINT, '/s', 'My');
    } else {
      const link = process.env.TS_CSC_LINK || process.env.CSC_LINK;
      const password = process.env.TS_CSC_PASSWORD || process.env.CSC_KEY_PASSWORD;
      pfx = materializePfx(link);
      args.push('/f', pfx.file);
      if (password) args.push('/p', password);
    }

    console.log(`[sign] ${path.basename(file)}`);
    execFileSync(signtool, [...args, file], { stdio: 'inherit' });
    return true;
  } finally {
    if (pfx) pfx.cleanup();
  }
}

module.exports = { signFile, isSigningConfigured, findSigntool };
