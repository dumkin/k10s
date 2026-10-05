// The window's areas, in the order F6 goes through them (⇧F6 back), as desktop apps have it: the sidebar's list, the
// table (or the view in its place), the details beside it, the dock under them. Each takes the keyboard where its keys
// work: the resource shown in the sidebar, the table itself, the open tab of the details (Tab goes on into it), the
// dock's terminal.

type Region = { name: string; present: () => boolean; focus: () => void };

const el = (selector: string) => document.querySelector<HTMLElement>(selector);

const REGIONS: Region[] = [
  {
    name: "sidebar",
    present: () => !!el(".sidebar"),
    focus: () => (el(".sidebar .sb-item.active") ?? el(".sidebar .sb-item"))?.focus(),
  },
  {
    name: "main",
    present: () => !!el(".main"),
    // The table takes the keyboard without a field or a button having it; a view without a table (Needs attention,
    // My permissions) the same way.
    focus: () => {
      const table = el(".main .content .tscroll");
      if (table) table.focus({ preventScroll: true });
      else (document.activeElement as HTMLElement | null)?.blur();
    },
  },
  {
    name: "details",
    present: () => !!el(".details"),
    focus: () => (el(".details .tab[aria-selected=true]") ?? el(".details"))?.focus(),
  },
  {
    name: "dock",
    present: () => !!el(".dock:not(.hidden)"),
    focus: () => {
      const pane = el(".dock .dock-pane.on");
      (pane?.querySelector<HTMLElement>(".term textarea, [tabindex], button, input") ?? el(".dock .dock-tab.on"))?.focus();
    },
  },
];

/** The area the keyboard is in now. */
function current(): number {
  const at = document.activeElement;
  if (at?.closest(".sidebar")) return 0;
  if (at?.closest(".details")) return 2;
  if (at?.closest(".dock")) return 3;
  return 1;
}

/** Takes the keyboard to the next area that is there (`step` 1), or the previous one (-1). */
export function cycleRegion(step: 1 | -1) {
  const from = current();
  for (let n = 1; n <= REGIONS.length; n++) {
    const r = REGIONS[(from + step * n + REGIONS.length * 2) % REGIONS.length];
    if (r.present()) return r.focus();
  }
}
