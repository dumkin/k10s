## What's new

<!-- Written for each release by the prepare-release skill (.claude/skills/prepare-release): New, Improved, Fixed, Notes. -->

The first release of k10s: one window for many Kubernetes clusters at once, on macOS, Windows and Linux.

### New

- **Many clusters in one table**: any number of contexts, live, with a cluster column and a status strip; clusters named as zones of one family (`prod-eu-z1`…`z3`) fold into one group.
- **Works without cluster-admin**: namespaces that worked are remembered, an action you can't take is grayed out with the reason, and **My permissions** (`:can`) shows every verb in every cluster.
- **Compare** (`=`): an object against its copies in every cluster, only the fields that differ.
- **Needs attention**: what is failing in all the selected clusters, one row per problem, with where it happens.
- **Logs** of pods and whole workloads across clusters, merged by time, with a query language, JSON tables, patterns and trace following.
- **Shells, attach, debug containers and node shells** in tabs that stay open while you work elsewhere; **port-forwards** that survive reloads, sleep and network changes.
- **Read-only mode** enforced by the engine on every request; confirmations list every object with its cluster.
- **Helm** releases read from the cluster: values, manifest, history, diffs, rollback and uninstall.
- **Metrics** from metrics-server, a command palette (⌘K), k9s-style commands (`:po`, `:ns`, `:ctx`), and every shortcut on screen while you hold ⌘ (Ctrl on Windows and Linux).
- **Settings** (⌘,) in a window, and in `settings.json`, which you can edit by hand.
- **Updates** built in: k10s checks GitHub Releases, verifies each update against the project's signing key, and offers to restart into it.

### Notes

- The apps aren't notarized by Apple or signed for Windows. The first time, macOS asks you to allow k10s in **System Settings → Privacy & Security**, and Windows SmartScreen needs **More info → Run anyway**.
- k10s doesn't edit or apply YAML: the README's "Limitations and gaps" lists what it doesn't do.

### Install

| | |
| --- | --- |
| macOS | `k10s_<version>_aarch64.dmg` (Apple silicon) |
| Windows | `k10s_<version>_x64-setup.exe`, or the `.msi` |
| Linux | `.AppImage`, `.deb` or `.rpm`: `amd64`/`x86_64` for Intel and AMD, `arm64`/`aarch64` for Arm |

Already using k10s? It updates itself: restart it when the status bar says the update is ready.
