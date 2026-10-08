# Releasing k10s

How versions get from a tag to users: the installers on GitHub Releases, the update feed that running copies of k10s check, and the package managers. Most of it is automatic; this page covers the one-time setup and what is left to do by hand.

## How it works

1. A tag `vX.Y.Z` starts the **Release** workflow. It checks that the version in the files matches the tag, opens a **draft** release, and builds on four runners: macOS on Apple silicon, Windows x64, Linux x64 and Linux Arm. Intel Macs aren't built for. Each build uploads its installers and update packages, and adds its platform to the update feed, `latest.json`, with the packages' signatures. A last job checks that the feed lists every platform and points it at direct download links.
2. You read the draft, write the notes and **publish** it. Only then does it become the latest release: running copies of k10s find it (`releases/latest/download/latest.json`), download it in the background and offer to restart into it.
3. Publishing starts the **Publish** workflow, which updates the Homebrew cask and opens a winget pull request, if those are set up.

Pre-releases (`v0.3.0-beta.1`) are built the same way but marked as pre-releases. GitHub never treats them as the latest release, so they are never offered as updates and never reach Homebrew or winget.

Every file of a release is named `k10s-<version>-<os>-<arch>`, so that the release page lists them by OS: `k10s-0.2.0-macos-arm64.dmg`, `k10s-0.2.0-windows-x64-setup.exe`, `k10s-0.2.0-linux-arm64.deb` and so on. The `<os>-<arch>` of a build is its `files` in `release.yml`; the Homebrew cask, the winget job, the README and the release notes count on these names. The update signatures are inside `latest.json`, not in `.sig` files of their own.

## One-time setup

### 1. The repository

- Settings → General: enable Issues; Discussions if you want them.
- Settings → Code security: enable **private vulnerability reporting** (SECURITY.md sends reports there), Dependabot alerts and security updates.
- Settings → Rules: protect `main` and require the **CI** checks and the **CLA** status before merging.
- The repository is `dumkin/k10s`. The Homebrew tap (`dumkin/homebrew-tap`) and the update feed of every release build follow from its name; the winget identifier, `dumkin.k10s`, is set in `publish.yml`. Moving the repository later works through GitHub's redirects, as long as no new repository takes the old name.

### 2. The update signing key (required)

Every update package is signed, and k10s installs only packages whose signature verifies against the public key built into it. Generate the pair once, on your own machine:

```bash
npm --prefix ui run tauri signer generate -- -w ~/.tauri/k10s.key
```

Pick a password when asked. Then, in the repository settings:

| Where | Name | Value |
| --- | --- | --- |
| Secrets → Actions | `TAURI_SIGNING_PRIVATE_KEY` | the contents of `~/.tauri/k10s.key` |
| Secrets → Actions | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | its password |
| Variables → Actions | `UPDATER_PUBKEY` | the contents of `~/.tauri/k10s.key.pub` |

**Back up the private key and its password** (a password manager and an offline copy). If they are lost, the copies of k10s already installed can never be updated again: their users would have to reinstall by hand.

`tauri.conf.json` sets `requireSignedVersion`: k10s installs an update only if its signature names the version `latest.json` announces. `tauri build` writes it into the signature; a file signed by hand needs `--app-version X.Y.Z`.

