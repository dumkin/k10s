<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="branding/k10s-lockup-light.svg">
    <img src="branding/k10s-lockup.svg" alt="k10s" width="300">
  </picture>
</p>

<p align="center">
  <b>A fast desktop client for fleets of Kubernetes clusters.</b><br>
  Every cluster in one live table. Made for people without cluster-admin. Driven from the keyboard.
</p>

<p align="center">
  <a href="../../releases/latest"><b>Download</b></a> &nbsp;·&nbsp;
  <a href="#install">Install</a> &nbsp;·&nbsp;
  <a href="docs/keyboard.md">Keyboard</a> &nbsp;·&nbsp;
  <a href="#how-it-compares">How it compares</a> &nbsp;·&nbsp;
  <a href="README.ru.md">По-русски</a>
</p>

<p align="center">
  <a href="../../actions/workflows/ci.yml"><img alt="CI" src="../../actions/workflows/ci.yml/badge.svg"></a>
  <a href="../../releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/dumkin/k10s?label=release&color=2f6f4e"></a>
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/license-AGPL--3.0-2f6f4e"></a>
  <img alt="macOS, Windows and Linux" src="https://img.shields.io/badge/platforms-macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-555">
</p>

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/hero-light.webp">
  <img alt="k10s showing the deployments of four clusters in one table, next to the merged logs of one deployment" src="docs/assets/hero-dark.webp">
</picture>

k10s is for people who look after many clusters at once: the zones of one data center, regions, staging and production. Often they can see only a few namespaces in each. k10s puts all of those clusters in one table, checks your permissions before you act, and stays fast when the fleet is large.

It's free and open source. No account, no telemetry, no license server.

## Why k10s

### Built for a fleet, not for one cluster

Pick any number of contexts, and their objects land in one live table with a cluster column and a status strip on top. Clusters connect in parallel and independently, so a slow or broken one never holds the rest back. Contexts that differ only by a zone, like `prod-eu-z1`, `prod-eu-z2` and `prod-eu-z3`, fold into one group you select with a click. Columns are merged by name across clusters: an operator that is newer in one zone doesn't shift the table. You get one SSO prompt for all of them, tokens are renewed before they expire, and watches restart by themselves after sleep or a network change.

### Works without cluster-admin

Most clients assume you can list everything. k10s assumes you can't. If you can't list namespaces, you get a prompt instead of a wall of 403 errors. It starts from the namespace in your kubeconfig, remembers the ones that worked for each cluster and each zone group, and never retries a forbidden watch. If you can't read a CRD, the API server prints its columns instead.

Before any action, k10s asks each cluster whether you may take it. An action you can't take is grayed out with the reason: *you may not patch deployments in payments on z3*. With rows marked in several clusters, it acts where it's allowed and tells you where it isn't. **My permissions** (`:can`) shows every resource and verb, with a square for each cluster.

### Drift between clusters, found in seconds

Press `=` on any object, and k10s compares it with the objects of the same name in every cluster of the table. Only the fields that differ are shown, one column per cluster, so the zone that drifted stands out. Containers, environment variables, ports and volumes are matched by name, so one inserted item doesn't make everything after it look changed. The status and the fields that always differ between copies (uid, resourceVersion, managedFields…) stay out of the way until you ask for them. Secret values stay hidden, but you still see that they differ. Pin any object with `+` to compare across namespaces, kinds, or clusters outside the table. Helm releases have their own column for chart versions that differ between zones.

### What's broken, everywhere, on one screen

**Needs attention** lists what is failing in all the selected clusters: crash-looping and stuck pods, stalled rollouts, failed jobs, NotReady nodes, pending volumes, autoscalers at their limit, failed Helm releases, certificates and Argo CD applications that aren't ready, recent warning events. The same problem in several clusters is one row, marked **only in z2** when something is wrong with that zone, or **all 4 zones** when something is wrong with the release. The engine sends only what is unhealthy, so thousands of healthy pods cost the UI nothing.

### Logs that answer questions

