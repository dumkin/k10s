import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { ResourceInfo } from "../lib/backend";
import { bindAll, comboLabel } from "../lib/hotkeys";
import { splitterKeyDown } from "../lib/splitter";
import { isBoolean, persisted, recordOf } from "../lib/persist";
import { ATTENTION } from "../lib/attention";
import { PERMISSIONS } from "../lib/permissions";
import { CATALOG, type CatalogSection, isCatalogued, isHiddenGroup, titleFor } from "../registry/catalog";
import { attentionCount } from "../state/attention";
import { discoveredResources, selectedClusters } from "../state/clusters";
import { navigate, resourceKey } from "../state/nav";
import { mainView } from "../state/views";
import { modalOpen } from "../state/keyboard";
import { setSidebarWidth, sidebarWidth } from "../state/ui";
import { Icon } from "./Icon";

/** Sidebar items on ⌘1…⌘9: the first nine shown, top to bottom (like the sessions list of a chat app). */
const QUICK_KEYS = 9;
/** How narrow and how wide the sidebar may be dragged (see `sidebarWidth`). */
const MIN_W = 180;
const MAX_W = 420;

const [collapsed, setCollapsed] = persisted<Record<string, boolean>>("sidebarCollapsed", { access: true, admin: true }, recordOf(isBoolean));