The release workflow stops at its first job without the `UPDATER_PUBKEY` variable or the `TAURI_SIGNING_PRIVATE_KEY` secret; without the password, the builds fail. Builds made anywhere else (`make build`, a distribution's package) have no update feed and don't update themselves.

### 3. The CLA

Nothing to do. The CLA workflow keeps signatures in `signatures/cla.json` on a branch of its own, `cla-signatures`, which it creates on the first signature. Leave that branch unprotected. The account that owns the repository never needs to sign. If that's an organization, put the maintainers' own logins in the repository variable `CLA_ALLOWLIST` (comma-separated), or they'll be asked to sign too.

### 4. Signing for macOS (optional, recommended)

Without it, macOS builds are signed ad hoc and not notarized. Users then confirm the first launch once: System Settings → Privacy & Security → **Open Anyway** (or `xattr -dr com.apple.quarantine /Applications/k10s.app`). With it, k10s opens like any other app.

You need a membership in the [Apple Developer Program](https://developer.apple.com/programs/) ($99 a year) and a **Developer ID Application** certificate. The certificate carries the legal name of whoever holds the membership, a person or an organization, and macOS shows it to users.

| Secret | Value |
| --- | --- |
| `APPLE_CERTIFICATE` | the certificate exported as `.p12`, in base64 on one line: `openssl base64 -A -in cert.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password of the `.p12` |
| `APPLE_SIGNING_IDENTITY` | e.g. `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | the Apple ID of the membership |
| `APPLE_PASSWORD` | an [app-specific password](https://support.apple.com/102654) for it |
| `APPLE_TEAM_ID` | the team ID |

The workflow passes each secret on only when it is set, so the build keeps working while some are missing.

### 5. Signing for Windows (optional)

Unsigned installers get the SmartScreen warning "Windows protected your PC": users click More info → **Run anyway**.

Signing has to happen inside the build, so that the update signatures cover the signed files. [Azure Artifact Signing](https://learn.microsoft.com/azure/artifact-signing/) (from about $10 a month; individuals must be in the US or Canada, organizations in more countries) plugs in through Tauri's `signCommand`:

- variable `WINDOWS_SIGN_COMMAND`: e.g. `artifact-signing-cli -e https://weu.codesigning.azure.net -a <account> -c <profile> -d k10s %1`;
- secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`.

The Release workflow installs `artifact-signing-cli` on the Windows runner when the variable is set.

[SignPath Foundation](https://signpath.org) signs open source projects for free, but not projects that also sell commercial licenses, and it signs after the build, so the update signatures would have to be made again, with `--app-version`.

### 6. Homebrew (optional)

1. Create a public repository `homebrew-tap` under the same owner.
2. Create a fine-grained token with **Contents: read and write** on that repository only, and save it as the secret `HOMEBREW_TAP_TOKEN`.

From the next published release on, the Publish workflow writes `Casks/k10s.rb` there (from `packaging/homebrew/k10s.rb`). Users install with `brew install --cask dumkin/tap/k10s`. Getting into the official homebrew/cask requires a notarized app and some popularity (75 stars, 30 forks or 30 watchers).

### 7. winget (optional)

1. Fork [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs) under the same owner.
2. Submit the first version by hand, once there is a published release: `wingetcreate new <URL of k10s-X.Y.Z-windows-x64-setup.exe>` (or `komac new`), with the identifier `dumkin.k10s`, publisher Danil Dumkin and moniker `k10s`.
3. Create a **classic** token with the `public_repo` scope (winget tooling doesn't take fine-grained ones) and save it as `WINGET_TOKEN`.

After that, every published release opens a pull request to winget-pkgs.

## Releasing a version

First bring the docs up to date with the version: the README and its Russian twin, the comparison table, screenshots (and their [JPEG copies](#linux-metadata)), the keyboard and architecture docs, and the release notes in `.github/release-notes.md`. With Claude Code, the `prepare-release` skill (`.claude/skills/prepare-release/SKILL.md`) walks through all of it. Either way, `node scripts/release-check.mjs 0.2.0` catches what can be checked mechanically: versions, the platform list, placeholders, release notes left from the previous release, README parity, the comparison table's date, the app size (with the license files releases carry: run `node scripts/third-party-notices.mjs` first), broken links, unused images, the screenshots of the Linux metadata, secrets and email addresses.

Then:

```bash
node scripts/version.mjs 0.2.0
git commit -am "chore: release v0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

If the files already have the version (as for the first release, 0.1.0), skip `version.mjs` and the commit.

`scripts/version.mjs` sets the version in `ui/package.json`, `ui/package-lock.json`, `Cargo.toml`, `Cargo.lock` and `crates/k10s-app/tauri.conf.json`, and adds it to the [Linux metadata](#linux-metadata); `--check` tells whether they agree.

Then watch the Release workflow, open the draft, check the notes and the files, and publish.

**When something fails:** re-run the failed jobs; the draft is reused, and the feed check runs again at the end. To start over, delete the draft release and the tag, fix, and tag again.

## Linux metadata

Linux software centers and the [AppImage catalog](https://appimage.github.io) take the name, summary, description, screenshots and releases of k10s from its AppStream metadata, `packaging/linux/io.dumkin.k10s.appdata.xml`. The deb, rpm and AppImage install it in `/usr/share/metainfo` (`bundle.linux` in `tauri.conf.json`), next to the desktop file Tauri makes, `k10s.desktop`.

- **Releases.** `version.mjs` puts each version on top of `<releases>`, dated the day it runs. A pre-release goes in as a development release and leaves when its version comes out: AppStream sorts `0.2.0-beta.1` above `0.2.0`. `version.mjs --check` fails while the newest release there isn't the version, and so does the Release workflow.
- **Screenshots.** The README's are lossless WebP of the mock UI (`npm --prefix ui run dev`) in WebKit at 1440×900, 2x; no PNG is kept, the WebP has the same pixels. AppStream takes only PNG and JPEG, so the metadata shows half-size JPEG copies, `docs/assets/*.jpg`. Their addresses name the version's tag (`…/dumkin/k10s/v0.2.0/docs/assets/…`), which `version.mjs` sets: a release shows its own screenshots, and they stay as they were when the README's change. When a README screenshot changes, make its copy again, without subsampling the colors of the text: `sips -Z 1440 -s format tga docs/assets/compare.webp --out /tmp/compare.tga && cjpeg -targa -quality 90 -sample 1x1 -optimize -progressive -outfile docs/assets/compare.jpg /tmp/compare.tga` (`cjpeg` from Homebrew's jpeg-turbo). `release-check.mjs` warns about a copy older than its screenshot.
- **The name.** `.appdata.xml` is the older of the two names AppStream reads; `.metainfo.xml` is the newer. The AppImage catalog takes the summary and the description only from an `.appdata.xml` file; from a `.metainfo.xml` one it would take just the screenshot and the license.
- **Checks.** CI validates the file with the `appstreamcli` of Ubuntu 22.04 and 24.04 (AppStream 0.15 and 1.0): a warning fails it. After the Linux builds, the Release workflow checks that each package carries the file, and validates it together with the desktop file Tauri made (`appstreamcli validate-tree`) and the desktop file itself (`desktop-file-validate`, which the AppImage catalog requires to pass).
- **The catalog** reads the file when it tests the AppImage of the latest release. After a release that changes it, comment `/retest` on k10s's pull request there.

## Third-party licenses

Release builds carry `LICENSE` and `THIRD-PARTY-NOTICES.md` (made by `scripts/third-party-notices.mjs`: every crate and npm package compiled into the app, with its license text). CI runs `cargo deny` with the list of licenses k10s may ship (`deny.toml`) and checks the npm packages the UI bundles against the same list.