Stream a pod, a whole deployment, or any marked pods and workloads across clusters, merged by time. The query language completes as you type: words, `"phrases"`, `!exclusions`, `/regex/`, and JSON or logfmt fields such as `status>=500`, `level>=warn` or `user=bob`. JSON logs turn into a table, and clicking a `trace_id` follows that request through every pod and cluster. **Patterns** group lines by their template and break each one down by cluster, so an error that only happens in z2 gives itself away. Crashes, OOM kills and restarts are marked in the stream. Scroll up and earlier history loads in place. A log keeps 100,000 lines in memory, and 3,000 lines a second from 16 pods in four clusters scroll without dropped frames.

### Sessions that survive a workday

Shells, attach, debug containers and node shells run over the API connection, without kubectl, in tabs that stay open while you work elsewhere. Port-forwards live in the engine. They survive a reload of the UI, token renewals, sleep and network changes, and when their pod is replaced they move to another ready one. Exec auth plugins (`aws`, `gke-gcloud-auth-plugin`, `kubelogin`) run once per cluster, with a timeout. On macOS and Linux, your `PATH` and `KUBECONFIG` come from your login shell even when k10s starts from the Dock or an app launcher.

### Safe by construction

Read-only mode is enforced by the engine on every request that would change a cluster, and on shells and attach; graying out buttons is only how it shows. In the app, turning it off takes a native confirmation that nothing inside the app's web view can click; outside it, `"readOnly": false` in `settings.json` does it. While k10s can't read that file, it stays read-only. Confirmations list every object with its cluster. Bulk changes, changes in several clusters at once, and dangerous kinds (namespaces, CRDs, nodes, volumes) need you to type what you're doing. Changes are sent with the object's uid, so they can't hit a recreated namesake, and they are never retried. Each one is written to a local audit log. And k10s never guesses which cluster is production from its name: every change is treated with the same care.

### Small and fast at fleet scale

Rows are rendered in Rust, and the UI gets them in batches, at most every 33 ms. Tables, pickers and logs are virtualized, and watches are shared between views and stay warm for three minutes by default, so going back is instant. k10s uses the system's web view instead of bundling a browser: the download is about 10 MB, and the installed app takes 19 MB. With 10,000 pods on screen it takes about 210 MB of memory and about 1% of a CPU core; Aptakube takes 1.1 GB, Freelens 715 MB and k9s 1.4 GB for the same table. A big list comes in a few pages fetched at once and read as they stream in: 100,000 namespaces in about a second, with 9 requests to the API server. See [Benchmarks](#benchmarks).

### Keyboard first, with k9s habits

`:po`, `:deploy payments`, `:ns kube-system` and `:ctx prod` work as in k9s, `1`–`9` switch between favorite namespaces and `0` shows all of them, and `?` opens the cheat sheet. Hold ⌘ (Ctrl on Linux and Windows) and every shortcut that works right now appears on screen. Shortcuts work in non-Latin keyboard layouts too.

<table>
  <tr>
    <td width="50%"><img alt="The Compare tab: one deployment against its copies in four clusters" src="docs/assets/compare.webp"></td>
    <td width="50%"><img alt="Needs attention: failing workloads across four clusters" src="docs/assets/attention.webp"></td>
  </tr>
  <tr>
    <td><b>Compare</b>: z2 runs a release candidate and has one replica ready; the other zones agree.</td>
    <td><b>Needs attention</b>: one row per problem, with where it happens.</td>
  </tr>
  <tr>
    <td><img alt="The relations graph of a deployment" src="docs/assets/relations.webp"></td>
    <td><img alt="My permissions: verbs per resource in four clusters" src="docs/assets/permissions.webp"></td>
  </tr>
  <tr>
    <td><b>Relations</b>: from the ingress to the pods, and what is missing.</td>
    <td><b>My permissions</b>: what you may do, in each cluster.</td>
  </tr>
</table>

## Everything else you'd expect

