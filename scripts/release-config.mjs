#!/usr/bin/env node
// Writes release.conf.json: what only release builds get, merged into tauri.conf.json with `tauri build --config`.
// - the update feed of the repository the build runs in (GITHUB_REPOSITORY) and the public key updates are
//   verified with (UPDATER_PUBKEY): builds without them don't update themselves;
// - the license files inside the bundle (run third-party-notices.mjs first);
// - signing: ad hoc on macOS unless a Developer ID certificate is given; WINDOWS_SIGN_COMMAND if set.

import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const env = process.env;
if (!env.GITHUB_REPOSITORY || !env.UPDATER_PUBKEY) {
  console.error("GITHUB_REPOSITORY (owner/name) and UPDATER_PUBKEY must be set.");
  process.exit(1);
}
const repo = `https://github.com/${env.GITHUB_REPOSITORY}`;
const bundle = {
  createUpdaterArtifacts: true,
  homepage: repo,
  // Paths relative to the app crate (crates/k10s-app).
  resources: { "../../LICENSE": "LICENSE", "../../THIRD-PARTY-NOTICES.md": "THIRD-PARTY-NOTICES.md" },
};
// Without a Developer ID certificate the app is signed ad hoc: macOS then offers to open it from Privacy & Security
// instead of calling it damaged.
if (!env.APPLE_SIGNING_IDENTITY && !env.APPLE_CERTIFICATE) bundle.macOS = { signingIdentity: "-" };
if (env.WINDOWS_SIGN_COMMAND) bundle.windows = { signCommand: env.WINDOWS_SIGN_COMMAND };
const plugins = { updater: { pubkey: env.UPDATER_PUBKEY, endpoints: [`${repo}/releases/latest/download/latest.json`] } };

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "release.conf.json");
writeFileSync(out, `${JSON.stringify({ bundle, plugins }, null, 2)}\n`);
console.log(`${out}:\n${JSON.stringify({ bundle, plugins }, null, 2)}`);
