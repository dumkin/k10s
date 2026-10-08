# Architecture

k10s is a Rust engine with a thin desktop shell around it. The engine knows nothing about the UI. It watches clusters, renders table rows, merges log streams and runs actions. The UI, written in SolidJS, draws what the engine sends and asks it for everything else.

```
crates/k10s-core   the engine; no UI dependencies (a CLI, TUI or server could reuse it)
  engine.rs        the Engine, k10s-app's one entry point; its settings (read-only mode, how long
                   unused watches stay)
  kubeconfig.rs    contexts from KUBECONFIG or ~/.kube/config, a client configuration per context
  env.rs           PATH and friends from the login shell (apps started from Finder get a bare environment)
  cluster.rs       connections: lazy, deduplicated, independent of each other
  discovery.rs     API discovery: aggregated (2 requests per cluster), or the per-group walk on older
                   or restricted servers
  exec.rs          exec auth plugins run by k10s, not by kube: kube gets a ready token or certificate
  feed.rs          shared watch feeds ("informers"): rendered rows, object JSON while the feed is small,
                   deltas broadcast to subscribers
  watch.rs         the list and watch behind a feed, of objects or server-printed tables
  list.rs          lists in a few pages fetched at once, each parsed as it streams in
  object.rs        Obj, the lean object type: managedFields skipped while parsing, nesting capped
  view.rs          a view = a resource × N clusters × M namespaces → one stream of JSON batches
  render/          rows per resource kind (kubectl's logic), CRD columns (JSONPath) and
                   server-side printing (table.rs)
  logs.rs          merged, reconnecting log streams, one per container; reads of earlier history
  ops.rs           get and YAML (a list of one on 403), mutations behind the read-only guard,
                   the k10s::audit journal
  yaml.rs          kubectl-style YAML output
  term.rs          terminals: exec and attach over websockets, debug containers, node shells;
                   output flow control
  pf.rs            port-forwards: the listener, a stream per connection, picking a pod behind a
                   service or workload
  metrics.rs       metrics.k8s.io: shared polls with warm-up and ten minutes of history
  helm.rs          Helm releases read from their Secrets, details, revision diffs; rollback and
                   uninstall through helm
  access.rs        permissions: access reviews cached per connection (actions), rules reviews
                   per namespace (the matrix)
  relations.rs     the graph around an object, built on namespace feeds: owners, selectors, routes,
                   spec references, policies; live
  error.rs, redact.rs  errors whose text never carries credentials (kube's exec failures embed them)
  time.rs          RFC 3339 timestamps parsed without allocation
crates/k10s-app    the desktop shell (Tauri) and the IPC layer: commands and channels (commands.rs), the
                   updater (updates.rs), logging, settings and state (prefs.rs: settings.json and
                   state.json in the app's config folder), the window's color and zoom before the page
                   paints (appearance.rs), the frozen-UI watchdog (diag.rs)
ui/src             the SolidJS UI
  lib/backend      the Backend interface, with a Tauri implementation and a browser mock
  lib/logs         log handling without UI: levels and formats, the query language and its
                   completion, patterns, histogram, export
  lib/compare      object comparison without UI: field-level diff (list items matched by name),
                   side-by-side YAML, Myers
  state/           signals and stores: clusters, navigation, views, tables, commands; what they
                   keep between starts goes through lib/persist.ts to the app's two files
  registry/        extension points: resource catalog, column kinds, actions, details tabs
  components/      title bar, pickers, sidebar, table, details panel, dock, palette, settings
  details/         the Overview, Relations, Logs, Events, YAML and Compare (details/compare) tabs;
                   a Helm release's Release, Values, Manifest and History
  details/logs     the log viewer (details tab and dock): an entry buffer with incremental views,
                   earlier history loaded in place, field suggestions
```

## Data flow

list and `watch` (k10s's own, over kube-rs's client) → the `Feed` renders each object's row **in Rust** (for a resource k10s has no renderer for, the API server prints the cells) and, while the feed is small, keeps its compact JSON → `broadcast` → the `View` merges the feeds of all its clusters, coalesces changes (the last upsert wins, a delete cancels an upsert) and every 33 ms at most sends **one** JSON batch over a Tauri `Channel` → the UI applies the batch to plain `Map`s and bumps one version signal.

## Why it stays fast