- **Every resource, CRDs included**: live tables with kubectl's columns and the CRDs' own; sorting; filtering by text and by labels, as with `kubectl -l` (`app=web`, `tier!=db`); columns you can resize and hide.
- **Details**: an Overview with containers, their environment resolved to values and sources, probes in plain words, volumes and scheduling; YAML with search; live events; a relations graph from the ingress down to the volumes; a full-screen view.
- **Actions**: restart, scale, delete (with force), cordon and uncordon, suspend and resume, trigger a CronJob, copy names. On one row or on many.
- **Logs and port-forwards** for pods, services and whole workloads; **shells, attach and debug containers** for pods; **node shells**.
- **Helm**: the releases of every selected cluster, read straight from the cluster with no helm needed; values, manifest, history and a diff of any two revisions; rollback and uninstall through your `helm`.
- **Metrics** from metrics-server: CPU and memory columns, usage against requests and limits, a 10-minute chart for each pod and node.
- **A command palette** (⌘K) for resources, clusters, namespaces and actions.
- **Any kubeconfig**: exec plugins, OIDC, client certificates, tokens, HTTP and SOCKS proxies.
- **Dark, light or system theme**, and zoom for the whole interface.
- **Settings** (⌘,) in one window, and in one file you can edit by hand: `settings.json`.
- **macOS, Windows and Linux**: Macs with Apple silicon, Windows on x64, Linux on x64 and Arm. Updates are built in.

## Limitations and gaps

What k10s can't do, or does only in part, so that you know before you install it:

| | |
| --- | --- |
| **Editing** | No editing, applying or creating from YAML: use kubectl for that. |
| **Rollouts** | No rollback of Deployments (Helm rollback works), no `set image`, no drain. |
| **Customization** | `settings.json` holds what the Settings window offers, no more: no custom actions or plugins, key remapping, aliases or JSONPath columns. |
| **Kubeconfig** | Reads `KUBECONFIG` or `~/.kube/config`; folders of kubeconfigs aren't scanned. |
| **Namespaces** | A view watches at most 100 picked namespaces of a cluster, and 1,000 cluster–namespace pairs in all; the rest say they aren't watched. All namespaces counts as one. |
| **Custom resources** | Shown as tables with their printer columns. No dedicated screens for Argo CD, Flux or cert-manager. |
| **Metrics** | metrics-server only, with 10 minutes of history. No Prometheus charts. |
| **Helm** | No install or upgrade. Releases are read from Secrets, Helm's default storage: without access to Secrets, or with the ConfigMap or SQL driver, they don't show. |
| **Windows** | One window: no split views, no tabs you can pull out. |
| **AI** | No assistant and no MCP server. |
| **Search** | The palette goes to resources, clusters, namespaces and actions, but not to an object by name. |
| **Old PKI** | Clusters that serve X.509 v1 certificates will likely fail: the TLS library k10s uses, rustls, rejects them. |
| **Platforms** | No builds for Intel Macs. k10s is developed and used mostly on macOS; the Linux and Windows builds see less real-world use. Releases aren't notarized by Apple or signed for Windows, so macOS and Windows ask for confirmation before the first launch ([Install](#install)). |

## How it compares

Five popular Kubernetes clients, side by side. Checked on 2026-10-04 against each project's releases, documentation and source code. If something here is wrong or out of date, please [open an issue](../../issues/new/choose).

