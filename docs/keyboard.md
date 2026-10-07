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
| `⌥1` … `⌥9` / `⌥0` | hide or show the rows of cluster N (like clicking its chip) / show all. `⌘`-click a chip (on macOS `⌃`-click too): only that cluster's rows; again: every cluster's |
| `⇧N` / `⇧A` | sort by name / age; again to reverse (any column: "Sort by…" in the palette) |
| `Space`, `⌘A` | mark a row / mark all visible rows |
| `⇧J` `⇧K` (`⇧↓` `⇧↑`), `⇧`-click | mark the rows on the way from the selected one; going back unmarks them |
| `⇧PgDn` `⇧PgUp`, `⇧Home` `⇧End` | mark a page down / up, or up to the first / last row |
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
| In a menu | `↑` `↓` (`j` `k`), `Home` / `End` move; the key shown next to an item runs it, on what the menu is for; another letter jumps to the next item that starts with it |

In a terminal every key belongs to the terminal (`Esc`, `⌃C`, `⌃D`), except `⌘` shortcuts on macOS. `⌘⇧J` (`Ctrl+Shift+J`) leaves it. When a shell or attach session has ended, `↵` starts a new one.

## Your own keys

A command's keys can be others: give them in `settings.json` (⌘K → **Open settings.json**), under `keys`, by the group and the name of the command. k10s takes the change when its window gets the focus back: the new key works at once, the old one no longer does, and the cheat sheet, the ⌘ hints, tooltips, menus and the palette show the new one.

```json
{
  "keys": {
    "logs": { "wrap": "alt+w", "pause": ["s", "shift+p"] },
    "table": { "down": "n" },
    "action": { "delete": null }
  }
}
```

A key is written like `mod+shift+k`: `mod` is `⌘` on macOS and `Ctrl` elsewhere, `ctrl` is `⌃` on macOS (and `Ctrl` elsewhere), then `alt`, `shift`, and a character or the name of a key (`/`, `?`, `f6`, `escape`, `space`, `arrowleft`, `pagedown`, `backspace`). A symbol is written as it is typed: `?`, not `shift+/`. A list gives a command several keys; `null` or `[]` takes them all away. A key k10s can't read leaves the command its own keys.

| Group | Commands |
| --- | --- |
| `app` | `palette`, `palette-new` (`⌘P`), `command` (`:`), `clusters`, `namespaces`, `help`, `settings`, `zoom-in`, `zoom-out`, `zoom-reset`, `next-area`, `previous-area` |
| `nav` | `back`, `forward` |
| `dock` | `toggle`, `toggle-from-terminal` |
| `table` | `down`, `up`, `first`, `last`, `mark-down`, `mark-up`, `filter` (`/`), `filter-anywhere` (`⌘F`), `sort-name`, `sort-age` |
| `action` | `shell`, `attach`, `node-shell`, `port-forward`, `restart`, `scale`, `delete`, `copy-name`, `compare-pin`, and, without a key of their own, `cordon`, `suspend`, `trigger`, `debug`, `helm-rollback`, `helm-uninstall` |
| `tab` | `overview`, `relations`, `logs`, `events`, `yaml`, `compare`; for a Helm release `release`, `values`, `manifest`, `history`. The keys of `logs` and `compare` also run those actions on marked rows |
| `details` | `full`, `down`, `up`, `top`, `bottom` |
| `logs` | `find`, `down`, `up`, `pick-down`, `pick-up`, `first`, `last`, `next-match`, `previous-match`, `next-problem`, `previous-problem`, `pause`, `expand`, `copy`, `save`, `wrap`, `timestamps`, `pretty`, `histogram`, `previous-containers` |
| `yaml` | `find`, `next-match`, `previous-match` |
| `diff` | `next-change`, `previous-change` (the Compare tab's YAML) |
| `attention` | `down`, `up`, `first`, `last`, `filter` (Needs attention) |

The arrows, `PgUp` `PgDn` `Home` `End`, `↵`, `Esc`, `Space`, `Tab`, the digits (`0`–`9`, `⌥1`…, `⌘1`…), `⇧F10`, `⌘C`, `⌘A`, and the keys of menus, pickers, dialogs and the palette stay as they are.