- The UI receives table cells, not objects. A whole object comes on request: from the engine's memory, or, for large feeds (over 2,000 objects or 16 MB of JSON; 64 MB across all feeds), from the API server when its details open. Secrets keep JSON only for the ones open.
- Objects are parsed in one pass into a lean type instead of `DynamicObject` with `serde(flatten)`; `managedFields` are dropped right away. Nesting depth is capped, so one object with absurdly deep data can't sink a whole list.
- Initial lists come gzip-compressed: a first page of 500 objects (rows on screen after one round trip), then the rest in pages of about 16 MB of JSON, at least three, up to three at once — each asked for as soon as the page before it gives its continue token, which comes first in a page — and every page parsed as it streams in, one object at a time. 100,000 namespaces take about a second over a 50 ms link, where pages of 500 one after the other take 14, and memory stays flat whatever the size of the list. No request comes near the API server's one-minute limit, which a whole list in one request over a slow link can reach. Aggregated discovery takes 2 requests per cluster instead of hundreds when CRDs are installed.
- Feeds are shared and stay warm after you leave a view, 3 minutes by default (Settings → Clusters), so going back is instant, with no new list. Feeds for one object's details (its events, a deployment's pods) stay for 15 seconds. At most 1,000 idle feeds and 128 MB are kept.
- Details open watches, log streams and requests only once the selection stops moving (180 ms): holding `j` doesn't open anything on the way.
- The table is virtualized and reuses row DOM nodes; sort keys are cached per immutable row; one ticking signal drives every "Age" cell.
- A dragged panel edge (the sidebar's, the details', the dock's, a column's) sets its size at most once a frame: WebKit lays the window out again before each mouse event that follows a change, and a mouse sends several a frame. What changes on every frame reaches only the elements that need it: the sidebar's width goes to the window's grid, not into a custom property every element would inherit, and size queries measure the header, toolbar or tab strip they restyle, as WebKit restyles everything inside a query container whenever it resizes. A terminal takes new columns once its width has stayed for 100 ms: each change reflows its scrollback and has the shell draw its screen again.
- Deltas travel in batches rather than as a message per event. A subscriber that falls behind gets an adaptive snapshot, and a big snapshot is split into parts (up to 5,000 rows or 2 MB) so the UI never parses tens of megabytes of JSON at once.
- k10s runs exec auth plugins (`aws`, `kubelogin`, `gke-gcloud-auth-plugin`…) itself: once per connection, at most 8 at a time, and the first one after a pause alone, so you get one SSO window instead of one per cluster. Each run has a timeout. kube receives a ready token and never runs the plugin itself, where it would do so inside requests, with no limit or timeout.
- A busy log (over 100 lines a second) comes four times a second, a quieter one 50 ms after a line. The log view draws at most ten times a second, and further apart the more the last drawing cost, and only the lines that reach the screen: while it follows new lines, those that come and go between two drawings are never drawn. A row draws the beginning of its line, as far as the screen's right edge reaches and a margin on, so a stream of 7 KB JSON lines lays out a few hundred characters a row, not all of them; the content stays as wide as the widest line, and never gets narrower under the screen. What it counts (levels, the histogram, patterns) is counted again at most four times a second as lines come, and only when those lines changed; a hidden histogram is not counted at all. The histogram's bars keep their width, the newest on the right: it counts again when the lines or its step change, not as the strip is resized or the pointer comes and goes, and at most 4,096 bars. A dock tab that is not shown draws nothing and takes its lines in once a second.
- One place decides where the log view is: at the bottom while it follows, else at the line it holds on to. Lines merged in or dropped above the screen do not move what is read, and the rows on screen are not drawn again for them. A wheel up stops following before the next lines arrive, new lines wait while the user scrolls what they read or selects text, and the lines being read (or paused on) are not dropped until the buffer holds one and a half times its budget.
- Pickers are virtualized. Namespaces reach the UI as names only, and only when the set changes: tens of thousands of namespaces across a fleet cost the UI nothing while their labels and statuses churn.
- Tables recompute adaptively: the more the last recompute cost, the longer until the next one, and tables of 5,000 rows or more at most four times a second. A storm of updates can't take over the main thread; clicks and scrolling stay responsive.
- Release builds use `lto = "fat"` and `codegen-units = 1`; dev builds compile dependencies with `opt-level = 2`.

## Extending k10s

| To add | Where |
| --- | --- |
| Columns for a resource kind | `crates/k10s-core/src/render/*.rs`: `fn(&Value) -> (Vec<Cell>, Tone)` plus `register` |
| A new cell type | `ui/src/registry/columns.ts` → `registerColumnKind` |
| A column computed in the UI (metrics, cross-cluster drift) | `ui/src/registry/columns.ts` → `registerExtraColumns` |
| A dock pane (next to terminals) | `ui/src/components/Dock.tsx` → `registerDockPane` |
| A sidebar section or item | `ui/src/registry/catalog.ts` (CRDs appear on their own) |
| An action on objects | `ui/src/registry/actions.ts` → `registerAction`, plus a command in `crates/k10s-app/src/commands.rs` |
| A details tab | `ui/src/registry/details.ts` → `registerDetailTab` |
| A palette command | `ui/src/state/commands.ts` → `registerCommands` |

A new engine command goes: a method on `k10s_core::Engine` → a `#[tauri::command] async fn` in `crates/k10s-app/src/commands.rs`, listed in `generate_handler!` in `crates/k10s-app/src/lib.rs` → a method on the `Backend` interface (`ui/src/lib/backend`) with its Tauri and mock implementations.
