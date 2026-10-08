---
name: prepare-release
description: Prepare a k10s release. Brings everything that describes the current state of the project up to date before a version is tagged (README.md and README.ru.md, the comparison table, screenshots and their AppStream copies, benchmarks, keyboard and architecture docs, release notes, versions), then runs the release checks. Use when asked to prepare, check or cut a release, or to update the README and docs for one ("подготовь релиз", "проверь перед релизом", "актуализируй README").
---

# Prepare a k10s release

When the tag is pushed, everything a user or a contributor reads must describe the version being released. The checks in CI pass whether the README is true or not, so this is done by reading and comparing, with `scripts/release-check.mjs` for the mechanical part. [docs/releasing.md](../../../docs/releasing.md) describes the workflows this ends in.

Don't commit, tag or push: the maintainer stages and commits themselves. End with a report and the commands for them to run.

## 1. What is being released

1. The version: ask if it wasn't given. Semver; a suffix (`0.3.0-beta.1`) makes a pre-release, which is never offered as an update.
2. The previous release: `git describe --tags --abbrev=0`. With no tag yet, this is the first release: review everything below, not just what changed.
3. What changed: `git log --oneline <previous>..HEAD` and `git diff --stat <previous>..HEAD`. Read the commits and skim the changed code until you can list the **user-visible** changes: new features, changed behavior, fixes users will notice, things removed, new platforms or packages.
4. What is still open:
   - `git log --oneline origin/main..HEAD`: commits that haven't been through CI on `main` yet. `gh run list` shows how CI and **Audit** did there; a red Audit is a known advisory in what k10s ships, and it blocks the release.
   - The previous release's **Publish** run (Homebrew cask, winget pull request) and its notes on GitHub.
   - Open Dependabot pull requests.
   - The winget package and the AppImage catalog entry: whether they are accepted yet ([Linux metadata](../../../docs/releasing.md#linux-metadata)).

## 2. Mechanical checks

```bash
node scripts/third-party-notices.mjs
node scripts/release-check.mjs <version>
```

The first writes `THIRD-PARTY-NOTICES.md` (ignored by git), which release builds carry and the size check counts in. Fix every ✗ and look at every ⚠ before going on. The check covers:

- the versions in all files, the AppStream releases among them;
- that the release matrix, the update feed's list of platforms and the Homebrew cask agree;
- that no placeholder is left;
- that `.github/release-notes.md` isn't the previous release's;
- that README.md and README.ru.md have the same sections, tables, images and links;
- how old the comparison table is;
- the size claims against a release build in `target/`, with its license files;
- broken relative links and unused screenshots;
- the screenshots of the Linux metadata: in the repository, and no older than the README's;
- secrets and email addresses in tracked files.

## 3. README.md, then README.ru.md

For every user-visible change, find where the README speaks about it and make it true:

- **Why k10s**: only for changes in what k10s does better than the others. Keep each point specific: what it does and how, no adjectives without facts.
- **Everything else you'd expect**: new everyday capabilities.
- **Limitations and gaps**: remove what was fixed (YAML editing, rollbacks, a config file…), reword what changed, add known new limits. This table is a promise of honesty: never leave a limitation that no longer exists, never hide a new one.
- **How it compares**: the k10s column. A gap that closed becomes ✓ (or a short description). Touch the other columns only as described in step 5.
- **Install**, **Updates**, **Getting started**, **Privacy**, **FAQ**: platforms, packages, keys, what k10s connects to.

Then make README.ru.md say exactly the same: same sections, same rows, same facts. Write the Russian as Russian, not as a translation: k10s terms are неймспейс, под, деплоймент, ворклоад, вотч, кластер, and the UI's own English names stay as they are (Needs attention, Compare, Sources).

Style for both: short sentences, concrete facts and numbers, no marketing words ("blazing", "seamless", "powerful", "beautiful"), few dashes, American spelling in English.

## 4. Other docs

- **docs/keyboard.md** and the key table in both READMEs, against `SHORTCUTS` in `ui/src/components/ShortcutsHelp.tsx`: the in-app cheat sheet is the source of truth.
- **docs/architecture.md**, against the modules in `crates/k10s-core/src`, `crates/k10s-app/src` and `ui/src`: new modules, extension points, the data flow.
- **CONTRIBUTING.md**: prerequisites (Rust: `rust-version` in Cargo.toml; Node.js: `.nvmrc`), commands, and the mock UI's parameters: its URL parameters and every `localStorage["k10s:mock.…"]` that `ui/src/lib/backend/mock.ts` reads.
- **docs/releasing.md** and **SECURITY.md**, when the release process or the updater changed.
- **Issue templates**: the OS list matches the platforms built.

## 5. The comparison table

If its "Checked on" date is more than about three months old, or a competitor shipped a major version, re-verify the competitors from primary sources: their release pages and the GitHub releases API (versions, dates, download sizes), pricing pages, docs and source code. Change a cell only for what you actually checked, and put "Not verified" where you couldn't. Then update the date in both READMEs. Delegating the research to subagents works well; give them the exact rows to check.

## 6. Screenshots and numbers

- **Screenshots** (`docs/assets/*.webp`): re-shoot them when the UI changed visibly. Use the mock UI (`npm run dev` in `ui/`, or `npx vite --port 1430 --strictPort` there if 1420 is taken) and Playwright's WebKit at 1440×900, device scale factor 2:
  - seed the mock's stand-ins for the app's files before the first load: `localStorage["k10s:mock.files"] = JSON.stringify({ settings: { theme }, state: { clusters: [the four acme-prod-apps-z* clusters], resource } })`;
  - hide the "mock data" badge and the engine-stats item in the status bar, and show the version being released, without `-mock`;
  - convert with `cwebp -lossless -z 9`.

  The README's hero comes in a dark and a light version. Every screenshot the AppStream metadata shows (`packaging/linux/io.dumkin.k10s.appdata.xml`) has a half-size JPEG copy next to it: make it again whenever its WebP changes, with the `sips` and `cjpeg` command in [docs/releasing.md](../../../docs/releasing.md#linux-metadata). Software centers show the copies of the version's tag, so they must be committed before the tag.
- **Sizes**: run `npm --prefix ui run tauri build -- --bundles app`. Releases also carry `LICENSE` and `THIRD-PARTY-NOTICES.md` (about 2 MB), which a local build lacks: the installed size is `du -sk` of the `.app` plus those two files, in MB (×1024 / 10⁶); `release-check.mjs` counts them in. For the download size, copy the two files into a copy of the `.app` and make an `hdiutil create -format UDZO -imagekey zlib-level=9` image of it; it comes within a few percent of the real `.dmg`. The previous release's `.dmg` (`gh release view v<previous> --json assets`) tells how close. Update the "Small and fast" paragraph and the table, in both READMEs.
- **Benchmarks**: the chart in the READMEs comes from the k10s-bench repository, next to this one. Re-run it there when the engine or the UI changed a lot, and say which version it was measured on; never pass old numbers off as a new version's.
  - k10s alone: `node bench.mjs run --k10s <this checkout> --clients k10s`, about two hours with nobody at the Mac (the apps come to the front). Build nothing else meanwhile: a busy Mac makes runs noisy. The report keeps each client's newest version and says when each was measured, so only k10s's numbers change. It must be the same macOS build, display and VM as the other clients' results; when it isn't, the run says so, and then every client is measured again (about 7 hours, overnight).
  - Then `node bench.mjs report --export <this checkout>`, which writes the charts into `docs/assets`. The "Small and fast" paragraph quotes the numbers: keep them in step.

## 7. Release notes

Write the notes for this version into the "What's new" part of `.github/release-notes.md`, replacing the previous version's: the Release workflow puts the whole file into the draft release, and the app's "What's new in k10s X" opens that release's page. Group the changes under New, Improved and Fixed, plus Notes for anything users must act on. One line each, written for users rather than developers. Keep the install table below them as it is.

## 8. Hygiene

- No real cluster names, internal hosts, company names, personal emails or tokens in docs, tests, fixtures, the mock or screenshots. Examples use `acme-*`, `prod-eu-z1…z3`, `payments`, `shop`, `payments-api`, `web`, pod IPs `10.244.x.y`, `registry.example.com`.
- Licenses: `cargo deny check` (when installed) and `node scripts/third-party-notices.mjs --check`. If a new dependency brings a license that isn't in `deny.toml`, stop and ask the maintainer: it must be compatible with the AGPL.
- Advisories: `npm --prefix ui audit --omit=dev` (what the Audit workflow runs) and, with cargo-deny, `cargo deny check advisories`.

## 9. Version and CI

```bash
node scripts/version.mjs <version>
npm --prefix ui run lint && npm --prefix ui run typecheck && npm --prefix ui test
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
node scripts/release-check.mjs <version>
```

`version.mjs` also adds the version to the AppStream releases, dated the day it runs, and points the metadata's screenshots at the version's tag. If the tag comes on another day, correct the date in `packaging/linux/io.dumkin.k10s.appdata.xml`.

If the workflows changed, also run actionlint, for example `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`.

## 10. Report

Tell the maintainer:

- what you updated, file by file;
- what needs them: decisions, facts you couldn't verify, screenshots or benchmarks left to do;
- how to cut the release once they've committed (the release commit is `chore: release v<version>`, in Conventional Commits like the rest of the history):

  ```bash
  git push origin main
  git tag v<version> && git push origin v<version>
  ```

  Tag once CI and Audit have passed on `main`. Then, in the draft release on GitHub, check the notes and the files, and publish it. Publishing starts the Publish workflow: check that the Homebrew cask and the winget pull request followed. If the AppStream metadata changed, comment `/retest` on k10s's pull request in the AppImage catalog.
