# Keyboard

Everything in k10s is reachable from the keyboard. Press `?` in the app for a searchable cheat sheet. **Hold ⌘** (Ctrl on Linux and Windows) for half a second and every key that works right now is written on the screen: on buttons, sidebar items, cluster chips, and the namespace digits at the bottom. Single-key shortcuts work when no text field has the focus; `Esc` leaves a field.

On Linux and Windows, `⌘` is `Ctrl` (so `⌃D` is also `Ctrl+D`), `⌥` is `Alt`, and back/forward are `Alt+←` / `Alt+→`. Shortcuts work in non-Latin keyboard layouts too: letters and `/` `:` `[` `]` are taken by key position, as on a US keyboard.

## Everywhere

| Keys | |
| --- | --- |
| `⌘K` (`⌘P`) / `:` | command palette / k9s-style commands (`:po`, `:deploy payments`, `:ns kube-system`, `:ctx prod`) |
| `⌘⇧C` / `⌘⇧N` | cluster picker / namespace picker |
| `⌘1` … `⌘9` | sidebar items, top to bottom (collapsed sections and the filter change the numbering) |
| `?` | the in-app cheat sheet, searchable ("logs", "⌘K"…) |
| `⌘,` | settings (`↑` `↓` move between its sections) |
| `F6` / `⇧F6` | next / previous area of the window: sidebar, table, details, dock |
| `⌘=` `⌘−` / `⌘0` | zoom the interface / back to 100% (the window opens at it next time) |
| `⌘[` / `⌘]`, mouse back/forward | back / forward through where you've been (resource, namespaces, filter, selected row, details) |
| `⌘↵` / `Esc` | confirm / cancel a dialog (dialogs open with focus on Cancel; `Tab` cycles inside them) |
| `Esc` | one step back: leave full-screen details, close details, clear marks, clear the filter, close the newest notification |

## Tables

| Keys | |
| --- | --- |
| `j` `k` `↑` `↓` `g` `G` `PgUp` `PgDn` | move |
| `/`, `⌘F` | filter (`Esc` clears it, a second `Esc` leaves the field) |
| `↵` | details |
| `0` / `1` … `9` | all namespaces / the namespace on that digit, like k9s favorites: those from your kubeconfig first, then recent ones |
| `⌥1` … `⌥9` / `⌥0` | hide or show the rows of cluster N (like clicking its chip) / show all |
| `⇧N` / `⇧A` | sort by name / age; again to reverse (any column: "Sort by…" in the palette) |
| `Space`, `⌘A` | mark a row / mark all visible rows |
| `⇧R`, `⇧S`, `⌃D` (`⌘⌫`), `c` | restart, scale, delete, copy the name (read-only mode explains why not) |
| `s` / `a` | shell into a pod (on a node: a node shell) / attach to a container's process |
| `⇧F` | port-forward a pod, service or workload |
| `l` on marked rows | their logs together, in a dock tab |
| `=` on marked rows · `+` | compare them, the first against the rest · pin an object to compare others with (again to unpin) |
| `⇧F10`, the menu key | the action menu of the selection (like a right click) |
| `⌘J` | the dock with terminals and port-forwards: show and focus it; again to hide (from a terminal: `⌘⇧J`) |

The filter is a list of terms, all of which must match:

| Term | Matches |
| --- | --- |
| `foo bar` | substrings of the name, namespace, cluster, labels or any column (case-insensitive) |
| `!foo` | rows without it |
| `app=web`, `app!=web` | label equal / not equal (or missing), exactly like `kubectl -l`: `app=web` matches neither `app=web-canary` nor `k8s-app=web` |
| `app=web,tier=frontend` | all of these labels |
| `"a=b"` | the substring `a=b`, not a label |

Actions apply to the marked rows if there are any, otherwise to the selected row, and only to visible ones: marks on rows hidden by the filter or by a hidden cluster are left alone.

## Details

| Keys | |
| --- | --- |
| `d` `r` `l` `e` `y` `=` | Overview / Relations / Logs / Events / YAML / Compare (a Helm release: `d` `v` `m` `h` for Release / Values / Manifest / History) |
| `←` `→` on the tabs | previous / next tab (the same in the dock, where `⌫` closes a terminal) |
| `f` | full-screen details and back |
| `j` `k` `g` `G` `Space` | scroll full-screen details (in logs: move the line cursor) |
| `/`, `⌘F` · `n` `⇧N` | filter logs or search YAML · next / previous match (in logs without a query: the next warning or error; in Compare: the next difference) |

## Logs

| Keys | |
| --- | --- |
| `j` `k` (`↑` `↓`) | move the line cursor |
| `⇧J` `⇧K`, `⇧`-click | extend the selection down / up |
| `c` · `x` `↵` | copy the selected lines · expand the line under the cursor |
| `g` / `G` | start (loading earlier lines) / end, following live |
| `[` `]` | previous / next error or warning |
| `s` | pause |
| `w` `t` `v` `h` `p` | wrap, timestamps, pretty JSON/logfmt, histogram, previous container |
| `⌘S` | save what's shown |
| `↵` `Tab` · `⌃Space` (in the query) | take the highlighted suggestion · suggest here |
| `⌥C` `⌥R` `⌥F` (in the query) | match case · the whole query as one regex · filter or search |
| `Esc` | drop the selection, then the cursor |

## Palette and pickers

| Keys | |
| --- | --- |
| `↑` `↓`, `⌃N` `⌃P` | move |
| `↵` | choose; in the cluster or namespace picker, add or remove it |
| `⌘↵` | in a picker: only this one; in the palette: add it to the selection |
| `Esc` | close |

## Panels and the sidebar

| Keys | |
| --- | --- |
| `Tab` into the sidebar (or `⇧F6`) | `↑` `↓` (`j` `k`) between items, `←` `→` collapse / expand a section, `↵` open, `Esc` back to the table |
| `Tab` onto a panel edge | arrows resize the sidebar, details or dock (`⇧` for bigger steps), `Home` / `End` for the narrowest / widest |
| In a menu | `↑` `↓`, `Home` / `End` move; a letter jumps to the next item that starts with it |

In a terminal every key belongs to the terminal (`Esc`, `⌃C`, `⌃D`), except `⌘` shortcuts on macOS. `⌘⇧J` (`Ctrl+Shift+J`) leaves it. When a shell or attach session has ended, `↵` starts a new one.
