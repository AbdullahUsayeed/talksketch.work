#!/usr/bin/env node
/**
 * Upload a desktop build to the TalkSketch download host and repoint the floating
 * "latest" alias.
 *
 *   npm run publish:download              # upload + repoint latest
 *   npm run publish:download -- --dry-run # show what would happen
 *
 * Environment (all optional except the key):
 *   TS_SSH_HOST  default 54.255.181.218
 *   TS_SSH_USER  default ubuntu
 *   TS_SSH_KEY   default %USERPROFILE%\.ssh\id_ed25519_lightsail
 *
 * The versioned files are immutable so the winget manifest SHA-256 stays valid.
 * The alias is what the website and the in-app updater use:
 *
 *   https://api.talksketch.work/download/latest/TalkSketch-Setup.exe
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const DRY = process.argv.includes('--dry-run');
const DESKTOP_DIR = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(path.join(DESKTOP_DIR, 'package.json'), 'utf8'));
const version = pkg.version;

const HOST = process.env.TS_SSH_HOST || '54.255.181.218';
const USER = process.env.TS_SSH_USER || 'ubuntu';
const KEY = process.env.TS_SSH_KEY || path.join(homedir(), '.ssh', 'id_ed25519_lightsail');
const REMOTE_DIR = '/var/www/talksketch-downloads';

const SETUP = `TalkSketch-Setup-${version}.exe`;
const PORTABLE = `TalkSketch-Portable-${version}.exe`;
const LATEST = 'TalkSketch-Setup.exe';

function sha256(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex').toUpperCase()));
  });
}

function run(command, args) {
  const line = [command, ...args].join(' ');
  console.log(`$ ${line}`);
  if (DRY) return '';
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
}

function ssh(script) {
  return run('ssh', [
    '-i', KEY,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    `${USER}@${HOST}`,
    script,
  ]);
}

/** Authenticode status of a PE, e.g. Valid / NotSigned / UnknownError. */
function signatureStatus(file) {
  if (process.platform !== 'win32') return 'unknown';
  const script = `(Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}').Status.ToString()`;
  try {
    return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

function scp(file) {
  return run('scp', [
    '-i', KEY,
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    file,
    `${USER}@${HOST}:/tmp/`,
  ]);
}

const artifacts = [SETUP, PORTABLE]
  .map((name) => path.join(DESKTOP_DIR, 'dist', name))
  .filter((file) => {
    if (existsSync(file)) return true;
    console.log(`skip (not built): ${path.basename(file)}`);
    return false;
  });

if (artifacts.length === 0) {
  console.error('Nothing to publish. Run `npm run dist` in desktop/ first.');
  process.exit(1);
}

if (!existsSync(KEY) && !DRY) {
  console.error(`SSH key not found: ${KEY}\nSet TS_SSH_KEY to your Lightsail private key.`);
  process.exit(1);
}

const hashes = {};
for (const file of artifacts) {
  hashes[path.basename(file)] = await sha256(file);
}

const setupPath = path.join(DESKTOP_DIR, 'dist', SETUP);
if (existsSync(setupPath)) {
  const status = signatureStatus(setupPath);
  console.log(`\nsignature (${SETUP}): ${status}`);
  if (process.env.TS_REQUIRE_SIGNATURE === '1' && status !== 'Valid') {
    console.error('Refusing to publish: installer is not validly signed and TS_REQUIRE_SIGNATURE=1.');
    console.error('See desktop/SIGNING.md. Unset TS_REQUIRE_SIGNATURE to publish anyway.');
    process.exit(1);
  }
}

for (const file of artifacts) {
  const name = path.basename(file);
  console.log(`\n-> ${name} (sha256 ${hashes[name]})`);
  scp(file);
  ssh(
    `sudo install -o www-data -g www-data -m 644 /tmp/${name} ${REMOTE_DIR}/${name} && ` +
      `printf '%s  %s\\n' '${hashes[name]}' '${name}' | sudo tee ${REMOTE_DIR}/${name}.sha256 >/dev/null && ` +
      `sudo chown www-data:www-data ${REMOTE_DIR}/${name}.sha256 && ` +
      `rm -f /tmp/${name}`,
  );
}

// Repoint the alias only after the versioned file is safely in place.
console.log(`\n-> ${LATEST} -> ${SETUP}`);
ssh(
  `sudo ln -sfn ${SETUP} ${REMOTE_DIR}/${LATEST} && ` +
    `sudo ln -sfn ${SETUP}.sha256 ${REMOTE_DIR}/${LATEST}.sha256 && ` +
    `sudo chown -h www-data:www-data ${REMOTE_DIR}/${LATEST} ${REMOTE_DIR}/${LATEST}.sha256 && ` +
    `ls -l ${REMOTE_DIR}/${LATEST} ${REMOTE_DIR}/${LATEST}.sha256`,
);

console.log('\nPublished:');
for (const file of artifacts) {
  console.log(`  https://api.talksketch.work/download/${path.basename(file)}`);
}
console.log(`  https://api.talksketch.work/download/latest/${LATEST}`);
console.log(`\nSHA256 (${SETUP}): ${hashes[SETUP]}`);
console.log('\nNext: update the winget manifest hash, then run the "Publish to winget" workflow.');
