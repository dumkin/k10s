#!/usr/bin/env node
// The licenses of everything k10s ships: the Rust crates compiled into the app and the npm packages bundled into
// its UI. Writes THIRD-PARTY-NOTICES.md (the release workflow puts it into every installer); `--check` only checks
// that each npm package the UI ships comes under a license k10s may ship (cargo-deny checks the crates).
//
//   node scripts/third-party-notices.mjs [--out FILE] [--check]

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : join(ROOT, "THIRD-PARTY-NOTICES.md");

/** The same list as deny.toml. */
const ALLOWED = new Set(["0BSD", "Apache-2.0", "Apache-2.0 WITH LLVM-exception", "BSD-2-Clause", "BSD-3-Clause", "CC0-1.0", "CDLA-Permissive-2.0", "ISC", "MIT", "MIT-0", "MPL-2.0", "Unicode-3.0", "Unlicense", "Zlib"]);
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/i;

/** Whether an SPDX expression (`MIT OR Apache-2.0`, `(A OR B) AND C`, old `MIT/Apache-2.0`) leaves a license k10s may ship. */
function allowed(expression) {
  const tokens = expression.replace(/\//g, " OR ").match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const term = () => {
    if (tokens[i] === "(") {
      i++;
      const v = or();
      i++;
      return v;
    }
    let id = tokens[i++];
    if (tokens[i] === "WITH") {
      id = `${id} WITH ${tokens[i + 1]}`;
      i += 2;
    }
    return ALLOWED.has(id);
  };
  const and = () => {
    let v = term();
    while (tokens[i] === "AND") {
      i++;
      v = term() && v;
    }
    return v;
  };
  const or = () => {
    let v = and();
    while (tokens[i] === "OR") {
      i++;
      v = and() || v;
    }
    return v;
  };
  return tokens.length > 0 && or();
}

function licenseTexts(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").replace(/\r\n/g, "\n").trim())
    .filter(Boolean);
}

/** Crates reachable from the workspace through normal dependencies: what is compiled into the app. */
function crates() {
  const meta = JSON.parse(execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], { cwd: ROOT, maxBuffer: 1 << 28 }).toString());
  const packages = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const members = new Set(meta.workspace_members);
  const seen = new Set();
  const stack = [...members];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) if (dep.dep_kinds.some((k) => k.kind === null)) stack.push(dep.pkg);
  }
  return [...seen]
    .filter((id) => !members.has(id))
    .map((id) => packages.get(id))
    .map((p) => ({
      name: p.name,
      version: p.version,
      license: p.license ?? "see its license file",
      source: `https://crates.io/crates/${p.name}/${p.version}`,
      texts: licenseTexts(dirname(p.manifest_path)),
    }));
}

/** npm packages the UI bundle is built from (not the build tools). */
function npmPackages() {
  const lock = JSON.parse(readFileSync(join(ROOT, "ui/package-lock.json"), "utf8"));
  return Object.entries(lock.packages)
    .filter(([path, p]) => path && !p.dev && !p.optional)
    .map(([path, p]) => {
      const dir = join(ROOT, "ui", path);
      const manifest = existsSync(join(dir, "package.json")) ? JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) : {};
      const name = path.split("node_modules/").at(-1);
      return { name, version: p.version, license: p.license ?? manifest.license ?? "unknown", source: `https://www.npmjs.com/package/${name}/v/${p.version}`, texts: licenseTexts(dir) };
    });
}

const npm = npmPackages();
const refused = npm.filter((p) => !allowed(p.license));
if (refused.length) {
  console.error("These npm packages come under licenses k10s can't ship:");
  for (const p of refused) console.error(`  ${p.name}@${p.version}: ${p.license}`);
  process.exit(1);
}
if (check) {
  console.log(`${npm.length} npm packages, all under licenses k10s may ship.`);
  process.exit(0);
}

const all = [...crates().map((p) => ({ ...p, kind: "Rust crate" })), ...npm.map((p) => ({ ...p, kind: "npm package" }))].sort((a, b) => a.name.localeCompare(b.name));
// Many packages carry the very same text (the Apache license above all): each text once, with everyone it covers.
const byText = new Map();
const without = [];
for (const p of all) {
  if (!p.texts.length) {
    without.push(p);
    continue;
  }
  const text = p.texts.join("\n\n---\n\n");
  if (!byText.has(text)) byText.set(text, []);
  byText.get(text).push(p);
}

const lines = [
  "# Third-party notices",
  "",
  "k10s is licensed under the GNU Affero General Public License v3.0 (see LICENSE). It includes the software below,",
  "used under the licenses that follow. The source code of each is available at the address given for it,",
  "including the files covered by the Mozilla Public License 2.0.",
  "",
  "## Components",
  "",
  ...all.map((p) => `- ${p.name} ${p.version} (${p.kind}, ${p.license}): ${p.source}`),
  "",
  "## License texts",
  "",
];
for (const [text, users] of byText) {
  lines.push(`### ${users.map((p) => `${p.name} ${p.version}`).join(", ")}`, "", "```text", text, "```", "");
}
if (without.length) {
  lines.push("### Packages that carry no license file", "", "Their license is the one named in their manifest; its standard text applies.", "");
  for (const p of without) lines.push(`- ${p.name} ${p.version}: ${p.license}`);
  lines.push("");
}
writeFileSync(out, lines.join("\n"));
console.log(`${out}: ${all.length} components, ${byText.size} distinct license texts.`);
