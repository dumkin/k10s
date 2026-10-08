## What's new

<!-- Written for each release by the prepare-release skill (.claude/skills/prepare-release): New, Improved, Fixed, Notes. -->

### New

- **Recent filters and log queries**: `↑` in the table's filter or in the log query, or a click on its icon, lists what you used there lately. Typing narrows the list, `↵` applies one, `⇧⌫` forgets one. The table keeps 20, the log query 30.
- **Copy any cell** with ⌥-click (Alt-click on Windows and Linux): a pod's IP, its node, a cluster's full context name. While ⌥ is held, the cell a click would copy is highlighted.
- **Late pods in Sources**: the log's Sources list says when a pod's lines come late (`45s behind`) or the pod has gone quiet (`last line 2m ago`). A late pod's lines are the oldest as they come, so a full buffer drops them first: that is why such a pod shows few lines.
- **Linux software centers** describe k10s: the `.deb`, `.rpm` and AppImage carry AppStream metadata with a description, screenshots and the list of releases.

### Improved

- **Logs keep up with huge, fast lines**: a stream of kilobyte-long JSON lines no longer leaves the view half blank, jumping, or tens of seconds behind. While you read, scroll, select or pause, the view stays where it is, and the strip says how far behind the newest lines come.
- **The histogram is a steady time tape**: bars keep their width, the newest on the right, and filters lower them without moving them. The bar under the pointer is lit and tells its time, a click or a drag picks what is under the pointer, and ticks show the time of day.
- **Dragging a panel's edge** (the sidebar's, the details', the dock's, a column's) takes about a third of the CPU it did, also with logs or a terminal open.
- **Copying** says what it copied, or why it couldn't: names, details, log fields and port-forwards alike.

### Fixed

- At a UI zoom other than 100%, the sidebar is no longer drawn wider than its edge (at 200% it could leave the table no room).
- A pod's Overview no longer jumps back up every second after a container restarted, folding the environment and hiding revealed Secrets again.
- A right-click on the sidebar's edge no longer leaves the sidebar following the pointer.
- Compare: a long name no longer runs out of its chip over the next one.
- My permissions: the squares and the rows line up.
- Escape while dragging over the histogram no longer also closes the details.
- macOS: if installing an update fails, the installed app is no longer deleted (for updates from this version on).

### Notes

- The apps still aren't notarized by Apple or signed for Windows. The first time, macOS asks you to allow k10s in **System Settings → Privacy & Security**, and Windows SmartScreen needs **More info → Run anyway**.
- Coming from 0.1.0? See also [what's new in 0.1.1](https://github.com/dumkin/k10s/releases/tag/v0.1.1).

### Install

| | |
| --- | --- |
| macOS | `k10s-<version>-macos-arm64.dmg` (Apple silicon) |
| Windows | `k10s-<version>-windows-x64-setup.exe`, or the `.msi` |
| Linux | `.AppImage`, `.deb` or `.rpm`: `linux-x64` for Intel and AMD, `linux-arm64` for Arm |

Already using k10s? It updates itself: restart it when the status bar says the update is ready.
