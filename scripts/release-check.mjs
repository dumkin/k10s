#!/usr/bin/env node
// Mechanical checks before a release: what CI can't know is out of date because nothing fails when it is.
// The prepare-release skill (.claude/skills/prepare-release) runs this first; it works on its own too.
//
//   node scripts/release-check.mjs [version]
//
// ✗ blocks the release, ⚠ needs a look. Exit code 1 when something blocks.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2]?.replace(/^v/, "");
const read = (file) => readFileSync(join(ROOT, file), "utf8");
const errors = [];
const warnings = [];
const notes = [];

// The version is the same everywhere (and is the one being released).
try {
  execFileSync(process.execPath, ["scripts/version.mjs", "--check", ...(version ? [version] : [])], { cwd: ROOT, stdio: "pipe" });
} catch (e) {
  errors.push(`versions disagree:\n${e.stderr.toString().trim()}`);
}

// The release notes are this version's: the draft release takes .github/release-notes.md as it is, and 0.1.1 went out
// with the notes of 0.1.0. The previous release is the newest tag before HEAD.
const git = (...args) => execFileSync("git", args, { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const previous = git("tag", "--merged", "HEAD", "--no-contains", "HEAD", "--sort=-v:refname", "--list", "v*")
  .split("\n")
  .find((tag) => tag && tag !== `v${version}`);
if (previous) {
  let before = null;
  try {
    before = git("show", `${previous}:.github/release-notes.md`);
  } catch {
    // The file isn't in that release.
  }
  if (before === read(".github/release-notes.md").trim()) errors.push(`.github/release-notes.md is still what ${previous} said: write this version's notes`);
}

// What the release builds = what the update feed must list = what the Homebrew cask downloads. Each target: its key in
// the update feed and the <os>-<arch> its files are named with (`files` in release.yml).
const TARGETS = {
  "aarch64-apple-darwin": ["darwin-aarch64", "macos-arm64"],
  "x86_64-apple-darwin": ["darwin-x86_64", "macos-x64"],
  "x86_64-pc-windows-msvc": ["windows-x86_64", "windows-x64"],
  "aarch64-pc-windows-msvc": ["windows-aarch64", "windows-arm64"],
  "x86_64-unknown-linux-gnu": ["linux-x86_64", "linux-x64"],
  "aarch64-unknown-linux-gnu": ["linux-aarch64", "linux-arm64"],
};
const workflow = read(".github/workflows/release.yml");
const targets = [...workflow.matchAll(/^\s+target:\s*(\S+)\s*$/gm)].map((m) => m[1]);
const built = targets.map((t) => TARGETS[t]?.[0] ?? `unknown target ${t}`);
const feed = JSON.parse(read("scripts/update-feed.mjs").match(/const PLATFORMS = (\[[^\]]*\])/)[1]);
const diff = (a, b) => a.filter((x) => !b.includes(x));
if (diff(built, feed).length || diff(feed, built).length) {
  errors.push(`release.yml builds [${built.join(", ")}] but update-feed.mjs expects [${feed.join(", ")}]`);
}
// Two builds with the same `files` would overwrite each other's files.
const files = [...workflow.matchAll(/^\s+files:\s*(\S+)\s*$/gm)].map((m) => m[1]);
const named = targets.map((t) => TARGETS[t]?.[1] ?? "?");
if (files.join() !== named.join()) errors.push(`release.yml names the files of [${targets.join(", ")}] [${files.join(", ")}], not [${named.join(", ")}]`);
const cask = read("packaging/homebrew/k10s.rb");
for (const mac of ["macos-arm64", "macos-x64"]) {
  if (files.includes(mac) !== cask.includes(`-${mac}.dmg`)) errors.push(`the Homebrew cask and the ${mac} build disagree`);
}

// Placeholders that must be gone by the first release.
for (const file of ["README.md", "README.ru.md"]) {
  if (/\bOWNER\//.test(read(file))) errors.push(`${file} still says OWNER/…: put the GitHub owner of the repository there`);
}

// README.md and README.ru.md tell the same story: same sections, tables, images and links.
function outline(md) {
  const lines = md.split("\n");
  const fence = { open: false };
  const headings = [];
  const tables = [];
  let rows = 0;
  for (const line of lines) {
    if (line.startsWith("```")) fence.open = !fence.open;
    if (fence.open) continue;
    const h = line.match(/^(#{2,4}) /);
    if (h) headings.push(h[1].length);
    if (line.startsWith("|")) rows++;
    else if (rows) {
      tables.push(rows);
      rows = 0;
    }
  }
  if (rows) tables.push(rows);
  // The Russian edition of a chart (docs/assets/bench-ru.svg) is the same image as the English one.
  const images = [...md.matchAll(/(?:src|srcset)="([^"]+)"/g)].map((m) => m[1].replace(/-ru((?:-(?:light|dark))?\.svg)$/, "$1")).sort();
  const links = [...md.matchAll(/\]\(([^)#\s]+)[^)]*\)|href="([^"#]+)"/g)].map((m) => m[1] ?? m[2]).filter((l) => !/^README(\.ru)?\.md$/.test(l)).sort();
  return { headings: headings.join(""), tables: tables.join(","), images: images.join(" "), links: [...new Set(links)].join(" ") };
}
const en = outline(read("README.md"));
const ru = outline(read("README.ru.md"));
for (const [what, label] of [["headings", "section structure"], ["tables", "table sizes"], ["images", "images"], ["links", "links"]]) {
  if (en[what] !== ru[what]) errors.push(`README.md and README.ru.md differ in ${label}:\n  en: ${en[what]}\n  ru: ${ru[what]}`);
}

// The comparison table says when it was checked; both languages agree, and it isn't stale.
const checkedEn = read("README.md").match(/Checked on (\d{4}-\d{2}-\d{2})/)?.[1];
const checkedRu = read("README.ru.md").match(/Проверено (\d{4}-\d{2}-\d{2})/)?.[1];
if (!checkedEn || checkedEn !== checkedRu) errors.push(`the comparison dates disagree: README.md ${checkedEn ?? "none"}, README.ru.md ${checkedRu ?? "none"}`);
else {
  const days = Math.floor((Date.now() - Date.parse(checkedEn)) / 86_400_000);
  if (days > 120) warnings.push(`the comparison table was checked ${days} days ago (${checkedEn}): re-verify the competitors`);
}

// Size claims against a release build, when there is one. Releases also carry the license files (release-config.mjs),
// about 2 MB a local build lacks: they are counted in from LICENSE and THIRD-PARTY-NOTICES.md.
const app = join(ROOT, "target/release/bundle/macos/k10s.app");
const LICENSES = ["LICENSE", "THIRD-PARTY-NOTICES.md"];
if (!existsSync(app)) {
  notes.push("no release build in target/: app sizes in the README were not checked (npm --prefix ui run tauri build -- --bundles app)");
} else if (!existsSync(join(ROOT, "THIRD-PARTY-NOTICES.md"))) {
  notes.push("no THIRD-PARTY-NOTICES.md, which releases carry: app sizes in the README were not checked (node scripts/third-party-notices.mjs)");
} else {
  const blocksKB = (file) => Math.ceil(statSync(file).size / 4096) * 4;
  let kb = Number(execFileSync("du", ["-sk", app]).toString().split("\t")[0]);
  for (const f of LICENSES) if (!existsSync(join(app, "Contents/Resources", f))) kb += blocksKB(join(ROOT, f));
  const mb = Math.round((kb * 1024) / 1e6);
  for (const [file, pattern] of [["README.md", /the installed app takes (\d+) MB/], ["README.ru.md", /установленное приложение занимает (\d+) МБ/]]) {
    const claimed = Number(read(file).match(pattern)?.[1]);
    if (!claimed) warnings.push(`${file} no longer says how much the installed app takes: update release-check.mjs`);
    else if (Math.abs(claimed - mb) > 1) warnings.push(`${file} says the installed app takes ${claimed} MB; the release build here, with its license files, takes ${mb} MB`);
  }
}

// Relative links and images in every tracked Markdown file lead somewhere.
const tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT }).toString().split("\n").filter(Boolean);
for (const file of tracked.filter((f) => f.endsWith(".md"))) {
  const text = read(file);
  for (const m of text.matchAll(/\]\(([^)\s]+)[^)]*\)|(?:src|srcset|href)="([^"]+)"/g)) {
    const target = (m[1] ?? m[2]).split("#")[0];
    if (!target || /^(https?:|mailto:|\.\.\/\.\.\/)/.test(target)) continue;
    if (!existsSync(normalize(join(ROOT, dirname(file), target)))) errors.push(`${file}: broken link ${target}`);
  }
}

// The AppStream metadata of the Linux packages. Its releases and the tag of its screenshots are checked with the version.
const METAINFO = "packaging/linux/io.dumkin.k10s.appdata.xml";

// Screenshots nobody shows.
for (const asset of readdirSync(join(ROOT, "docs/assets"))) {
  // From the repository root (docs/assets/x) or from a document in docs/ (assets/x).
  const used = (f) => read(f).includes(`docs/assets/${asset}`) || (f.startsWith("docs/") && read(f).includes(`assets/${asset}`));
  if (!tracked.some((f) => (f.endsWith(".md") || f === METAINFO) && used(f))) warnings.push(`docs/assets/${asset} is not used by any document`);
}

// Software centers show the screenshots of the AppStream metadata from the version's tag, so they must be in the
// repository: JPEG copies of the README's screenshots, made again whenever those change.
const committed = (file) => Number(execFileSync("git", ["log", "-1", "--format=%ct", "--", file], { cwd: ROOT }).toString().trim() || Infinity);
for (const [, image] of read(METAINFO).matchAll(/<image[^>]*>https:\/\/raw\.githubusercontent\.com\/dumkin\/k10s\/[^/]+\/([^<]+)<\/image>/g)) {
  const webp = image.replace(/\.jpg$/, ".webp");
  if (!existsSync(join(ROOT, image))) errors.push(`${METAINFO} shows ${image}, which isn't in the repository`);
  else if (existsSync(join(ROOT, webp)) && committed(webp) > committed(image)) warnings.push(`${image} is older than ${webp}: make it again (docs/releasing.md)`);
}

// Secrets and personal data that must never ship.
const SKIP = /(^|\/)(package-lock\.json|Cargo\.lock|LICENSE)$|\.(webp|png|jpg|icns|ico|svg)$/;
const SECRET = [
  // A real key, not a test fixture with a few letters inside.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----\s*[A-Za-z0-9+/=\s]{100,}/, "a private key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS access key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}\b/, "a GitHub token"],
  [/\bxox[abpr]-[A-Za-z0-9-]{10,}/, "a Slack token"],
  [/untrusted comment: (rsign|minisign|signature from tauri)/i, "a signing key or signature"],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAIL = /@(users\.noreply\.github\.com|example\.(com|org)|acme\.dev)$|^noreply@anthropic\.com$|^git@github\.com$/;
for (const file of tracked.filter((f) => !SKIP.test(f))) {
  let text;
  try {
    text = read(file);
  } catch {
    continue;
  }
  for (const [pattern, what] of SECRET) if (pattern.test(text)) errors.push(`${file} contains ${what}`);
  for (const email of new Set(text.match(EMAIL) ?? [])) if (!ALLOWED_EMAIL.test(email) && !/\.(png|svg|js|ts|rs)$/.test(email)) warnings.push(`${file} mentions ${email}`);
}

for (const e of errors) console.log(`✗ ${e}`);
for (const w of warnings) console.log(`⚠ ${w}`);
for (const n of notes) console.log(`· ${n}`);
if (!errors.length && !warnings.length) console.log("✓ nothing found");
process.exit(errors.length ? 1 : 0);
