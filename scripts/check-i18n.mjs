#!/usr/bin/env node
// i18n catalog guard (ADR-0052, issue #78). Runs @formatjs/cli extract over the
// source to recover the canonical message-id set (from each <FormattedMessage
// defaultMessage=...> / intl.formatMessage defaultMessage), then asserts:
//   1. the extracted id set == en-US.json keys (source covers the English catalog)
//   2. en-US.json keys == zh-CN.json keys (no missing translations / drift)
// Fails the CI build on any mismatch so a new <FormattedMessage> can never ship
// without its catalog entries. Mirrors the vitest catalog-alignment test (this
// script additionally gates on SOURCE coverage, which the vitest test cannot do
// without scanning JSX).

import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const en = JSON.parse(readFileSync(join(root, "src/locales/en-US.json"), "utf8"));
const zh = JSON.parse(readFileSync(join(root, "src/locales/zh-CN.json"), "utf8"));

// Extract the source id set via @formatjs/cli. Writes to a temp file so the
// repo stays clean; --format simple yields { id: defaultMessage }. shell: true is
// required so Node can spawn npx.cmd on Windows (POSIX finds npx directly); the
// args are all hardcoded literals so the shell-injection warning does not apply.
const tmp = mkdtempSync(join(tmpdir(), "toptopduck-i18n-"));
const extractedPath = join(tmp, "extracted.json");
let extracted;
try {
  execFileSync(
    "npx",
    [
      "formatjs",
      "extract",
      "src/**/*.tsx",
      "src/**/*.ts",
      "--format",
      "simple",
      "--out-file",
      extractedPath,
    ],
    { cwd: root, stdio: "inherit", shell: true },
  );
  extracted = JSON.parse(readFileSync(extractedPath, "utf8"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const exKeys = Object.keys(extracted).sort();
const enKeys = Object.keys(en).sort();
const zhKeys = Object.keys(zh).sort();

const problems = [];
const pushMissing = (label, have, want) => {
  const missing = want.filter((k) => !have.includes(k));
  const extra = have.filter((k) => !want.includes(k));
  if (missing.length) problems.push(`${label} missing: ${missing.join(", ")}`);
  if (extra.length) problems.push(`${label} extra: ${extra.join(", ")}`);
};

// (1) source coverage: every extracted id is in the English catalog and vice versa.
pushMissing("en-US.json vs source", enKeys, exKeys);
// (2) catalog alignment: en and zh carry the same key set.
pushMissing("zh-CN.json vs en-US.json", zhKeys, enKeys);

if (problems.length) {
  console.error("✖ i18n catalog guard failed:");
  for (const p of problems) console.error(`  • ${p}`);
  console.error("");
  console.error("Fix: add the missing keys to src/locales/{en-US,zh-CN}.json,");
  console.error("or run `npm run i18n:extract` to regenerate the en-US skeleton.");
  process.exit(1);
}

console.log(
  `✓ i18n catalogs aligned (${exKeys.length} ids: source == en-US == zh-CN).`,
);
