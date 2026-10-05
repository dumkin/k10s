#!/usr/bin/env node
// The version of k10s is written in several files. This sets it in all of them, or checks that they agree.
//
//   node scripts/version.mjs 0.2.0            set it
//   node scripts/version.mjs --check [0.2.0]  check that the files agree (and that they say 0.2.0)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/** Where the version is: a file and the pattern around it (the version is the second group). */
const PLACES = [
  ["ui/package.json", /^(\{[\s\S]*?\n  "version": ")([^"]+)(")/],
  ["ui/package-lock.json", /^(\{[\s\S]*?\n  "version": ")([^"]+)(")/],
  ["ui/package-lock.json", /(\n    "": \{\n      "name": "k10s",\n      "version": ")([^"]+)(")/],
  ["Cargo.toml", /(\[workspace\.package\]\nversion = ")([^"]+)(")/],
  ["Cargo.lock", /(\nname = "k10s"\nversion = ")([^"]+)(")/],
  ["Cargo.lock", /(\nname = "k10s-core"\nversion = ")([^"]+)(")/],
  ["crates/k10s-app/tauri.conf.json", /^(\{[\s\S]*?\n  "version": ")([^"]+)(")/],
];

const read = (file) => readFileSync(join(ROOT, file), "utf8");

function found() {
  return PLACES.map(([file, pattern]) => {
    const m = read(file).match(pattern);
    if (!m) throw new Error(`no version found in ${file}`);
    return { file, version: m[2] };
  });
}

const args = process.argv.slice(2);
if (args[0] === "--check") {
  const want = args[1]?.replace(/^v/, "");
  const all = found();
  const versions = new Set(all.map((f) => f.version));
  if (versions.size !== 1 || (want && !versions.has(want))) {
    console.error(want ? `Expected version ${want} everywhere:` : "The version differs between files:");
    for (const f of all) console.error(`  ${f.file}: ${f.version}`);
    console.error("Set it with: node scripts/version.mjs <version>");
    process.exit(1);
  }
  console.log(`Version ${[...versions][0]} everywhere.`);
} else if (args.length === 1 && SEMVER.test(args[0].replace(/^v/, ""))) {
  const version = args[0].replace(/^v/, "");
  for (const [file, pattern] of PLACES) writeFileSync(join(ROOT, file), read(file).replace(pattern, `$1${version}$3`));
  console.log(`Version ${version} set in ${[...new Set(PLACES.map(([f]) => f))].join(", ")}.`);
} else {
  console.error("Usage: node scripts/version.mjs <version> | --check [version]");
  process.exit(2);
}