export function Sidebar() {
  const [query, setQuery] = createSignal("");
  const discovered = discoveredResources;
  const anyDiscovery = () => discovered().size > 0;

  /** CRDs and other non-catalogued resources, grouped by API group. */
  const custom = createMemo(() => {
    const groups = new Map<string, (ResourceInfo & { clusters: string[] })[]>();
    for (const r of discovered().values()) {
      if (isCatalogued(r.key) || !r.group || isHiddenGroup(r.group) || !r.verbs.includes("list")) continue;
      const list = groups.get(r.group) ?? [];
      list.push(r);
      groups.set(r.group, list);
    }
    return [...groups.entries()]
      .map(([group, items]) => ({ group, items: items.sort((a, b) => a.kind.localeCompare(b.kind)) }))
      .sort((a, b) => a.group.localeCompare(b.group));
  });

  const matches = (title: string, key: string) => {
    const q = query().trim().toLowerCase();
    if (!q) return true;
    const r = discovered().get(key);
    return title.toLowerCase().includes(q) || key.includes(q) || !!r?.shortNames.some((s) => s === q);
  };

  const count = (key: string) => (key === ATTENTION ? (attentionCount() ?? undefined) : key === resourceKey() ? mainView.rows().length : undefined);

  /** Items as shown, top to bottom: sections that are open (all while filtering), entries that match. */
  const shownKeys = createMemo(() => {
    const out: string[] = matches("Needs attention", ATTENTION) ? [ATTENTION] : [];
    for (const section of CATALOG) {
      if (!query() && collapsed()[section.id]) continue;
      for (const e of section.entries) if (matches(e.title, e.key)) out.push(e.key);
    }
    if (query() || !collapsed().custom) for (const g of custom()) for (const r of g.items) if (matches(titleFor(r.kind), r.key)) out.push(r.key);
    return out;
  });
  /** The entry Tab lands on in the list. */
  const tabStop = createMemo(() => (shownKeys().includes(resourceKey()) ? resourceKey() : shownKeys()[0]));
  const quickKey = (key: string) => {
    const i = shownKeys().indexOf(key);
    return i >= 0 && i < QUICK_KEYS ? `mod+${i + 1}` : undefined;
  };
  onMount(() => {
    onCleanup(
      bindAll(
        [...Array(QUICK_KEYS).keys()].map((i) => ({
          combo: `mod+${i + 1}`,
          inInputs: true,
          priority: 40,
          when: () => !modalOpen(),
          run: () => {
            const key = shownKeys()[i];
            if (!key) return false;
            navigate(key);
          },
        })),
      ),
    );
  });

  const Item = (p: { key: string; title: string; icon: Parameters<typeof Icon>[0]["name"]; hint?: string }) => {
    const r = () => discovered().get(p.key);
    const partial = () => {
      const res = r();
      return res && res.clusters.length < selectedClusters().length ? `${res.clusters.length}/${selectedClusters().length}` : undefined;
    };
    const title = () => {
      const res = r();
      const what =
        p.hint ??
        (p.key === PERMISSIONS ? "What you may do, per resource and verb, in each selected cluster" : res ? `${res.kind} · ${res.group || "core"}/${res.version}${res.shortNames.length ? ` · ${res.shortNames.join(", ")}` : ""}` : p.key);
      const key = quickKey(p.key);
      return key ? `${what} (${comboLabel(key)})` : what;
    };
    return (
      <button
        class="sb-item"
        classList={{ active: resourceKey() === p.key, unavailable: anyDiscovery() && !r() && !p.hint && p.key !== PERMISSIONS }}
        aria-current={resourceKey() === p.key ? "page" : undefined}
        // One stop for the whole list (the resource shown, or the first entry while that one is out of sight); ↑ ↓ move
        // along it.
        tabIndex={tabStop() === p.key ? 0 : -1}
        // A click doesn't take the keyboard into the list (Chromium-based web views would), and gives it back from the
        // sidebar's filter: j / k are the table's again.
        onMouseDown={releaseKeyboard}
        onClick={() => navigate(p.key)}
        title={title()}
        data-hint={quickKey(p.key)}
      >
        <Icon name={p.icon} size={15} />
        <span class="ellipsis">{p.title}</span>
        <Show when={count(p.key) !== undefined} fallback={<Show when={partial()}>{(x) => <span class="meta" title="Served by only some selected clusters">{x()}</span>}</Show>}>
          <span class="meta">{count(p.key)!.toLocaleString("en-US")}</span>
        </Show>
      </button>
    );
  };

  const Section = (p: { section: CatalogSection }) => {
    const entries = () => p.section.entries.filter((e) => matches(e.title, e.key));
    const isCollapsed = () => !query() && !!collapsed()[p.section.id];
    return (
      <Show when={entries().length}>
        <div class="sb-section">
          <button
            class="sb-head"
            classList={{ collapsed: isCollapsed() }}
            aria-expanded={!isCollapsed()}
            tabIndex={-1}
            onMouseDown={releaseKeyboard}
            onClick={() => setCollapsed({ ...collapsed(), [p.section.id]: !collapsed()[p.section.id] })}
          >
            <Icon name="chevron-down" size={12} />
            {p.section.title}
          </button>
          <Show when={!isCollapsed()}>
            <For each={entries()}>{(e) => <Item key={e.key} title={e.title} icon={e.icon} />}</For>
          </Show>
        </div>
      </Show>
    );
  };

  const startResize = (e: MouseEvent) => {
    e.preventDefault();
    const target = e.currentTarget as HTMLElement;
    target.classList.add("dragging");
    let width: number | null = null;
    let frame = 0;
    // The new width shows at most once a frame. Mouse events come faster than frames, and WebKit lays the window out
    // before each one (to find what is under the pointer) when something changed since: one layout per event.
    const move = (ev: MouseEvent) => {
      width = Math.max(MIN_W, Math.min(MAX_W, ev.clientX));
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        if (width !== null) setSidebarWidth(width);
      });
    };
    const up = () => {
      cancelAnimationFrame(frame);
      target.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (width !== null) setSidebarWidth(width);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };
  const resizeKeys = splitterKeyDown({ value: sidebarWidth, set: setSidebarWidth, min: () => MIN_W, max: () => MAX_W, grow: "ArrowRight", shrink: "ArrowLeft" });

  let nav!: HTMLElement;
  let filterInput!: HTMLInputElement;
  /** A click on an entry: no focus for it, and none left in the sidebar (its filter, an entry): the table's keys again. */
  const releaseKeyboard = (e: MouseEvent) => {
    e.preventDefault();
    if (nav.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
  };
  /** The list's stops, top to bottom: section heads and items (what ↑ ↓ go through). */
  const stops = () => [...nav.querySelectorAll<HTMLElement>(".sb-head, .sb-item")];
  /**
   * Keys along the list, as in any sidebar: ↑ ↓ (j k) to the previous / next entry, Home / End to the first / last,
   * ← on an open section's head closes it and → opens it; ↵ and Space are the buttons' own. ↑ from the first entry goes
   * to the filter, Esc back to the table.
   */
  const listKeys = (e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const list = stops();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    const go = (i: number) => {
      e.preventDefault();
      if (i < 0) return filterInput.focus();
      list[Math.min(i, list.length - 1)]?.focus();
    };
    const head = list[at].classList.contains("sb-head");
    if (e.key === "ArrowDown" || e.key === "j") go(at + 1);
    else if (e.key === "ArrowUp" || e.key === "k") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (head && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      const open = list[at].getAttribute("aria-expanded") === "true";
      if (open === (e.key === "ArrowLeft")) list[at].click();
    } else if (e.key === "Escape") {
      e.preventDefault();
      (document.activeElement as HTMLElement).blur();
    }
  };

  return (
    <nav class="sidebar" ref={nav} aria-label="Resources" data-own-arrows onKeyDown={listKeys}>
      <div class="sb-filter search-field">
        <Icon name="filter" size={13} />
        <input
          ref={filterInput}
          class="input"
          placeholder="Filter resources"
          aria-label="Filter resources"
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            // ↵ opens the first match; ↓ goes down the list; Esc clears, then gives the keyboard back to the table.
            if (e.key === "Enter" && shownKeys().length) {
              navigate(shownKeys()[0]);
              setQuery("");
              e.currentTarget.blur();
            } else if (e.key === "ArrowDown") (nav.querySelector<HTMLElement>(".sb-item.active") ?? stops()[0])?.focus();
            else if (e.key === "Escape" && query()) setQuery("");
            else if (e.key === "Escape") e.currentTarget.blur();
            else return;
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      </div>
      <Show when={matches("Needs attention", ATTENTION)}>
        <div class="sb-section sb-top">
          <Item key={ATTENTION} title="Needs attention" icon="alert" hint="What is wrong across the selected clusters: failing pods, degraded workloads, nodes, claims, releases, warning events" />
        </div>
      </Show>
      <For each={CATALOG}>{(s) => <Section section={s} />}</For>
      <Show when={custom().length}>
        <div class="sb-section">
          <button
            class="sb-head"
            classList={{ collapsed: !query() && !!collapsed().custom }}
            aria-expanded={!!query() || !collapsed().custom}
            tabIndex={-1}
            onMouseDown={releaseKeyboard}
            onClick={() => setCollapsed({ ...collapsed(), custom: !collapsed().custom })}
          >
            <Icon name="chevron-down" size={12} />
            Custom Resources
            <span class="count">{custom().reduce((n, g) => n + g.items.length, 0)}</span>
          </button>
          <Show when={query() || !collapsed().custom}>
            <For each={custom()}>
              {(g) => {
                const items = () => g.items.filter((r) => matches(titleFor(r.kind), r.key));
                return (
                  <Show when={items().length}>
                    <div class="sb-group-label" title={g.group}>
                      {g.group}
                    </div>
                    <For each={items()}>{(r) => <Item key={r.key} title={titleFor(r.kind)} icon="crd" />}</For>
                  </Show>
                );
              }}
            </For>
          </Show>
        </div>
      </Show>
      <div
        class="resizer"
        style={{ position: "fixed", left: `${sidebarWidth() - 4}px`, top: "var(--titlebar-h)", bottom: "var(--statusbar-h)" }}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the sidebar"
        aria-valuenow={sidebarWidth()}
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        tabIndex={0}
        onMouseDown={startResize}
        onKeyDown={(e) => {
          e.stopPropagation();
          resizeKeys(e);
        }}
      />
    </nav>
  );
}