| | **k10s** | **k9s** | **Lens** | **Freelens** | **Headlamp** | **Aptakube** |
| --- | --- | --- | --- | --- | --- | --- |
| **Interface** | Desktop (Tauri, Rust) | Terminal (Go) | Desktop (Electron) | Desktop (Electron) | Desktop (Electron), or a web app in the cluster | Desktop (Tauri, Rust) |
| **Price** | Free | Free | Free for companies under $10M in revenue or funding; then $25–60 per user a month | Free | Free | $79 a year; teams $59 per user a year |
| **Source** | AGPL-3.0 | Apache-2.0 | Closed | MIT | Apache-2.0 | Closed |
| **Account** | None | None | Lens ID required | None | None | License key |
| **Telemetry** | None¹ | None¹ | On by default | None¹ | None¹ | App version, OS, device ID and name on license and update checks |
| **Download, macOS on Apple silicon** | ~10 MB | 39 MB | 253 MB | 200 MB | 144 MB | 33 MB |
| **Installed, macOS** | 19 MB | 127 MB | 790 MB | 604 MB | 371 MB | 53 MB |
| **Several clusters in one table** | ✓ | – | – | – | ✓ | ✓ |
| **Without the right to list namespaces** | Asks; remembered per cluster and zone group | Type it; remembered per context | List them in the cluster's settings | List them in the cluster's settings | List them in the cluster's settings | Type it; only the last one is kept |
| **Read-only mode** | ✓ enforced by the engine | ✓ | – | – | – | – |
| **Checks permissions before actions** | ✓ shows why, per cluster | – | Hides what you can't list | Hides what you can't list | ✓ hides what you can't do | Port-forward only |
| **Object comparison** | ✓ any number, across clusters | – | – | – | – | ✓ two, across clusters |
| **Logs of a whole workload** | ✓ | ✓ | ✓ | – | ✓ | ✓ |
| **Logs across clusters** | ✓ | – | – | – | – | Not verified |
| **Structured logs** | JSON and logfmt fields as columns, patterns, queries | Plugin | Formatting | – | Formatting | Highlighting, level filter |
| **Shell, attach, debug containers** | Built in | Through kubectl | Through kubectl; no debug containers | Through kubectl; no debug containers | Built in | Through kubectl |
| **Port-forward** | Built in; moves to a new pod | Built in | Through kubectl | Through kubectl | Built in | Built in |
| **Helm** | View, diff revisions, rollback, uninstall; drift across clusters | View, rollback, uninstall | + install, upgrade | + install, upgrade | + install, upgrade | + upgrade |
| **Metrics** | metrics-server | metrics-server | Prometheus, metrics-server | metrics-server, Prometheus | metrics-server, Prometheus plugin | metrics-server |
| **Edit and apply YAML** | – | Through kubectl | ✓ | ✓ | ✓ with dry run | ✓ |
| **Plugins** | – | ✓ | – | ✓ | ✓ | – |
| **AI** | – | Plugin | Paid plans | Extension | Plugin | – |
| **Updates itself** | ✓ | – | ✓ | – | Notifies | ✓ |
| **Signed and notarized** | No | No | Yes | Yes | macOS only | Yes |

¹ The open source clients ask GitHub or npm for their latest version; k10s does it to update itself, and you can turn it off.

## Benchmarks

<img alt="Bar charts for k10s, Aptakube, Headlamp, Freelens and k9s, one bar per Mac: time to a table of 10,000 pods, memory, CPU while pods change, data downloaded, memory with five clusters and with 50,000 pods, time to 100,000 namespaces, CPU while following a log" src="docs/assets/bench.svg">

k10s and four other clients, on the same local clusters and with nobody at the Mac: the latest version of each with its default settings, the median of 5 to 9 runs; lower is better everywhere. How it's measured, every number, and how to repeat it on your own Mac: [k10s-bench](../../../k10s-bench).

## Install

### macOS

```bash
brew install --cask dumkin/tap/k10s
```

Or download the `.dmg` from [Releases](../../releases/latest). k10s runs on Macs with Apple silicon (M1 and later); Intel Macs aren't supported.

<details>
<summary>macOS says it can't open k10s</summary>

Releases aren't notarized by Apple. Open **System Settings → Privacy & Security**, scroll down to the message about k10s and click **Open Anyway**. You only do this once. From a terminal, `xattr -dr com.apple.quarantine /Applications/k10s.app` does the same.

</details>

### Windows

```powershell
winget install Dumkin.k10s
```

Or download `k10s_<version>_x64-setup.exe` (or the `.msi`) from [Releases](../../releases/latest). The installer isn't code-signed: if SmartScreen says "Windows protected your PC", click **More info → Run anyway**.

### Linux

Download a package from [Releases](../../releases/latest), for x86_64 or Arm:

```bash
sudo apt install ./k10s_*_amd64.deb         # Debian, Ubuntu
sudo dnf install ./k10s-*.x86_64.rpm        # Fedora, RHEL
chmod +x k10s_*_amd64.AppImage && ./k10s_*_amd64.AppImage
```

On Arm, take the `_arm64.deb`, `.aarch64.rpm` or `_aarch64.AppImage`.

k10s needs WebKitGTK 4.1 and glibc 2.35 or newer: Ubuntu 22.04, Debian 12, Fedora 36 and later.

### Updates

