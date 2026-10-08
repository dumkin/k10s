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
/** The AppStream metadata of the Linux packages: it lists every version, newest first. */
const METAINFO = "packaging/linux/io.dumkin.k10s.appdata.xml";

/** Where the version is: a file, the pattern around it (the version is the second group; a global pattern finds all of
 * them) and, when the file name doesn't say, what it is. */
const PLACES = [
  ["ui/package.json", /^(\{[\s\S]*?\n  "version": ")([^"]+)(")/],
  ["ui/package-lock.json", /^(\{[\s\S]*?\n  "version": ")([^"]+)(")/],
  ["ui/package-lock.json", /(\n    "": \{\n      "name": "k10s",\n      "version": ")([^"]+)(")/],
  ["Cargo.toml", /(\[workspace\.package\]\nversion = ")([^"]+)(")/],
  ["Cargo.lock", /(\nname = "k10s"\nversion = ")([^"]+)(")/],
  ["Cargo.lock", /(\nname = "k10s-core"\nversion = ")([^"]+)(")/],
  ["crates/k10s-app/tauri.conf.json", /^(\{[\s\S]*?\n  "version": ")([^"]+)(")/],
  // The screenshots of the version's tag: those of a released version stay as they were.
  [METAINFO, /(https:\/\/raw\.githubusercontent\.com\/dumkin\/k10s\/v)([^/]+)(\/)/g, "screenshots"],
];

const read = (file) => readFileSync(join(ROOT, file), "utf8");

function found() {
  const places = PLACES.flatMap(([file, pattern, what]) => {
    const matches = pattern.global ? [...read(file).matchAll(pattern)] : [read(file).match(pattern)].filter(Boolean);
    if (!matches.length) throw new Error(`no version found in ${file}`);
    return [...new Set(matches.map((m) => m[2]))].map((version) => ({ file: what ? `${file}, ${what}` : file, version }));
  });
  const newest = read(METAINFO).match(/<release version="([^"]+)"/);
  if (!newest) throw new Error(`no release found in ${METAINFO}`);
  return [...places, { file: `${METAINFO}, newest release`, version: newest[1] }];
}

/** Puts the version on top of the releases in the AppStream metadata, dated today. A pre-release goes in as a
 * development release and leaves when its version comes out, since AppStream sorts 0.2.0-beta.1 above 0.2.0. */
function addRelease(version) {
  const text = read(METAINFO);
  if (text.includes(`<release version="${version}"`)) return;
  const date = new Date().toISOString().slice(0, 10);
  const type = version.includes("-") ? ' type="development"' : "";
  const prereleases = new RegExp(`\\n *<release version="${version.replaceAll(".", "\\.")}-[^"]*"[^>]*/>`, "g");
  const releases = /(\n( *)<releases>\n)/;
  writeFileSync(join(ROOT, METAINFO), text.replace(prereleases, "").replace(releases, `$1$2  <release version="${version}" date="${date}"${type}/>\n`));
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
  addRelease(version);
  for (const [file, pattern] of PLACES) writeFileSync(join(ROOT, file), read(file).replace(pattern, `$1${version}$3`));
  console.log(`Version ${version} set in ${[...new Set(PLACES.map(([f]) => f))].join(", ")}.`);
} else {
  console.error("Usage: node scripts/version.mjs <version> | --check [version]");
  process.exit(2);
}
