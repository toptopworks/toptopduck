#!/usr/bin/env node
// Assemble the updater manifest (latest.json) from a flat directory of
// release artifacts (ADR-0143, issue #1509). The bare `tauri build` produces
// signed updater artifacts + .sig files but no manifest (tauri-action does
// that job upstream; this repo keeps the bare-build release chain per
// ADR-0143's rejection), so the release workflow runs this script instead.
//
// The script is the assembly-time integrity gate: every expected platform
// key must resolve to an artifact WITH a sibling .sig, or the run fails --
// a half manifest must never reach a mirror (an old client would see the
// new version but fail to download its platform's payload).
//
// Usage:
//   node scripts/build-updater-manifest.mjs <assets-dir> <tag> <version> \
//        <github-download-base> <notes-file|-> <pub-date-iso> [out.json] [--out-assets <dir>]
//
//   github-download-base  e.g. https://github.com/toptopworks/toptopduck/releases/download/v0.5.0
//   notes-file           "-" for no notes; otherwise a UTF-8 text file (the release body)
//   --out-assets         optional directory to copy the consumed artifacts + .sigs
//                        into (what the workflow then uploads to the mirror + release)

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

function fail(message) {
  console.error(`build-updater-manifest: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const outAssetsIdx = args.indexOf('--out-assets');
const outAssetsDir = outAssetsIdx === -1 ? null : args[outAssetsIdx + 1] ?? null;
if (outAssetsIdx !== -1) args.splice(outAssetsIdx, 2);

const [assetsDir, tag, version, githubBase, notesFile, pubDate, output = 'latest.json'] = args;
if (!assetsDir || !tag || !version || !githubBase || !notesFile || !pubDate) {
  fail(
    'usage: node scripts/build-updater-manifest.mjs <assets-dir> <tag> <version> ' +
      '<github-download-base> <notes-file|-> <pub-date-iso> [out.json] [--out-assets <dir>]',
  );
}

// Which artifact feeds which manifest platform key (ADR-0143 Decision 2/3):
// the bare windows-x86_64 key points at the NSIS build (the recommended
// install form); the variant keys let the stock updater (>=2.10) pick the
// payload matching the locally installed package type; the one universal
// macOS artifact serves both darwin keys.
const FILE_RULES = [
  { suffix: '_universal.app.tar.gz', keys: ['darwin-aarch64', 'darwin-x86_64'] },
  { suffix: '-setup.exe', keys: ['windows-x86_64', 'windows-x86_64-nsis'] },
  { suffix: '.msi', keys: ['windows-x86_64-msi'] },
  { suffix: '.AppImage', keys: ['linux-x86_64'] },
  { suffix: '.deb', keys: ['linux-x86_64-deb'] },
  { suffix: '.rpm', keys: ['linux-x86_64-rpm'] },
];
const REQUIRED_KEYS = [
  'darwin-aarch64',
  'darwin-x86_64',
  'linux-x86_64',
  'linux-x86_64-deb',
  'linux-x86_64-rpm',
  'windows-x86_64',
  'windows-x86_64-nsis',
  'windows-x86_64-msi',
];

const files = readdirSync(assetsDir).sort();
const platforms = {};
const consumed = [];

for (const name of files) {
  if (name.endsWith('.sig') || name === 'latest.json') continue;
  const rule = FILE_RULES.find((entry) => name.endsWith(entry.suffix));
  if (!rule) continue;
  const path = join(assetsDir, name);
  if (!statSync(path).isFile()) continue;
  const sigPath = `${path}.sig`;
  let signature;
  try {
    signature = readFileSync(sigPath, 'utf8').trim();
  } catch {
    fail(`missing updater signature: ${sigPath} (set TAURI_SIGNING_PRIVATE_KEY on the build)`);
  }
  if (signature === '') fail(`empty updater signature: ${sigPath}`);
  const url = `${githubBase.replace(/\/+$/, '')}/${encodeURIComponent(name)}`;
  for (const key of rule.keys) {
    platforms[key] = { signature, url };
  }
  consumed.push(name, `${name}.sig`);
}

const missing = REQUIRED_KEYS.filter((key) => platforms[key] === undefined);
if (missing.length > 0) {
  fail(`manifest incomplete, missing platform keys: ${missing.join(', ')}`);
}

const notes = notesFile === '-' ? null : readFileSync(notesFile, 'utf8');
const manifest = {
  version,
  notes,
  pub_date: pubDate,
  platforms,
};
writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`);

if (outAssetsDir) {
  mkdirSync(outAssetsDir, { recursive: true });
  for (const name of consumed) {
    copyFileSync(join(assetsDir, name), join(outAssetsDir, name));
  }
}

console.log(`build-updater-manifest: wrote ${output} (${REQUIRED_KEYS.length} platform keys)`);
