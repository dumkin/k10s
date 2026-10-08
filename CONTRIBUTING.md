# Contributing to k10s

Thanks for considering it. Bug reports, ideas and pull requests are all welcome. Some notes to save us both time:

- **Bugs and ideas** go into [issues](../../issues/new/choose); the forms ask for what's needed to act on them.
- **Small fixes** (a typo, an obvious bug, a missing column) can go straight to a pull request.
- **Anything bigger**: open an issue first and describe the approach. A new screen or a change in how something behaves is easier to agree on before the code exists.
- **Security problems**: never in public. See [SECURITY.md](SECURITY.md).

## The CLA

Contributions are accepted under the [Contributor License Agreement](CLA.md). On your first pull request a bot asks you to sign it with one comment. You keep the copyright in your work; the project gets the right to use it in any way, including under licenses other than the AGPL. The last paragraph of the CLA explains why.

## Setting up

You need:

- **Rust**, stable (1.90 or newer): [rustup.rs](https://rustup.rs);
- **Node.js** 24.15 or newer in the 24 line (what CI uses; `.nvmrc` says so), or 22.22.2 or newer in the 22 line;
- the platform's build tools:
  - macOS: Xcode Command Line Tools (`xcode-select --install`);
  - Windows: [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) and WebView2 (already on Windows 10 and 11);
  - Linux (Debian/Ubuntu): `sudo apt install build-essential libwebkit2gtk-4.1-dev libxdo-dev librsvg2-dev patchelf xdg-utils`. Other distributions: [Tauri's list](https://v2.tauri.app/start/prerequisites/#linux).

npm dependencies install by themselves on the first `make` run, from the public registry.npmjs.org (set in `ui/.npmrc`).

| Command | What it does |
| --- | --- |
| `make dev` | the app with hot reload: Vite reloads the UI, Rust rebuilds on change |
| `cd ui && npm run dev` | the UI alone in a browser, on mock data: 12 simulated clusters with live updates and strict RBAC on `acme-prod-db-*` |
| `make build` | release build of every bundle into `target/release/bundle` |
| `make install` | macOS: build the `.app` and copy it to `/Applications` (another folder: `make install INSTALL_DIR=~/Applications`) |
| `make clean` | remove `target/`, `ui/node_modules/`, `ui/dist/` and other build output |

Any page opened outside the desktop app runs on the mock. It takes a few URL parameters: `http://localhost:1420/?ns=8000` adds about 8,000 namespaces to each app cluster, mostly the same ones, and keeps some of them changing (a load test; at most 50,000); `?wide` adds a zone group of eight data centers with names of different lengths (a layout test); `?kubeconfig=nocurrent`, `missing`, `empty` or `invalid` shows the first-run screens; `?update` finds a newer release, downloads it and reloads to "install" it. `localStorage["k10s:mock.logRate"]` sets the log lines per container per second (a log load test), `k10s:mock.logAudit` (0 to 1) makes that share of the lines kilobyte-long JSON records without a level (a test of huge lines), and `k10s:mock.logLag` delays every third container's lines by that many milliseconds (late pods in Sources).

To try the real app without touching your clusters, keep `make dev` running and start a second copy with an empty kubeconfig: `KUBECONFIG=/path/to/empty-file target/debug/k10s`. A debug build loads its UI from the dev server on port 1420, and it shares `settings.json` and `state.json` with an installed k10s.

## Before you push

CI runs these on every pull request (the Rust tests on Linux and macOS; Windows builds and lints). Running them locally saves a round trip:

```bash
cd ui && npm run lint && npm run typecheck && npm test
```

```bash
cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings && cargo test --workspace
```

## Code

- The engine is in `crates/k10s-core`, the desktop app around it (Tauri) in `crates/k10s-app`, the UI in `ui`. [docs/architecture.md](docs/architecture.md) explains how they fit together, why it is fast, and where to plug new things in.
- Rust is formatted by `rustfmt` with wide lines (see `rustfmt.toml`) and must be clippy-clean. TypeScript is linted by `oxlint` and type-checked strictly.
- Comments say why, not what. Match the code around you.
- The engine owns the state that matters (read-only mode, how long unused watches stay, port-forwards); the UI mirrors it. The UI's own settings go through `ui/src/lib/persist.ts` to `settings.json`. Anything that changes a cluster goes through the engine's read-only guard.
- Every feature has to work with more than one cluster and with namespace-restricted RBAC. The mock simulates both.
- UI: every control is reachable from the keyboard, works in both themes, and doesn't move the layout while loading (k10s shows loading as a thin line under a header, not a spinner that pushes things around).
- Examples, fixtures and screenshots use neutral names: `prod-eu-z1…z3`, `acme-*`, `registry.example.com`. Never real cluster names, hosts or credentials.

## Debugging

**Logs** go to `~/Library/Logs/io.dumkin.k10s/k10s.log` on macOS, `~/.local/share/io.dumkin.k10s/logs/` on Linux and `%LOCALAPPDATA%\io.dumkin.k10s\logs\` on Windows; ⌘K → "Open log folder" opens the folder. They use local time and log the engine and the UI at debug level, kube, hyper, tower and rustls at warn, other libraries at info. Files rotate at 10 MB, and five old ones are kept (`k10s.1.log` is the most recent). `make dev` prints info level to the terminal.

`K10S_LOG` (tracing syntax, e.g. `K10S_LOG=debug,kube=info`) overrides both, except for two things. The change journal `k10s::audit` (what was changed, where, and how it ended, never object data) is always written. Response bodies that kube-client couldn't parse are written only if `K10S_LOG` names `kube_client` explicitly.

**UI freezes** land in the log by themselves:

- `UI is not responding: no heartbeat for 5s · app main thread: … · engine: … · IPC: …` is written even if the UI never recovers. It tells whether the app's main thread is alive and how much data went to the UI recently, per subscription.
- `UI main thread was blocked for 8.0s. Recent: …` comes after the UI recovers, with the last things that happened (a picker opened, namespaces changed, slow table updates).
- Frontend errors (`k10s::ui`) come with the stack and the recent actions.

**DevTools** (the WebKit Web Inspector on macOS) are available in release builds too: ⌘⌥I on macOS, right click → Inspect Element (except on table rows, which have their own menu), or ⌘K → "Toggle developer tools". To catch a JavaScript hang, open the inspector first; when the UI freezes, pause in Sources to see where it spins.

**Settings and state** are two JSON files in the app's config folder (on macOS `~/Library/Application Support/io.dumkin.k10s/`): `settings.json`, what the user sets (Settings, ⌘,), made to be edited by hand and taken again when the window gets the focus back; and `state.json`, what k10s remembers by itself (clusters, namespaces, column widths…). `crates/k10s-app/src/prefs.rs` owns both; the UI reads them at start and sends its changes (`ui/src/lib/persist.ts`: `setting()` for the first, `persisted()` for the second). Values are validated when read: one of the wrong shape is replaced with its default. If the app still fails to start, it shows the error with Reload and Reset preferences buttons. Resetting forgets the settings and the state; your kubeconfig and read-only mode are left alone. The mock UI keeps both files in the browser's `localStorage["k10s:mock.files"]`.

## Releases

Maintainers: [docs/releasing.md](docs/releasing.md) covers versioning, the release workflow, update signing and package managers.