k10s checks GitHub Releases when it starts and every six hours, but a start within six hours of an automatic check that found nothing doesn't check again. A new version downloads in the background and is verified against the project's signing key, and then k10s offers to restart into it. ⌘K → **Check for updates** checks right away. To turn the automatic checks off: Settings (⌘,) → **Updates** → **Check automatically**, or `"autoUpdate": false` in `settings.json`. Builds made from source don't update themselves.

### From source

You need Rust and Node.js; [CONTRIBUTING.md](CONTRIBUTING.md) has the details. Then `make dev` runs the app with hot reload, and `make build` builds the installers.

## Getting started

1. k10s reads your kubeconfig from `KUBECONFIG` or `~/.kube/config` and opens your current context. Other clusters connect only when you pick them.
2. Pick clusters with ⌘⇧C. Contexts that differ only by a zone show up as one group, and ★ saves any set of clusters.
3. Pick namespaces with ⌘⇧N, or type one in if you aren't allowed to list them.
4. Press `?` for every shortcut, or hold ⌘ to see them on screen.

| Keys | |
| --- | --- |
| ⌘K, `:` | command palette, k9s-style commands |
| ⌘⇧C, ⌘⇧N | clusters, namespaces |
| `j` `k`, `/`, `↵` | move, filter, open details |
| `d` `r` `l` `e` `y` `=` | Overview, Relations, Logs, Events, YAML, Compare |
| `Space`, then `l` or `=` | mark rows, then see their logs together or compare them |
| `s`, `a`, `⇧F` | shell, attach, port-forward |
| `⇧R`, `⇧S`, `⌃D` | restart, scale, delete |
| ⌘J | the dock with terminals, port-forwards and logs |
| ⌘, | settings |

On Linux and Windows, ⌘ is Ctrl. All the shortcuts: [docs/keyboard.md](docs/keyboard.md).

## Privacy

k10s connects to your clusters' API servers, with the credentials in your kubeconfig, and runs the exec plugins your kubeconfig names. Apart from that, it talks only to GitHub, to check for updates and download them, unless you turn that off. On macOS and Linux it also starts your login shell once, to read `PATH` and `KUBECONFIG`, and Helm rollback and uninstall run your `helm`. There is no account, no analytics and no crash reporting.

Its logs stay on your machine (⌘K → **Open log folder**). They include the `k10s::audit` journal: every change made through k10s, where it was made and how it ended. Object data never goes into it.

## FAQ

**Does it need kubectl?**
No. Only Helm rollback and uninstall call your `helm`.

**Does it work with EKS, GKE, AKS, OpenShift, k3s…?**
With anything your kubeconfig reaches: exec plugins such as `aws`, `gke-gcloud-auth-plugin` and `kubelogin`, OIDC, client certificates, tokens, HTTP and SOCKS proxies.

**Can I use it at work?**
Yes, for anything. The AGPL asks something of you only if you distribute a modified k10s, or let other people use a modified version over a network: then you share your changes under the same license.

**Where are the logs?**
On macOS in `~/Library/Logs/io.dumkin.k10s/`, on Linux in `~/.local/share/io.dumkin.k10s/logs/`, on Windows in `%LOCALAPPDATA%\io.dumkin.k10s\logs\`.

**Where are the settings?**
⌘, opens them. They're kept in one file, `settings.json`: on macOS in `~/Library/Application Support/io.dumkin.k10s/`, on Linux in `~/.config/io.dumkin.k10s/`, on Windows in `%APPDATA%\io.dumkin.k10s\`. You can edit it by hand (⌘K → **Open settings.json**): k10s takes the changes when its window gets the focus back. If it can't read the file, it leaves it as it is and runs on the defaults, in read-only mode, until you fix it. What k10s remembers by itself (the clusters you picked, column widths…) is in `state.json` next to it.

## Contributing

Bug reports and ideas are welcome in [issues](../../issues/new/choose), and pull requests too. [CONTRIBUTING.md](CONTRIBUTING.md) explains how to set up, test, and find your way around the code; [docs/architecture.md](docs/architecture.md) shows how the engine and the UI fit together. Contributors sign the [CLA](CLA.md) once, with a comment on their first pull request. Please report security problems privately: [SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Danil Dumkin.

k10s is free software, licensed under the [GNU Affero General Public License v3.0](LICENSE). Release builds include the licenses of the third-party code they contain.
